# Supabase Bridge Agent v4.0 - Multi-PC + RPA Edition
# 회사 PC에서 실행. Supabase commands 테이블 폴링 + GUI 자동화 지원
# 멀티PC 지원: pc_id 필드로 특정 PC만 명령 수신
# PowerShell 5.1 호환

param(
    [string]$ProjectUrl = "https://rnnigyfzwlgojxyccgsm.supabase.co",
    [string]$AnonKey    = "sb_publishable_Nmv51BZccADB0bN5JY2URw_lLffyFgE",
    [int]$PollSec       = 10,
    [string]$PcId       = ""   # 비어있으면 자동으로 hostname 사용
)

$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$RestBase = "$ProjectUrl/rest/v1"
$global:Running = $true

# PC 식별자 설정 (hostname 기반)
if ([string]::IsNullOrEmpty($PcId)) {
    $PcId = $env:COMPUTERNAME.ToLower()
}

Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  Supabase Bridge Agent v4.0 - Multi-PC RPA Edition"    -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  PC ID  : $PcId"                                        -ForegroundColor Yellow
Write-Host "  Host   : $(hostname)"                                   -ForegroundColor Gray
Write-Host "  Poll   : ${PollSec}s"                                   -ForegroundColor Gray
Write-Host "  Filter : pc_id=$PcId OR pc_id=all OR pc_id is null"     -ForegroundColor Gray
Write-Host "  Actions: run_ps, run_cmd, read_file, write_file,"       -ForegroundColor Gray
Write-Host "           list_dir, ping, screenshot, click,"            -ForegroundColor Gray
Write-Host "           double_click, type_text, key_send,"            -ForegroundColor Gray
Write-Host "           list_windows, activate_window, start_app"      -ForegroundColor Gray
Write-Host "  Stop   : Ctrl+C"                                       -ForegroundColor Yellow
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""

# ========== Load GUI Automation Assemblies ==========
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Win32 API for mouse/keyboard/window control
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
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public const uint MOUSEEVENTF_LEFTDOWN  = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP    = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP   = 0x0010;

    public static string GetWindowTitle(IntPtr hWnd) {
        StringBuilder sb = new StringBuilder(256);
        GetWindowText(hWnd, sb, 256);
        return sb.ToString();
    }

    public static List<IntPtr> GetAllWindows() {
        List<IntPtr> wins = new List<IntPtr>();
        EnumWindows((hWnd, lParam) => { wins.Add(hWnd); return true; }, IntPtr.Zero);
        return wins;
    }
}
"@

# ========== Supabase REST ==========
function Supa {
    param([string]$Method, [string]$Path, [string]$Body = $null)
    $uri = "$RestBase$Path"
    $headers = @{
        "apikey"        = $AnonKey
        "Authorization" = "Bearer $AnonKey"
        "Content-Type"  = "application/json; charset=utf-8"
        "Prefer"        = "return=representation"
    }
    try {
        if ($Body) {
            $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
            Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -Body $bodyBytes -ContentType "application/json; charset=utf-8"
        } else {
            Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers
        }
    } catch {
        Write-Host "[ERROR] Supa $Method $Path : $_" -ForegroundColor Red
        $null
    }
}

# ========== Heartbeat / Registration ==========
function Register-PC {
    # Register this PC in a 'bridge_agents' table (if exists)
    # This allows the relay worker to list available PCs
    $body = @{
        pc_id      = $PcId
        hostname   = $env:COMPUTERNAME
        status     = "online"
        last_seen  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        agent_ver  = "4.0"
    } | ConvertTo-Json -Compress

    try {
        # Upsert - if pc_id exists, update; otherwise insert
        $headers = @{
            "apikey"        = $AnonKey
            "Authorization" = "Bearer $AnonKey"
            "Content-Type"  = "application/json; charset=utf-8"
            "Prefer"        = "resolution=merge-duplicates,return=representation"
        }
        $uri = "$RestBase/bridge_agents"
        $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
        Invoke-RestMethod -Uri $uri -Method 'POST' -Headers $headers -Body $bodyBytes -ContentType "application/json; charset=utf-8" | Out-Null
        Write-Host "[REGISTER] PC registered: $PcId" -ForegroundColor Green
    } catch {
        # bridge_agents table might not exist yet - that's OK
        Write-Host "[INFO] bridge_agents table not found (optional). Continuing..." -ForegroundColor Yellow
    }
}

function Update-Heartbeat {
    try {
        $body = @{
            status    = "online"
            last_seen = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        } | ConvertTo-Json -Compress
        Supa -Method 'PATCH' -Path "/bridge_agents?pc_id=eq.$PcId" -Body $body | Out-Null
    } catch {
        # Ignore heartbeat errors
    }
}

# ========== RPA Functions ==========
function Take-Screenshot {
    param([int]$MaxWidth = 800, [int]$Quality = 30)
    try {
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $g.Dispose()

        $ratio = [Math]::Min(1.0, $MaxWidth / $bounds.Width)
        $newW = [int]($bounds.Width * $ratio)
        $newH = [int]($bounds.Height * $ratio)
        $resized = New-Object System.Drawing.Bitmap($newW, $newH)
        $g2 = [System.Drawing.Graphics]::FromImage($resized)
        $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
        $g2.DrawImage($bmp, 0, 0, $newW, $newH)
        $g2.Dispose()
        $bmp.Dispose()

        $encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
        $encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
        $ms = New-Object System.IO.MemoryStream
        $resized.Save($ms, $encoder, $encParams)
        $resized.Dispose()
        $base64 = [Convert]::ToBase64String($ms.ToArray())
        $ms.Dispose()

        return @{
            success     = $true
            width       = $bounds.Width
            height      = $bounds.Height
            thumbWidth  = $newW
            thumbHeight = $newH
            base64      = $base64
            sizeKB      = [Math]::Round($base64.Length / 1024, 1)
        }
    } catch {
        return @{ success = $false; error = $_.ToString() }
    }
}

function Get-VisibleWindows {
    $windows = @()
    $allWins = [Win32RPA]::GetAllWindows()
    foreach ($hWnd in $allWins) {
        if (-not [Win32RPA]::IsWindowVisible($hWnd)) { continue }
        $title = [Win32RPA]::GetWindowTitle($hWnd)
        if ([string]::IsNullOrWhiteSpace($title)) { continue }
        $rect = New-Object Win32RPA+RECT
        [Win32RPA]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
        $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
        if ($w -le 0 -or $h -le 0) { continue }
        $pid = 0
        [Win32RPA]::GetWindowThreadProcessId($hWnd, [ref]$pid) | Out-Null
        $windows += @{ handle = $hWnd.ToInt64(); title = $title; x = $rect.Left; y = $rect.Top; width = $w; height = $h; pid = $pid }
    }
    return $windows
}

function Click-At {
    param([int]$X, [int]$Y, [string]$Button = "left")
    [Win32RPA]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 100
    if ($Button -eq "left") {
        [Win32RPA]::mouse_event([Win32RPA]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 30
        [Win32RPA]::mouse_event([Win32RPA]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    } elseif ($Button -eq "right") {
        [Win32RPA]::mouse_event([Win32RPA]::MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 30
        [Win32RPA]::mouse_event([Win32RPA]::MOUSEEVENTF_RIGHTUP, 0, 0, 0, [IntPtr]::Zero)
    }
}

function DoubleClick-At {
    param([int]$X, [int]$Y)
    [Win32RPA]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 50
    [Win32RPA]::mouse_event([Win32RPA]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 20
    [Win32RPA]::mouse_event([Win32RPA]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Win32RPA]::mouse_event([Win32RPA]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 20
    [Win32RPA]::mouse_event([Win32RPA]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [IntPtr]::Zero)
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
    $action  = $Cmd.action
    $target  = $Cmd.target
    $content = $Cmd.content

    try {
        switch ($action) {
            'ping' {
                return "pong from $PcId ($env:COMPUTERNAME) at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
            }
            'run_ps' {
                $output = Invoke-Expression $content 2>&1 | Out-String
                return $output.Trim().Substring(0, [Math]::Min(3000, $output.Trim().Length))
            }
            'run_cmd' {
                $output = cmd /c $content 2>&1 | Out-String
                return $output.Trim().Substring(0, [Math]::Min(3000, $output.Trim().Length))
            }
            'read_file' {
                if (Test-Path $target) {
                    $text = Get-Content $target -Raw -Encoding UTF8
                    return $text.Substring(0, [Math]::Min(3000, $text.Length))
                } else {
                    return "ERROR: File not found: $target"
                }
            }
            'write_file' {
                $dir = Split-Path $target -Parent
                if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
                [IO.File]::WriteAllText($target, $content, [Text.Encoding]::UTF8)
                return "Written $($content.Length) chars -> $target"
            }
            'list_dir' {
                $path = if ($target) { $target } else { 'C:\' }
                if (Test-Path $path) {
                    $items = Get-ChildItem $path -Force -ErrorAction SilentlyContinue |
                        Select-Object Name, Length, LastWriteTime, @{N='Type';E={if($_.PSIsContainer){'DIR'}else{'FILE'}}}
                    return ($items | Format-Table -AutoSize | Out-String).Trim()
                } else {
                    return "ERROR: Path not found: $path"
                }
            }
            'screenshot' {
                $maxW = if ($content -match '\d+') { [int]$content } else { 800 }
                $result = Take-Screenshot -MaxWidth $maxW
                if ($result.success) {
                    return "SCREENSHOT:$($result.thumbWidth)x$($result.thumbHeight)|$($result.base64)"
                } else {
                    return "ERROR: $($result.error)"
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
                return "Typed: $($content.Substring(0, [Math]::Min(50, $content.Length)))"
            }
            'key_send' {
                [System.Windows.Forms.SendKeys]::SendWait($content)
                Start-Sleep -Milliseconds 200
                return "Key sent: $content"
            }
            'list_windows' {
                $windows = Get-VisibleWindows
                $lines = $windows | ForEach-Object { "[$($_.pid)] $($_.title) | $($_.width)x$($_.height) at ($($_.x),$($_.y))" }
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
            'list_pcs' {
                # 등록된 모든 PC 목록 반환
                return "This PC: $PcId ($env:COMPUTERNAME)"
            }
            default {
                return "Unknown action: $action"
            }
        }
    } catch {
        return "ERROR executing $action : $_"
    }
}

# ========== Main Loop ==========

# Register this PC on startup
Register-PC

$heartbeatTimer = 0

while ($global:Running) {
    try {
        # Heartbeat every 60 seconds
        $heartbeatTimer++
        if ($heartbeatTimer -ge (60 / $PollSec)) {
            Update-Heartbeat
            $heartbeatTimer = 0
        }

        # Fetch pending commands for this PC
        # 3가지 조건: pc_id가 이 PC와 같거나, 'all'이거나, 비어있는 경우
        $filter = "status=eq.pending&order=created_at.asc&limit=5"
        $filter += "&or=(pc_id.eq.$PcId,pc_id.eq.all,pc_id.is.null)"

        $cmds = Supa -Method 'GET' -Path "/commands?$filter"

        if ($cmds -and $cmds.Count -gt 0) {
            foreach ($cmd in $cmds) {
                $ts = Get-Date -Format 'HH:mm:ss'
                $preview = if ($cmd.target) { $cmd.target } elseif ($cmd.content) { $cmd.content } else { "" }
                $preview = $preview.Substring(0, [Math]::Min(40, $preview.Length))
                Write-Host "[$ts] Executing: $($cmd.action) $preview" -ForegroundColor Green

                # Mark as processing first (claim the command)
                $claimBody = @{ status = "processing"; processed_by = $PcId } | ConvertTo-Json -Compress
                Supa -Method 'PATCH' -Path "/commands?id=eq.$($cmd.id)&status=eq.pending" -Body $claimBody | Out-Null

                $result = Execute-Command -Cmd $cmd

                # Update command with result
                $body = @{
                    status       = "completed"
                    result       = if ($result) { $result.Substring(0, [Math]::Min(60000, $result.Length)) } else { "(no output)" }
                    processed_by = $PcId
                } | ConvertTo-Json -Compress
                $bodyUtf8 = [System.Text.Encoding]::UTF8.GetString([System.Text.Encoding]::UTF8.GetBytes($body))
                Supa -Method 'PATCH' -Path "/commands?id=eq.$($cmd.id)" -Body $bodyUtf8

                Write-Host "[$ts] Done: $($cmd.action) -> $($result.Substring(0, [Math]::Min(80, $result.Length)))" -ForegroundColor Gray
            }
        }
    } catch {
        Write-Host "[ERROR] Poll loop: $_" -ForegroundColor Red
        Start-Sleep -Seconds 5
    }

    Start-Sleep -Seconds $PollSec
}
