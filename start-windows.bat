@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Chua cai Node.js. Tai tai https://nodejs.org roi chay lai. & pause & exit /b 1)
if not exist .env.local (
  copy .env.example .env.local >nul
  echo Da tao file .env.local - hay dien ANTHROPIC_API_KEY, luu lai roi chay lai file nay.
  notepad .env.local
  pause
  exit /b 0
)
if not exist node_modules call npm install || (pause & exit /b 1)
if not exist .next\BUILD_ID call npm run build || (pause & exit /b 1)
start "" http://localhost:3000
call npm start
