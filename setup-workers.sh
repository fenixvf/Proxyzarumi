#!/bin/bash
# setup-workers.sh
# Substitui SEU-USUARIO pelo seu username do Cloudflare em todos os arquivos

if [ -z "$1" ]; then
  echo "Uso: bash setup-workers.sh SEU-USERNAME"
  echo "Exemplo: bash setup-workers.sh fenixvf"
  exit 1
fi

USERNAME="$1"

sed -i "s/SEU-USUARIO/$USERNAME/g" zarumi-proxy/worker.sw.js

echo "✅ Pronto! zarumi-proxy/worker.sw.js configurado com username: $USERNAME"
echo ""
echo "Seus workers serão acessíveis em:"
echo "  https://zarumi-drivea.$USERNAME.workers.dev"
echo "  https://zarumi-aq.$USERNAME.workers.dev"
echo "  https://zarumi-at.$USERNAME.workers.dev"
echo "  https://zarumi-proxy.$USERNAME.workers.dev"
echo ""
echo "Próximo passo: faça o deploy de cada worker no Cloudflare Dashboard."
echo "Ver README.md para instruções completas."
