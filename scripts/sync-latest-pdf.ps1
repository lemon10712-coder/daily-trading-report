param(
  [string]$RepositoryRawUrl = 'https://raw.githubusercontent.com/lemon10712-coder/daily-trading-report/main',
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
  $manifest = Invoke-RestMethod -Uri "$RepositoryRawUrl/data/pdf-latest.json" -TimeoutSec 30
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
    Invoke-WebRequest -Uri "$RepositoryRawUrl/$relative" -OutFile $tempPath -TimeoutSec 60
    $bytes = [System.IO.File]::ReadAllBytes($tempPath)
    if ($bytes.Length -lt 10000 -or [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne '%PDF') {
      throw "$fileName is not a valid PDF"
    }
    Move-Item -LiteralPath $tempPath -Destination $finalPath -Force
    $downloaded++
  }

  if ($downloaded -eq 0) { throw 'Manifest contains no downloadable PDF' }
  Write-SyncLog "OK date=$($manifest.date) files=$downloaded destination=$destination"
} catch {
  Write-SyncLog "FAILED $($_.Exception.Message)"
  exit 1
}
