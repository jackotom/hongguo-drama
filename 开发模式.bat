@echo off
rem Hongguo Drama 5.2 source candidate - version metadata: package.json
title 红果短剧下载器 - 开发模式
cd /d "%~dp0"

echo ============================================
echo  红果短剧下载器 - 开发模式
echo  将启动 React 开发服务器 + Electron 窗口
echo ============================================
echo.

if not exist node_modules (
    echo 首次运行，正在安装依赖，请稍候...
    call npm install
)

call npm run dev
