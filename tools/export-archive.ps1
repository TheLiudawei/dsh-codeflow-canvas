# Build a privacy-clean source archive of dsh-codeflow-canvas (Windows).
#
# Run via export-archive.cmd, or:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\export-archive.ps1
#
# The launcher exists because the DSH Host's shell tool can be blocked by a
# machine-wide PowerShell execution policy (the workspace preparation script is
# refused before any command starts). This script only copies the shippable
# source, removes runtime/VCS artifacts, checks for the local profile path, and
# calls Compress-Archive.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$out = [IO.Path]::GetFullPath((Join-Path $root '..\dsh-codeflow-canvas-0.6.0.zip'))
if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }

$stage = Join-Path $env:TEMP ('codeflow-export-' + [guid]::NewGuid().ToString('N'))
$dest = Join-Path $stage 'dsh-codeflow-canvas'
New-Item -ItemType Directory -Path $dest -Force | Out-Null

$skip = @('.git', 'node_modules', 'flow-projects', '.DS_Store')
Get-ChildItem -LiteralPath $root -Force | Where-Object {
  $_.Name -notin $skip -and
  $_.Name -notlike '*.log' -and
  $_.Name -notlike '*.zip' -and
  $_.Name -notlike '*.tar'
} | ForEach-Object {
  if ($_.PSIsContainer) {
    Copy-Item -LiteralPath $_.FullName -Destination $dest -Recurse -Force
  } else {
    Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
  }
}

# Defensive cleanup for nested copies.
Get-ChildItem -LiteralPath $dest -Recurse -Force -Directory |
  Where-Object { $_.Name -in @('.git', 'node_modules', 'flow-projects') } |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -LiteralPath $dest -Recurse -Force -File |
  Where-Object { $_.Name -eq '.DS_Store' -or $_.Extension -in @('.log', '.zip', '.tar') } |
  Remove-Item -Force -ErrorAction SilentlyContinue

# Privacy gate. The source uses generic examples only; a hit here means a real
# absolute profile path leaked in.
$needles = @($env:USERPROFILE, ('C:' + '\Users\')) |
  Where-Object { $_ -and $_.Length -gt 3 } |
  Select-Object -Unique
$hits = Get-ChildItem -LiteralPath $dest -Recurse -Force -File |
  Select-String -Pattern $needles -SimpleMatch -ErrorAction SilentlyContinue
if ($hits) {
  $hits | ForEach-Object { Write-Host ('privacy hit: ' + $_.Path + ':' + $_.LineNumber) }
  Remove-Item -LiteralPath $stage -Recurse -Force
  throw 'refusing to package: a local/private path was found in the staged source'
}

Compress-Archive -Path $dest -DestinationPath $out -Force
Remove-Item -LiteralPath $stage -Recurse -Force
Write-Host ('wrote ' + $out)
