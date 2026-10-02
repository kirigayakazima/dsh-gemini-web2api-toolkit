# ============================================================
#  gemini-web2api 管理脚本（PowerShell）
#  用法:
#    powershell -File manage.ps1 start                启动（后台，日志写 server.log）
#    powershell -File manage.ps1 status               查看状态
#    powershell -File manage.ps1 stop                 停止
#    powershell -File manage.ps1 test                 跑一次对话测试
#    powershell -File manage.ps1 log                  查看最近日志
# ============================================================
param(
  [Parameter(Position=0)]
  [ValidateSet('start','stop','status','test','log')]
  [string]$Action = 'status'
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$py   = "C:\Python314\python.exe"
$main = Join-Path $root 'gemini_web2api.py'
$cfg  = Join-Path $root 'config.json'
$log  = Join-Path $root 'server.log'
$pidFile = Join-Path $root 'server.pid'
$env:PYTHONPATH = (Join-Path $root '.deps') + ';' + $env:PYTHONPATH

function Get-RunningPid {
  if (Test-Path $pidFile) {
    $p = [int](Get-Content $pidFile)
    if (Get-Process -Id $p -ErrorAction SilentlyContinue) { return $p }
  }
  return $null
}

switch ($Action) {
  'start' {
    if (Get-RunningPid) { Write-Host "已在运行 (PID $(Get-RunningPid))，无需重复启动" -ForegroundColor Yellow; exit 0 }
    Write-Host "启动 gemini-web2api ..." -ForegroundColor Green
    # 通过 cmd /c 启动并重定向日志，进程与当前终端分离（关窗/断开不影响）
    $cmdLine = "set `"PYTHONPATH=$root\.deps`"&& `"$py`" `"$main`" --config `"$cfg`" > `"$log`" 2> `"$log.err`""
    $proc = Start-Process -FilePath "cmd.exe" -ArgumentList @('/c', $cmdLine) -WindowStyle Hidden -PassThru
    # Start-Process cmd 返回的是 cmd 进程，等它 exec 后记录真正的 python pid
    Start-Sleep -Seconds 2
    $pyProc = Get-Process -Name python -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -eq $py } | Select-Object -Last 1
    if ($pyProc) {
      $pyProc.Id | Set-Content $pidFile
      Write-Host "已启动 (Python PID $($pyProc.Id))，等待端口就绪 ..."
    } else {
      $proc.Id | Set-Content $pidFile
    }
    Start-Sleep -Seconds 4
    $ok = $false
    try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8081/v1/models' -Headers @{Authorization='Bearer sk-gemini'} -UseBasicParsing -TimeoutSec 8; $ok = ($r.StatusCode -eq 200) } catch {}
    if ($ok) { Write-Host "✅ 启动成功  http://localhost:8081/v1" -ForegroundColor Green }
    else { Write-Host "⚠️ 端口尚未就绪，看日志: $log" -ForegroundColor Yellow }
  }
  'status' {
    $p = Get-RunningPid
    if ($p) { Write-Host "✅ 运行中 (PID $p)" -ForegroundColor Green }
    else { Write-Host "❌ 未运行" -ForegroundColor Red }
    try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8081/v1/models' -Headers @{Authorization='Bearer sk-gemini'} -UseBasicParsing -TimeoutSec 8; Write-Host "接口响应: HTTP $($r.StatusCode)" } catch { Write-Host "接口响应: 不可达" -ForegroundColor Red }
  }
  'stop' {
    $p = Get-RunningPid
    if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Remove-Item $pidFile -ErrorAction SilentlyContinue; Write-Host "✅ 已停止 (PID $p)" -ForegroundColor Green }
    else { Write-Host "未在运行" -ForegroundColor Yellow }
  }
  'test' {
    $body = '{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"Reply with exactly: PONG"}]}'
    try {
      $out = & curl.exe -s -m 60 -X POST 'http://127.0.0.1:8081/v1/chat/completions' `
        -H 'Content-Type: application/json' -H 'Authorization: Bearer sk-gemini' -d $body 2>$null
      if ($LASTEXITCODE -eq 0 -and $out -match '"content"\s*:\s*"([^"]+)"') {
        Write-Host "✅ 对话正常: '$($Matches[1])'" -ForegroundColor Green
      } else {
        Write-Host "❌ 对话失败 (exit $LASTEXITCODE): $out" -ForegroundColor Red
      }
    } catch { Write-Host "❌ 对话失败: $($_.Exception.Message)" -ForegroundColor Red }
  }
  'log' {
    if (Test-Path $log) { Get-Content $log -Tail 30 } else { Write-Host "暂无日志" }
  }
}
