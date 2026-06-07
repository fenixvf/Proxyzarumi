/**
 * Zarumi Proxy Worker — Service Worker format
 * Usa extratores externos como backend:
 *   AnimeQ  → aq.masterotaku487.workers.dev
 *   AniTube → at.masterotaku487.workers.dev (retorna HLS)
 *   AnimésDrive → extração direta via HTML (DooPlay AJAX)
 */

const ALLOWED_ORIGINS = [
  "https://zarumi.com",
  "https://www.zarumi.com",
  "http://localhost:3000",
];

const CACHE_TTL    = 60 * 60 * 6;
const OVERRIDE_TTL = 60 * 60 * 24 * 30;

const SOURCES = [
  {
    name:      "animesdrive",
    base:      "https://animesdrive.online/episodio",
    extractor: "https://drivea.masterotaku487.workers.dev",
  },
  {
    name:      "animeq",
    base:      "https://animeq.net/episodio",
    extractor: "https://aq.masterotaku487.workers.dev",
  },
];

const ANITUBE_EXTRACTOR = "https://at.masterotaku487.workers.dev";

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

  if (path === "/video")           return handleVideo(url.searchParams);
  if (path === "/slug")            return handleSlug(url.searchParams);
  if (path === "/cache/clear")     return handleCacheClear(url.searchParams);
  if (path === "/override")        return handleOverride(url.searchParams, request);
  if (path === "/override/delete") return handleOverrideDelete(url.searchParams);
  if (path === "/debug")           return handleDebug(url.searchParams);

  return corsResponse(JSON.stringify({ error: "Not found" }), 404);
}

// ─── /video ──────────────────────────────────────────────────────────────────

async function handleVideo(params) {
  const slug   = params.get("slug");
  const ep     = params.get("ep");
  const type   = params.get("type") || "serie";
  const dub    = params.get("dub") === "true";
  const mal_id = params.get("mal_id");

  if (!slug) return corsResponse(JSON.stringify({ error: "Missing slug" }), 400);

  const cacheKey = `v1:${slug}:${ep ?? "none"}:${type}:${dub ? "dub" : "leg"}`;

  // 1. Cache
  const cached = await kvGet(cacheKey);
  if (cached) return corsResponse(JSON.stringify({ ...cached, cached: true }), 200);

  // 2. Override manual (AniTube / hash-based)
  if (mal_id) {
    const override = await getOverrideUrl(mal_id, ep, dub);
    if (override) {
      const playUrl = `${ANITUBE_EXTRACTOR}/?url=${encodeURIComponent(override)}`;
      const result  = { url: playUrl, source: override, provider: "anitube", label: "override" };
      await kvSet(cacheKey, result, CACHE_TTL);
      return corsResponse(JSON.stringify(result), 200);
    }
  }

  // 3. Fontes automáticas
  const variants = buildSlugVariants(slug, ep, type, dub);
  const errors   = [];

  for (const source of SOURCES) {
    for (const { path: slugPath, label } of variants) {
      const sourceUrl = `${source.base}/${slugPath}`;
      try {
        const videoUrl = source.extractor
          ? await extractViaWorker(source.extractor, sourceUrl)
          : await extractFromPage(sourceUrl);

        if (videoUrl) {
          const result = { url: videoUrl, source: sourceUrl, provider: source.name, label };
          await kvSet(cacheKey, result, CACHE_TTL);
          return corsResponse(JSON.stringify(result), 200);
        }
      } catch (err) {
        errors.push(`${source.name}/${label}: ${err.message}`);
      }
    }
  }

  return corsResponse(JSON.stringify({
    error: "Video not found after all retries",
    tried: SOURCES.flatMap(s => variants.map(v => `${s.base}/${v.path}`)),
    errors,
  }), 404);
}

// ─── Extratores ───────────────────────────────────────────────────────────────

async function extractViaWorker(extractorBase, sourceUrl) {
  const res = await fetch(`${extractorBase}/?url=${encodeURIComponent(sourceUrl)}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!res.ok) return null;

  const text = await res.text();

  // Resposta HLS (m3u8) — AniTube
  if (text.startsWith("#EXTM3U")) {
    return `${extractorBase}/?url=${encodeURIComponent(sourceUrl)}`;
  }

  // Resposta JSON — AnimésDrive / AnimeQ
  try {
    const data = JSON.parse(text);
    if (!data.success) return null;

    if (Array.isArray(data.results) && data.results.length > 0) {
      // Prefere mp4 direto
      const mp4 = data.results.find(r => r.type === "mp4");
      if (mp4) return mp4.proxyUrl || mp4.url;

      // Fallback: iframe proxiado
      const iframe = data.results.find(r => r.type === "iframe" && r.proxyUrl);
      if (iframe) return iframe.proxyUrl;

      // Qualquer resultado com URL
      const any = data.results.find(r => r.proxyUrl || r.url);
      if (any) return any.proxyUrl || any.url;
    }

    if (data.url) return data.url;
  } catch {}

  // URL mp4 direta no texto
  const mp4Match = text.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
  if (mp4Match) return mp4Match[0];

  return null;
}

async function extractFromPage(pageUrl) {
  const html = await fetchPage(pageUrl);
  return extractFromHtml(html, pageUrl);
}

function extractFromHtml(html, baseUrl) {
  const sourceTag = html.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)/i);
  if (sourceTag) return decodeHtmlEntities(sourceTag[1]);

  const fileAttr = html.match(/file\s*:\s*["']([^"']+\.mp4[^"']*)/i);
  if (fileAttr) return decodeHtmlEntities(fileAttr[1]);

  const jsonSrc = html.match(/"src"\s*:\s*"([^"]+\.mp4[^"]*)"/i);
  if (jsonSrc) return decodeHtmlEntities(jsonSrc[1]);

  const playerInit = html.match(/player\.init\s*\(\s*\{[^}]*file\s*:\s*["']([^"']+)/i);
  if (playerInit) return decodeHtmlEntities(playerInit[1]);

  const b64 = html.match(/atob\s*\(\s*["']([A-Za-z0-9+/=]{20,})["']\s*\)/);
  if (b64) {
    try {
      const decoded = atob(b64[1]);
      const mp4 = decoded.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
      if (mp4) return mp4[0];
    } catch {}
  }

  const anyMp4 = html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
  if (anyMp4) return anyMp4[0];

  return null;
}

// ─── /slug ───────────────────────────────────────────────────────────────────

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

// ─── /cache/clear ────────────────────────────────────────────────────────────

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

// ─── /override ───────────────────────────────────────────────────────────────

async function handleOverride(params, request) {
  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch {
      return corsResponse(JSON.stringify({ error: "Invalid JSON body" }), 400);
    }

    const { mal_id, provider = "anitube", leg = {}, dub = {} } = body;
    if (!mal_id) return corsResponse(JSON.stringify({ error: "Missing mal_id" }), 400);

    const key      = `override:${mal_id}`;
    const existing = await kvGet(key) || {};
    const updated  = {
      ...existing,
      [provider]: {
        leg: { ...(existing[provider]?.leg || {}), ...leg },
        dub: { ...(existing[provider]?.dub || {}), ...dub },
      },
    };
    await kvSet(key, updated, OVERRIDE_TTL);
    return corsResponse(JSON.stringify({ saved: key, data: updated }), 200);
  }

  const mal_id = params.get("mal_id");
  const ep     = params.get("ep");
  const dub    = params.get("dub") === "true";

  if (!mal_id) return corsResponse(JSON.stringify({ error: "Missing mal_id" }), 400);

  const data = await kvGet(`override:${mal_id}`);
  if (!data) return corsResponse(JSON.stringify({ found: false }), 404);
  if (!ep)   return corsResponse(JSON.stringify({ found: true, data }), 200);

  const url = findOverrideUrl(data, ep, dub);
  return corsResponse(JSON.stringify({ found: !!url, url: url || null }), 200);
}

async function handleOverrideDelete(params) {
  const mal_id = params.get("mal_id");
  if (!mal_id) return corsResponse(JSON.stringify({ error: "Missing mal_id" }), 400);

  await kvDelete(`override:${mal_id}`);
  return corsResponse(JSON.stringify({ deleted: `override:${mal_id}` }), 200);
}

async function getOverrideUrl(mal_id, ep, dub) {
  const data = await kvGet(`override:${mal_id}`);
  if (!data) return null;
  return findOverrideUrl(data, ep, dub);
}

function findOverrideUrl(data, ep, dub) {
  for (const provider of Object.values(data)) {
    const track = dub ? provider.dub : provider.leg;
    if (track && ep && track[String(ep)]) return track[String(ep)];
  }
  return null;
}

// ─── /debug ──────────────────────────────────────────────────────────────────

async function handleDebug(params) {
  const pageUrl = params.get("url");
  if (!pageUrl) return corsResponse(JSON.stringify({ error: "Missing url" }), 400);

  const source = SOURCES.find(s => pageUrl.includes(new URL(s.base).hostname));

  if (source?.extractor) {
    try {
      const res  = await fetch(`${source.extractor}/?url=${encodeURIComponent(pageUrl)}`);
      const text = await res.text();
      return corsResponse(JSON.stringify({
        url: pageUrl,
        extractor: source.extractor,
        status: res.status,
        response: text.slice(0, 3000),
      }, null, 2), 200);
    } catch (err) {
      return corsResponse(JSON.stringify({ error: err.message }), 502);
    }
  }

  try {
    const html = await fetchPage(pageUrl);
    return corsResponse(JSON.stringify({
      url: pageUrl,
      html_length: html.length,
      extracted: extractFromHtml(html, pageUrl),
      html_start: html.slice(0, 2000),
      html_end:   html.slice(-1000),
    }, null, 2), 200);
  } catch (err) {
    return corsResponse(JSON.stringify({ error: err.message }), 502);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildSlugVariants(slug, ep, type, dub) {
  if (type !== "serie") {
    return [
      { label: "padrao",    path: slug },
      { label: "com-filme", path: `${slug}-filme` },
      { label: "com-ova",   path: `${slug}-ova` },
    ];
  }

  const dubSuffix = dub ? "-dublado" : "";
  const ep2d = String(ep).padStart(2, "0");
  const ep1d = String(ep);

  return [
    { label: "padrao",   path: `${slug}${dubSuffix}-episodio-${ep2d}` },
    { label: "sem-zero", path: `${slug}${dubSuffix}-episodio-${ep1d}` },
    { label: "alias-ep", path: `${slug}${dubSuffix}-ep-${ep2d}` },
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    },
  });
}
