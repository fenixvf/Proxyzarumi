# zarumi-proxy

Cloudflare Worker que extrai links de vídeo do AnimésDrive para o site Zarumi.

## Setup

1. Crie um KV namespace chamado `ZARUMI_CACHE` no Cloudflare Dashboard
2. Cole o ID gerado no `wrangler.toml` no campo `id`
3. Instale as dependências: `npm install`
4. Faça o deploy: `npm run deploy`

## Endpoints

- `GET /video?slug=naruto&ep=1&type=serie&dub=false` → retorna o link mp4
- `GET /slug?title=Naruto&ep=1&type=serie` → retorna o slug gerado
- `GET /cache/clear?slug=naruto&ep=1&type=serie` → limpa o cache do episódio
