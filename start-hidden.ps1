# Pi / 后台用：拉起 keel 代理后立即退出（不阻塞）
$ErrorActionPreference = "Stop"
$proj = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8082

function Test-PortOpen([int]$Port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect("127.0.0.1", $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(300, $false)
    if (-not $ok) { $c.Close(); return $false }
    $c.EndConnect($iar) | Out-Null
    $c.Close()
    return $true
  } catch {
    return $false
  }
}

if (Test-PortOpen $port) {
  Write-Output "keel-code-switch already on :$port"
  exit 0
}

$bun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
if (-not (Test-Path -LiteralPath $bun)) {
  $cmd = Get-Command bun -ErrorAction SilentlyContinue
  if ($cmd) { $bun = $cmd.Source }
}
if (-not (Test-Path -LiteralPath $bun)) {
  Write-Error "bun not found"
  exit 1
}

$logs = Join-Path $proj "logs"
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$outLog = Join-Path $logs "proxy.out.log"
$errLog = Join-Path $logs "proxy.err.log"

$envPath = (Join-Path $env:USERPROFILE ".bun\bin") + ";" + $env:Path

$p = Start-Process -FilePath $bun `
  -ArgumentList @("run", "proxy.ts", "--port", "$port") `
  -WorkingDirectory $proj `
  -WindowStyle Hidden `
  -PassThru `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog

# 给子进程补 PATH 不方便；bun 绝对路径已够
if (-not $p) {
  Write-Error "failed to start bun proxy"
  exit 1
}

Write-Output "keel-code-switch started pid=$($p.Id) -> :$port"
exit 0
