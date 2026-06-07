/**
 * zarumi-at — AniTube extractor + HLS proxy
 * Cloudflare Worker
 *
 * GET /?url=https://www.anitube.zip/HASH/
 *   → Extrai m3u8 e retorna playlist com segmentos reescritos
 *
 * GET /?url=https://cdn-s01.mywallpaper-4k-image.net/stream/.../seg-N.webp
 *   → Faz proxy do segmento CDN (mesmo endpoint, dual-purpose)
 */

const ANITUBE_ORIGIN  = "https://www.anitube.zip";
const ANITUBE_REFERER = "https://www.anitube.zip/";
const CDN_HOST        = "mywallpaper-4k-image.net";

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
    const target    = workerUrl.searchParams.get("url");

    if (!target) return jsonResponse({ error: "Use ?url=..." }, 400);

    // Se for URL de segmento CDN → proxy direto
    if (isCdnUrl(target)) {
      return proxySegment(target, request);
    }

    // Se for página do AniTube → extrai m3u8 e reescreve
    return handleAnitubePage(target, workerUrl);
  },
};

// ─── Detecta se é URL do CDN de segmentos ────────────────────────────────────

function isCdnUrl(url) {
  return url.includes(CDN_HOST) || url.includes("/stream/") || /\.(webp|ts|m4s|aac|mp4)$/.test(url);
}

// ─── Scraping da página AniTube ───────────────────────────────────────────────

async function handleAnitubePage(pageUrl, workerUrl) {
  try {
    const m3u8Url = await findM3u8(pageUrl);
    if (!m3u8Url) {
      return jsonResponse({ success: false, error: "HLS stream not found", source: pageUrl }, 404);
    }

    const proxyBase   = `${workerUrl.origin}/?url=`;
    const m3u8Content = await fetchAndRewriteM3u8(m3u8Url, proxyBase);

    return new Response(m3u8Content, {
      status: 200,
      headers: {
        "Content-Type":  "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message, source: pageUrl }, 502);
  }
}

async function findM3u8(pageUrl) {
  const html = await fetchPage(pageUrl);

  // CDN pattern: cdn-s01.mywallpaper-4k-image.net
  const cdn = html.match(/["'](https?:\/\/[^"'<>\s]*mywallpaper[^"'<>\s]*\.m3u8[^"'<>\s]*)["']/i);
  if (cdn) return cdn[1];

  // Qualquer .m3u8
  const any = html.match(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/i);
  if (any) return any[1];

  // file: "..."
  const file = html.match(/file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
  if (file) return file[1];

  // atob
  const b64 = html.match(/atob\s*\(\s*["']([A-Za-z0-9+/=]{20,})["']\s*\)/);
  if (b64) {
    try {
      const d = atob(b64[1]);
      const m = d.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
      if (m) return m[0];
    } catch {}
  }

  // Segue iframes
  const iframes = [...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)];
  for (const [, src] of iframes) {
    const iUrl = src.startsWith("http") ? src : src.startsWith("//") ? "https:" + src : ANITUBE_ORIGIN + src;
    try {
      const iHtml = await fetchPage(iUrl, pageUrl);
      const im3u8 = iHtml.match(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/i);
      if (im3u8) return im3u8[1];
      const ib64 = iHtml.match(/atob\s*\(\s*["']([A-Za-z0-9+/=]{20,})["']\s*\)/);
      if (ib64) {
        try {
          const d = atob(ib64[1]);
          const m = d.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
          if (m) return m[0];
        } catch {}
      }
    } catch {}
  }

  return null;
}

// ─── Reescreve m3u8 ───────────────────────────────────────────────────────────

async function fetchAndRewriteM3u8(m3u8Url, proxyBase) {
  const res = await fetch(m3u8Url, {
    headers: {
      "User-Agent": UA,
      "Referer":    ANITUBE_REFERER,
      "Origin":     ANITUBE_ORIGIN,
    },
  });
  if (!res.ok) throw new Error(`m3u8 HTTP ${res.status}`);

  const text    = await res.text();
  const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);

  return text.replace(/^(?!#)(.+)$/gm, (line) => {
    line = line.trim();
    if (!line) return line;
    const abs = line.startsWith("http") ? line
              : line.startsWith("//")   ? "https:" + line
              : baseUrl + line;
    return `${proxyBase}${encodeURIComponent(abs)}`;
  });
}

// ─── Proxy de segmentos CDN ───────────────────────────────────────────────────

async function proxySegment(target, request) {
  const headers = {
    "User-Agent": UA,
    "Referer":    ANITUBE_REFERER,
    "Origin":     ANITUBE_ORIGIN,
  };

  const range = request.headers.get("Range");
  if (range) headers["Range"] = range;

  const res        = await fetch(target, { headers });
  const resHeaders = new Headers(res.headers);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => resHeaders.set(k, v));
  resHeaders.delete("Content-Security-Policy");
  resHeaders.delete("X-Frame-Options");

  // Sub-playlist m3u8 — reescreve também
  const ct = resHeaders.get("Content-Type") || "";
  if (ct.includes("mpegurl") || target.includes(".m3u8")) {
    const wUrl    = new URL(request.url);
    const pBase   = `${wUrl.origin}/?url=`;
    const baseUrl = target.substring(0, target.lastIndexOf("/") + 1);
    const text    = await res.text();
    const rw = text.replace(/^(?!#)(.+)$/gm, (line) => {
      line = line.trim();
      if (!line) return line;
      const abs = line.startsWith("http") ? line : line.startsWith("//") ? "https:" + line : baseUrl + line;
      return `${pBase}${encodeURIComponent(abs)}`;
    });
    resHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
    return new Response(rw, { status: res.status, headers: resHeaders });
  }

  return new Response(res.body, { status: res.status, headers: resHeaders });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchPage(url, referer = ANITUBE_REFERER) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":                UA,
      "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language":           "pt-BR,pt;q=0.9,en;q=0.8",
      "Referer":                   referer,
      "Upgrade-Insecure-Requests": "1",
      "sec-ch-ua":                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "sec-ch-ua-mobile":          "?0",
      "sec-ch-ua-platform":        '"Windows"',
      "sec-fetch-dest":            "document",
      "sec-fetch-mode":            "navigate",
      "sec-fetch-site":            "same-origin",
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
