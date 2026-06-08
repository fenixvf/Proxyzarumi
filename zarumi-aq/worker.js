/**
 * zarumi-aq — Extrator genérico para sites DooPlay + proxy de vídeo
 * Cloudflare Worker
 *
 * Suporta: animeq.net, animeplay.cloud, animesonline.cloud, ou qualquer site DooPlay
 *
 * GET /?url=https://animeplay.cloud/episodio/one-piece-dublado-episodio-01
 * GET /?url=https://animeq.net/filme/jujutsu-kaisen-0-o-filme-dublado/
 * Retorna JSON:
 * { success, title, site, postId, type, results: [{ label, type, url, proxyUrl }] }
 *
 * GET /?proxy=https://cdn.exemplo.com/video.mp4
 * → Proxy do vídeo com Referer correto
 */

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

    const isAjaxDebug = workerUrl.pathname === "/ajax-debug";

    if (proxy)                return handleProxy(proxy, request);
    if (pageUrl && isAjaxDebug) return handleAjaxDebug(pageUrl, workerUrl);
    if (pageUrl && isDebug)   return handleDebug(pageUrl, workerUrl);
    if (pageUrl)              return handleExtract(pageUrl, workerUrl);

    return jsonResponse({ error: "Use ?url=PAGE_URL ou ?proxy=VIDEO_URL" }, 400);
  },
};

// ─── Extrator principal ───────────────────────────────────────────────────────

async function handleExtract(pageUrl, workerUrl) {
  try {
    const { html, cookies } = await fetchPageWithCookies(pageUrl);
    const siteOrigin        = getSiteOrigin(pageUrl);
    const meta              = extractMeta(html, pageUrl, siteOrigin);

    // 1. DooPlay AJAX (admin_ajax ou wp_json)
    const ajaxResults = await tryDooplayAjax(html, pageUrl, siteOrigin, cookies, workerUrl);
    if (ajaxResults?.length) return jsonResponse({ success: true, ...meta, results: ajaxResults });

    // 2. WP REST API com nonce
    const restResults = await tryWpRestApi(html, pageUrl, siteOrigin, cookies, workerUrl);
    if (restResults?.length) return jsonResponse({ success: true, ...meta, results: restResults });

    // 3. URLs diretas no HTML
    const direct = extractDirectFromHtml(html, workerUrl);
    if (direct.length) return jsonResponse({ success: true, ...meta, results: direct });

    // 4. Iframes
    const iframes = extractAllIframes(html, siteOrigin);
    for (const iUrl of iframes.slice(0, 3)) {
      const { html: iHtml } = await fetchPageWithCookies(iUrl, pageUrl).catch(() => ({ html: "" }));
      const r = extractDirectFromHtml(iHtml, workerUrl);
      if (r.length) return jsonResponse({ success: true, ...meta, results: r });
    }

    return jsonResponse({ success: false, error: "Video not found", source: pageUrl }, 404);
  } catch (err) {
    return jsonResponse({ success: false, error: err.message, source: pageUrl }, 502);
  }
}

// ─── Metadados ────────────────────────────────────────────────────────────────

function getSiteOrigin(pageUrl) {
  const u = new URL(pageUrl);
  return u.origin;
}

function extractMeta(html, pageUrl, siteOrigin) {
  const title  = html.match(/<title>([^<]+)<\/title>/i)?.[1]
                    ?.replace(/\s*[–|\-]+\s*(AnimeQ|AnimePlay|AnimesOnline|AnimeS).*$/i, "")
                    ?.trim() || "";
  const postId = extractPostId(html) || "";
  const type   = extractDooplayType(html, pageUrl);
  return { title, site: siteOrigin, postId, type };
}

// ─── DooPlay AJAX ─────────────────────────────────────────────────────────────

async function tryDooplayAjax(html, pageUrl, siteOrigin, cookies, workerUrl) {
  const ajaxUrl    = dec(html.match(/["']ajaxurl["']\s*:\s*["']([^"']+)["']/i)?.[1]
                      || html.match(/["']url["']\s*:\s*["']([^"']+admin-ajax[^"']+)["']/i)?.[1]
                      || "") || null;
  const postId     = extractPostId(html);
  const nonce      = extractNonce(html);
  const type       = extractDooplayType(html, pageUrl);

  if (!postId || !nonce) return null;

  // Resolve URL do AJAX (pode ser relativa)
  const ajaxFullUrl = ajaxUrl
    ? (ajaxUrl.startsWith("http") ? ajaxUrl : `${siteOrigin}${ajaxUrl}`)
    : `${siteOrigin}/wp-admin/admin-ajax.php`;

  const cookieHeader = buildCookieHeader(cookies);
  const numes        = ["1", "2", "3", "4", "trailer"];
  const actions      = ["dooplay_ajax_player", "dooplay_player_ajax", "doo_player_ajax", "TWP"];
  const results      = [];

  for (const action of actions) {
    for (const nume of numes) {
      try {
        const body = new URLSearchParams({ action, postID: postId, type, nume, nonce });

        const headers = {
          "Content-Type":     "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent":       UA,
          "Accept":           "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
          "Referer":          pageUrl,
          "Origin":           siteOrigin,
        };
        if (cookieHeader) headers["Cookie"] = cookieHeader;

        const res  = await fetch(ajaxFullUrl, { method: "POST", headers, body: body.toString() });
        const text = await res.text();

        if (!text || text.trim() === "0" || text.trim() === "-1" || text.trim() === "false") continue;

        let data;
        try { data = JSON.parse(text); } catch {
          const extracted = await parseEmbedForResults(text, pageUrl, siteOrigin, workerUrl);
          if (extracted.length) return extracted;
          continue;
        }

        const embedHtml = data.embed || data.data || data.html || data.result || "";
        if (embedHtml) {
          const parsed = await parseEmbedForResults(embedHtml, pageUrl, siteOrigin, workerUrl);
          results.push(...parsed);
        }

        if (Array.isArray(data.sources)) {
          data.sources.forEach((s, i) => results.push(
            buildResult(s.file || s.url, s.label || `Opção ${i+1}`, s.type, workerUrl)
          ));
        }

        if (results.length) return results;
      } catch {}
    }
    if (results.length) break;
  }

  return results.length ? results : null;
}

// ─── WP REST API ──────────────────────────────────────────────────────────────

async function tryWpRestApi(html, pageUrl, siteOrigin, cookies, workerUrl) {
  const playerApi = html.match(/"player_api"\s*:\s*"([^"]+)"/i)?.[1];
  const postId    = extractPostId(html);
  const nonce     = extractNonce(html);
  const type      = extractDooplayType(html, pageUrl);

  if (!postId || !nonce || !playerApi) return null;

  const cookieHeader = buildCookieHeader(cookies);
  const results      = [];

  for (const source of ["1", "2", "3"]) {
    try {
      const apiUrl = `${playerApi.replace(/\/$/, "")}/${postId}?type=${type}&source=${source}&nonce=${nonce}`;
      const headers = {
        "User-Agent":  UA,
        "Accept":      "application/json",
        "Referer":     pageUrl,
        "Origin":      siteOrigin,
        "X-WP-Nonce": nonce,
      };
      if (cookieHeader) headers["Cookie"] = cookieHeader;

      const res  = await fetch(apiUrl, { headers });
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      if (!data) continue;

      const url = data.embed_url || data.url || data.file || "";
      if (!url) continue;

      const vType = url.includes(".m3u8") ? "hls" : url.includes(".mp4") ? "mp4" : "iframe";
      results.push(buildResult(url, `Opção ${source}`, vType, workerUrl));
    } catch {}
  }

  return results.length ? results : null;
}

// ─── Parse do embed ───────────────────────────────────────────────────────────

async function parseEmbedForResults(embedHtml, referer, siteOrigin, workerUrl) {
  const results = [];

  const mp4s = [...embedHtml.matchAll(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/gi)];
  for (const [url] of mp4s)
    if (!results.find(r => r.url === url))
      results.push(buildResult(url, `Opção ${results.length + 1} (MP4)`, "mp4", workerUrl));

  const m3u8s = [...embedHtml.matchAll(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/gi)];
  for (const [, url] of m3u8s)
    if (!results.find(r => r.url === url))
      results.push(buildResult(url, `Opção ${results.length + 1} (HLS)`, "hls", workerUrl));

  if (results.length) return results;

  const iframes = [...embedHtml.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)];
  for (const [, src] of iframes.slice(0, 3)) {
    const iUrl = src.startsWith("http") ? src : src.startsWith("//") ? "https:" + src : siteOrigin + src;
    try {
      const { html: iHtml } = await fetchPageWithCookies(iUrl, referer);
      const mp4  = iHtml.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
      const m3u8 = iHtml.match(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/i);
      if (mp4)       results.push(buildResult(mp4[0], `Opção ${results.length + 1} (MP4)`, "mp4", workerUrl));
      else if (m3u8) results.push(buildResult(m3u8[1], `Opção ${results.length + 1} (HLS)`, "hls", workerUrl));
      else           results.push(buildResult(iUrl, `Opção ${results.length + 1}`, "iframe", workerUrl));
    } catch {
      results.push(buildResult(iUrl, `Opção ${results.length + 1}`, "iframe", workerUrl));
    }
  }

  return results;
}

// ─── URLs diretas no HTML ─────────────────────────────────────────────────────

function extractDirectFromHtml(html, workerUrl) {
  const results = [];

  const mp4s = [...html.matchAll(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/gi)];
  for (const [url] of mp4s)
    if (!results.find(r => r.url === url))
      results.push(buildResult(url, `Opção ${results.length + 1} (MP4)`, "mp4", workerUrl));

  const m3u8s = [...html.matchAll(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/gi)];
  for (const [, url] of m3u8s)
    if (!results.find(r => r.url === url))
      results.push(buildResult(url, `Opção ${results.length + 1} (HLS)`, "hls", workerUrl));

  return results;
}

// ─── AJAX Debug ───────────────────────────────────────────────────────────────

async function handleAjaxDebug(pageUrl, workerUrl) {
  try {
    const { html, cookies } = await fetchPageWithCookies(pageUrl);
    const siteOrigin        = getSiteOrigin(pageUrl);
    const postId            = extractPostId(html);
    const nonce             = extractNonce(html);
    const type              = extractDooplayType(html, pageUrl);
    const cookieHeader      = buildCookieHeader(cookies);

    const ajaxUrl = (() => {
      const m = html.match(/["']ajaxurl["']\s*:\s*["']([^"']+)["']/i)
             || html.match(/["']url["']\s*:\s*["']([^"']+admin-ajax[^"']+)["']/i);
      const raw = dec(m?.[1] || "");
      return raw ? (raw.startsWith("http") ? raw : `${siteOrigin}${raw}`)
                 : `${siteOrigin}/wp-admin/admin-ajax.php`;
    })();

    const actions = ["dooplay_ajax_player", "dooplay_player_ajax", "doo_player_ajax", "TWP", "dooprime_ajax_player"];
    const numes   = ["1", "2"];
    const results = [];

    for (const action of actions) {
      for (const nume of numes) {
        const body = new URLSearchParams({ action, postID: postId, type, nume, nonce });
        const headers = {
          "Content-Type":     "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent":       UA,
          "Accept":           "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
          "Referer":          pageUrl,
          "Origin":           siteOrigin,
        };
        if (cookieHeader) headers["Cookie"] = cookieHeader;

        try {
          const res  = await fetch(ajaxUrl, { method: "POST", headers, body: body.toString() });
          const text = await res.text();
          results.push({ action, nume, status: res.status, response: text.slice(0, 500) });
          if (text && text !== "0" && text !== "-1" && text !== "false") break;
        } catch (e) {
          results.push({ action, nume, error: e.message });
        }
      }
    }

    return jsonResponse({
      url: pageUrl, postId, nonce, type, ajaxUrl,
      cookiesSent: cookieHeader?.split(";").map(c => c.split("=")[0].trim()),
      cookiesRcvd: Object.keys(cookies),
      results,
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 502);
  }
}

// ─── Debug ────────────────────────────────────────────────────────────────────

async function handleDebug(pageUrl, workerUrl) {
  try {
    const { html, cookies } = await fetchPageWithCookies(pageUrl);
    const siteOrigin        = getSiteOrigin(pageUrl);
    return jsonResponse({
      url:          pageUrl,
      html_length:  html.length,
      post_id:      extractPostId(html),
      nonce:        extractNonce(html),
      type:         extractDooplayType(html, pageUrl),
      player_api:   html.match(/"player_api"\s*:\s*"([^"]+)"/i)?.[1] || null,
      play_method:  html.match(/"play_method"\s*:\s*"([^"]+)"/i)?.[1] || null,
      ajax_url:     html.match(/["']url["']\s*:\s*["']([^"']+admin-ajax[^"']+)["']/i)?.[1] || null,
      cookies_rcvd: Object.keys(cookies),
      iframes:      extractAllIframes(html, siteOrigin).slice(0, 5),
      direct:       extractDirectFromHtml(html, workerUrl),
      html_start:   html.slice(0, 2000),
    });
  } catch (err) {
    return jsonResponse({ error: err.message, url: pageUrl }, 502);
  }
}

// ─── Proxy de vídeo ───────────────────────────────────────────────────────────

async function handleProxy(target, request) {
  const siteOrigin = (() => {
    try { return new URL(target).origin; } catch { return "https://animeq.net"; }
  })();

  const headers = {
    "User-Agent": UA,
    "Referer":    siteOrigin + "/",
    "Origin":     siteOrigin,
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

function extractPostId(html) {
  // data-post='56511' ou data-postid='56434'
  return html.match(/data-post(?:id)?\s*=\s*["']?(\d+)/i)?.[1]
      || html.match(/["']post_?[Ii][Dd]["']\s*:\s*["']?(\d+)/i)?.[1]
      || html.match(/postID\s*[=:]\s*["']?(\d+)/i)?.[1];
}

function extractNonce(html) {
  // Pega o primeiro nonce encontrado nos objetos dtAjax/dtGonza
  const all = [...html.matchAll(/["']nonce["']\s*:\s*["']([a-f0-9]{8,12})["']/gi)];
  return all[0]?.[1] || null;
}

function extractDooplayType(html, pageUrl) {
  // Extrai data-type direto dos elementos do player (mais confiável)
  // Valores conhecidos: "movie", "tv", "serie"
  const m = html.match(/class=['"]dooplay_player_option['"][^>]*data-type=['"]([^'"]+)['"]/i)
         || html.match(/data-type=['"]([^'"]+)['"][^>]*data-post=['"][0-9]+['"]/i);
  if (m) return m[1];

  // Fallback por URL
  if (pageUrl.includes("/filme/") || pageUrl.includes("/movie/")) return "movie";
  return "tv"; // padrão para episódios
}

function extractAllIframes(html, siteOrigin) {
  return [...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)]
    .map(([, s]) => s.startsWith("http") ? s : s.startsWith("//") ? "https:" + s : siteOrigin + s);
}

function buildResult(url, label, type, workerUrl) {
  const vType    = type || (url.includes(".m3u8") ? "hls" : "mp4");
  const proxyUrl = `${workerUrl.origin}/?proxy=${encodeURIComponent(url)}`;
  return { label, type: vType, url, option: null, isBlogger: false, resolveUrl: null, proxyUrl };
}

function buildCookieHeader(cookies) {
  const entries = Object.entries(cookies).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
  return entries.length ? entries.join("; ") : null;
}

function dec(s) {
  if (!s) return s;
  return s.replace(/&amp;/g, "&").replace(/&#038;/g, "&").replace(/\\u0026/g, "&");
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchPageWithCookies(url, referer) {
  if (!referer) {
    try { referer = new URL(url).origin + "/"; } catch { referer = url; }
  }
  const res = await fetch(url, {
    headers: {
      "User-Agent":                UA,
      "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language":           "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "Referer":                   referer,
      "Upgrade-Insecure-Requests": "1",
      "sec-ch-ua":                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "sec-ch-ua-mobile":          "?0",
      "sec-ch-ua-platform":        '"Windows"',
      "sec-fetch-dest":            "document",
      "sec-fetch-mode":            "navigate",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} → ${url}`);

  const cookies = {};
  for (const [key, val] of res.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") {
      const name  = val.split("=")[0].trim();
      const value = val.split("=")[1]?.split(";")[0]?.trim() || "";
      if (name) cookies[name] = value;
    }
  }

  return { html: await res.text(), cookies };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}
