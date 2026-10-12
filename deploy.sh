#!/usr/bin/env bash
# Deploy Gapless Amp to kichi.
#
#   ./deploy.sh
#
# Rsyncs the static app to /mnt/user/appdata/gapless-amp/app and makes sure the
# container and the tailnet HTTPS front (needed for the service worker) are up.
set -euo pipefail

HOST=root@kichi
REMOTE=/mnt/user/appdata/gapless-amp
URL=https://kichi.tailae45a.ts.net:8445

cd "$(dirname "$0")"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty — commit before deploying:" >&2
  git status --short >&2
  exit 1
fi
if [[ -n "$(git log --oneline @{u}.. 2>/dev/null || echo unpushed)" ]]; then
  echo "Unpushed commits — push before deploying." >&2
  exit 1
fi

echo "==> Syncing app files"
ssh $HOST "mkdir -p $REMOTE/app"
rsync -az --delete \
  --include='/*.js' --include='/*.html' --include='/*.css' --include='/serve.py' \
  --include='/manifest.webmanifest' \
  --include='/icons/' --include='/icons/*.png' \
  --include='/vendor/' --include='/vendor/*' \
  --exclude='*' \
  ./ $HOST:$REMOTE/app/
scp -q docker-compose.yml $HOST:$REMOTE/docker-compose.yml

echo "==> Starting container"
ssh $HOST "cd $REMOTE && docker compose up -d && docker compose restart"
ssh $HOST "tailscale serve status 2>/dev/null | grep -q ':8445' || tailscale serve --bg --https=8445 http://127.0.0.1:48081"

echo "==> Waiting for it to answer"
for i in $(seq 1 15); do
  if ssh $HOST "curl -fsS --max-time 2 http://127.0.0.1:48081/sw.js" >/dev/null 2>&1; then
    echo "OK — $URL (tailnet only; add to Home Screen from Safari)"
    exit 0
  fi
  sleep 1
done
echo "Container did not answer in time. Logs:" >&2
ssh $HOST "docker logs --tail 30 gapless-amp" >&2
exit 1
