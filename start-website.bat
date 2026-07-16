@echo off
rem ============================================================
rem  Double-click this file to view the Platform_Signal website.
rem  It starts a local web server and opens your browser.
rem  Keep the black server window open while using the site;
rem  close that window when you are done to stop the server.
rem ============================================================

cd /d "%~dp0"

echo Starting a local server for Platform_Signal...
echo (The first run may take a minute while it downloads "serve".)
echo.

start "Platform_Signal server" cmd /k "npx --yes serve -l 4173 ."

echo Waiting for the server to start...
timeout /t 5 /nobreak >nul

start "" http://localhost:4173

echo.
echo Your browser should now open at http://localhost:4173
echo If the page looks empty, wait a few seconds and refresh it.
echo.
echo You can close THIS window now. Keep the OTHER server window open.
timeout /t 8 /nobreak >nul
