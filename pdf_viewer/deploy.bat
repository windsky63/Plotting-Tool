@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [1/3] 停止旧的生产服务器...
taskkill /F /FI "WINDOWTITLE eq prod-server" >nul 2>&1

echo [2/3] 构建新版本（请稍候...）
set "GENERATE_SOURCEMAP=false"
set "REACT_APP_SERVER_PAGE_CACHE=true"
set "REACT_APP_IMAGE_FIRST_PDF=true"
set "PDF_PAGE_CACHE_PYTHON=C:\Users\1\AppData\Local\Programs\Python\Python311\python.exe"
call npm run build
if %errorlevel% neq 0 (
    echo 构建失败，终止发布
    pause
    exit /b 1
)

echo [2.5/3] 隔离生产环境文件...
rmdir /s /q build_prod 2>nul
xcopy build build_prod /E /I /H /Y >nul

echo [3/3] 启动生产服务器（端口 3005）...
start "prod-server" /MIN cmd /c "node scripts\prod_server_with_autosave_proxy.js"
echo.
echo 发布完成！
call node scripts/get-local-ip.js 2>nul
echo 用户可通过 http://[本机IP]:3005 访问新版本
pause
