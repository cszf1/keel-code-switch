# Start keelcode local proxy on 8082
$ErrorActionPreference = "Stop"
$proj = Split-Path -Parent $MyInvocation.MyCommand.Path
$bun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
if (-not (Test-Path $bun)) {
  $cmd = Get-Command bun -ErrorAction SilentlyContinue
  if ($cmd) { $bun = $cmd.Source } else { throw "bun not found. Install Bun first." }
}
$env:Path = (Join-Path $env:USERPROFILE ".bun\bin") + ";" + $env:Path
Set-Location $proj
Write-Host "Starting keel-code-switch on http://127.0.0.1:8082 ..."
& $bun run proxy.ts --port 8082
