# Remote Bridge Watchdog v1.0
# Auto-restarts bridge agent if it dies
# Checks every 45 seconds

$bridgeScript = "C:\RemoteBridge\scripts\bridge-agent.ps1"
$logFile = "C:\RemoteBridge\logs\watchdog.log"

function Write-Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

Write-Log "Watchdog started (PID=$PID)"

while ($true) {
    try {
        $procs = Get-Process powershell -ErrorAction SilentlyContinue | Where-Object {
            try {
                $cmd = (Get-WmiObject Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
                $cmd -match 'bridge-agent' -and $_.Id -ne $PID
            } catch { $false }
        }
        if (-not $procs) {
            Write-Log "Bridge not running, restarting..."
            Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"$bridgeScript`"" -WindowStyle Minimized
            Write-Log "Bridge restarted"
            Start-Sleep 10
        }
    } catch {
        Write-Log "Error: $_"
    }
    Start-Sleep 45
}
