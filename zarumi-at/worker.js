/**
 * zarumi-at — AniTube extractor + HLS proxy
 * Cloudflare Worker
 *
 * GET /?url=https://www.anitube.zip/HASH/
 *   → Extrai m3u8 (via api.anivideo.net ?d= param) e retorna playlist reescrita
 *
 * GET /?url=https://cdn-s01.mywallpaper-4k-image.net/stream/.../seg-N.webp
 *   → Proxy do segmento CDN (mesmo endpoint, dual-purpose)
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

    // URLs de segmento CDN → proxy direto
    if (isCdnUrl(target)) {
      return proxySegment(target, request);
    }

    // Página do AniTube → extrai m3u8 e serve playlist reescrita
    return handleAnitubePage(target, workerUrl);
  },
};

// ─── Detecta URL de segmento CDN ─────────────────────────────────────────────

function isCdnUrl(url) {
  return (
    url.includes(CDN_HOST) ||
    /\.(ts|m4s|aac|webp)(\?|$)/.test(url) ||
    (url.includes("/stream/") && !url.includes("anitube.zip"))
  );
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
        "Content-Type":    "application/vnd.apple.mpegurl",
        "Cache-Control":   "no-cache",
        "x-proxied-url":   m3u8Url,
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message, source: pageUrl }, 502);
  }
}

async function findM3u8(pageUrl) {
  const html = await fetchPage(pageUrl);

  // ── Padrão principal: api.anivideo.net/videohls.php?d=M3U8_URL ──
  // <iframe src="https://api.anivideo.net/videohls.php?d=https://cdn-s01...m3u8&nocache...">
  const anivideoMatch = html.match(
    /api\.anivideo\.net\/videohls\.php\?d=(https?:\/\/[^&"'\s]+\.m3u8[^&"'\s]*)/i
  );
  if (anivideoMatch) return decodeURIComponent(anivideoMatch[1]);

  // ── Fallback: qualquer .m3u8 do CDN no HTML ──
  const cdnM3u8 = html.match(
    /["'](https?:\/\/[^"'<>\s]*cdn[^"'<>\s]*\.m3u8[^"'<>\s]*)["']/i
  );
  if (cdnM3u8) return cdnM3u8[1];

  // ── Fallback: qualquer .m3u8 ──
  const anyM3u8 = html.match(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/i);
  if (anyM3u8) return anyM3u8[1];

  // ── Fallback: atob ──
  const b64 = html.match(/atob\s*\(\s*["']([A-Za-z0-9+/=]{20,})["']\s*\)/);
  if (b64) {
    try {
      const decoded = atob(b64[1]);
      const m = decoded.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
      if (m) return m[0];
    } catch {}
  }

  // ── Fallback: file: "..." ──
  const fileProp = html.match(/file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
  if (fileProp) return fileProp[1];

  // ── Fallback: segue iframes ──
  const iframes = [...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)];
  for (const [, src] of iframes) {
    // Extrai ?d= de qualquer iframe
    const dParam = src.match(/[?&]d=(https?:\/\/[^&"'\s]+\.m3u8[^&"'\s]*)/i);
    if (dParam) return decodeURIComponent(dParam[1]);

    // Tenta carregar o iframe para buscar m3u8
    try {
      const iUrl = src.startsWith("http") ? src
                 : src.startsWith("//")   ? "https:" + src
                 : ANITUBE_ORIGIN + src;
      const iHtml = await fetchPage(iUrl, pageUrl);
      const im3u8 = iHtml.match(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/i);
      if (im3u8) return im3u8[1];
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

// ─── Proxy de segmentos ───────────────────────────────────────────────────────

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
      const abs = line.startsWith("http") ? line
                : line.startsWith("//")   ? "https:" + line
                : baseUrl + line;
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
