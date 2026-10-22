# Sync the standalone server + admin console into the runtime data directory.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File server\sync-to-runtime.ps1
# ASCII-only on purpose: Windows PowerShell 5.1 misreads BOM-less UTF-8 scripts.
$ErrorActionPreference = 'Stop'

$source = $PSScriptRoot
$root = if ($env:ICE_AGENT_DATA) { $env:ICE_AGENT_DATA } else { 'D:\IceAgent' }
$target = Join-Path $root 'server'

if (-not (Test-Path -LiteralPath $target)) {
  New-Item -ItemType Directory -Path $target | Out-Null
}

Copy-Item -LiteralPath (Join-Path $source 'server.mjs') -Destination (Join-Path $target 'server.mjs') -Force

$adminSource = Join-Path $source 'admin'
$adminTarget = Join-Path $target 'admin'
if (Test-Path -LiteralPath $adminTarget) {
  Remove-Item -LiteralPath $adminTarget -Recurse -Force
}
Copy-Item -LiteralPath $adminSource -Destination $adminTarget -Recurse -Force

# The TypeScript source of the bundled renderer is build-time only.
$srcTarget = Join-Path $adminTarget 'src'
if (Test-Path -LiteralPath $srcTarget) {
  Remove-Item -LiteralPath $srcTarget -Recurse -Force
}

# The Live2D SDK runtime (core + shaders) is not committed; it comes from assets/live2d,
# which is gitignored for the same reason the pet's /live2d bundle is.
$sdkSource = Join-Path (Split-Path -Parent $source) 'assets\live2d'
$vendorTarget = Join-Path $adminTarget 'vendor\live2d'
if (Test-Path -LiteralPath $sdkSource) {
  New-Item -ItemType Directory -Force -Path (Join-Path $vendorTarget 'shaders') | Out-Null
  Copy-Item -LiteralPath (Join-Path $sdkSource 'live2dcubismcore.min.js') -Destination $vendorTarget -Force
  Copy-Item -Path (Join-Path $sdkSource 'shaders\*') -Destination (Join-Path $vendorTarget 'shaders') -Force
  Write-Host 'Live2D SDK runtime copied from assets/live2d'
} else {
  Write-Host 'WARN: assets/live2d not found; Live2D thumbnails will show a placeholder'
}

$files = Get-ChildItem -LiteralPath $adminTarget -Recurse -File | Select-Object -ExpandProperty Name

$startCommand = '  node "' + (Join-Path $target 'server.mjs') + '"'
Write-Host ('Synced to ' + $target)
Write-Host ('admin files: ' + ($files -join ', '))
Write-Host ''
Write-Host 'Next: stop the running server window, then start it again with:'
Write-Host $startCommand
Write-Host ('Open http://127.0.0.1:8787/admin/ (port comes from config.json)')
