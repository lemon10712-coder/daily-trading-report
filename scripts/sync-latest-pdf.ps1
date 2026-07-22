param(
  [string]$RepositoryRawUrl = 'https://raw.githubusercontent.com/lemon10712-coder/daily-trading-report/main',
  [string]$RepositoryApiUrl = 'https://api.github.com/repos/lemon10712-coder/daily-trading-report',
  [string]$DestinationRoot = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $DestinationRoot) {
  $reportFolder = "$( [char]0x65E5 )$( [char]0x5831 )"
  $agentRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
  $DestinationRoot = Join-Path $agentRoot $reportFolder
}
$logRoot = Join-Path $DestinationRoot '_automation'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$logPath = Join-Path $logRoot 'pdf-sync.log'

function Write-SyncLog([string]$Message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
  Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
  Write-Output $line
}

try {
  # Resolve main to an immutable commit SHA. Fetching the mutable /main path can
  # briefly return the previous PDF from GitHub's CDN after a same-path update.
  $headers = @{ 'Cache-Control' = 'no-cache'; 'User-Agent' = 'CHARLES-AGENT-PDF-SYNC' }
  $commit = Invoke-RestMethod -Uri "$RepositoryApiUrl/commits/main" -TimeoutSec 30 -Headers $headers
  if ($commit.sha -notmatch '^[0-9a-f]{40}$') { throw 'Cannot resolve GitHub main commit SHA' }
  $commitRawUrl = $RepositoryRawUrl -replace '/main$', "/$($commit.sha)"
  $manifest = Invoke-RestMethod -Uri "$commitRawUrl/data/pdf-latest.json" -TimeoutSec 30 -Headers $headers
  if ($manifest.date -notmatch '^\d{4}-\d{2}-\d{2}$') { throw 'PDF manifest date is invalid' }
  $dateCompact = $manifest.date.Replace('-', '')
  $reportSuffix = "$( [char]0x65E5 )$( [char]0x5831 )"
  $destination = Join-Path $DestinationRoot "${dateCompact}${reportSuffix}"
  New-Item -ItemType Directory -Path $destination -Force | Out-Null

  $downloaded = 0
  foreach ($property in @('morning_pdf', 'final_pdf')) {
    $relative = $manifest.$property
    if (-not $relative) { continue }
    $fileName = [System.IO.Path]::GetFileName($relative)
    $finalPath = Join-Path $destination $fileName
    $tempPath = "$finalPath.part"
    Invoke-WebRequest -Uri "$commitRawUrl/$relative" -OutFile $tempPath -TimeoutSec 60 -Headers $headers
    $bytes = [System.IO.File]::ReadAllBytes($tempPath)
    if ($bytes.Length -lt 10000 -or [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne '%PDF') {
      throw "$fileName is not a valid PDF"
    }
    Move-Item -LiteralPath $tempPath -Destination $finalPath -Force
    $downloaded++
  }

  if ($downloaded -eq 0) { throw 'Manifest contains no downloadable PDF' }
  Write-SyncLog "OK date=$($manifest.date) commit=$($commit.sha.Substring(0, 7)) files=$downloaded destination=$destination"
} catch {
  Write-SyncLog "FAILED $($_.Exception.Message)"
  exit 1
}
