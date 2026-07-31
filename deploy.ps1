[CmdletBinding()]
param(
  [string]$Proxy = "",
  [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function ConvertTo-PHPayProxy {
  param([string]$Value)

  $candidate = [string]$Value
  if ([string]::IsNullOrWhiteSpace($candidate)) { return "" }
  $candidate = $candidate.Trim()

  if ($candidate.Contains("=") -and $candidate.Contains(";")) {
    $mapped = @{}
    foreach ($part in $candidate.Split(";")) {
      $pair = $part.Split("=", 2)
      if ($pair.Count -eq 2) { $mapped[$pair[0].Trim().ToLowerInvariant()] = $pair[1].Trim() }
    }
    if ($mapped.ContainsKey("https")) { $candidate = $mapped["https"] }
    elseif ($mapped.ContainsKey("http")) { $candidate = $mapped["http"] }
    else { return "" }
  }

  if ($candidate -notmatch "^[a-zA-Z][a-zA-Z0-9+.-]*://") {
    $candidate = "http://$candidate"
  }

  try {
    $builder = New-Object System.UriBuilder($candidate)
  } catch {
    return ""
  }

  if ($builder.Scheme -notin @("http", "https")) { return "" }
  if ($builder.Host -in @("127.0.0.1", "localhost", "::1")) {
    $builder.Host = "host.docker.internal"
  }
  return $builder.Uri.AbsoluteUri.TrimEnd("/")
}

function Get-PHPayProxy {
  param([string]$ExplicitProxy)

  foreach ($candidate in @(
    $ExplicitProxy,
    $env:PHPAY_PROXY,
    $env:HTTPS_PROXY,
    $env:HTTP_PROXY,
    $env:ALL_PROXY
  )) {
    $normalized = ConvertTo-PHPayProxy $candidate
    if ($normalized) { return $normalized }
  }

  try {
    $settings = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
    if ([int]$settings.ProxyEnable -eq 1) {
      return ConvertTo-PHPayProxy ([string]$settings.ProxyServer)
    }
  } catch {}

  return ""
}

function Get-SafeProxyLabel {
  param([string]$Value)
  if (-not $Value) { return "Direct connection" }
  try {
    $uri = [Uri]$Value
    return "$($uri.Scheme)://$($uri.Host):$($uri.Port)"
  } catch {
    return "Configured proxy"
  }
}

Push-Location $PSScriptRoot
try {
  $detectedProxy = Get-PHPayProxy $Proxy
  if ($detectedProxy) {
    $env:PHPAY_PROXY = $detectedProxy
    Write-Host "[PHPay] Proxy: $(Get-SafeProxyLabel $detectedProxy)" -ForegroundColor Cyan
  } else {
    Remove-Item Env:\PHPAY_PROXY -ErrorAction SilentlyContinue
    Write-Host "[PHPay] Direct connection (no host proxy detected)." -ForegroundColor Cyan
  }

  docker info *> $null
  if ($LASTEXITCODE -ne 0) { throw "Docker Desktop is not running." }

  docker compose up -d --build
  if ($LASTEXITCODE -ne 0) { throw "Docker deployment failed." }

  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $health = Invoke-RestMethod "http://127.0.0.1:3456/api/health" -TimeoutSec 2
      if ($health.ok) { $ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw "PHPay started but the health check did not become ready." }

  Write-Host "[PHPay] Ready: http://127.0.0.1:3456" -ForegroundColor Green
  if (-not $NoBrowser) { Start-Process "http://127.0.0.1:3456" }
} finally {
  Pop-Location
}
