# Builds a Chrome Web Store-ready zip in .\dist\.
#
# Why not just zip the repo:
#   - The CWS rejects packages whose manifest contains a "key" field (the
#     store assigns the published ID itself). The key stays in the repo so
#     unpacked dev installs keep a stable extension ID across machines.
#   - Repo-only files (.git, docs, this script) don't belong in the package.
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\build-release.ps1

$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot
$staging = Join-Path $repo "dist\staging"
$distDir = Join-Path $repo "dist"

if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Force -Path $staging | Out-Null

# Everything the extension actually loads at runtime, plus the GPL license
# text (distributed copies should carry it).
$files = @(
  "manifest.json", "LICENSE",
  "background.js", "shared.js", "content.js", "early.js", "welcome.js",
  "options.js", "popup.js",
  "options.html", "popup.html", "welcome.html",
  "preload.css", "features.css", "home.css"
)
foreach ($f in $files) { Copy-Item (Join-Path $repo $f) $staging }
Copy-Item -Recurse (Join-Path $repo "icons") (Join-Path $staging "icons")
Copy-Item -Recurse (Join-Path $repo "pictures") (Join-Path $staging "pictures")

# Strip the "key" field from the staged manifest (CWS rejects it).
$manifestPath = Join-Path $staging "manifest.json"
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8
$manifest = $manifest -replace '(?m)^\s*"key":\s*"[^"]*",?\r?\n', ''
[System.IO.File]::WriteAllText($manifestPath, $manifest, (New-Object System.Text.UTF8Encoding($false)))

# Sanity: staged manifest must still parse and must not contain "key".
$check = Get-Content $manifestPath -Raw | ConvertFrom-Json
if ($check.PSObject.Properties.Name -contains "key") { throw "key field survived the strip" }

$version = $check.version
$zip = Join-Path $distDir "betterfeed-$version.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip

Remove-Item -Recurse -Force $staging
Write-Host "Built $zip"
