# Remote Bridge - Company PC Auto Updater
# Usage: irm https://raw.githubusercontent.com/seongchun/remote-bridge/main/update-bridge.ps1 | iex

$ErrorActionPreference = "Stop"
$BaseUrl = "https://raw.githubusercontent.com/seongchun/remote-bridge/main"
$InstallDir = "C:\RemoteBridge"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Remote Bridge - Auto Updater v4.0" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Create directories
$dirs = @("$InstallDir", "$InstallDir\scripts")
foreach ($d in $dirs) {
    if (-not (Test-Path $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
        Write-Host "[CREATE] $d" -ForegroundColor Green
    }
}

# Files to download
$files = @(
    @{ Remote = "start-bridge.bat"; Local = "$InstallDir\start-bridge.bat" },
    @{ Remote = "scripts/supabase-bridge-agent.ps1"; Local = "$InstallDir\scripts\supabase-bridge-agent.ps1" },
    @{ Remote = "scripts/bridge-watchdog.ps1"; Local = "$InstallDir\scripts\bridge-watchdog.ps1" },
    @{ Remote = "scripts/config.json"; Local = "$InstallDir\scripts\config.json" }
)

$downloaded = 0
foreach ($f in $files) {
    $url = "$BaseUrl/$($f.Remote)"
    try {
        Write-Host "[DOWNLOAD] $($f.Remote) ... " -NoNewline
        Invoke-WebRequest -Uri $url -OutFile $f.Local -UseBasicParsing
        Write-Host "OK" -ForegroundColor Green
        $downloaded++
    } catch {
        Write-Host "SKIP (not found)" -ForegroundColor Yellow
    }
}

# Fix line endings for .bat files (GitHub raw serves LF, Windows cmd.exe needs CRLF)
Get-ChildItem "$InstallDir\*.bat" -ErrorAction SilentlyContinue | ForEach-Object {
    $txt = [System.IO.File]::ReadAllText($_.FullName)
    $txt = $txt -replace "`r`n", "`n"
    $txt = $txt -replace "`n", "`r`n"
    [System.IO.File]::WriteAllText($_.FullName, $txt)
    Write-Host "[FIX] $($_.Name) -> CRLF" -ForegroundColor Gray
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " Done! $downloaded files downloaded" -ForegroundColor Green
Write-Host " Location: $InstallDir" -ForegroundColor Gray
Write-Host " PC ID: $($env:COMPUTERNAME.ToLower())" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host " Next: start-bridge.bat double-click!" -ForegroundColor Cyan
Write-Host ""

# Create desktop shortcut for start-bridge.bat
try {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = "$desktop\Remote Bridge.lnk"
    if (-not (Test-Path $shortcutPath)) {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = "$InstallDir\start-bridge.bat"
        $shortcut.WorkingDirectory = $InstallDir
        $shortcut.Description = "Remote Bridge Agent"
        $shortcut.Save()
        Write-Host " Desktop shortcut created!" -ForegroundColor Green
    }
} catch {
    Write-Host " (Shortcut creation skipped)" -ForegroundColor Yellow
}
