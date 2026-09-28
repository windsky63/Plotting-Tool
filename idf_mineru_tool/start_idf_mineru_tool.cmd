@echo off
cd /d "%~dp0"
set "MINERU_HOST=192.168.32.61"
set "MINERU_PORT=8081"
set "MINERU_CONCURRENCY=4"
set "OCR_HOST=192.168.32.61"
set "OCR_PORT=8766"
node server.js
