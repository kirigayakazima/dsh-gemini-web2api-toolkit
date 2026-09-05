@echo off
REM ============================================================
REM  gemini-web2api 一键启动（Windows）
REM  用法:
REM    start.bat                -> 用 config.json 启动
REM    start.bat --proxy http://127.0.0.1:7890   -> 走 HTTP 代理
REM    start.bat --cookie-file cookie.txt        -> 带 Pro 账号 cookie
REM ============================================================
cd /d "%~dp0"

REM 让 Python 找到项目内依赖 (.deps 里的 httpx)
set PYTHONPATH=%CD%\.deps

echo [1/2] 检查依赖...
python -c "import httpx" >nul 2>&1
if errorlevel 1 (
  echo   httpx 缺失，尝试安装到 .deps ...
  python -m pip install --disable-pip-version-check --target "%CD%\.deps" httpx
)

echo [2/2] 启动 gemini-web2api ...
echo   服务地址: http://localhost:8081/v1
echo   停止服务: 关闭本窗口或按 Ctrl+C
echo.
python gemini_web2api.py --config config.json %*
