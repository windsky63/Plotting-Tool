@echo off
chcp 65001 >nul
echo === 启动开发服务器并开启外网访问 ===
echo.

REM 检查是否安装了localtunnel
where lt >nul 2>&1
if %errorLevel% neq 0 (
    echo 首次运行需要安装localtunnel...
    call npm install -g localtunnel
)

echo 启动React开发服务器...
start "React Dev Server" cmd /k "npm start"

echo 等待服务器启动...
timeout /t 10 /nobreak >nul

echo 创建外网隧道...
lt --port 3005 --subdomain pdf-viewer-demo

pause















































