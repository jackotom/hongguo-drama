@echo off
rem Hongguo Drama 5.2 source candidate - version metadata: package.json
chcp 65001 >nul
cd /d "%~dp0"
if exist "dist\win-unpacked\红果短剧.exe" (
  start "" "dist\win-unpacked\红果短剧.exe"
  exit /b 0
)
for %%F in ("dist\红果短剧-*-便携版.exe") do (
  start "" "%%~fF"
  exit /b 0
)
for %%F in ("dist\hongguo-downloader-*-win-x64-setup.exe") do (
  start "" "%%~fF"
  exit /b 0
)
echo 未找到已打包的程序。请先执行 npm run build，或双击「开发模式.bat」。
pause
