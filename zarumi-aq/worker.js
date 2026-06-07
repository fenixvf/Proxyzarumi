/**
 * zarumi-aq — Extrator AnimeQ
 * Cloudflare Worker
 *
 * GET /?url=https://animeq.net/episodio/SLUG-episodio-01
 * GET /?url=https://animeq.net/filme/SLUG/
 * Retorna JSON: { success, url, type, source }
 *
 * GET /proxy?url=https://... → proxy transparente
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

    const url  = new URL(request.url);
    if (url.pathname === "/proxy") return handleProxy(url.searchParams, request);
    return handleExtract(url.searchParams);
  },
};

// ─── Extrator principal ───────────────────────────────────────────────────────

async function handleExtract(params) {
  const pageUrl = params.get("url");
  if (!pageUrl) return jsonResponse({ success: false, error: "Missing ?url=" }, 400);

  try {
    const result = await extractVideo(pageUrl);
    if (result) return jsonResponse({ success: true, ...result, source: pageUrl });
    return jsonResponse({ success: false, error: "Video not found", source: pageUrl }, 404);
  } catch (err) {
    return jsonResponse({ success: false, error: err.message, source: pageUrl }, 502);
  }
}

async function extractVideo(pageUrl) {
  const html = await fetchPage(pageUrl);

  // 1. Direto no HTML
  const direct = extractFromHtml(html, SITE_ORIGIN);
  if (direct) return direct;

  // 2. DooPlay AJAX
  const dooplay = await tryDooplayAjax(html, pageUrl);
  if (dooplay) return dooplay;

  // 3. Iframe
  const iframeUrl = extractIframe(html, SITE_ORIGIN);
  if (iframeUrl && iframeUrl !== pageUrl) {
    const iHtml = await fetchPage(iframeUrl, pageUrl);
    const fromI = extractFromHtml(iHtml, iframeUrl);
    if (fromI) return fromI;

    // Iframe dentro do iframe
    const iframeUrl2 = extractIframe(iHtml, iframeUrl);
    if (iframeUrl2 && iframeUrl2 !== iframeUrl) {
      const iHtml2 = await fetchPage(iframeUrl2, iframeUrl);
      const fromI2 = extractFromHtml(iHtml2, iframeUrl2);
      if (fromI2) return fromI2;
    }
  }

  return null;
}

// ─── DooPlay AJAX ─────────────────────────────────────────────────────────────

async function tryDooplayAjax(html, referer) {
  const ajaxUrl = extractAjaxUrl(html);
  const postId  = extractPostId(html);
  const nonce   = extractNonce(html);
  if (!ajaxUrl || !postId || !nonce) return null;

  for (const action of ["dooplay_ajax_player", "dooplay_player_ajax", "TWP", "doo_player_ajax"]) {
    try {
      const body = new URLSearchParams({ action, postID: postId, nonce });
      const res  = await fetch(ajaxUrl, {
        method: "POST",
        headers: {
          "Content-Type":     "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent":       UA,
          "Accept":           "application/json, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
          "Referer":          referer,
          "Origin":           SITE_ORIGIN,
        },
        body: body.toString(),
      });
      const text = await res.text();
      if (!text || text === "0" || text === "-1") continue;

      let embedHtml = text;
      try { const d = JSON.parse(text); embedHtml = d.embed || d.data || d.html || d.result || text; } catch {}

      const result = extractFromHtml(embedHtml, SITE_ORIGIN);
      if (result) return result;

      const iUrl = extractIframe(embedHtml, SITE_ORIGIN);
      if (iUrl) {
        const iH = await fetchPage(iUrl, referer);
        const r  = extractFromHtml(iH, iUrl);
        if (r) return r;
      }
    } catch {}
  }
  return null;
}

// ─── Extração HTML ────────────────────────────────────────────────────────────

function extractFromHtml(html, base) {
  const s = html.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)/i);
  if (s) return { url: dec(s[1]), type: "mp4" };
  const f = html.match(/["\s,({]file\s*:\s*["']([^"']+\.mp4[^"']*)/i);
  if (f) return { url: dec(f[1]), type: "mp4" };
  const j = html.match(/"(?:src|file|url)"\s*:\s*"([^"]+\.mp4[^"]*)"/i);
  if (j) return { url: dec(j[1]), type: "mp4" };
  const p = html.match(/(?:player|playerjs)\.(?:setup|init)\s*\(\s*\{[^}]*?file\s*:\s*["']([^"']+)/i);
  if (p) return { url: dec(p[1]), type: "mp4" };
  const b = html.match(/atob\s*\(\s*["']([A-Za-z0-9+/=]{20,})["']\s*\)/);
  if (b) {
    try {
      const d = atob(b[1]);
      const m = d.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
      if (m) return { url: m[0], type: "mp4" };
      const h = d.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
      if (h) return { url: h[0], type: "hls" };
    } catch {}
  }
  const h = html.match(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/i);
  if (h) return { url: h[1], type: "hls" };
  const any = html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
  if (any) return { url: any[0], type: "mp4" };
  return null;
}

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

// ─── Proxy ────────────────────────────────────────────────────────────────────

async function handleProxy(params, request) {
  const target = params.get("url");
  if (!target) return new Response("Missing url", { status: 400 });

  const headers = { "User-Agent": UA, "Referer": SITE_REFERER, "Origin": SITE_ORIGIN };
  const range   = request.headers.get("Range");
  if (range) headers["Range"] = range;

  const res = await fetch(target, { headers });
  const resHeaders = new Headers(res.headers);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => resHeaders.set(k, v));
  resHeaders.delete("Content-Security-Policy");
  resHeaders.delete("X-Frame-Options");
  return new Response(res.body, { status: res.status, headers: resHeaders });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  return s.replace(/&amp;/g, "&").replace(/&#038;/g, "&").replace(/\\u0026/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}
