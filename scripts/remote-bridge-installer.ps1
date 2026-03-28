# ============================================================
#  Remote Bridge - One-Click Installer v4.0
#  이 스크립트른 회사 PC에서 딱 1번만 실행하면:
#  1) 브릿지 에이전트 설치 (PS 5.1 호환)
#  2) Watchdog (감시자) 설치 - 브릿지 죽으면 자동 재시작
#  3) 자동 업데이트 기능 - 원격으로 스크립트 교체 가능
#  4) Windows 시작 시 자동 실행 등록
#  5) 즉시 시작
#
#  이후에는 회사 PC른 건드릴 필요가 없습니다.
# ============================================================

$ErrorActionPreference = 'Continue'

# === CONFIG ===
$BASE_DIR = "C:\RemoteBridge"
$SCRIPTS_DIR = "$BASE_DIR\scripts"
$LOGS_DIR = "$BASE_DIR\logs"
$TEMP_DIR = "$BASE_DIR\temp"
$PROJECT_URL = "https://rnnigyfzwlgojxyccgsm.supabase.co"
$ANON_KEY = "sb_publishable_Nmv51BZccADB0bN5JY2URw_lLffyFgE"

Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  Remote Bridge Installer v4.0 - Self-Healing Edition" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

# === STEP 1: Create directories ===
Write-Host "[1/6] Creating directories..." -ForegroundColor Yellow
foreach ($d in @($BASE_DIR, $SCRIPTS_DIR, $LOGS_DIR, $TEMP_DIR)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
Write-Host "      OK" -ForegroundColor Green

# === STEP 2: Write Bridge Agent v4 (PS 5.1 compatible) ===
Write-Host "[2/6] Installing Bridge Agent v4..." -ForegroundColor Yellow

$bridgeScript = @'
# Supabase Bridge Agent v4.0 - Self-Healing RPA Edition
# PowerShell 5.1 Compatible (NO ?? operator, NO ternary)
param(
    [string]$ProjectUrl = "https://rnnigyfzwlgojxyccgsm.supabase.co",
    [string]$AnonKey = "sb_publishable_Nmv51BZccADB0bN5JY2URw_lLffyFgE",
    [int]$PollSec = 8
)

$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$RestBase = "$ProjectUrl/rest/v1"
$global:Running = $true
$global:Version = "4.0"
$logFile = "C:\RemoteBridge\logs\bridge.log"

function Write-Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $msg"
    Write-Host $line
    try { $line | Out-File -FilePath $logFile -Append -Encoding utf8 -ErrorAction SilentlyContinue } catch {}
}

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  Supabase Bridge Agent v4.0 - Self-Healing RPA" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  Host    : $(hostname)" -ForegroundColor Gray
Write-Host "  User    : $env:USERNAME" -ForegroundColor Gray
Write-Host "  Poll    : ${PollSec}s" -ForegroundColor Gray
Write-Host "  Version : $global:Version" -ForegroundColor Gray
Write-Host "  PID     : $PID" -ForegroundColor Gray
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

# ========== Load GUI Assemblies ==========
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class Win32RPA {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    public const uint MOUSEEVENTF_LEFTDOWN = 0x02;
    public const uint MOUSEEVENTF_LEFTUP = 0x04;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x08;
    public const uint MOUSEEVENTF_RIGHTUP = 0x10;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static List<Dictionary<string, object>> GetWindows() {
        var result = new List<Dictionary<string, object>>();
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            string title = sb.ToString();
            if (string.IsNullOrWhiteSpace(title)) return true;
            RECT r;
            GetWindowRect(hWnd, out r);
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            var d = new Dictionary<string, object>();
            d["handle"] = hWnd.ToInt64();
            d["title"] = title;
            d["pid"] = pid;
            d["x"] = r.Left; d["y"] = r.Top;
            d["width"] = r.Right - r.Left;
            d["height"] = r.Bottom - r.Top;
            result.Add(d);
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
"@

# ========== Supabase HTTP ==========
function Supa {
    param([string]$Method, [string]$Path, [string]$Body)
    $headers = @{
        'apikey' = $AnonKey
        'Authorization' = "Bearer $AnonKey"
        'Content-Type' = 'application/json; charset=utf-8'
        'Prefer' = 'return=representation'
    }
    $uri = "$RestBase$Path"
    $params = @{ Uri = $uri; Method = $Method; Headers = $headers; ContentType = 'application/json; charset=utf-8' }
    if ($Body) { $params.Body = [System.Text.Encoding]::UTF8.GetBytes($Body) }
    try {
        return Invoke-RestMethod @params
    } catch {
        Write-Log "ERROR Supa $Method $Path : $_"
        return $null
    }
}

# ========== RPA Functions ==========
function Take-Screenshot {
    param([int]$MaxWidth = 800)
    try {
        $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
        $gfx = [System.Drawing.Graphics]::FromImage($bmp)
        $gfx.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
        $gfx.Dispose()

        $ratio = [Math]::Min(1.0, $MaxWidth / $screen.Width)
        $newW = [int]($screen.Width * $ratio)
        $newH = [int]($screen.Height * $ratio)
        $thumb = New-Object System.Drawing.Bitmap($newW, $newH)
        $gfx2 = [System.Drawing.Graphics]::FromImage($thumb)
        $gfx2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $gfx2.DrawImage($bmp, 0, 0, $newW, $newH)
        $gfx2.Dispose()
        $bmp.Dispose()

        $ms = New-Object System.IO.MemoryStream
        $thumb.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $thumb.Dispose()
        $bytes = $ms.ToArray()
        $ms.Dispose()

        return @{
            success = $true
            base64 = [Convert]::ToBase64String($bytes)
            width = $screen.Width; height = $screen.Height
            thumbWidth = $newW; thumbHeight = $newH
            sizeKB = [Math]::Round($bytes.Length / 1024, 1)
        }
    } catch {
        return @{ success = $false; error = "$_" }
    }
}

function Get-VisibleWindows {
    $wins = [Win32RPA]::GetWindows()
    return $wins | ForEach-Object {
        [PSCustomObject]@{
            handle = $_['handle']; title = $_['title']; pid = $_['pid']
            x = $_['x']; y = $_['y']; width = $_['width']; height = $_['height']
        }
    }
}

function Click-At {
    param([int]$X, [int]$Y, [string]$Button = "left")
    [Win32RPA]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 50
    if ($Button -eq "right") {
        [Win32RPA]::mouse_event([Win32RPA]::MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, [IntPtr]::Zero)
        [Win32RPA]::mouse_event([Win32RPA]::MOUSEEVENTF_RIGHTUP, 0, 0, 0, [IntPtr]::Zero)
    } else {
        [Win32RPA]::mouse_event([Win32RPA]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
        [Win32RPA]::mouse_event([Win32RPA]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    }
}

function DoubleClick-At {
    param([int]$X, [int]$Y)
    Click-At -X $X -Y $Y -Button "left"
    Start-Sleep -Milliseconds 80
    Click-At -X $X -Y $Y -Button "left"
}

function Activate-WindowByTitle {
    param([string]$TitlePattern)
    $windows = Get-VisibleWindows
    $match = $windows | Where-Object { $_.title -like "*$TitlePattern*" } | Select-Object -First 1
    if ($match) {
        $hWnd = [IntPtr]::new($match.handle)
        [Win32RPA]::ShowWindow($hWnd, 9) | Out-Null
        Start-Sleep -Milliseconds 200
        [Win32RPA]::SetForegroundWindow($hWnd) | Out-Null
        Start-Sleep -Milliseconds 300
        return "Activated: $($match.title) ($($match.width)x$($match.height) at $($match.x),$($match.y))"
    } else {
        $titles = ($windows | ForEach-Object { $_.title }) -join "`n"
        return "Window not found matching '$TitlePattern'. Open windows:`n$titles"
    }
}

# ========== Command Execution ==========
function Execute-Command {
    param($Cmd)
    $action = $Cmd.action
    $target = $Cmd.target
    $content = $Cmd.content

    try {
        switch ($action) {
            'ping' {
                return "pong from $(hostname) v$global:Version at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') PID=$PID"
            }
            'run_ps' {
                $output = Invoke-Expression $content 2>&1 | Out-String
                $trimmed = $output.Trim()
                $maxLen = [Math]::Min(50000, $trimmed.Length)
                return $trimmed.Substring(0, $maxLen)
            }
            'run_cmd' {
                $output = cmd /c $content 2>&1 | Out-String
                $trimmed = $output.Trim()
                $maxLen = [Math]::Min(50000, $trimmed.Length)
                return $trimmed.Substring(0, $maxLen)
            }
            'read_file' {
                if (Test-Path $target) {
                    $text = Get-Content $target -Raw -Encoding UTF8
                    $maxLen = [Math]::Min(50000, $text.Length)
                    return $text.Substring(0, $maxLen)
                } else {
                    return "ERROR: File not found: $target"
                }
            }
            'write_file' {
                $dir = Split-Path $target -Parent
                if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
                [IO.File]::WriteAllText($target, $content, [Text.Encoding]::UTF8)
                return "OK: written $($content.Length) chars -> $target"
            }
            'list_dir' {
                $path = if ($target) { $target } else { 'C:\' }
                if (Test-Path $path) {
                    $items = Get-ChildItem $path -Force -ErrorAction SilentlyContinue | Select-Object Name, Length, LastWriteTime, @{N='Type';E={if($_.PSIsContainer){'DIR'}else{'FILE'}}}
                    return ($items | Format-Table -AutoSize | Out-String).Trim()
                } else {
                    return "ERROR: Path not found: $path"
                }
            }

            # ===== RPA ACTIONS =====
            'screenshot' {
                $maxW = 800
                if ($content -and $content -match '^\d+$') { $maxW = [int]$content }
                $result = Take-Screenshot -MaxWidth $maxW
                if ($result.success) {
                    $windows = Get-VisibleWindows | ForEach-Object {
                        "$($_.title) | $($_.width)x$($_.height) at ($($_.x),$($_.y))"
                    }
                    $windowList = $windows -join "`n"
                    $json = @{
                        type = "screenshot"
                        screen = "$($result.width)x$($result.height)"
                        thumb = "$($result.thumbWidth)x$($result.thumbHeight)"
                        sizeKB = $result.sizeKB
                        image_base64 = $result.base64
                        windows = $windowList
                    } | ConvertTo-Json -Compress
                    return $json
                } else {
                    return "ERROR: Screenshot failed: $($result.error)"
                }
            }
            'click' {
                $params = $content | ConvertFrom-Json
                $btn = if ($params.button) { $params.button } else { "left" }
                Click-At -X $params.x -Y $params.y -Button $btn
                Start-Sleep -Milliseconds 300
                return "Clicked at ($($params.x), $($params.y)) button=$btn"
            }
            'double_click' {
                $params = $content | ConvertFrom-Json
                DoubleClick-At -X $params.x -Y $params.y
                Start-Sleep -Milliseconds 500
                return "Double-clicked at ($($params.x), $($params.y))"
            }
            'type_text' {
                [System.Windows.Forms.SendKeys]::SendWait($content)
                Start-Sleep -Milliseconds 200
                $showLen = [Math]::Min(50, $content.Length)
                return "Typed: $($content.Substring(0, $showLen))"
            }
            'key_send' {
                [System.Windows.Forms.SendKeys]::SendWait($content)
                Start-Sleep -Milliseconds 200
                return "Key sent: $content"
            }
            'list_windows' {
                $windows = Get-VisibleWindows
                $lines = $windows | ForEach-Object {
                    "[$($_.pid)] $($_.title) | $($_.width)x$($_.height) at ($($_.x),$($_.y))"
                }
                return ($lines -join "`n")
            }
            'activate_window' {
                return Activate-WindowByTitle -TitlePattern $content
            }
            'start_app' {
                $waitTitle = $content
                try {
                    Start-Process $target
                    if ($waitTitle) {
                        for ($i = 0; $i -lt 15; $i++) {
                            Start-Sleep -Seconds 1
                            $wins = Get-VisibleWindows | Where-Object { $_.title -like "*$waitTitle*" }
                            if ($wins.Count -gt 0) {
                                $w = $wins[0]
                                return "Started: $target -> Window: $($w.title) ($($w.width)x$($w.height))"
                            }
                        }
                        return "Started: $target but window '$waitTitle' not found after 15s"
                    } else {
                        Start-Sleep -Seconds 2
                        return "Started: $target"
                    }
                } catch {
                    return "ERROR starting $target : $_"
                }
            }

            # ===== SELF-MANAGEMENT ACTIONS =====
            'self_update' {
                # content = new script content, target = which file to update
                $filePath = if ($target) { $target } else { "C:\RemoteBridge\scripts\bridge-agent-v4.ps1" }
                $dir = Split-Path $filePath -Parent
                if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
                [IO.File]::WriteAllText($filePath, $content, [Text.Encoding]::UTF8)
                return "OK: Updated $filePath ($($content.Length) chars). Restart bridge to apply."
            }
            'self_restart' {
                # Schedule restart via watchdog by exiting cleanly
                Write-Log "Self-restart requested. Exiting for watchdog to restart..."
                $global:Running = $false
                return "OK: Bridge exiting. Watchdog will restart in ~60s."
            }
            'deploy_html' {
                # Deploy HTML file to a location accessible from company PC browser
                $filePath = if ($target) { $target } else { "C:\RemoteBridge\web\cowork-clone.html" }
                $dir = Split-Path $filePath -Parent
                if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
                [IO.File]::WriteAllText($filePath, $content, [Text.Encoding]::UTF8)
                return "OK: HTML deployed to $filePath ($($content.Length) chars)"
            }
            'get_status' {
                $uptime = (Get-Date) - (Get-Process -Id $PID).StartTime
                $info = @{
                    version = $global:Version
                    hostname = $(hostname)
                    user = $env:USERNAME
                    pid = $PID
                    uptime_minutes = [Math]::Round($uptime.TotalMinutes, 1)
                    time = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
                    bridge_path = $MyInvocation.ScriptName
                    watchdog_running = $( (Get-Process powershell -EA SilentlyContinue | Where-Object { try { (Get-WmiObject Win32_Process -Filter "ProcessId=$($_.Id)" -EA SilentlyContinue).CommandLine -match 'watchdog' } catch { $false } }).Count -gt 0 )
                } | ConvertTo-Json
                return $info
            }

            default {
                return "Unknown action: $action. Available: ping, run_ps, run_cmd, read_file, write_file, list_dir, screenshot, click, double_click, type_text, key_send, list_windows, activate_window, start_app, self_update, self_restart, deploy_html, get_status"
            }
        }
    } catch {
        return "ERROR executing $action : $_"
    }
}

# ========== Main Loop ==========
Write-Log "Bridge v$global:Version started. Polling every ${PollSec}s..."

$errorCount = 0
while ($global:Running) {
    try {
        $cmds = Supa -Method 'GET' -Path '/commands?status=eq.pending&order=created_at.asc&limit=5'
        $errorCount = 0  # Reset on success

        if ($cmds -and $cmds.Count -gt 0) {
            foreach ($cmd in $cmds) {
                Write-Log ">> $($cmd.action) $(if($cmd.target){$cmd.target}else{$cmd.content})"

                # Mark as processing
                $processingBody = '{"status":"processing"}'
                Supa -Method 'PATCH' -Path "/commands?id=eq.$($cmd.id)" -Body $processingBody | Out-Null

                $result = Execute-Command -Cmd $cmd

                # Update with result
                $resultText = if ($result) { $result } else { "(no output)" }
                $maxLen = [Math]::Min(60000, $resultText.Length)
                $resultText = $resultText.Substring(0, $maxLen)

                $body = @{
                    status = "completed"
                    result = $resultText
                } | ConvertTo-Json -Compress
                $bodyBytes = [System.Text.Encoding]::UTF8.GetString([System.Text.Encoding]::UTF8.GetBytes($body))
                Supa -Method 'PATCH' -Path "/commands?id=eq.$($cmd.id)" -Body $bodyBytes

                Write-Log "<< $($cmd.action) done ($($resultText.Length) chars)"
            }
        }
    } catch {
        $errorCount++
        Write-Log "ERROR in poll loop ($errorCount): $_"
        if ($errorCount -ge 10) {
            Write-Log "Too many consecutive errors. Sleeping 60s..."
            Start-Sleep -Seconds 60
            $errorCount = 0
        } else {
            Start-Sleep -Seconds 5
        }
    }

    Start-Sleep -Seconds $PollSec
}

Write-Log "Bridge stopped."
'@

$bridgePath = "$SCRIPTS_DIR\bridge-agent-v4.ps1"
[IO.File]::WriteAllText($bridgePath, $bridgeScript, [Text.Encoding]::UTF8)
Write-Host "      Bridge Agent v4 installed -> $bridgePath" -ForegroundColor Green

# === STEP 3: Write Watchdog ===
Write-Host "[3/6] Installing Watchdog..." -ForegroundColor Yellow

$watchdogScript = @'
# Bridge Watchdog - Keeps the bridge alive forever
# Checks every 45 seconds. If bridge is dead, restarts it.
$bridgeScript = "C:\RemoteBridge\scripts\bridge-agent-v4.ps1"
$logFile = "C:\RemoteBridge\logs\watchdog.log"

if (-not (Test-Path "C:\RemoteBridge\logs")) {
    New-Item -ItemType Directory -Path "C:\RemoteBridge\logs" -Force | Out-Null
}

function Write-Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts - $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

Write-Log "Watchdog started (PID=$PID)"

while ($true) {
    try {
        $bridgeProcs = Get-Process powershell -ErrorAction SilentlyContinue | Where-Object {
            try {
                $cmd = (Get-WmiObject Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
                $cmd -match "bridge-agent-v4"
            } catch { $false }
        }

        if (-not $bridgeProcs -or $bridgeProcs.Count -eq 0) {
            Write-Log "Bridge not running! Restarting..."
            Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"$bridgeScript`"" -WindowStyle Minimized
            Write-Log "Bridge restart command sent"
            Start-Sleep -Seconds 10  # Wait for it to start
        }
    } catch {
        Write-Log "Watchdog error: $_"
    }

    Start-Sleep -Seconds 45
}
'@

$watchdogPath = "$SCRIPTS_DIR\bridge-watchdog.ps1"
[IO.File]::WriteAllText($watchdogPath, $watchdogScript, [Text.Encoding]::UTF8)
Write-Host "      Watchdog installed -> $watchdogPath" -ForegroundColor Green

# === STEP 4: Create start scripts ===
Write-Host "[4/6] Creating start scripts..." -ForegroundColor Yellow

# Start bridge script
$startBridge = @"
@echo off
title Remote Bridge Agent v4.0
chcp 65001 >nul
echo ============================================================
echo   Starting Bridge Agent v4.0 (Self-Healing RPA Edition)
echo   Press Ctrl+C to stop
echo ============================================================
powershell -ExecutionPolicy Bypass -File "C:\RemoteBridge\scripts\bridge-agent-v4.ps1"
echo.
echo [!] Bridge agent stopped.
pause
"@
[IO.File]::WriteAllText("$SCRIPTS_DIR\start-bridge.bat", $startBridge, [Text.Encoding]::UTF8)

# Start all (bridge + watchdog)
$startAll = @"
@echo off
title Remote Bridge - Starting All Services
chcp 65001 >nul
echo ============================================================
echo   Starting Remote Bridge Services
echo ============================================================
echo.
echo [1] Starting Watchdog (hidden)...
start /min powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\RemoteBridge\scripts\bridge-watchdog.ps1"
echo [2] Starting Bridge Agent v4...
start powershell -ExecutionPolicy Bypass -File "C:\RemoteBridge\scripts\bridge-agent-v4.ps1"
echo.
echo All services started!
echo - Bridge: visible window (minimize to tray)
echo - Watchdog: hidden (auto-restarts bridge if it crashes)
echo.
timeout /t 5
"@
[IO.File]::WriteAllText("$SCRIPTS_DIR\start-all.bat", $startAll, [Text.Encoding]::UTF8)

Write-Host "      start-bridge.bat, start-all.bat created" -ForegroundColor Green

# === STEP 5: Register auto-start ===
Write-Host "[5/6] Setting up auto-start on login..." -ForegroundColor Yellow

# Method 1: Try Windows Task Scheduler
$taskCreated = $false
try {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogPath`""
    $trigger = New-ScheduledTaskTrigger -AtLogon
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)

    Unregister-ScheduledTask -TaskName "RemoteBridgeWatchdog" -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName "RemoteBridgeWatchdog" -Action $action -Trigger $trigger -Settings $settings -Description "Keeps Remote Bridge alive" | Out-Null

    $taskCreated = $true
    Write-Host "      Task Scheduler: OK (auto-start on login)" -ForegroundColor Green
} catch {
    Write-Host "      Task Scheduler: SKIPPED (no admin rights)" -ForegroundColor Yellow
}

# Method 2: Startup folder shortcut (works without admin)
try {
    $startupPath = [Environment]::GetFolderPath('Startup')
    $shortcutFile = "$startupPath\RemoteBridgeWatchdog.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($shortcutFile)
    $lnk.TargetPath = "powershell.exe"
    $lnk.Arguments = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogPath`""
    $lnk.WorkingDirectory = $SCRIPTS_DIR
    $lnk.Description = "Remote Bridge Watchdog - Auto-restart"
    $lnk.Save()
    Write-Host "      Startup shortcut: OK ($shortcutFile)" -ForegroundColor Green
} catch {
    Write-Host "      Startup shortcut: FAILED ($_)" -ForegroundColor Red
}

# === STEP 6: Kill old bridges and start fresh ===
Write-Host "[6/6] Starting services..." -ForegroundColor Yellow

# Kill any old bridge processes
Get-Process powershell -ErrorAction SilentlyContinue | Where-Object {
    $_.Id -ne $PID -and (
        try {
            $cmd = (Get-WmiObject Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
            $cmd -match "bridge-agent" -or $cmd -match "bridge-watchdog" -or $cmd -match "supabase-bridge"
        } catch { $false }
    )
} | ForEach-Object {
    Write-Host "      Stopping old process PID=$($_.Id)..." -ForegroundColor Gray
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2

# Start watchdog (hidden)
Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogPath`"" -WindowStyle Hidden
Write-Host "      Watchdog started (hidden)" -ForegroundColor Green

# Start bridge
Start-Process powershell -ArgumentList "-ExecutionPolicy Bypass -File `"$bridgePath`""
Write-Host "      Bridge Agent v4 started" -ForegroundColor Green

Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  INSTALLATION COMPLETE!" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Bridge Agent v4 + Watchdog are now running." -ForegroundColor White
Write-Host ""
Write-Host "  Features:" -ForegroundColor Gray
Write-Host "  - Bridge crashes -> Watchdog restarts it in ~45s" -ForegroundColor Gray
Write-Host "  - PC reboots -> Watchdog auto-starts on login" -ForegroundColor Gray
Write-Host "  - Remote update: send 'self_update' command" -ForegroundColor Gray
Write-Host "  - Remote restart: send 'self_restart' command" -ForegroundColor Gray
Write-Host "  - Remote status: send 'get_status' command" -ForegroundColor Gray
Write-Host "  - Remote HTML deploy: send 'deploy_html' command" -ForegroundColor Gray
Write-Host ""
Write-Host "  You should NEVER need to touch this PC again." -ForegroundColor Yellow
Write-Host ""
Write-Host "  Files:" -ForegroundColor Gray
Write-Host "  - $bridgePath" -ForegroundColor Gray
Write-Host "  - $watchdogPath" -ForegroundColor Gray
Write-Host "  - $LOGS_DIR\bridge.log" -ForegroundColor Gray
Write-Host "  - $LOGS_DIR\watchdog.log" -ForegroundColor Gray
Write-Host ""
