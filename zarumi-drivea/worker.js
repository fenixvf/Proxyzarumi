/**
 * zarumi-drivea — AnimésDrive extractor + video proxy
 * Drop-in replacement para drivea.masterotaku487.workers.dev
 *
 * GET /?url=https://animesdrive.online/episodio/SLUG-episodio-01
 *   → Extrai vídeo da página, retorna { success, results: [...] }
 *
 * GET /?proxy=https://aniplay.online/Midias/...mp4
 *   → Proxy do arquivo de vídeo com Range support
 *
 * GET /debug?url=PAGE_URL
 *   → Diagnóstico: HTML, postId, nonce, iframes encontrados
 */

const SITE_ORIGIN  = "https://animesdrive.online";
const SITE_REFERER = "https://animesdrive.online/";
const VIDEO_CDN    = "aniplay.online";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":   "*",
  "Access-Control-Allow-Methods":  "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers":  "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS_HEADERS });

    const workerUrl = new URL(request.url);
    const proxy     = workerUrl.searchParams.get("proxy");
    const pageUrl   = workerUrl.searchParams.get("url");
    const isDebug   = workerUrl.pathname === "/debug";

    if (proxy)              return handleProxy(proxy, request);
    if (pageUrl && isDebug) return handleDebug(pageUrl, workerUrl);
    if (pageUrl)            return handleExtract(pageUrl, workerUrl);

    return jsonResponse({ error: "Use ?url=PAGE_URL ou ?proxy=VIDEO_URL" }, 400);
  },
};

// ─── Extrator principal ───────────────────────────────────────────────────────

async function handleExtract(pageUrl, workerUrl) {
  try {
    const results = await extractFromPage(pageUrl, workerUrl);
    if (results.length > 0) {
      return jsonResponse({ success: true, results, source: pageUrl });
    }
    return jsonResponse({ success: false, error: "Video not found", source: pageUrl }, 404);
  } catch (err) {
    return jsonResponse({ success: false, error: err.message, source: pageUrl }, 502);
  }
}

async function extractFromPage(pageUrl, workerUrl) {
  const html = await fetchPage(pageUrl);

  // 1. URLs diretas no HTML (mp4, m3u8)
  const direct = extractDirectUrls(html, pageUrl, workerUrl);
  if (direct.length) return direct;

  // 2. DooPlay AJAX
  const ajax = await tryDooplayAjax(html, pageUrl, workerUrl);
  if (ajax.length) return ajax;

  // 3. Iframes
  const iframes = extractAllIframes(html);
  for (const iUrl of iframes.slice(0, 4)) {
    try {
      const iHtml = await fetchPage(iUrl, pageUrl);
      const r = extractDirectUrls(iHtml, iUrl, workerUrl);
      if (r.length) return r;
    } catch {}
  }

  return [];
}

// ─── Extração de URLs diretas ─────────────────────────────────────────────────

function extractDirectUrls(html, referer, workerUrl) {
  const results = [];
  const workerBase = workerUrl.origin;

  // aniplay.online CDN (mp4 direto)
  const aniplayUrls = [...html.matchAll(/(https?:\/\/[^"'\s<>]*aniplay\.online[^"'\s<>]+\.mp4[^"'\s<>]*)/gi)];
  for (const [url] of aniplayUrls) {
    const clean = dec(url);
    if (!results.find(r => r.url === clean)) {
      results.push(buildResult(clean, "AnimésDrive", "mp4", workerBase));
    }
  }
  if (results.length) return results;

  // <source src="...mp4">
  const sourceTag = html.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)/i);
  if (sourceTag) return [buildResult(dec(sourceTag[1]), "Source", "mp4", workerBase)];

  // file: "...mp4" ou file: '...mp4'
  const fileAttr = html.match(/["\s,({]file\s*:\s*["']([^"']+\.mp4[^"']*)/i);
  if (fileAttr) return [buildResult(dec(fileAttr[1]), "Player", "mp4", workerBase)];

  // "src"/"file"/"url": "...mp4"
  const jsonSrc = html.match(/"(?:src|file|url)"\s*:\s*"([^"]+\.mp4[^"]*)"/i);
  if (jsonSrc) return [buildResult(dec(jsonSrc[1]), "JSON", "mp4", workerBase)];

  // playerjs.setup / player.init
  const playerJs = html.match(/(?:player|playerjs)\.(?:setup|init)\s*\(\s*\{[^}]*?file\s*:\s*["']([^"']+)/i);
  if (playerJs) {
    const url = dec(playerJs[1]);
    const type = url.includes(".m3u8") ? "hls" : "mp4";
    return [buildResult(url, "PlayerJS", type, workerBase)];
  }

  // atob decode
  const b64 = html.match(/atob\s*\(\s*["']([A-Za-z0-9+/=]{20,})["']\s*\)/);
  if (b64) {
    try {
      const decoded = atob(b64[1]);
      const mp4 = decoded.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
      if (mp4) return [buildResult(mp4[0], "Base64 MP4", "mp4", workerBase)];
      const m3u8 = decoded.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
      if (m3u8) return [buildResult(m3u8[0], "Base64 HLS", "hls", workerBase)];
    } catch {}
  }

  // HLS m3u8
  const m3u8s = [...html.matchAll(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/gi)];
  for (const [, url] of m3u8s) {
    results.push(buildResult(url, "HLS", "hls", workerBase));
  }
  if (results.length) return results;

  // Blogger embed (isBlogger=true) — tem URL com blogspot ou blogger
  const bloggerIframes = [...html.matchAll(/<iframe[^>]+src=["'](https?:\/\/(?:[^"']*\.googleusercontent\.com|[^"']*blogger\.com|[^"']*blogspot\.com)[^"']*)["']/gi)];
  for (const [, src] of bloggerIframes) {
    results.push(buildBloggerResult(src, workerBase));
  }
  if (results.length) return results;

  // Qualquer mp4
  const anyMp4 = html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
  if (anyMp4) return [buildResult(anyMp4[0], "MP4", "mp4", workerBase)];

  return [];
}

// ─── DooPlay AJAX ─────────────────────────────────────────────────────────────

async function tryDooplayAjax(html, pageUrl, workerUrl) {
  const postId = extractPostId(html);
  const nonce  = extractNonce(html);
  const type   = extractDooplayType(html, pageUrl);
  if (!postId || !nonce) return [];

  const ajaxUrl = (() => {
    const m = html.match(/["']ajaxurl["']\s*:\s*["']([^"']+)["']/i)
           || html.match(/["']url["']\s*:\s*["']([^"']+admin-ajax[^"']+)["']/i)
           || html.match(/var\s+ajaxurl\s*=\s*["']([^"']+)["']/i);
    const raw = dec(m?.[1] || "");
    return raw ? (raw.startsWith("http") ? raw : `${SITE_ORIGIN}${raw}`)
               : `${SITE_ORIGIN}/wp-admin/admin-ajax.php`;
  })();

  const actions = ["dooplay_ajax_player", "dooplay_player_ajax", "doo_player_ajax", "TWP"];
  const numes   = ["1", "2", "3"];

  for (const action of actions) {
    for (const nume of numes) {
      try {
        const body = new URLSearchParams({ action, postID: postId, type, nume, nonce });
        const res  = await fetch(ajaxUrl, {
          method: "POST",
          headers: {
            "Content-Type":     "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent":       UA,
            "Accept":           "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Referer":          pageUrl,
            "Origin":           SITE_ORIGIN,
          },
          body: body.toString(),
        });
        const text = await res.text();
        if (!text || text.trim() === "0" || text.trim() === "-1" || text.trim() === "false") continue;

        let embedHtml = text;
        try {
          const d = JSON.parse(text);
          embedHtml = d.embed || d.data || d.html || d.result || text;
        } catch {}

        const results = extractDirectUrls(embedHtml, pageUrl, workerUrl);
        if (results.length) return results;

        // Segue iframes dentro do embed
        const iframes = extractAllIframes(embedHtml);
        for (const iUrl of iframes.slice(0, 3)) {
          try {
            const iHtml = await fetchPage(iUrl, pageUrl);
            const r = extractDirectUrls(iHtml, iUrl, workerUrl);
            if (r.length) return r;
          } catch {}
        }
      } catch {}
    }
  }
  return [];
}

// ─── Debug ────────────────────────────────────────────────────────────────────

async function handleDebug(pageUrl, workerUrl) {
  try {
    const html = await fetchPage(pageUrl);
    return jsonResponse({
      url:         pageUrl,
      html_length: html.length,
      post_id:     extractPostId(html),
      nonce:       extractNonce(html),
      type:        extractDooplayType(html, pageUrl),
      ajax_url:    html.match(/["']ajaxurl["']\s*:\s*["']([^"']+)["']/i)?.[1] || null,
      iframes:     extractAllIframes(html).slice(0, 6),
      direct:      extractDirectUrls(html, pageUrl, workerUrl),
      html_start:  html.slice(0, 3000),
    });
  } catch (err) {
    return jsonResponse({ error: err.message, url: pageUrl }, 502);
  }
}

// ─── Proxy de vídeo ───────────────────────────────────────────────────────────

async function handleProxy(target, request) {
  const origin = (() => {
    try { return new URL(target).origin; } catch { return SITE_ORIGIN; }
  })();

  const headers = {
    "User-Agent": UA,
    "Referer":    origin + "/",
    "Origin":     origin,
  };

  const range = request.headers.get("Range");
  if (range) headers["Range"] = range;

  const res        = await fetch(target, { headers });
  const resHeaders = new Headers(res.headers);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => resHeaders.set(k, v));
  resHeaders.delete("Content-Security-Policy");
  resHeaders.delete("X-Frame-Options");

  return new Response(res.body, { status: res.status, headers: resHeaders });
}

// ─── Helpers de extração ──────────────────────────────────────────────────────

function buildResult(url, label, type, workerBase) {
  return {
    label,
    type,
    url,
    proxyUrl:   `${workerBase}/?proxy=${encodeURIComponent(url)}`,
    isBlogger:  false,
    resolveUrl: null,
    option:     null,
  };
}

function buildBloggerResult(src, workerBase) {
  return {
    label:      "Blogger",
    type:       "iframe",
    url:        src,
    proxyUrl:   null,
    isBlogger:  true,
    resolveUrl: `${workerBase}/?resolve=${encodeURIComponent(src)}`,
    option:     null,
  };
}

function extractPostId(html) {
  return html.match(/data-post(?:id)?\s*=\s*["']?(\d+)/i)?.[1]
      || html.match(/["']post_?[Ii][Dd]["']\s*:\s*["']?(\d+)/i)?.[1]
      || html.match(/postID\s*[=:]\s*["']?(\d+)/i)?.[1]
      || null;
}

function extractNonce(html) {
  // Prefere o nonce mais próximo do ajaxurl (AJAX nonce, não REST nonce)
  const ajaxCtx = html.match(/ajaxurl[^}]{0,200}"nonce"\s*:\s*"([a-f0-9]{8,12})"/i);
  if (ajaxCtx) return ajaxCtx[1];
  const all = [...html.matchAll(/["']nonce["']\s*:\s*["']([a-f0-9]{8,12})["']/gi)];
  return all[0]?.[1] || null;
}

function extractDooplayType(html, pageUrl) {
  const m = html.match(/class=['"]dooplay_player_option['"][^>]*data-type=['"]([^'"]+)['"]/i)
         || html.match(/data-type=['"]([^'"]+)['"][^>]*data-post=['"][0-9]+['"]/i);
  if (m) return m[1];
  if (pageUrl.includes("/filme/") || pageUrl.includes("/movie/")) return "movie";
  return "tv";
}

function extractAllIframes(html) {
  return [...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)]
    .map(([, s]) => s.startsWith("http") ? s : s.startsWith("//") ? "https:" + s : SITE_ORIGIN + s)
    .filter(u => !u.includes("google.com/maps") && !u.includes("youtube.com/embed"));
}

function dec(s) {
  if (!s) return s;
  return s.replace(/&amp;/g, "&").replace(/&#038;/g, "&").replace(/\\u0026/g, "&")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchPage(url, referer = SITE_REFERER) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":                UA,
      "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language":           "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "Referer":                   referer,
      "Upgrade-Insecure-Requests": "1",
      "Cache-Control":             "max-age=0",
      "sec-ch-ua":                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "sec-ch-ua-mobile":          "?0",
      "sec-ch-ua-platform":        '"Windows"',
      "sec-fetch-dest":            "document",
      "sec-fetch-mode":            "navigate",
      "sec-fetch-site":            "same-origin",
      "sec-fetch-user":            "?1",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} → ${url}`);
  return res.text();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}
