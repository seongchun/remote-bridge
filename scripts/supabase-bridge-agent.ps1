# Supabase Bridge Agent v4.0 - Multi-PC + RPA Edition
# 회사 PC에서 실행. Supabase commands 테이블 폴링 + GUI 자동화 지원
# 멀티PC 지원: pc_id 필드로 퉹정 PC만 명령 수신
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
  H�]\���T��Ԏ�	
	�\�[�\��܊H��B�B�	��X���	\�[\�H	�۝[��۝�\����KR��ۂ�	��HY�
	\�[\˘�]ۊH�	\�[\˘�]ۈH[�H��Y��B��X��P]V	\�[\˞VH	\�[\˞HP�]ۈ	����\�T�Y\SZ[\�X�ۙ����]\����X��Y]
	
	\�[\˞
K	
	\�[\˞JJH�]ۏI����B�	��X�W��X���	\�[\�H	�۝[��۝�\����KR��ۂ��X�P�X��P]V	\�[\˞VH	\�[\˞B��\�T�Y\SZ[\�X�ۙ�
L��]\����X�KX�X��Y]
	
	\�[\˞
K	
	\�[\˞JJH��B�	�\W�^	���\�[K��[���ˑ�ܛ\˔�[��^\�N���[��Z]
	�۝[�
B��\�T�Y\SZ[\�X�ۙ����]\���\Y�	
	�۝[���X���[���X]N��Z[�
L	�۝[��[��
JJH��B�	��^W��[�	���\�[K��[���ˑ�ܛ\˔�[��^\�N���[��Z]
	�۝[�
B��\�T�Y\SZ[\�X�ۙ����]\����^H�[��	�۝[���B�	�\���[�����	�[����H�]U�\�X�U�[���	[�\�H	�[�����ܑXX�Sؚ�X����
	˜Y
WH	
	˝]JH	
	˝�Y
^	
	˚ZY�
H]
	
	˞
K	
	˞JJH�B��]\��
	[�\�Z��[����B�B�	�X�]�]W��[�����]\��X�]�]KU�[��ОU]HU]T]\��	�۝[��B�	��\��\	�	�Z]]HH	�۝[���H�\�T���\��	\��]�Y�
	�Z]]JH�܈
	HH�	H[MN�	J��H�\�T�Y\T�X�ۙ�B�	�[��H�]U�\�X�U�[�����\�KSؚ�X��	˝]H[Z�H���Z]]J��B�Y�
	�[�ː��[�Y�
H	�H	�[���B��]\����\�Y�	\��]O��[��Έ	
	˝]JH
	
	˝�Y
^	
	˚ZY�
JH��B�B��]\����\�Y�	\��]�]�[���	��Z]]I�����[�Y�\�M\Ȃ�H[�H�\�T�Y\T�X�ۙ����]\����\�Y�	\��]��B�H�]��]\���T��Ԉ�\�[��	\��]�	Ȃ�B�B�	�\������:��z�gz�':�:���:�z�gH:�&;ff��]\���\�Έ	�Y
	[�����TUT��SQJH��B�Y�][�]\���[�ۛ�ۈX�[ێ�	X�[ۈ��B�B�H�]��]\���T��Ԉ^X�][��	X�[ۈ�	Ȃ�B�B���OOOOOOOOOHXZ[���OOOOOOOOOB����Y�\�\�\��ۈ�\�\��Y�\�\�T�X\��X][Y\�H���[H
	�ؘ[��[��[��H�H�X\��X]]�\�H
��X�ۙ	X\��X][Y\��Y�
	X\��X][Y\�Y�H

��	��X�JH\]KRX\��X]�	X\��X][Y\�H�B����]�[�[����[X[���܈\���� ;)�;(l:�m���Y:� ;'m�&`:�&z�l:�	�[	�'m:�l:�:�a;%�;'�:�:��{&��	�[\�H��]\�Y\K�[�[�ɛܙ\�XܙX]Y�]�\�ɛ[Z]MH��	�[\�
�H��܏J��Y�\K��Y��Y�\K�[��Y�\˛�[
H���	�Y�H�\HSY]�	��U	�T]����[X[����[\����Y�
	�Y�X[�	�Yː��[�Y�
H�ܙXX�
	�Y[�	�Y�H	�H�]Q]HQ�ܛX]	��[N���	�]�Y]�HY�
	�Y�\��]
H�	�Y�\��]H[�ZY�
	�Y��۝[�
H�	�Y��۝[�H[�H���B�	�]�Y]�H	�]�Y]˔�X���[���X]N��Z[�
	�]�Y]˓[��
JB�ܚ]KR�����H^X�][�Έ	
	�Y�X�[ۊH	�]�Y]ȈQ�ܙYܛ�[���܈ܙY[����X\��\����\��[���\��
�Z[HH��[X[�
B�	�Z[P��HH��]\�H����\��[�Ȏ����\��Y؞HH	�YH�۝�\��R��ۈP��\�\��\HSY]�	�U�	�T]����[X[���YY\K�
	�Y�Y
I��]\�Y\K�[�[�ȈP��H	�Z[P��H�]S�[��	�\�[H^X�]KP��[X[�P�Y	�Y���\]H��[X[��]�\�[�	��HH�]\�H���\]Y���\�[HY�
	�\�[
H�	�\�[��X���[���X]N��Z[�
�	�\�[�[��
JHH[�H�����]]
H�B����\��Y؞HH	�Y�H�۝�\��R��ۈP��\�\�	��U]�H��\�[K�^�[���[��N��U���]��[����\�[K�^�[���[��N��U���]�]\�	��JJB��\HSY]�	�U�	�T]����[X[���YY\K�
	�Y�Y
H�P��H	��U]���ܚ]KR�����HۙN�	
	�Y�X�[ۊHO�	
	�\�[��X���[���X]N��Z[�	�\�[�[��
JJH�Q�ܙYܛ�[���܈ܘ^B�B�B�H�]�ܚ]KR����T��ԗH����	ȈQ�ܙYܛ�[���܈�Y��\�T�Y\T�X�ۙ�
B�B���\�T�Y\T�X�ۙ�	��XB
