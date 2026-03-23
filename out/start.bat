@echo off
cd /d "%~dp0"
set PORT=3001
set HOSTNAME=127.0.0.1
set NODE_ENV=production
node server.js
