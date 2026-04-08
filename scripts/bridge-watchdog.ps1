# Remote Bridge Watchdog v2.0
# Auto-restarts bridge agent if it dies
# Checks every 60 seconds
# Fixed: Now looks for both supabase-bridge-agent AND bridge-agent
# Fixed: Uses -WindowStyle Hidden to prevent visible windows

$bridgeScript = "C:\RemoteBridge\scripts\supabase-bridge-agent.ps1"
$logFile = "C:\RemoteBridge\logs\watchdog.log"

# Create log directory if needed
$logDir = Split-Path $logFile -Parent
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

Write-Log "Watchdog v2.0 started (PID=$PID)"

while ($true) {
    try {
        # Look for ANY bridge agent process (both old and new names)
        $procs = Get-Process powershell -ErrorAction SilentlyContinue | Where-Object {
            try {
                $cmd = (Get-WmiObject Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
                ($cmd -match 'bridge-agent' -or $cmd -match 'supabase-bridge-agent') -and $_.Id -ne $PID
            } catch { $false }
        }

        if (-not $procs) {
            Write-Log "Bridge not running, restarting..."
            # Use -WindowStyle Hidden to prevent visible PowerShell windows
            Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$bridgeScript`"" -WindowStyle Hidden
            Write-Log "Bridge restarted (hidden window)"
            Start-Sleep 15
        }
    } catch {
        Write-Log "Error: $_"
    }

    Start-Sleep 60
}
