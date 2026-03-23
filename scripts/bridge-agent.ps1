# Remote Bridge Agent (PowerShell + GitHub API)
# Git 불필요 - GitHub API만으로 동작
# 실행: bridge-agent-api.bat 더블클릭

# 설정 파일에서 토큰 읽기
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $ScriptDir "token.txt"
if (-not (Test-Path $ConfigPath)) {
    Write-Host "ERROR: token.txt not found in $ScriptDir"
    Write-Host "Create token.txt with your GitHub token"
    Read-Host "Press Enter to exit"
    exit 1
}
$TOKEN = (Get-Content $ConfigPath -Raw).Trim()
$OWNER = "seongchun"
$REPO = "remote-bridge"
$POLL_INTERVAL = 30

$Headers = @{
    "Authorization" = "token $TOKEN"
    "Accept" = "application/vnd.github.v3+json"
}

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$ts] $msg"
}

function Get-GitHubFile($path) {
    try {
        $url = "https://api.github.com/repos/$OWNER/$REPO/contents/$path"
        $r = Invoke-WebRequest -Uri $url -Headers $Headers -UseBasicParsing -ErrorAction Stop
        return ($r.Content | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Upload-GitHubFile($path, $content, $message) {
    $url = "https://api.github.com/repos/$OWNER/$REPO/contents/$path"
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($content))
    $body = @{ message = $message; content = $b64 }
    try {
        $existing = Invoke-WebRequest -Uri $url -Headers $Headers -UseBasicParsing -ErrorAction Stop
        $sha = ($existing.Content | ConvertFrom-Json).sha
        $body["sha"] = $sha
    } catch {}
    try {
        $json = $body | ConvertTo-Json -Compress
        $r = Invoke-WebRequest -Uri $url -Method PUT -Headers $Headers -Body $json -ContentType "application/json" -UseBasicParsing -ErrorAction Stop
        return $true
    } catch {
        Log "Upload failed: $path - $_"
        return $false
    }
}

function Delete-GitHubFile($path, $sha, $message) {
    $url = "https://api.github.com/repos/$OWNER/$REPO/contents/$path"
    $body = @{ message = $message; sha = $sha } | ConvertTo-Json -Compress
    try {
        Invoke-WebRequest -Uri $url -Method DELETE -Headers $Headers -Body $body -ContentType "application/json" -UseBasicParsing -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Process-Command($file) {
    $name = $file.name
    $cmdId = $name -replace '\.json$', ''
    Log "Command found: $name"

    try {
        $contentB64 = $file.content
        if (-not $contentB64) {
            $detail = Get-GitHubFile "commands/pending/$name"
            $contentB64 = $detail.content
        }
        $jsonStr = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($contentB64))
        $cmd = $jsonStr | ConvertFrom-Json
    } catch {
        Log "Failed to parse command: $_"
        return
    }

    $action = $cmd.action
    $target = $cmd.path
    Log "Executing: $action - $target"

    $resultContent = ""
    $statusMsg = ""

    switch ($action) {
        "read_file" {
            if (Test-Path $target) {
                $resultContent = Get-Content -Path $target -Raw -Encoding UTF8
                $statusMsg = '{"status":"success","message":"read ok"}'
            } else {
                $statusMsg = '{"status":"error","message":"file not found: ' + $target + '"}'
            }
        }
        "write_file" {
            try {
                $dir = Split-Path -Parent $target
                if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
                [System.IO.File]::WriteAllText($target, $cmd.content, [System.Text.Encoding]::UTF8)
                $statusMsg = '{"status":"success","message":"write ok"}'
            } catch {
                $statusMsg = '{"status":"error","message":"write failed: ' + $_.Exception.Message + '"}'
            }
        }
        "list_dir" {
            if (Test-Path $target) {
                $items = Get-ChildItem -Path $target | ForEach-Object {
                    $type = if ($_.PSIsContainer) { "[DIR]" } else { "[FILE] " + "{0:N0} bytes" -f $_.Length }
                    "$($_.Name)  $type  $($_.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))"
                }
                $resultContent = $items -join "`n"
                $statusMsg = '{"status":"success","message":"list ok"}'
            } else {
                $statusMsg = '{"status":"error","message":"directory not found"}'
            }
        }
        "run_cmd" {
            try {
                $output = cmd /c $target 2>&1 | Out-String
                $resultContent = $output
                $statusMsg = '{"status":"success","message":"run ok"}'
            } catch {
                $statusMsg = '{"status":"error","message":"run failed: ' + $_.Exception.Message + '"}'
            }
        }
        "copy_to_repo" {
            if (Test-Path $target) {
                try {
                    $fileContent = Get-Content -Path $target -Raw -Encoding UTF8
                    $fileName = Split-Path -Leaf $target
                    $dest = if ($cmd.dest) { $cmd.dest } else { "sync" }
                    Upload-GitHubFile "$dest/$fileName" $fileContent "copy: $fileName from company PC"
                    $statusMsg = '{"status":"success","message":"copy ok"}'
                } catch {
                    $statusMsg = '{"status":"error","message":"copy failed"}'
                }
            } else {
                $statusMsg = '{"status":"error","message":"source not found"}'
            }
        }
        default {
            $statusMsg = '{"status":"error","message":"unknown action: ' + $action + '"}'
        }
    }

    if ($resultContent) {
        Upload-GitHubFile "results/$cmdId.txt" $resultContent "result: $cmdId" | Out-Null
        Start-Sleep -Milliseconds 500
    }
    Upload-GitHubFile "results/$cmdId.status.json" $statusMsg "status: $cmdId" | Out-Null
    Start-Sleep -Milliseconds 500
    Upload-GitHubFile "commands/completed/$name" $jsonStr "completed: $cmdId" | Out-Null
    Start-Sleep -Milliseconds 500
    Delete-GitHubFile "commands/pending/$name" $file.sha "done: $cmdId" | Out-Null
    Log "Command completed: $cmdId"
}

# Main Loop
Clear-Host
Write-Host "=========================================="
Write-Host "  Remote Bridge Agent (API Mode)"
Write-Host "  Owner: $OWNER / Repo: $REPO"
Write-Host "  Polling: ${POLL_INTERVAL}s"
Write-Host "  Close this window to stop"
Write-Host "=========================================="
Write-Host ""

try {
    $test = Invoke-WebRequest -Uri "https://api.github.com/repos/$OWNER/$REPO" -Headers $Headers -UseBasicParsing -ErrorAction Stop
    Log "Connected to GitHub repo successfully"
} catch {
    Log "ERROR: Cannot connect to GitHub repo. Check token and repo name."
    Log "Error: $_"
    Read-Host "Press Enter to exit"
    exit 1
}

while ($true) {
    try {
        $url = "https://api.github.com/repos/$OWNER/$REPO/contents/commands/pending"
        $response = Invoke-WebRequest -Uri $url -Headers $Headers -UseBasicParsing -ErrorAction Stop
        $files = $response.Content | ConvertFrom-Json
        $commands = $files | Where-Object { $_.name -like "*.json" -and $_.name -ne ".gitkeep" }
        if ($commands) {
            foreach ($cmd in $commands) {
                Process-Command $cmd
                Start-Sleep -Seconds 1
            }
        } else {
            Log "No pending commands"
        }
    } catch {
        if ($_.Exception.Response.StatusCode -ne 404) {
            Log "Poll error: $_"
        } else {
            Log "No pending commands"
        }
    }
    Start-Sleep -Seconds $POLL_INTERVAL
}
