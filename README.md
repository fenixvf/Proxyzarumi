# Zarumi Workers

Quatro Cloudflare Workers para extração e proxy de vídeos de anime.

## Estrutura

| Worker | Pasta | Função |
|---|---|---|
| `zarumi-drivea` | `zarumi-drivea/` | Extrai links do AnimésDrive |
| `zarumi-aq` | `zarumi-aq/` | Extrai links do AnimeQ |
| `zarumi-at` | `zarumi-at/` | Extrai e faz proxy HLS do AniTube |
| `zarumi-proxy` | `zarumi-proxy/` | Worker principal — chama os três acima |

## Setup inicial

### 1. Descubra seu username do Cloudflare

Acesse [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages.
O subdomínio dos seus workers é `SEU-USERNAME.workers.dev`.

### 2. Configure o username

```bash
bash setup-workers.sh SEU-USERNAME
```

Isso atualiza automaticamente o `zarumi-proxy/worker.sw.js` com as URLs dos seus workers.

### 3. Deploy no Cloudflare Dashboard

Para cada worker, faça o deploy manualmente:

1. Acesse **Workers & Pages → Create application → Create Worker**
2. Nomeie o worker (ex: `zarumi-drivea`)
3. Cole o conteúdo do arquivo `worker.js` correspondente
4. Clique em **Deploy**

Repita para: `zarumi-aq`, `zarumi-at`, `zarumi-proxy`

> **Atenção:** o `zarumi-proxy` usa `worker.sw.js` (não `worker.js`)

### 4. Configure o KV do zarumi-proxy

1. No Dashboard → **Workers & Pages → KV → Create namespace**
2. Nome: `ZARUMI_CACHE`
3. Copie o ID gerado
4. No worker `zarumi-proxy` → **Settings → Variables → KV Namespace Bindings**
5. Adicione: Variable = `ZARUMI_CACHE`, KV Namespace = o que você criou

---

## Endpoints

### zarumi-drivea / zarumi-aq

```
GET /?url=https://animesdrive.online/episodio/SLUG-episodio-01
```

Retorna:
```json
{ "success": true, "url": "https://...", "type": "mp4", "source": "..." }
```

```
GET /proxy?url=https://...
```
Proxy transparente de conteúdo.

### zarumi-at

```
GET /?url=https://www.anitube.zip/HASH/
```

Retorna o conteúdo HLS (`.m3u8`) com segmentos reescritos para passar pelo proxy.

### zarumi-proxy (principal)

```
GET /video?slug=rezero-kara-4th-season&ep=1&type=serie&dub=false
GET /video?slug=rezero-kara-4th-season&ep=1&type=serie&dub=false&mal_id=54857
GET /slug?title=Re:Zero - Starting Life in Another World Season 4&ep=1&type=serie
GET /cache/clear?slug=rezero-kara-4th-season&ep=1&type=serie
GET /debug?url=https://animesdrive.online/episodio/...
GET /override                            (GET → lê override; POST → salva override)
GET /override/delete?mal_id=54857
```

#### Override manual (AniTube — URLs hash-based)

```bash
curl -X POST https://zarumi-proxy.SEU-USERNAME.workers.dev/override \
  -H "Content-Type: application/json" \
  -d '{
    "mal_id": "54857",
    "provider": "anitube",
    "leg": { "1": "https://www.anitube.zip/939915b/" },
    "dub": { "1": "https://www.anitube.zip/abc123/" }
  }'
```

---

## Padrões de slug

### AnimésDrive / AnimeQ

| Tipo | Padrão |
|---|---|
| Série | `{slug}-episodio-{ep2d}` ex: `rezero-kara-4th-season-episodio-03` |
| Série dub | `{slug}-dublado-episodio-{ep2d}` |
| Filme/OVA | `{slug}` ex: `kimetsu-no-yaiba-movie-mugen-jou-hen` |

Slug: título em romaji, letras minúsculas, sem acentos, espaços → hífens.

### AniTube

URLs hash-based — não têm padrão automático.
Use overrides manuais conforme documentado acima.
