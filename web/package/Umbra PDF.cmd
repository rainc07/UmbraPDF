@echo off
rem Umbra PDF (desktop): starts the local server and opens the app in your browser. Close this window to stop it.
title Umbra PDF
"%~dp0node\node.exe" "%~dp0server.mjs" --root "%~dp0app" --models "%~dp0models" %*
if errorlevel 1 (
  echo.
  echo Umbra PDF could not start. See the messages above.
  pause
)
