/**
 * zarumi-at — Extrator e Proxy HLS do AniTube
 * Cloudflare Worker
 *
 * GET /?url=https://www.anitube.zip/HASH/
 * → Extrai a URL m3u8 e retorna o conteúdo HLS com segmentos reescritos
 *
 * GET /proxy?url=https://...
 * → Proxy genérico de segmentos de vídeo (ts, mp4, m3u8)
 */

const SITE_ORIGIN  = "https://www.anitube.zip";
const SITE_REFERER = "https://www.anitube.zip/";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    if (path === "/proxy") return handleProxy(url.searchParams, request);
    return handleExtract(url.searchParams, url);
  },
};

// ─── Extrator principal ───────────────────────────────────────────────────────

async function handleExtract(params, workerUrl) {
  const pageUrl = params.get("url");
  if (!pageUrl) return jsonResponse({ success: false, error: "Missing url" }, 400);

  try {
    const m3u8Url = await findM3u8(pageUrl);

    if (!m3u8Url) {
      return jsonResponse({ success: false, error: "HLS stream not found", source: pageUrl }, 404);
    }

    // Faz proxy do m3u8, reescrevendo os segmentos para passar pelo /proxy
    const proxyBase = `${workerUrl.origin}/proxy?url=`;
    const m3u8Content = await fetchM3u8(m3u8Url, proxyBase);

    return new Response(m3u8Content, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        ...CORS_HEADERS,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message, source: pageUrl }, 502);
  }
}

// ─── Localiza o m3u8 ─────────────────────────────────────────────────────────

async function findM3u8(pageUrl) {
  const html = await fetchPage(pageUrl);

  // Padrão CDN conhecido: cdn-s01.mywallpaper-4k-image.net
  const cdnM3u8 = html.match(/["'](https?:\/\/[^"'<>\s]*cdn[^"'<>\s]*\.m3u8[^"'<>\s]*)["']/i);
  if (cdnM3u8) return cdnM3u8[1];

  // Qualquer .m3u8 no HTML
  const anyM3u8 = html.match(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/i);
  if (anyM3u8) return anyM3u8[1];

  // atob encoded
  const b64 = html.match(/atob\s*\(\s*["']([A-Za-z0-9+/=]{20,})["']\s*\)/);
  if (b64) {
    try {
      const decoded = atob(b64[1]);
      const m3u8 = decoded.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
      if (m3u8) return m3u8[0];
    } catch {}
  }

  // jwplayer / playerjs setup
  const setup = html.match(/file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
  if (setup) return setup[1];

  // sources JSON array
  const sourcesJson = html.match(/sources\s*:\s*\[([^\]]+)\]/i);
  if (sourcesJson) {
    const m3u8InSources = sourcesJson[1].match(/(https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)/i);
    if (m3u8InSources) return m3u8InSources[1];
  }

  // Segue iframes (AniTube costuma ter player embutido)
  const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (iframeMatch) {
    const iframeUrl = iframeMatch[1].startsWith("http")
      ? iframeMatch[1]
      : iframeMatch[1].startsWith("//")
        ? "https:" + iframeMatch[1]
        : SITE_ORIGIN + iframeMatch[1];

    const iHtml = await fetchPage(iframeUrl, pageUrl);

    const inIframe = iHtml.match(/["'](https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)["']/i);
    if (inIframe) return inIframe[1];

    const b64i = iHtml.match(/atob\s*\(\s*["']([A-Za-z0-9+/=]{20,})["']\s*\)/);
    if (b64i) {
      try {
        const decoded = atob(b64i[1]);
        const m3u8 = decoded.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
        if (m3u8) return m3u8[0];
      } catch {}
    }
  }

  return null;
}

// ─── Proxy HLS ────────────────────────────────────────────────────────────────

async function fetchM3u8(m3u8Url, proxyBase) {
  const res = await fetch(m3u8Url, {
    headers: {
      "User-Agent": UA,
      "Referer":    SITE_REFERER,
      "Origin":     SITE_ORIGIN,
    },
  });
  if (!res.ok) throw new Error(`m3u8 HTTP ${res.status}`);

  const text = await res.text();
  const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);

  // Reescreve URIs de segmentos e sub-playlists para passar pelo /proxy
  return text.replace(/^(?!#)(.+)$/gm, (line) => {
    line = line.trim();
    if (!line) return line;

    let absUrl;
    if (line.startsWith("http")) {
      absUrl = line;
    } else if (line.startsWith("//")) {
      absUrl = "https:" + line;
    } else {
      absUrl = baseUrl + line;
    }

    return `${proxyBase}${encodeURIComponent(absUrl)}`;
  });
}

async function handleProxy(params, request) {
  const target = params.get("url");
  if (!target) return new Response("Missing url", { status: 400 });

  const upstreamHeaders = {
    "User-Agent": UA,
    "Referer":    SITE_REFERER,
    "Origin":     SITE_ORIGIN,
  };

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) upstreamHeaders["Range"] = rangeHeader;

  const res = await fetch(target, { headers: upstreamHeaders });

  const headers = new Headers(res.headers);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
  headers.delete("Content-Security-Policy");
  headers.delete("X-Frame-Options");

  // Se for sub-playlist m3u8, reescreve também
  const ct = headers.get("Content-Type") || "";
  if (ct.includes("mpegurl") || target.includes(".m3u8")) {
    const workerUrl  = new URL(request.url);
    const proxyBase  = `${workerUrl.origin}/proxy?url=`;
    const baseUrl    = target.substring(0, target.lastIndexOf("/") + 1);
    const text       = await res.text();

    const rewritten = text.replace(/^(?!#)(.+)$/gm, (line) => {
      line = line.trim();
      if (!line) return line;
      let absUrl;
      if (line.startsWith("http")) absUrl = line;
      else if (line.startsWith("//")) absUrl = "https:" + line;
      else absUrl = baseUrl + line;
      return `${proxyBase}${encodeURIComponent(absUrl)}`;
    });

    headers.set("Content-Type", "application/vnd.apple.mpegurl");
    return new Response(rewritten, { status: res.status, headers });
  }

  return new Response(res.body, { status: res.status, headers });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchPage(url, referer = SITE_REFERER) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":      UA,
      "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      "Referer":         referer,
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
