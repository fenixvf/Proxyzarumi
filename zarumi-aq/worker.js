/**
 * zarumi-aq — AnimeQ extractor + proxy
 * Cloudflare Worker
 *
 * GET /?url=https://animeq.net/episodio/SLUG-episodio-01
 * GET /?url=https://animeq.net/filme/SLUG/
 * Retorna JSON:
 * { success, title, site, postId, type, results: [{ label, type, url, option, isBlogger, resolveUrl, proxyUrl }] }
 *
 * GET /?proxy=https://aniplay.online/...mp4
 * → Faz proxy do arquivo de vídeo com Referer do AnimeQ
 */

const SITE_ORIGIN  = "https://animeq.net";
const SITE_REFERER = "https://animeq.net/";
const AJAX_URL     = "https://animeq.net/wp-admin/admin-ajax.php";

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
    const debugPath = workerUrl.pathname === "/debug";

    if (proxy)             return handleProxy(proxy, request);
    if (pageUrl && debugPath) return handleDebug(pageUrl, workerUrl);
    if (pageUrl)           return handleExtract(pageUrl, workerUrl);

    return jsonResponse({ error: "Use ?url=PAGE_URL ou ?proxy=VIDEO_URL" }, 400);
  },
};

// ─── Extrator principal ───────────────────────────────────────────────────────

async function handleExtract(pageUrl, workerUrl) {
  try {
    // Busca página e captura cookies da resposta
    const { html, cookies } = await fetchPageWithCookies(pageUrl);
    const meta              = extractMeta(html, pageUrl);

    // 1. Tenta DooPlay AJAX com os cookies da resposta
    const ajaxResults = await tryDooplayAjax(html, pageUrl, cookies, workerUrl);
    if (ajaxResults && ajaxResults.length > 0)
      return jsonResponse({ success: true, ...meta, results: ajaxResults });

    // 2. Tenta WP REST API com nonce
    const restResults = await tryWpRestApi(html, pageUrl, cookies, workerUrl);
    if (restResults && restResults.length > 0)
      return jsonResponse({ success: true, ...meta, results: restResults });

    // 3. Extração direta do HTML
    const direct = extractDirectFromHtml(html, workerUrl);
    if (direct.length > 0)
      return jsonResponse({ success: true, ...meta, results: direct });

    // 4. Segue iframes
    const iframeUrls = extractAllIframes(html);
    for (const iUrl of iframeUrls.slice(0, 3)) {
      const { html: iHtml } = await fetchPageWithCookies(iUrl, pageUrl).catch(() => ({ html: "" }));
      const iDirect = extractDirectFromHtml(iHtml, workerUrl);
      if (iDirect.length > 0)
        return jsonResponse({ success: true, ...meta, results: iDirect });
    }

    return jsonResponse({ success: false, error: "Video not found", source: pageUrl }, 404);
  } catch (err) {
    return jsonResponse({ success: false, error: err.message, source: pageUrl }, 502);
  }
}

// ─── Metadados da página ──────────────────────────────────────────────────────

function extractMeta(html, pageUrl) {
  const title  = html.match(/<title>([^<]+)<\/title>/i)?.[1]
                    ?.replace(/ [–\-|]+ AnimeQ.*/i, "")
                    ?.trim() || "";
  const postId = extractPostId(html) || "";
  const isFilm = pageUrl.includes("/filme/") || pageUrl.includes("/movie/");
  return { title, site: SITE_ORIGIN, postId, type: isFilm ? "movie" : "serie" };
}

// ─── DooPlay AJAX ─────────────────────────────────────────────────────────────

async function tryDooplayAjax(html, pageUrl, cookies, workerUrl) {
  const postId  = extractPostId(html);
  const nonce   = extractNonce(html);
  const isFilm  = pageUrl.includes("/filme/") || pageUrl.includes("/movie/");
  const type    = isFilm ? "movie" : "serie";

  if (!postId || !nonce) return null;

  // Opções de fonte: 1, 2, 3 + trailer
  const numes   = ["1", "2", "3", "4", "trailer"];
  const actions = ["dooplay_ajax_player", "dooplay_player_ajax", "doo_player_ajax", "TWP"];

  const cookieHeader = buildCookieHeader(cookies);
  const results      = [];

  for (const action of actions) {
    for (const nume of numes) {
      try {
        const body = new URLSearchParams({
          action,
          postID: postId,
          type,
          nume,
          nonce,
        });

        const headers = {
          "Content-Type":     "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent":       UA,
          "Accept":           "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
          "Referer":          pageUrl,
          "Origin":           SITE_ORIGIN,
        };
        if (cookieHeader) headers["Cookie"] = cookieHeader;

        const res  = await fetch(AJAX_URL, { method: "POST", headers, body: body.toString() });
        const text = await res.text();

        if (!text || text === "0" || text === "-1" || text === "false") continue;

        let data;
        try { data = JSON.parse(text); } catch {
          // Resposta pode ser HTML puro
          const extracted = await parseEmbedForResults(text, pageUrl, workerUrl);
          if (extracted.length > 0) return extracted;
          continue;
        }

        const embedHtml = data.embed || data.data || data.html || data.result || "";
        if (embedHtml) {
          const parsed = await parseEmbedForResults(embedHtml, pageUrl, workerUrl);
          results.push(...parsed);
        }

        if (Array.isArray(data.sources)) {
          data.sources.forEach((s, i) =>
            results.push(buildResult(s.file || s.url, s.label || `Opção ${i+1}`, s.type, workerUrl)));
        }

        if (results.length > 0) return results;
      } catch {}
    }
    if (results.length > 0) break;
  }

  return results.length ? results : null;
}

// ─── WP REST API (wp_json mode) ───────────────────────────────────────────────

async function tryWpRestApi(html, pageUrl, cookies, workerUrl) {
  const playerApi = html.match(/"player_api"\s*:\s*"([^"]+)"/i)?.[1];
  const postId    = extractPostId(html);
  const nonce     = extractNonce(html);  // dtGonza.nonce é o REST nonce
  const isFilm    = pageUrl.includes("/filme/") || pageUrl.includes("/movie/");
  const type      = isFilm ? "movie" : "serie";

  if (!postId || !nonce || !playerApi) return null;

  const cookieHeader = buildCookieHeader(cookies);
  const results      = [];

  for (const source of ["1", "2", "3"]) {
    try {
      const apiUrl = `${playerApi.replace(/\/$/, "")}/${postId}?type=${type}&source=${source}&nonce=${nonce}`;
      const headers = {
        "User-Agent":   UA,
        "Accept":       "application/json",
        "Referer":      pageUrl,
        "Origin":       SITE_ORIGIN,
        "X-WP-Nonce":  nonce,
      };
      if (cookieHeader) headers["Cookie"] = cookieHeader;

      const res  = await fetch(apiUrl, { headers });
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      if (!data) continue;

      // Resposta DooPlay v2: { embed_url, type, ... }
      const url = data.embed_url || data.url || data.file || "";
      if (!url) continue;

      const vType = url.includes(".m3u8") ? "hls" : url.includes(".mp4") ? "mp4" : "iframe";
      results.push(buildResult(url, `Opção ${source}`, vType, workerUrl));
    } catch {}
  }

  return results.length ? results : null;
}

// ─── Parse do embed HTML ──────────────────────────────────────────────────────

async function parseEmbedForResults(embedHtml, referer, workerUrl) {
  const results = [];

  const mp4s = [...embedHtml.matchAll(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/gi)];
  for (const [url] of mp4s)
    if (!results.find(r => r.url === url))
      results.push(buildResult(url, `Opção ${results.length + 1} (MP4 Direto)`, "mp4", workerUrl));

  const m3u8s = [...embedHtml.matchAll(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/gi)];
  for (const [, url] of m3u8s)
    if (!results.find(r => r.url === url))
      results.push(buildResult(url, `Opção ${results.length + 1} (HLS)`, "hls", workerUrl));

  const iframes = [...embedHtml.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)];
  for (const [, src] of iframes.slice(0, 3)) {
    const iUrl = src.startsWith("http") ? src : src.startsWith("//") ? "https:" + src : SITE_ORIGIN + src;
    if (results.find(r => r.url === iUrl)) continue;
    try {
      const { html: iHtml } = await fetchPageWithCookies(iUrl, referer);
      const mp4  = iHtml.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
      const m3u8 = iHtml.match(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/i);
      if (mp4)        results.push(buildResult(mp4[0], `Opção ${results.length + 1} (MP4)`, "mp4", workerUrl));
      else if (m3u8)  results.push(buildResult(m3u8[1], `Opção ${results.length + 1} (HLS)`, "hls", workerUrl));
      else            results.push(buildResult(iUrl, `Opção ${results.length + 1}`, "iframe", workerUrl));
    } catch {
      results.push(buildResult(iUrl, `Opção ${results.length + 1}`, "iframe", workerUrl));
    }
  }

  return results;
}

// ─── Extração direta do HTML da página ───────────────────────────────────────

function extractDirectFromHtml(html, workerUrl) {
  const results = [];

  const mp4s = [...html.matchAll(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/gi)];
  for (const [url] of mp4s)
    if (!results.find(r => r.url === url))
      results.push(buildResult(url, `Opção ${results.length + 1} (MP4 Direto)`, "mp4", workerUrl));

  const m3u8s = [...html.matchAll(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/gi)];
  for (const [, url] of m3u8s)
    if (!results.find(r => r.url === url))
      results.push(buildResult(url, `Opção ${results.length + 1} (HLS)`, "hls", workerUrl));

  return results;
}

// ─── Debug ────────────────────────────────────────────────────────────────────

async function handleDebug(pageUrl, workerUrl) {
  try {
    const { html, cookies } = await fetchPageWithCookies(pageUrl);
    return jsonResponse({
      url:         pageUrl,
      html_length: html.length,
      post_id:     extractPostId(html),
      nonce:       extractNonce(html),
      player_api:  html.match(/"player_api"\s*:\s*"([^"]+)"/i)?.[1] || null,
      play_method: html.match(/"play_method"\s*:\s*"([^"]+)"/i)?.[1] || null,
      cookies_received: Object.keys(cookies),
      iframes:     extractAllIframes(html).slice(0, 5),
      direct:      extractDirectFromHtml(html, workerUrl),
      html_start:  html.slice(0, 3000),
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildResult(url, label, type, workerUrl) {
  const vType    = type || (url.includes(".m3u8") ? "hls" : "mp4");
  const proxyUrl = `${workerUrl.origin}/?proxy=${encodeURIComponent(url)}`;
  return { label, type: vType, url, option: null, isBlogger: false, resolveUrl: null, proxyUrl };
}

function extractAllIframes(html) {
  return [...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)]
    .map(([, s]) => s.startsWith("http") ? s : s.startsWith("//") ? "https:" + s : SITE_ORIGIN + s);
}

function extractPostId(html) {
  return html.match(/data-post(?:-id)?\s*=\s*["']?(\d+)/i)?.[1]
      || html.match(/["']post_?[Ii][Dd]["']\s*:\s*["']?(\d+)/i)?.[1]
      || html.match(/postID\s*[=:]\s*["']?(\d+)/i)?.[1];
}

function extractNonce(html) {
  // Prefere o nonce do dtGonza (REST nonce) ou dtAjax
  const all = [...html.matchAll(/["']nonce["']\s*:\s*["']([a-f0-9]{8,12})["']/gi)];
  return all[0]?.[1] || null;
}

function buildCookieHeader(cookies) {
  const entries = Object.entries(cookies)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`);
  if (entries.length === 0) return null;
  return entries.join("; ");
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchPageWithCookies(url, referer = SITE_REFERER) {
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
      "sec-fetch-site":            referer.includes(url.split("/")[2]) ? "same-origin" : "cross-site",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} → ${url}`);

  // Captura cookies da resposta para usar em chamadas subsequentes
  const cookies = {};
  for (const [key, val] of res.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") {
      const name = val.split("=")[0].trim();
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
