$ErrorActionPreference = 'Stop'

$configPath = Join-Path $PSScriptRoot 'openclaw.project.json'
if (-not (Test-Path $configPath)) {
  throw "Missing project config: $configPath"
}

# Pin OpenClaw to the project-local Node runtime so the global node version does not matter.
$nodeHome = Join-Path (Split-Path $PSScriptRoot -Parent) '.local-tools\node-v24.15.0-win-x64'
if (-not (Test-Path $nodeHome)) {
  throw "Missing local Node runtime: $nodeHome"
}
$env:PATH = "$nodeHome;$env:PATH"

# Use the project-local OpenClaw config so validation does not depend on the global profile.
$env:OPENCLAW_CONFIG_PATH = $configPath

& npm run build
& "C:\Users\Lenovo\AppData\Local\pnpm\openclaw.cmd" plugins validate --entry ./dist/index.js
