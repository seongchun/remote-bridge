$ErrorActionPreference = 'Stop'
$Nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $Nssm) { throw 'NSSM not found on PATH.' }
& $Nssm stop   VictusRelay 2>$null | Out-Null
& $Nssm remove VictusRelay confirm
Write-Host 'Uninstalled VictusRelay. Env file at $env:USERPROFILE\.config\seongchun-victus\env.json retained.'
