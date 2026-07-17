# Build portable zip for vfox-gui.
# Run AFTER `pnpm tauri build` — this script packages the raw release binary.
#
# The Tauri release binary at target/release/vfox-gui.exe is fully self-contained
# (all web assets embedded), so it can be zipped and distributed as a portable
# version with no installer needed.

param(
    [string]$Version = "0.1.0"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $root "src-tauri\target\release"
$exe = Join-Path $releaseDir "vfox-gui.exe"
$outDir = Join-Path $root "dist-portable"
$zipName = "vfox-gui-v$Version-portable-x64.zip"
$zipPath = Join-Path $outDir $zipName

if (-not (Test-Path $exe)) {
    Write-Error "找不到 $exe — 请先运行 pnpm tauri build"
    exit 1
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# Create a clean temp dir with only the files users need.
$staging = Join-Path $env:TEMP "vfox-gui-portable"
Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $staging | Out-Null

Copy-Item $exe $staging

# Write a simple README for portable users.
@"
# vfox-gui $Version (Portable)

免安装便携版。下载后解压，双击 `vfox-gui.exe` 即可运行。

**前提条件**：请先安装 [vfox](https://github.com/version-fox/vfox)

- 无需安装，解压即用
- 所有数据存储在 vfox 目录中，不会写入注册表
- 可放在 U 盘随身携带
"@ | Set-Content -Path (Join-Path $staging "README.txt") -Encoding UTF8

# Zip it.
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path "$staging\*" -DestinationPath $zipPath -CompressionLevel Optimal

# Calculate size.
$size = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Portable zip ready!" -ForegroundColor Green
Write-Host "  $zipPath" -ForegroundColor Cyan
Write-Host "  Size: $size MB" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

# Cleanup staging.
Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
