$ErrorActionPreference = 'Stop'

$configPath = Join-Path $PSScriptRoot 'openclaw.project.json'
if (-not (Test-Path $configPath)) {
  throw "Missing project config: $configPath"
}

# Pin OpenClaw to the project-local Node runtime so Gateway startup uses the same version.
$nodeHome = Join-Path (Split-Path $PSScriptRoot -Parent) '.local-tools\node-v24.15.0-win-x64'
if (-not (Test-Path $nodeHome)) {
  throw "Missing local Node runtime: $nodeHome"
}
$env:PATH = "$nodeHome;$env:PATH"

# This keeps OpenClaw pointed at the project-local config instead of the global profile.
$env:OPENCLAW_CONFIG_PATH = $configPath
$env:OPENCLAW_BRIDGE_USER_ID = 'openclaw-local'

& "C:\Users\Lenovo\AppData\Local\pnpm\openclaw.cmd" gateway restart
