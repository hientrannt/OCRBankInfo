#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Chưa cài Node.js. Tải tại https://nodejs.org"; exit 1; }
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  echo "Đã tạo .env.local - hãy điền ANTHROPIC_API_KEY rồi chạy lại."
  exit 0
fi
[ -d node_modules ] || npm install
[ -f .next/BUILD_ID ] || npm run build
( sleep 3; (open http://localhost:3000 || xdg-open http://localhost:3000) >/dev/null 2>&1 ) &
npm start
