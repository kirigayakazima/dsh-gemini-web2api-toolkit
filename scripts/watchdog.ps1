# ============================================================
#  gemini-web2api watchdog 控制脚本
#
#  用法（在本脚本所在目录执行）：
#    powershell -File watchdog.ps1 start     启动守护（后台无窗口）
#    powershell -File watchdog.ps1 stop      停止守护（不影响反代本体）
#    powershell -File watchdog.ps1 status    查看状态 + 日志尾部
#    powershell -File watchdog.ps1 pause     暂停自动重启（手动维护时用）
#    powershell -File watchdog.ps1 resume    恢复自动重启
#    powershell -File watchdog.ps1 once      只检查一次
#
#  可选参数：
#    -ServerRoot <路径>   显式指定反代项目根目录（默认自动探测，见下）
#
#  自动探测顺序：
#    1) -ServerRoot 参数
#    2) 环境变量 DSH_WEB2API_ROOT
#    3) 本脚本所在目录及其上一级（standalone：脚本直接放在反代目录里）
#    4) 已知的本机默认位置 D:\CodePackage\DSP\gemini-web2api
#       —— 本脚本随 toolkit 分发放在 scripts/ 下时，靠这一条命中
#
#  注：本文件为 UTF-8 带 BOM。含中文的 .ps1 若无 BOM，Windows PowerShell 5.1
#      会按 GBK 解码导致解析崩溃（本项目已踩过两次）。
# ============================================================
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'status', 'pause', 'resume', 'once')]
  [string]$Action = 'status',
  [string]$ServerRoot = ''
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $scriptDir 'watchdog.py'

function Resolve-ServerRoot {
  param([string]$Explicit)
  $cands = @()
  if ($Explicit) { $cands += $Explicit }
  if ($env:DSH_WEB2API_ROOT) { $cands += $env:DSH_WEB2API_ROOT }
  $cands += $scriptDir
  $cands += (Split-Path -Parent $scriptDir)
  $cands += 'D:\CodePackage\DSP\gemini-web2api'
  foreach ($c in $cands) {
    if (-not $c) { continue }
    if (Test-Path (Join-Path $c 'gemini_web2api.py')) { return (Resolve-Path $c).Path }
  }
  return $null
}

# 状态文件都放在反代目录（与 server.log 同处），所以需要先解析出它
$root = Resolve-ServerRoot -Explicit $ServerRoot
if (-not $root) {
  Write-Host "❌ 找不到反代项目目录（未找到 gemini_web2api.py）" -ForegroundColor Red
  Write-Host "   请用 -ServerRoot 指定，或设置环境变量 DSH_WEB2API_ROOT" -ForegroundColor Yellow
  exit 1
}

$pyArgs = @("`"$py`"", '--server-root', "`"$root`"")
$pidFile = Join-Path $root 'watchdog.pid'
$pauseFile = Join-Path $root 'watchdog.pause'
$logFile = Join-Path $root 'watchdog.log'
$pyw = 'pythonw'

function Get-WatchdogPid {
  if (Test-Path $pidFile) {
    $p = [int](Get-Content $pidFile -ErrorAction SilentlyContinue)
    if (Get-Process -Id $p -ErrorAction SilentlyContinue) { return $p }
  }
  return $null
}

switch ($Action) {
  'start' {
    if (Get-WatchdogPid) {
      Write-Host "watchdog 已在运行 (PID $(Get-WatchdogPid))，无需重复启动" -ForegroundColor Yellow
      exit 0
    }
    if (-not (Test-Path $py)) { Write-Host "❌ 找不到 $py" -ForegroundColor Red; exit 1 }
    $proc = Start-Process -FilePath $pyw `
      -ArgumentList ($pyArgs + '--verbose') `
      -WorkingDirectory $root -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 2
    if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
      $proc.Id | Set-Content $pidFile
      Write-Host "✅ watchdog 已启动 (PID $($proc.Id))" -ForegroundColor Green
      Write-Host "   反代目录: $root" -ForegroundColor Cyan
      Write-Host "   日志    : $logFile" -ForegroundColor Cyan
      Write-Host "   停止    : watchdog.ps1 stop" -ForegroundColor Cyan
    } else {
      Write-Host "❌ 启动失败，请手动运行: python `"$py`" --server-root `"$root`" --verbose" -ForegroundColor Red
      exit 1
    }
  }
  'stop' {
    $p = Get-WatchdogPid
    if ($p) {
      Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
      Remove-Item $pidFile -ErrorAction SilentlyContinue
      Write-Host "✅ 已停止 watchdog (PID $p)" -ForegroundColor Green
      Write-Host "   注意：反代本体不受影响，仍在运行" -ForegroundColor Yellow
    } else {
      Write-Host "watchdog 未在运行" -ForegroundColor Yellow
    }
  }
  'status' {
    $p = Get-WatchdogPid
    if ($p) { Write-Host "✅ watchdog 运行中 (PID $p)" -ForegroundColor Green }
    else { Write-Host "❌ watchdog 未运行" -ForegroundColor Red }
    if (Test-Path $pauseFile) { Write-Host "⏸ 自动重启已暂停 (watchdog.pause 存在)" -ForegroundColor Yellow }
    Write-Host ''
    & python @pyArgs --status
  }
  'pause' {
    New-Item -ItemType File -Force -Path $pauseFile | Out-Null
    Write-Host "⏸ 已暂停自动重启（watchdog 仍会记录探测日志）" -ForegroundColor Yellow
    Write-Host "   恢复: watchdog.ps1 resume" -ForegroundColor Cyan
  }
  'resume' {
    Remove-Item $pauseFile -ErrorAction SilentlyContinue
    Write-Host "▶ 已恢复自动重启" -ForegroundColor Green
  }
  'once' {
    & python @pyArgs --once
    exit $LASTEXITCODE
  }
}
