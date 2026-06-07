/**
 * Zarumi Proxy Worker — Service Worker format
 * Compatível com o editor padrão do Cloudflare Dashboard
 */

const ALLOWED_ORIGINS = [
  "https://zarumi.com",
  "https://www.zarumi.com",
  "http://localhost:3000",
];

const SOURCE_BASE = "https://animesdrive.online/episodio";
const CACHE_TTL   = 60 * 60 * 6;
const MAX_RETRIES = 3;

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method === "OPTIONS") return corsResponse(null, 204);

  const origin = request.headers.get("Origin") || "";
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return corsResponse(JSON.stringify({ error: "Origin not allowed" }), 403);
  }

  const url  = new URL(request.url);
  const path = url.pathname;

  if (path === "/video")       return handleVideo(url.searchParams);
  if (path === "/slug")        return handleSlug(url.searchParams);
  if (path === "/cache/clear") return handleCacheClear(url.searchParams);

  return corsResponse(JSON.stringify({ error: "Not found" }), 404);
}

async function handleVideo(params) {
  const slug = params.get("slug");
  const ep   = params.get("ep");
  const type = params.get("type") || "serie";
  const dub  = params.get("dub") === "true";

  if (!slug) return corsResponse(JSON.stringify({ error: "Missing slug" }), 400);

  const cacheKey = `v1:${slug}:${ep ?? "none"}:${type}:${dub ? "dub" : "leg"}`;

  const cached = await kvGet(cacheKey);
  if (cached) return corsResponse(JSON.stringify({ ...cached, cached: true }), 200);

  const slugVariants = buildSlugVariants(slug, ep, type, dub);

  let lastError = null;
  for (let i = 0; i < slugVariants.length && i < MAX_RETRIES; i++) {
    const { sourceUrl, label } = slugVariants[i];
    try {
      const mp4Url = await extractVideoUrl(sourceUrl);
      if (mp4Url) {
        const result = { url: mp4Url, source: sourceUrl, attempt: i + 1, label };
        await kvSet(cacheKey, result, CACHE_TTL);
        return corsResponse(JSON.stringify(result), 200);
      }
    } catch (err) {
      lastError = err.message;
    }
  }

  return corsResponse(JSON.stringify({
    error: "Video not found after all retries",
    tried: slugVariants.map(v => v.sourceUrl),
    detail: lastError,
  }), 404);
}

async function handleSlug(params) {
  const title = params.get("title");
  const ep    = params.get("ep");
  const type  = params.get("type") || "serie";
  const dub   = params.get("dub") === "true";

  if (!title) return corsResponse(JSON.stringify({ error: "Missing title" }), 400);

  const slug     = toSlug(title);
  const variants = buildSlugVariants(slug, ep, type, dub);

  return corsResponse(JSON.stringify({ slug, variants }), 200);
}

async function handleCacheClear(params) {
  const slug = params.get("slug");
  const ep   = params.get("ep");
  const type = params.get("type") || "serie";
  const dub  = params.get("dub") === "true";

  if (!slug) return corsResponse(JSON.stringify({ error: "Missing slug" }), 400);

  const cacheKey = `v1:${slug}:${ep ?? "none"}:${type}:${dub ? "dub" : "leg"}`;
  await kvDelete(cacheKey);

  return corsResponse(JSON.stringify({ cleared: cacheKey }), 200);
}

function buildSlugVariants(slug, ep, type, dub) {
  if (type !== "serie") {
    return [
      { label: "padrao",    sourceUrl: `${SOURCE_BASE}/${slug}` },
      { label: "com-filme", sourceUrl: `${SOURCE_BASE}/${slug}-filme` },
      { label: "com-ova",   sourceUrl: `${SOURCE_BASE}/${slug}-ova` },
    ];
  }

  const dubSuffix = dub ? "-dublado" : "";
  const ep2d = String(ep).padStart(2, "0");
  const ep1d = String(ep);

  return [
    { label: "padrao",   sourceUrl: `${SOURCE_BASE}/${slug}${dubSuffix}-episodio-${ep2d}` },
    { label: "sem-zero", sourceUrl: `${SOURCE_BASE}/${slug}${dubSuffix}-episodio-${ep1d}` },
    { label: "alias-ep", sourceUrl: `${SOURCE_BASE}/${slug}${dubSuffix}-ep-${ep2d}` },
  ];
}

function toSlug(title) {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

async function extractVideoUrl(pageUrl) {
  const html = await fetchPage(pageUrl);

  const sourceTag = html.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)/i);
  if (sourceTag) return decodeHtmlEntities(sourceTag[1]);

  const fileAttr = html.match(/file\s*:\s*["']([^"']+\.mp4[^"']*)/i);
  if (fileAttr) return decodeHtmlEntities(fileAttr[1]);

  const jsonSrc = html.match(/"src"\s*:\s*"([^"]+\.mp4[^"]*)"/i);
  if (jsonSrc) return decodeHtmlEntities(jsonSrc[1]);

  const iframeSrc = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (iframeSrc) {
    const iframeUrl = iframeSrc[1].startsWith("http")
      ? iframeSrc[1]
      : `https://animesdrive.online${iframeSrc[1]}`;
    return await extractVideoUrl(iframeUrl);
  }

  const anyMp4 = html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
  if (anyMp4) return anyMp4[0];

  return null;
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      "Referer": "https://animesdrive.online/",
    },
    redirect: "follow",
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} → ${url}`);
  return res.text();
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&")
    .replace(/\\u0026/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function kvGet(key) {
  if (typeof ZARUMI_CACHE === "undefined") return null;
  try {
    const raw = await ZARUMI_CACHE.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function kvSet(key, value, ttl) {
  if (typeof ZARUMI_CACHE === "undefined") return;
  try {
    await ZARUMI_CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl });
  } catch {}
}

async function kvDelete(key) {
  if (typeof ZARUMI_CACHE === "undefined") return;
  try { await ZARUMI_CACHE.delete(key); } catch {}
}

function corsResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    },
  });
}
