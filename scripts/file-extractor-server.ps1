# ============================================================
# file-extractor-server.ps1
# 회사 PC에서 실행 - Office/DRM 파일 텍스트 추출 HTTP 서버
# 포트 7654 에서 대기, cowork-web.html 의 파일 첨부 기능에 사용됨
# 실행: PowerShell 에서 .\file-extractor-server.ps1
# ============================================================

$PORT = 7654
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$PORT/")

try {
    $listener.Start()
    Write-Host "===========================================" -ForegroundColor Green
    Write-Host " File Extractor Server" -ForegroundColor Green
    Write-Host " http://localhost:$PORT" -ForegroundColor Green
    Write-Host " Close this window to stop" -ForegroundColor Green
    Write-Host "===========================================" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Port $PORT is already in use or access denied." -ForegroundColor Red
    Write-Host "Try running as Administrator." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

function Log($msg) {
    $ts = Get-Date -Format "HH:mm:ss"
    Write-Host "[$ts] $msg"
}

# ── Office COM Extraction Functions ──────────────────────────

function Extract-Word($path) {
    $word = $null
    try {
        $word = New-Object -ComObject Word.Application
        $word.Visible = $false
        $doc = $word.Documents.Open($path, $false, $true)
        $text = $doc.Content.Text
        $doc.Close($false)
        return $text
    } catch {
        throw "Word COM error: $($_.Exception.Message)"
    } finally {
        if ($word) { try { $word.Quit() } catch {}; [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null }
    }
}

function Extract-Excel($path) {
    $excel = $null
    try {
        $excel = New-Object -ComObject Excel.Application
        $excel.Visible = $false
        $excel.DisplayAlerts = $false
        $wb = $excel.Workbooks.Open($path, $false, $true)
        $text = ""
        foreach ($sheet in $wb.Worksheets) {
            $text += "=== Sheet: $($sheet.Name) ===`n"
            $used = $sheet.UsedRange
            if ($used) {
                for ($r = 1; $r -le $used.Rows.Count; $r++) {
                    $row = @()
                    for ($c = 1; $c -le $used.Columns.Count; $c++) {
                        $row += $used.Cells($r, $c).Text
                    }
                    $line = ($row -join "`t").Trim()
                    if ($line) { $text += $line + "`n" }
                }
            }
            $text += "`n"
        }
        $wb.Close($false)
        return $text
    } catch {
        throw "Excel COM error: $($_.Exception.Message)"
    } finally {
        if ($excel) { try { $excel.Quit() } catch {}; [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null }
    }
}

function Extract-PowerPoint($path) {
    $ppt = $null
    try {
        $ppt = New-Object -ComObject PowerPoint.Application
        $pres = $ppt.Presentations.Open($path, 1, 0, 0)
        $text = ""
        foreach ($slide in $pres.Slides) {
            $text += "=== Slide $($slide.SlideIndex) ===`n"
            foreach ($shape in $slide.Shapes) {
                if ($shape.HasTextFrame) {
                    $t = $shape.TextFrame.TextRange.Text.Trim()
                    if ($t) { $text += $t + "`n" }
                }
            }
            $text += "`n"
        }
        $pres.Close()
        return $text
    } catch {
        throw "PowerPoint COM error: $($_.Exception.Message)"
    } finally {
        if ($ppt) { try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null } catch {} }
    }
}

function Extract-Hwp($path) {
    try {
        $hwp = New-Object -ComObject HWPFrame.HwpObject
        $hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule") 2>&1 | Out-Null
        $hwp.Open($path, "HWP", "forceopen:true") | Out-Null
        $text = $hwp.GetTextFile("TEXT", "")
        $hwp.Quit()
        return $text
    } catch {
        throw "HWP COM error (한컴오피스 필요): $($_.Exception.Message)"
    }
}

function Extract-File($tmpPath, $fileName) {
    $ext = [System.IO.Path]::GetExtension($fileName).ToLower()
    switch ($ext) {
        { $_ -in '.docx','.doc' }       { return Extract-Word $tmpPath }
        { $_ -in '.xlsx','.xls' }       { return Extract-Excel $tmpPath }
        { $_ -in '.pptx','.ppt' }       { return Extract-PowerPoint $tmpPath }
        { $_ -in '.hwp','.hwpx' }       { return Extract-Hwp $tmpPath }
        '.pdf' {
            # Try plain text extraction for text-based PDFs
            try {
                $bytes = [System.IO.File]::ReadAllBytes($tmpPath)
                $raw = [System.Text.Encoding]::Latin1.GetString($bytes)
                $matches = [regex]::Matches($raw, '(([^)]{3,}))')
                $lines = $matches | ForEach-Object { $_.Groups[1].Value } | Where-Object { $_ -match '[가-힣a-zA-Z]' }
                if ($lines.Count -gt 0) { return $lines -join "`n" }
                return "[PDF: 텍스트 추출 불가 - 이미지 기반 PDF이거나 Adobe Acrobat이 필요합니다]"
            } catch { return "[PDF 읽기 실패: $($_.Exception.Message)]" }
        }
        default {
            return [System.IO.File]::ReadAllText($tmpPath, [System.Text.Encoding]::UTF8)
        }
    }
}

# ── HTTP Request Handler ──────────────────────────────────────

Log "Server started on port $PORT"
Log "Supported: .docx .doc .xlsx .xls .pptx .ppt .hwp .hwpx .pdf"
Log ""

while ($listener.IsListening) {
    try {
        $ctx    = $listener.GetContext()
        $req    = $ctx.Request
        $resp   = $ctx.Response

        # CORS headers (required: GitHub Pages is HTTPS, localhost is HTTP)
        $resp.Headers.Add("Access-Control-Allow-Origin", "*")
        $resp.Headers.Add("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        $resp.Headers.Add("Access-Control-Allow-Headers", "Content-Type")

        if ($req.HttpMethod -eq "OPTIONS") {
            $resp.StatusCode = 200; $resp.Close(); continue
        }

        $path = $req.Url.AbsolutePath

        if ($path -eq "/extract" -and $req.HttpMethod -eq "POST") {
            $reader  = [System.IO.StreamReader]::new($req.InputStream, [System.Text.Encoding]::UTF8)
            $body    = $reader.ReadToEnd(); $reader.Close()
            $json    = $body | ConvertFrom-Json
            $fname   = $json.name
            $b64data = $json.data

            Log "Extracting: $fname"

            $tmpBase = [System.IO.Path]::GetTempFileName()
            $ext     = [System.IO.Path]::GetExtension($fname)
            $tmpFile = $tmpBase + $ext

            try {
                [System.IO.File]::WriteAllBytes($tmpFile, [Convert]::FromBase64String($b64data))
                $text = Extract-File $tmpFile $fname
                $result = @{ text = $text } | ConvertTo-Json -Compress -Depth 2
                Log "  -> OK ($($text.Length) chars)"
            } catch {
                $errMsg = $_.Exception.Message
                $result = @{ error = $errMsg } | ConvertTo-Json -Compress
                Log "  -> ERROR: $errMsg" -ForegroundColor Red
            } finally {
                Remove-Item $tmpFile  -Force -ErrorAction SilentlyContinue
                Remove-Item $tmpBase  -Force -ErrorAction SilentlyContinue
            }

        } elseif ($path -eq "/" -or $path -eq "/health") {
            $result = '{"status":"ok","port":' + $PORT + '}'
        } else {
            $resp.StatusCode = 404
            $result = '{"error":"not found"}'
        }

        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($result)
            $resp.ContentType = "application/json; charset=utf-8"
            $resp.ContentLength64 = $bytes.Length
            $resp.OutputStream.Write($bytes, 0, $bytes.Length)
            $resp.Close()
        } catch {
            Log "Response write failed (client may have disconnected)"
        }

    } catch [System.Net.HttpListenerException] {
        break  # Listener stopped
    } catch {
        Log "Request error: $_"
        try { $ctx.Response.StatusCode = 500; $ctx.Response.Close() } catch {}
    }
}

$listener.Stop()
Log "Server stopped."
