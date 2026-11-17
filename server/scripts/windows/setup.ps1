# One-step BugSnap setup for Windows. Run setup.cmd in the project folder (double-click it).
#
#   1. Installs Node.js and ffmpeg with winget if they are missing
#   2. Installs the server's packages
#   3. Starts the server in the background at every logon (scheduled task "BugSnap Server")
#   4. Opens the setup page in your browser, which walks you through the rest
#
# Safe to run again at any time (after an update, for example): it only does what is missing
# and restarts the server so it runs the latest code.
#   -Check   only report what is installed; change nothing

param([switch]$Check)

$ErrorActionPreference = 'Stop'
$server = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$root = Split-Path $server -Parent
$extension = Join-Path $root 'extension'
$port = 4800
$minNode = [version]'22.9.0'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step($n, $text) { Write-Host ''; Write-Host "[$n/4] $text" -ForegroundColor White }
function Ok($text) { Write-Host "  OK  $text" -ForegroundColor Green }
function Todo($text) { Write-Host "  ..  $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "  !!  $text" -ForegroundColor Red; Write-Host ''; exit 1 }

# winget changes PATH in the registry; pick that up without opening a new window.
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Node-Version {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  try { return [version](& node -p 'process.versions.node') } catch { return $null }
}

function Find-Ffmpeg {
  $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  # winget's portable ffmpeg, in case its folder is not on PATH yet.
  $hit = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Filter ffmpeg.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { return $hit.FullName }
  return $null
}

function Winget-Install($id, $name) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Fail "$name is missing and winget is not available. Install $name yourself, then run setup again."
  }
  Todo "Installing $name (a Windows prompt may ask for permission)..."
  & winget install --id $id -e --silent --accept-source-agreements --accept-package-agreements | Out-Host
  Refresh-Path
}

function Server-Up {
  try { return (Invoke-WebRequest "http://127.0.0.1:$port/healthz" -UseBasicParsing -TimeoutSec 2).Content -eq 'ok' } catch { return $false }
}

Write-Host ''
Write-Host '  BugSnap setup' -ForegroundColor White
Write-Host "  $root" -ForegroundColor DarkGray

# ---------------------------------------------------------------- 1. Node.js and ffmpeg
Step 1 'Node.js and ffmpeg'
$nodeV = Node-Version
if ($nodeV -and $nodeV -ge $minNode) { Ok "Node.js $nodeV" }
elseif ($Check) { Todo "Node.js $minNode or newer is needed (found: $(if ($nodeV) { $nodeV } else { 'none' }))" }
else {
  Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js'
  $nodeV = Node-Version
  if (-not $nodeV -or $nodeV -lt $minNode) { Fail "Node.js $minNode or newer is still missing. Close this window, open a new one and run setup again." }
  Ok "Node.js $nodeV installed"
}

$ffmpeg = Find-Ffmpeg
if ($ffmpeg) { Ok "ffmpeg ($ffmpeg)" }
elseif ($Check) { Todo 'ffmpeg is missing (needed for smooth seeking, thumbnails and trimming)' }
else {
  Winget-Install 'Gyan.FFmpeg' 'ffmpeg'
  $ffmpeg = Find-Ffmpeg
  if (-not $ffmpeg) { Fail 'ffmpeg is still missing. Close this window, open a new one and run setup again.' }
  Ok "ffmpeg installed ($ffmpeg)"
}

# ---------------------------------------------------------------- 2. packages and .env
Step 2 'Server packages'
$envFile = Join-Path $server '.env'
if ($Check) {
  if (Test-Path (Join-Path $server 'node_modules\express')) { Ok 'Packages installed' } else { Todo 'Packages not installed yet' }
} else {
  Push-Location $server
  try {
    & npm install --omit=dev --no-audit --no-fund --loglevel=error | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail 'npm install failed (see above). Check your internet connection and run setup again.' }
  } finally { Pop-Location }
  Ok 'Packages installed'
  if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $server '.env.example') $envFile; Ok 'Created server\.env (settings are made on the setup page; you rarely need this file)' }
  # ffmpeg found outside PATH: tell the server where it is.
  if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue) -and $ffmpeg) {
    $lines = @(Get-Content $envFile | Where-Object { $_ -notmatch '^\s*FFMPEG_PATH\s*=' })
    $lines += "FFMPEG_PATH=$ffmpeg"
    [IO.File]::WriteAllLines($envFile, [string[]]$lines)  # UTF-8 without BOM, as node expects
    Ok 'Saved the ffmpeg location in server\.env'
  }
}

# ---------------------------------------------------------------- 3. background server
Step 3 'Background server (starts when you log in)'
$task = Get-ScheduledTask -TaskName 'BugSnap Server' -ErrorAction SilentlyContinue
$autostart = Join-Path $PSScriptRoot 'install-autostart.ps1'
if ($Check) {
  if ($task) { Ok 'Auto-start is on' } else { Todo 'Auto-start is not set up yet' }
  if (Server-Up) { Ok "Server running on port $port" } else { Todo "Server not running on port $port" }
} else {
  $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($busy -and -not (Server-Up)) {
    $owner = (Get-Process -Id $busy.OwningProcess -ErrorAction SilentlyContinue).ProcessName
    Fail "Port $port is used by another program ($owner). Close it, or set PORT in server\.env, then run setup again."
  }
  if ($task) { & $autostart -Restart | Out-Host } else { & $autostart | Out-Host }
  $waited = 0
  while (-not (Server-Up) -and $waited -lt 40) { Start-Sleep -Seconds 1; $waited++ }
  if (-not (Server-Up)) { Fail "The server did not start. See $server\data\server.log" }
  Ok "Server running at http://localhost:$port"
}

# ---------------------------------------------------------------- 4. the rest happens in the browser
Step 4 'Finish in your browser'
if ($Check) { Say "  Setup page: http://localhost:$port/setup"; Write-Host ''; return }
try { Set-Clipboard -Value $extension } catch { }
Start-Process "http://localhost:$port/setup"
Ok 'Opened the setup page'
Write-Host ''
Write-Host '  Next: load the browser extension (the setup page shows these steps too):' -ForegroundColor White
Say '    1. Open chrome://extensions  (Brave: brave://extensions, Edge: edge://extensions)'
Say '    2. Turn on "Developer mode" (top right)'
Say '    3. Click "Load unpacked" and paste this folder (already copied for you):'
Write-Host "       $extension" -ForegroundColor Cyan
Write-Host ''
