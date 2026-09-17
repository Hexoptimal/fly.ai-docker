@echo off
rem fly.ai compute: Bitcoin pool mining. Double-click to start; see README.md.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js isn't installed. Download the LTS version from https://nodejs.org, install it,
  echo then double-click this file again.
  echo.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)"
if errorlevel 1 (
  echo.
  echo This needs Node.js 22.18 or newer. Download the LTS version from https://nodejs.org, install it,
  echo then double-click this file again.
  echo.
  pause
  exit /b 1
)
node start.ts
pause
