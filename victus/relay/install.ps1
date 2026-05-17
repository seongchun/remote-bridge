# Install the victus relay as a Windows service using NSSM.
# Run in an elevated PowerShell prompt (Run as Administrator).
#
# Prereqs:
#   - Node.js 18+ installed (https://nodejs.org/)
#   - claude CLI installed (npm install -g @anthropic-ai/claude-code)
#   - NSSM installed (https://nssm.cc/) and `nssm` on PATH, OR scoop install nssm

$ErrorActionPreference = 'Stop'

$RepoDir   = (Resolve-Path "$PSScriptRoot\..").Path
$ScriptJs  = Join-Path $RepoDir 'relay\relay.mjs'
$CfgDir    = Join-Path $env:USERPROFILE '.config\seongchun-victus'
$EnvFile   = Join-Path $CfgDir 'env.json'
$LogDir    = Join-Path $env:USERPROFILE '.config\seongchun-victus\logs'
$SvcName   = 'VictusRelay'

New-Item -ItemType Directory -Force -Path $CfgDir, $LogDir | Out-Null

if (-not (Test-Path $EnvFile)) {
    Write-Host "Creating env file: $EnvFile"
    $SU = Read-Host 'SUPABASE_URL [https://rnnigyfzwlgojxyccgsm.supabase.co]'
    if ([string]::IsNullOrWhiteSpace($SU)) { $SU = 'https://rnnigyfzwlgojxyccgsm.supabase.co' }
    $SK = Read-Host 'SUPABASE_ANON_KEY'
    $DS = Read-Host 'DISPATCH_SECRET (must match cloud env var)'
    $WR = Read-Host "WORKSPACE_ROOT [$env:USERPROFILE\claude-workspaces]"
    if ([string]::IsNullOrWhiteSpace($WR)) { $WR = "$env:USERPROFILE\claude-workspaces" }
    $CB = (Get-Command claude -ErrorAction SilentlyContinue).Source
    $CBin = Read-Host "CLAUDE_PATH [$CB]"
    if ([string]::IsNullOrWhiteSpace($CBin)) { $CBin = $CB }

    @{
        SUPABASE_URL      = $SU
        SUPABASE_ANON_KEY = $SK
        DISPATCH_SECRET   = $DS
        WORKSPACE_ROOT    = $WR
        CLAUDE_PATH       = $CBin
        RELAY_TARGET      = 'victus'
    } | ConvertTo-Json | Set-Content -Path $EnvFile -Encoding utf8

    New-Item -ItemType Directory -Force -Path (Join-Path $WR 'default') | Out-Null
}

$NodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeBin) { throw 'Node.js not found on PATH. Install Node 18+ from https://nodejs.org/' }

$Nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $Nssm) { throw "NSSM not found on PATH. Install via 'scoop install nssm' or download from https://nssm.cc/" }

# Stop+remove existing service if present
& $Nssm stop    $SvcName 2>$null | Out-Null
& $Nssm remove  $SvcName confirm 2>$null | Out-Null

& $Nssm install $SvcName $NodeBin $ScriptJs
& $Nssm set     $SvcName AppDirectory $RepoDir
& $Nssm set     $SvcName AppStdout    (Join-Path $LogDir 'relay.out.log')
& $Nssm set     $SvcName AppStderr    (Join-Path $LogDir 'relay.err.log')
& $Nssm set     $SvcName AppRotateFiles 1
& $Nssm set     $SvcName AppRotateBytes 10485760
& $Nssm set     $SvcName Start SERVICE_AUTO_START
& $Nssm set     $SvcName AppExit Default Restart
& $Nssm set     $SvcName AppRestartDelay 5000

# Load env vars from the JSON file and apply them to the service environment
$envObj = Get-Content $EnvFile -Raw | ConvertFrom-Json
$envPairs = $envObj.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }
& $Nssm set $SvcName AppEnvironmentExtra $envPairs

& $Nssm start $SvcName

Write-Host ''
Write-Host "Installed service: $SvcName"
Write-Host "Logs: $LogDir\relay.out.log"
Write-Host "Verify: Get-Content $LogDir\relay.out.log -Tail 30 -Wait"
Write-Host "Control: Stop-Service $SvcName / Start-Service $SvcName / Restart-Service $SvcName"
