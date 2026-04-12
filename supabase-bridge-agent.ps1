# =============================================================================
# Supabase Bridge Agent v4
# =============================================================================
# 회사 PC에서 실행되는 브릿지 에이전트
# - Supabase commands 테이블에서 pending 명령을 폴링
# - PowerShell 스크립트 명령 실행 (run_ps)
# - 결과를 commands 테이블에 PATCH
# - 단일 인스턴스 (Named Mutex)
# - 하트비트 전송
# =============================================================================

param(
    [switch]$NoExit   # Debugging: don't exit on fatal error
)

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ─── Config ──────────────────────────────────────────────────────────────────────────────────
$SUPA_URL  = 'https://rnnigyfzwlgojxyccgsm.supabase.co'
$SUPA_KEY  = 'sb_publishable_Nmv51BZccADB0bN5JY2URw_lLffyFgE'
$VERSION   = 'v4'
$POLL_MS   = 3000
$HB_SEC    = 15
$HOSTNAME  = $env:COMPUTERNAME

# ─── Single-instance mutex ────────────────────────────────────────────────────────────────────
$mutexName = 'Global\\SBridgeAgent_v4'
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$acquired = $false
try {
    $acquired = $mutex.WaitOne(0, $false)
} catch [System.Threading.AbandonedMutexException] {
    $acquired = $true
}

if (-not $acquired) {
    Write-Host '[Bridge] 이미 실행 중입니다 (단일 인스턴스). 종료.' -ForegroundColor Yellow
    Start-Sleep 3
    exit 0
}

Write-Host '╔════════════════════════════════════════════════════════════╗' -ForegroundColor Cyan
Write-Host "║  Supabase Bridge Agent $VERSION                        ║" -ForegroundColor Cyan
Write-Host '║  DRM: ExportAsFixedFormat → PDF → localhost:7655 ║' -ForegroundColor Cyan
Write-Host '║  단일 인스턴스 (Named Mutex)                     ║' -ForegroundColor Cyan
Write-Host '╠════════════════════════════════════════════════════════════╣' -ForegroundColor Cyan
Write-Host "║  PC: $($HOSTNAME.PadRight(41))║" -ForegroundColor Cyan
Write-Host '╚════════════════════════════════════════════════════════════╝' -ForegroundColor Cyan
Write-Host ''

# ─── HTTP helpers ────────────────────────────────────────────────────────────────────────────────────
function Invoke-Supa {
    param([string]$Method, [string]$Path, [hashtable]$Body = $null, [hashtable]$Extra = @{})
    $headers = @{
        'apikey'        = $SUPA_KEY
        'Authorization' = "Bearer $SUPA_KEY"
        'Content-Type'  = 'application/json'
    }
    foreach ($k in $Extra.Keys) { $headers[$k] = $Extra[$k] }
    $uri = "$SUPA_URL/rest/v1/$Path"
    $params = @{
        Uri     = $uri
        Method  = $Method
        Headers = $headers
    }
    if ($Body) {
        $params['Body'] = ($Body | ConvertTo-Json -Depth 10 -Compress)
    }
    try {
        Invoke-RestMethod @params
    } catch {
        throw "Supa $Method $Path : $($_.Exception.Message)"
    }
}

function Supa-Get($path) {
    Invoke-Supa -Method 'Get' -Path $path
}

function Supa-Patch($path, $body) {
    Invoke-Supa -Method 'Patch' -Path $path -Body $body -Extra @{ 'Prefer' = 'return=minimal' }
}

# ─── Heartbeat ────────────────────────────────────────────────────────────────────────────────────────────────────────────
$lastHb = [DateTime]::MinValue
function Send-Heartbeat {
    $now = [DateTime]::UtcNow
    if (($now - $lastHb).TotalSeconds -lt $HB_SEC) { return }
    $script:lastHb = $now
    try {
        # Use upsert via POST with Prefer: resolution=merge-duplicates
        $headers = @{
            'apikey'        = $SUPA_KEY
            'Authorization' = "Bearer $SUPA_KEY"
            'Content-Type'  = 'application/json'
            'Prefer'        = 'resolution=merge-duplicates,return=minimal'
        }
        $body = @{
            id      = 'bridge-heartbeat'
            action  = 'heartbeat'
            target  = 'bridge'
            content = "online/$HOSTNAME/$VERSION"
            status  = 'completed'
            result  = $now.ToString('o')
        } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri "$SUPA_URL/rest/v1/commands" -Method Post -Headers $headers -Body $body | Out-Null
        Write-Host "  [$(Get-Date -f 'HH:mm:ss')] [HB] 하트비트 전송" -ForegroundColor DarkGray
    } catch {
        Write-Host "  [HB] 실패: $($_.Exception.Message.Substring(0,[Math]::Min(80,$_.Exception.Message.Length)))" -ForegroundColor DarkYellow
    }
}

# ─── Execute a PowerShell command ─────────────────────────────────────────────────────────────────────────────────────
function Execute-PsCommand {
    param([string]$CmdId, [string]$Content)

    Write-Host "[$(Get-Date -f 'HH:mm:ss')] [CMD] 실행 시작: $($CmdId.Substring(0,[Math]::Min(20,$CmdId.Length)))" -ForegroundColor Green

    # Mark as processing
    try { Supa-Patch "commands?id=eq.$([Uri]::EscapeDataString($CmdId))" @{ status = 'processing' } } catch {}

    $result = ''
    $status = 'completed'
    try {
        # Write content to temp script file
        $tmpScript = [IO.Path]::Combine($env:TEMP, "bridge-cmd-$([DateTime]::Now.Ticks).ps1")
        [IO.File]::WriteAllText($tmpScript, $Content, [Text.Encoding]::UTF8)

        # Execute via PowerShell (capture all output)
        $proc = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$tmpScript`"" `
            -RedirectStandardOutput "$tmpScript.stdout.txt" `
            -RedirectStandardError  "$tmpScript.stderr.txt" `
            -PassThru -WindowStyle Hidden
        $done = $proc.WaitForExit(120000)  # 120s timeout
        if (-not $done) {
            Stop-Process -Id $proc.Id -Force -EA 0
            $result = 'TIMEOUT:120s'
            $status = 'error'
        } else {
            $stdout = if (Test-Path "$tmpScript.stdout.txt") { Get-Content "$tmpScript.stdout.txt" -Raw } else { '' }
            $stderr = if (Test-Path "$tmpScript.stderr.txt") { Get-Content "$tmpScript.stderr.txt" -Raw } else { '' }
            $result = if ($stdout.Trim()) { $stdout.Trim() } elseif ($stderr.Trim()) { "ERR:$($stderr.Trim())" } else { '' }
        }
        Remove-Item $tmpScript -EA 0
        Remove-Item "$tmpScript.stdout.txt" -EA 0
        Remove-Item "$tmpScript.stderr.txt" -EA 0
    } catch {
        $result = "EXEC_ERR:$($_.Exception.Message)"
        $status  = 'error'
    }

    # Truncate result to avoid Supabase row size limits
    if ($result.Length -gt 50000) {
        $result = $result.Substring(0, 50000) + '...[truncated]'
    }

    # PATCH result back (PATCH method - different from POST/DELETE which are blocked)
    $patchOk = $false
    for ($retry = 0; $retry -lt 3; $retry++) {
        try {
            Supa-Patch "commands?id=eq.$([Uri]::EscapeDataString($CmdId))" @{ status = $status; result = $result }
            $patchOk = $true
            break
        } catch {
            Write-Host "  [PATCH] 재시도 $retry : $($_.Exception.Message.Substring(0,60))" -ForegroundColor DarkYellow
            Start-Sleep -Milliseconds 2000
        }
    }

    if ($patchOk) {
        Write-Host "[$(Get-Date -f 'HH:mm:ss')] [CMD] 완료 '$($result.Substring(0,[Math]::Min(60,$result.Length)))'" -ForegroundColor Green
    } else {
        Write-Host "[$(Get-Date -f 'HH:mm:ss')] [CMD] PATCH 실패! 결과를 Supabase에 쓸 수 없습니다." -ForegroundColor Red
        Write-Host "  결과 내용: $($result.Substring(0,[Math]::Min(200,$result.Length)))" -ForegroundColor DarkYellow
    }
}

# ─── Main poll loop ───────────────────────────────────────────────────────────────────────────────────────────────────────────
Write-Host "[$(Get-Date -f 'HH:mm:ss')] [OK] 폴링 시작 (${POLL_MS}ms 간격)" -ForegroundColor Cyan
Write-Host ''

Send-Heartbeat

$isProcessing = $false

while ($true) {
    Send-Heartbeat

    if (-not $isProcessing) {
        try {
            # Poll for pending commands targeting bridge or unspecified target
            $rows = Supa-Get "commands?action=eq.run_ps&status=eq.pending&order=created_at.asc&limit=1&select=id,action,target,content"

            if ($rows -and $rows.Count -gt 0) {
                $row = $rows[0]
                # Accept commands for 'bridge' target, or empty target
                if ($row.target -eq 'bridge' -or $row.target -eq '' -or $null -eq $row.target) {
                    $isProcessing = $true
                    try {
                        Execute-PsCommand -CmdId $row.id -Content $row.content
                    } finally {
                        $isProcessing = $false
                    }
                }
            }
        } catch {
            Write-Host "[$(Get-Date -f 'HH:mm:ss')] [POLL] 오류: $($_.Exception.Message.Substring(0,[Math]::Min(100,$_.Exception.Message.Length)))" -ForegroundColor DarkYellow
        }
    }

    Start-Sleep -Milliseconds $POLL_MS
}
