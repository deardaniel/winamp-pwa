#!/usr/bin/env bash
# Deploy Gapless Amp to kichi.
#
#   ./deploy.sh
#
# The code goes through the feedback service's deployer, the same path as a
# change Claude ships from a feedback thread: it copies the files kichi.json
# lists from the pushed commit, restarts, checks the app answers and puts the
# previous commit back if it doesn't. This script only does what the deployer
# must not: the compose file (it decides the container's privileges, mounts and
# ports) and the tailnet HTTPS front. Data on kichi is never touched.
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
  echo "Unpushed commits — push before deploying (only pushed commits are deployed)." >&2
  exit 1
fi

echo "==> Compose file and HTTPS"
ssh $HOST "mkdir -p $REMOTE/app $REMOTE/data"
scp -q docker-compose.yml $HOST:$REMOTE/docker-compose.yml
# Creates the container, or applies a compose change; otherwise a no-op.
ssh $HOST "cd $REMOTE && docker compose up -d"
ssh $HOST "tailscale serve status 2>/dev/null | grep -q ':8445' || tailscale serve --bg --https=8445 http://127.0.0.1:48081"

echo "==> Deploying $(git rev-parse --short HEAD)"
ssh $HOST "docker exec feedback-deployer python3 /app/deployer.py deploy gapless-amp $(git rev-parse HEAD)"

echo "OK — $URL"
