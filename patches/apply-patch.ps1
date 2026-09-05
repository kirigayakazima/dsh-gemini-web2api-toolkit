# ============================================================
# 一键应用 gemini_web2api.py 本地补丁
# 用法:
#   powershell -File apply-patch.ps1 -Target D:\path\to\gemini-web2api
#   参数 -Target 指向 clone 自 Sophomoresty/gemini-web2api 的目录
# ============================================================
param(
  [Parameter(Mandatory = $true)]
  [string]$Target,
  [switch]$Revert
)

$patch = Join-Path $PSScriptRoot 'gemini_web2api.py.patch'
$targetFile = Join-Path $Target 'gemini_web2api.py'

if (-not (Test-Path $targetFile)) {
  Write-Host "❌ 找不到目标文件: $targetFile" -ForegroundColor Red
  Write-Host "   请确认 -Target 指向 gemini-web2api 项目根目录" -ForegroundColor Yellow
  exit 1
}

if ($Revert) {
  git -C $Target apply -R $patch
  if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ 已回滚补丁（恢复到上游原版）" -ForegroundColor Green
  } else {
    Write-Host "❌ 回滚失败（可能已被其他修改覆盖）" -ForegroundColor Red
  }
  exit
}

git -C $Target apply --check $patch 2>$null
if ($LASTEXITCODE -eq 0) {
  git -C $Target apply $patch
  Write-Host "✅ 补丁应用成功！" -ForegroundColor Green
  Write-Host "   改动内容:" -ForegroundColor Cyan
  Write-Host "     ① gemini-3.8-flash 模型条目（上游暂无）" -ForegroundColor Cyan
  Write-Host "     ② x-goog-ext-525001261-jspb model header（Issue #82 修复）" -ForegroundColor Cyan
  Write-Host "     ③ load_cookie 支持 gemini-auth.json（自动注入 xsrf/bl）" -ForegroundColor Cyan
  Write-Host "     ④ fetch_xsrf_token 自动抓取（FdrFJe）" -ForegroundColor Cyan
} else {
  Write-Host "⚠️ 补丁无法干净应用（目标可能已有改动或版本不同）" -ForegroundColor Yellow
  Write-Host "   尝试强制应用? 或手动对比后打补丁" -ForegroundColor Yellow
  Write-Host "   git apply --3way $patch" -ForegroundColor Gray
  exit 1
}
