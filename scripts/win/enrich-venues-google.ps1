<#
  Fills court gaps from Google Places, for places OSM doesn't know about.
  Same priority ladder as enrich-venues.ps1: Alameda, then Bay Area, then California.

    # cost preview — spends nothing, needs no key (THIS IS THE DEFAULT):
    powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Brian\source\repos\pickleague\scripts\win\enrich-venues-google.ps1"
    # actually spend, one region at a time:
    powershell -NoProfile -ExecutionPolicy Bypass -File "...\enrich-venues-google.ps1" -Region alameda -Execute
    # drop rows past their 30-day display cache:
    powershell -NoProfile -ExecutionPolicy Bypass -File "...\enrich-venues-google.ps1" -PurgeExpired

  THIS ONE COSTS MONEY, which is why it will not spend anything unless you pass
  -Execute. Run it without that first and read the estimate. Google Places bills
  per request, and 'california' is a very large number of requests — do the
  narrow regions first and check what they actually added.

  Run it AFTER enrich-venues.ps1 for the same region. The underlying script
  dedups against venues already in the catalog, so seeding from OSM first means
  Google is only asked about genuine gaps, which is both cheaper and better data.

  Licensing, handled by scripts/ingest-google-venues.mjs (not by this wrapper):
  place_id is stored long-term, display fields are a 30-day performance cache
  with attribution per row. -PurgeExpired drops stale ones.

  Secrets come from tools/toolbox/toolbox.secrets.json and are never printed.
#>
[CmdletBinding()]
param(
  # Comma-separated. A string rather than string[] because `powershell -File`
  # passes a comma-separated value through as one token without splitting it.
  [string] $Region = 'alameda,bay-area,california',
  # Without this, every run is a no-spend cost preview.
  [switch] $Execute,
  # Delete google-sourced rows past their 30-day cache, then exit.
  [switch] $PurgeExpired
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

function Step($msg) { Write-Host ""; Write-Host "==== $msg ====" -ForegroundColor Cyan }
function Info($msg) { Write-Host "  $msg" }
function Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }
function Fail($msg, $code) { Write-Host "FAILED: $msg (exit $code)" -ForegroundColor Red; exit $code }

# Keep in sync with enrich-venues.ps1.
$REGIONS = [ordered]@{
  'alameda'        = @{ Box = '37.72 -122.34 37.81 -122.21'; Label = 'City of Alameda' }
  'alameda-county' = @{ Box = '37.45 -122.37 37.91 -121.46'; Label = 'Alameda County' }
  'oakland'        = @{ Box = '37.70 -122.36 37.89 -122.11'; Label = 'Oakland + Berkeley' }
  'bay-area'       = @{ Box = '36.85 -123.55 38.90 -121.20'; Label = 'Greater Bay Area (9 counties)' }
  'california'     = @{ Box = '32.50 -124.50 42.05 -114.10'; Label = 'California' }
}

$regionList = @($Region.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($regionList -contains 'all') { $regionList = @('alameda', 'bay-area', 'california') }
foreach ($r in $regionList) {
  if (-not $REGIONS.Contains($r)) { Fail "unknown region '$r'. Known: $($REGIONS.Keys -join ', ')" 2 }
}

Step "Loading secrets"
$secretsPath = Join-Path $repoRoot 'tools\toolbox\toolbox.secrets.json'
if (-not (Test-Path $secretsPath)) { Fail "not found: $secretsPath" 4 }
$s = Get-Content $secretsPath -Raw | ConvertFrom-Json
foreach ($k in @('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GOOGLE_PLACES_KEY')) {
  if ($s.PSObject.Properties.Name -contains $k -and -not [string]::IsNullOrWhiteSpace($s.$k)) {
    Set-Item -Path "env:$k" -Value $s.$k
  }
}
Info "loaded (values not shown)"

if ($PurgeExpired) {
  if (-not $env:SUPABASE_URL -or -not $env:SUPABASE_SERVICE_ROLE_KEY) { Fail "Supabase secrets missing" 5 }
  Step "Purging expired google rows"
  node scripts/ingest-google-venues.mjs --purge-expired
  if ($LASTEXITCODE -ne 0) { Fail "purge failed" $LASTEXITCODE }
  exit 0
}

if ($Execute) {
  if (-not $env:SUPABASE_URL -or -not $env:SUPABASE_SERVICE_ROLE_KEY) { Fail "Supabase secrets missing" 5 }
  if (-not $env:GOOGLE_PLACES_KEY) {
    Fail "GOOGLE_PLACES_KEY missing from toolbox.secrets.json — a real run needs it" 6
  }
  Warn "-Execute given: this run WILL call the Google Places API and incur cost."
} else {
  Info "cost preview only — nothing will be spent or written. Add -Execute to run for real."
}

foreach ($r in $regionList) {
  $meta = $REGIONS[$r]
  Step "$($meta.Label)  [$r]"
  if ($Execute) {
    node scripts/ingest-google-venues.mjs --bbox $meta.Box
  } else {
    node scripts/ingest-google-venues.mjs --bbox $meta.Box --dry-run
  }
  if ($LASTEXITCODE -ne 0) { Fail "region '$r' failed" $LASTEXITCODE }
}

# The Google path doesn't write `city` either — same offline-geocoder ownership
# as the OSM loader — so a real run leaves new rows null until this runs.
if ($Execute) {
  Step "Backfilling city from coordinates"
  try {
    $hdr = @{ apikey = $env:SUPABASE_SERVICE_ROLE_KEY
              Authorization = "Bearer $($env:SUPABASE_SERVICE_ROLE_KEY)"
              'Content-Type' = 'application/json' }
    $n = Invoke-RestMethod -Method Post -Uri "$($env:SUPABASE_URL)/rest/v1/rpc/backfill_venue_cities" `
      -Headers $hdr -Body '{}' -TimeoutSec 120
    Info "$n venues given a city"
  } catch {
    Warn "city backfill failed (venues are still saved): $($_.Exception.Message)"
  }
}

Step "Summary"
if (-not $Execute) {
  Info "that was an estimate only. Re-run with -Execute (and ideally one -Region at a time)."
} else {
  Info "done — check coverage with enrich-venues.ps1 -StatusOnly"
}
exit 0
