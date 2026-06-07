/**
 * zarumi-aq — AnimeQ extractor + proxy
 * Cloudflare Worker
 *
 * GET /?url=https://animeq.net/episodio/SLUG-episodio-01
 * GET /?url=https://animeq.net/filme/SLUG/
 * Retorna JSON estruturado:
 * { success, title, site, postId, type, results: [{ label, type, url, proxyUrl }] }
 *
 * GET /?proxy=https://aniplay.online/...mp4
 * → Faz proxy do arquivo de vídeo com Referer do AnimeQ
 */

const SITE_ORIGIN  = "https://animeq.net";
const SITE_REFERER = "https://animeq.net/";

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
    const debugUrl  = workerUrl.pathname === "/debug" ? workerUrl.searchParams.get("url") : null;

    if (proxy)    return handleProxy(proxy, request);
    if (debugUrl) return handleDebug(debugUrl, workerUrl);
    if (pageUrl)  return handleExtract(pageUrl, workerUrl);

    return jsonResponse({ error: "Use ?url=PAGE ou ?proxy=VIDEO_URL" }, 400);
  },
};

// ─── Extrator principal ───────────────────────────────────────────────────────

async function handleExtract(pageUrl, workerUrl) {
  try {
    const html  = await fetchPage(pageUrl);
    const meta  = extractMeta(html, pageUrl);
    const ajax  = await tryDooplayAjax(html, pageUrl, workerUrl);

    if (ajax && ajax.length > 0) {
      return jsonResponse({ success: true, ...meta, results: ajax });
    }

    // Fallback: extração direta do HTML
    const direct = extractDirectFromHtml(html, SITE_ORIGIN, workerUrl);
    if (direct.length > 0) {
      return jsonResponse({ success: true, ...meta, results: direct });
    }

    // Fallback: segue iframe
    const iframeUrl = extractIframe(html, SITE_ORIGIN);
    if (iframeUrl && iframeUrl !== pageUrl) {
      const iHtml   = await fetchPage(iframeUrl, pageUrl);
      const iDirect = extractDirectFromHtml(iHtml, iframeUrl, workerUrl);
      if (iDirect.length > 0) {
        return jsonResponse({ success: true, ...meta, results: iDirect });
      }
    }

    return jsonResponse({ success: false, error: "Video not found", source: pageUrl }, 404);
  } catch (err) {
    return jsonResponse({ success: false, error: err.message, source: pageUrl }, 502);
  }
}

// ─── Metadados da página ──────────────────────────────────────────────────────

function extractMeta(html, pageUrl) {
  const title   = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.replace(/ – AnimeQ.*/, "").trim() || "";
  const postId  = extractPostId(html) || "";
  const isFilme = pageUrl.includes("/filme/") || pageUrl.includes("/movie/");
  return { title, site: SITE_ORIGIN, postId, type: isFilme ? "movie" : "serie" };
}

// ─── DooPlay AJAX ─────────────────────────────────────────────────────────────

async function tryDooplayAjax(html, referer, workerUrl) {
  const ajaxUrl = extractAjaxUrl(html);
  const postId  = extractPostId(html);
  const nonce   = extractNonce(html);

  if (!ajaxUrl || !postId || !nonce) return null;

  const actions = ["dooplay_ajax_player", "dooplay_player_ajax", "TWP", "doo_player_ajax"];

  for (const action of actions) {
    try {
      const body = new URLSearchParams({ action, postID: postId, nonce });
      const res  = await fetch(ajaxUrl, {
        method: "POST",
        headers: {
          "Content-Type":     "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent":       UA,
          "Accept":           "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
          "Referer":          referer,
          "Origin":           SITE_ORIGIN,
        },
        body: body.toString(),
      });

      const text = await res.text();
      if (!text || text === "0" || text === "-1") continue;

      let data;
      try { data = JSON.parse(text); } catch { continue; }

      // Resposta pode ter embed, data, html, ou array de sources
      const embedHtml = data.embed || data.data || data.html || data.result || "";

      if (embedHtml) {
        const results = await parseEmbedForResults(embedHtml, referer, workerUrl);
        if (results.length > 0) return results;
      }

      // Alguns DooPlay retornam array de sources direto
      if (Array.isArray(data.sources)) {
        return data.sources.map((s, i) => buildResult(s.file || s.url, s.label || `Opção ${i+1}`, s.type, workerUrl));
      }

    } catch {}
  }

  return null;
}

async function parseEmbedForResults(embedHtml, referer, workerUrl) {
  const results = [];

  // URLs mp4 diretas no embed
  const mp4s = [...embedHtml.matchAll(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/gi)];
  for (const [url] of mp4s) {
    results.push(buildResult(url, `Opção ${results.length + 1} (MP4 Direto)`, "mp4", workerUrl));
  }

  // m3u8
  const m3u8s = [...embedHtml.matchAll(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/gi)];
  for (const [, url] of m3u8s) {
    results.push(buildResult(url, `Opção ${results.length + 1} (HLS)`, "hls", workerUrl));
  }

  // iframes dentro do embed
  const iframes = [...embedHtml.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)];
  for (const [, src] of iframes) {
    const iUrl = src.startsWith("http") ? src : src.startsWith("//") ? "https:" + src : SITE_ORIGIN + src;
    try {
      const iHtml = await fetchPage(iUrl, referer);
      const mp4   = iHtml.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
      const m3u8  = iHtml.match(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/i);
      if (mp4)  results.push(buildResult(mp4[0], `Opção ${results.length + 1} (MP4)`, "mp4", workerUrl));
      if (m3u8) results.push(buildResult(m3u8[1], `Opção ${results.length + 1} (HLS)`, "hls", workerUrl));
      if (!mp4 && !m3u8) results.push(buildResult(iUrl, `Opção ${results.length + 1}`, "iframe", workerUrl));
    } catch {
      results.push(buildResult(iUrl, `Opção ${results.length + 1}`, "iframe", workerUrl));
    }
  }

  return results;
}

function buildResult(url, label, type, workerUrl) {
  const proxyUrl = `${workerUrl.origin}/?proxy=${encodeURIComponent(url)}`;
  return { label, type: type || "mp4", url, proxyUrl };
}

// ─── Extração direta do HTML ──────────────────────────────────────────────────

function extractDirectFromHtml(html, base, workerUrl) {
  const results = [];

  const mp4s = [...html.matchAll(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/gi)];
  for (const [url] of mp4s) {
    if (!results.find(r => r.url === url))
      results.push(buildResult(url, `Opção ${results.length + 1} (MP4 Direto)`, "mp4", workerUrl));
  }

  const m3u8s = [...html.matchAll(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/gi)];
  for (const [, url] of m3u8s) {
    if (!results.find(r => r.url === url))
      results.push(buildResult(url, `Opção ${results.length + 1} (HLS)`, "hls", workerUrl));
  }

  return results;
}

// ─── Debug ────────────────────────────────────────────────────────────────────

async function handleDebug(pageUrl, workerUrl) {
  try {
    const html = await fetchPage(pageUrl);
    return jsonResponse({
      url:        pageUrl,
      html_length: html.length,
      ajax_url:   extractAjaxUrl(html),
      post_id:    extractPostId(html),
      nonce:      extractNonce(html),
      iframe:     extractIframe(html, SITE_ORIGIN),
      direct:     extractDirectFromHtml(html, SITE_ORIGIN, workerUrl),
      html_start: html.slice(0, 3000),
    });
  } catch (err) {
    return jsonResponse({ error: err.message, url: pageUrl }, 502);
  }
}

// ─── Proxy de vídeo ───────────────────────────────────────────────────────────

async function handleProxy(target, request) {
  const headers = {
    "User-Agent": UA,
    "Referer":    SITE_REFERER,
    "Origin":     SITE_ORIGIN,
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

// ─── Helpers HTML ─────────────────────────────────────────────────────────────

function extractIframe(html, base) {
  const m = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (!m) return null;
  const s = m[1];
  return s.startsWith("http") ? s : s.startsWith("//") ? "https:" + s : base + s;
}

function extractAjaxUrl(html) {
  const m = html.match(/["']ajaxurl["']\s*:\s*["']([^"']+)["']/i)
         || html.match(/var\s+ajaxurl\s*=\s*["']([^"']+)["']/i);
  return m ? dec(m[1]) : null;
}

function extractPostId(html) {
  const m = html.match(/["']post_?[Ii][Dd]["']\s*:\s*["']?(\d+)/i)
         || html.match(/postID\s*=\s*["']?(\d+)/i)
         || html.match(/data-post(?:-id)?\s*=\s*["']?(\d+)/i);
  return m ? m[1] : null;
}

function extractNonce(html) {
  const m = html.match(/["']nonce["']\s*:\s*["']([a-f0-9]{10,})["']/i)
         || html.match(/data-nonce\s*=\s*["']([a-f0-9]{10,})["']/i);
  return m ? m[1] : null;
}

// ─── Helpers gerais ───────────────────────────────────────────────────────────

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchPage(url, referer = SITE_REFERER) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":                UA,
      "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language":           "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "Referer":                   referer,
      "Origin":                    SITE_ORIGIN,
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

function dec(s) {
  return s.replace(/&amp;/g, "&").replace(/&#038;/g, "&").replace(/\\u0026/g, "&");
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}
