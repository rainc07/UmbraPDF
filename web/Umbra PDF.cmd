@echo off
rem Umbra PDF (desktop): starts the local server and opens the app in your browser.
rem First run installs and builds (needs Node.js 20+). Close this window to stop Umbra PDF.
title Umbra PDF
cd /d "%~dp0"
if not exist node_modules\onnxruntime-node (call npm install || goto fail)
if not exist ..\core\node_modules (call npm --prefix ..\core ci || goto fail)
if not exist ..\core\dist\index.html (call npm run build:core || goto fail)
if not exist dist\server.mjs (call npm run build || goto fail)
node dist\server.mjs %*
if errorlevel 1 goto fail
goto :eof
:fail
echo.
echo Umbra PDF could not start. See the messages above.
pause
