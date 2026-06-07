/**
 * zarumi-drivea — Extrator AnimésDrive
 * Cloudflare Worker
 *
 * GET /?url=https://animesdrive.online/episodio/SLUG-episodio-01
 * Retorna JSON: { success, url, type, source }
 *
 * GET /proxy?url=https://...  → faz proxy transparente do conteúdo
 */

const SITE_ORIGIN  = "https://animesdrive.online";
const SITE_REFERER = "https://animesdrive.online/";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    if (path === "/proxy") return handleProxy(url.searchParams);
    return handleExtract(url.searchParams);
  },
};

// ─── Extrator principal ───────────────────────────────────────────────────────

async function handleExtract(params) {
  const pageUrl = params.get("url");
  if (!pageUrl) return jsonResponse({ success: false, error: "Missing url" }, 400);

  try {
    const result = await extractVideo(pageUrl);
    if (result) return jsonResponse({ success: true, ...result, source: pageUrl });
    return jsonResponse({ success: false, error: "Video not found", source: pageUrl }, 404);
  } catch (err) {
    return jsonResponse({ success: false, error: err.message, source: pageUrl }, 502);
  }
}

async function extractVideo(pageUrl) {
  const html = await fetchPage(pageUrl, SITE_REFERER);

  // 1. Tenta extrair direto do HTML
  const direct = extractFromHtml(html, SITE_ORIGIN);
  if (direct) return direct;

  // 2. Tenta DooPlay AJAX
  const dooplay = await tryDooplayAjax(html, pageUrl);
  if (dooplay) return dooplay;

  // 3. Segue iframes
  const iframeUrl = extractIframe(html, SITE_ORIGIN);
  if (iframeUrl) {
    const iframeHtml = await fetchPage(iframeUrl, pageUrl);
    const fromIframe = extractFromHtml(iframeHtml, iframeUrl);
    if (fromIframe) return fromIframe;
  }

  return null;
}

// ─── DooPlay AJAX ─────────────────────────────────────────────────────────────

async function tryDooplayAjax(html, referer) {
  const ajaxUrl = extractAjaxUrl(html);
  const postId  = extractPostId(html);
  const nonce   = extractNonce(html);

  if (!ajaxUrl || !postId || !nonce) return null;

  const actions = ["dooplay_ajax_player", "dooplay_player_ajax", "TWP", "doo_player_ajax"];

  for (const action of actions) {
    try {
      const body = new URLSearchParams({
        action,
        postID: postId,
        nonce,
      });

      const res = await fetch(ajaxUrl, {
        method: "POST",
        headers: {
          "Content-Type":  "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent":    UA,
          "Accept":        "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
          "Referer":       referer,
          "Origin":        SITE_ORIGIN,
        },
        body: body.toString(),
      });

      const text = await res.text();
      if (!text || text === "0" || text === "-1") continue;

      // Resposta pode ser JSON ou HTML direto
      let embedHtml = text;
      try {
        const data = JSON.parse(text);
        embedHtml = data.embed || data.data || data.html || data.result || text;
      } catch {}

      if (typeof embedHtml === "string") {
        const result = extractFromHtml(embedHtml, SITE_ORIGIN);
        if (result) return result;

        const embedIframe = extractIframe(embedHtml, SITE_ORIGIN);
        if (embedIframe) {
          const iHtml = await fetchPage(embedIframe, referer);
          const fromI = extractFromHtml(iHtml, embedIframe);
          if (fromI) return fromI;
        }
      }
    } catch {}
  }

  return null;
}

// ─── Extração HTML ────────────────────────────────────────────────────────────

function extractFromHtml(html, base) {
  // source tag mp4
  const sourceTag = html.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)/i);
  if (sourceTag) return { url: decodeEntities(sourceTag[1]), type: "mp4" };

  // file: "..." (JWPlayer / PlayerJS)
  const fileAttr = html.match(/["\s]file\s*:\s*["']([^"']+\.mp4[^"']*)/i);
  if (fileAttr) return { url: decodeEntities(fileAttr[1]), type: "mp4" };

  // "src": "...mp4"
  const jsonSrc = html.match(/"src"\s*:\s*"([^"]+\.mp4[^"]*)"/i);
  if (jsonSrc) return { url: decodeEntities(jsonSrc[1]), type: "mp4" };

  // player.setup / playerjs.setup
  const setup = html.match(/(?:player|playerjs)\.(?:setup|init)\s*\(\s*\{[^}]*?file\s*:\s*["']([^"']+)/i);
  if (setup) return { url: decodeEntities(setup[1]), type: "mp4" };

  // atob encoded
  const b64 = html.match(/atob\s*\(\s*["']([A-Za-z0-9+/=]{20,})["']\s*\)/);
  if (b64) {
    try {
      const decoded = atob(b64[1]);
      const mp4 = decoded.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
      if (mp4) return { url: mp4[0], type: "mp4" };
      const m3u8 = decoded.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
      if (m3u8) return { url: m3u8[0], type: "hls" };
    } catch {}
  }

  // m3u8
  const m3u8 = html.match(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/i);
  if (m3u8) return { url: m3u8[1], type: "hls" };

  // qualquer mp4 no HTML
  const anyMp4 = html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
  if (anyMp4) return { url: anyMp4[0], type: "mp4" };

  return null;
}

function extractIframe(html, base) {
  const m = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (!m) return null;
  const src = m[1];
  if (src.startsWith("http")) return src;
  if (src.startsWith("//")) return "https:" + src;
  return base + src;
}

function extractAjaxUrl(html) {
  const m = html.match(/["']ajaxurl["']\s*:\s*["']([^"']+)["']/i)
         || html.match(/var\s+ajaxurl\s*=\s*["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]) : null;
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

async function handleProxy(params) {
  const target = params.get("url");
  if (!target) return new Response("Missing url", { status: 400 });

  const res = await fetch(target, {
    headers: {
      "User-Agent": UA,
      "Referer":    SITE_REFERER,
      "Origin":     SITE_ORIGIN,
    },
  });

  const headers = new Headers(res.headers);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
  headers.delete("Content-Security-Policy");
  headers.delete("X-Frame-Options");

  return new Response(res.body, { status: res.status, headers });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchPage(url, referer = SITE_REFERER) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":                UA,
      "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language":           "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept-Encoding":           "gzip, deflate, br",
      "Referer":                   referer,
      "Origin":                    SITE_ORIGIN,
      "Upgrade-Insecure-Requests": "1",
      "Cache-Control":             "max-age=0",
      "Connection":                "keep-alive",
      "sec-ch-ua":                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "sec-ch-ua-mobile":          "?0",
      "sec-ch-ua-platform":        '"Windows"',
      "sec-fetch-dest":            "document",
      "sec-fetch-mode":            "navigate",
      "sec-fetch-site":            "same-origin",
      "sec-fetch-user":            "?1",
      "DNT":                       "1",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} → ${url}`);
  const text = await res.text();
  if (text.includes("error code:") || text.includes("Checking your browser") || text.includes("cf-browser-verification")) {
    throw new Error(`Cloudflare bloqueou: ${text.slice(0, 100)}`);
  }
  return text;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&")
    .replace(/\\u0026/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}
