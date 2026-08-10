<#
  Fills the venues catalog from OpenStreetMap (Overpass), working a priority
  ladder: Alameda first, then the Bay Area, then the rest of California.

    powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Brian\source\repos\pickleague\scripts\win\enrich-venues.ps1"
    powershell -NoProfile -ExecutionPolicy Bypass -File "...\enrich-venues.ps1" -Region alameda -DryRun
    powershell -NoProfile -ExecutionPolicy Bypass -File "...\enrich-venues.ps1" -StatusOnly

  This is the Windows driver for scripts/ingest-overpass-venues.sh (which needs
  Git Bash). Same two stages, same order: fetch-overpass-venues.mjs emits
  line-delimited GeoJSON, load-osm-venues.mjs upserts it.

  WHY IT TILES. Overpass will not hand you a whole state in one request — an
  --area US-CA query times out on the public server. So each region is cut into
  a grid of small bounding boxes and fetched one at a time. California at the
  default 0.5 degrees is a few hundred tiles; most are ocean or desert and come
  back empty in a second or two.

  SAFE TO INTERRUPT. Every finished tile is recorded in
  scripts/win/.enrich-state/venues-<region>.json before the next one starts, so
  Ctrl-C, a closed lid, or a dead connection costs only the tile in flight — run
  it again and it picks up where it stopped. Venues upsert on their OSM id, so
  re-doing a tile changes nothing. Use -Restart to deliberately start a region over.

  Overpass needs no API key. Supabase credentials are loaded from
  tools/toolbox/toolbox.secrets.json into this process's environment and are
  never printed.
#>
[CmdletBinding()]
param(
  # Regions to work, in order — comma-separated. See $REGIONS below for the list.
  # Typed as a string, not string[], because `powershell -File` hands a
  # comma-separated value through as ONE token and never splits it into an array.
  [string] $Region = 'alameda,bay-area,california',
  # Tile size in degrees. Smaller = more requests but less chance of a timeout.
  [double] $TileDeg = 0.5,
  # Stop cleanly after this long. 0 = run until the ladder is done.
  [double] $HoursToRun = 6,
  # Parse and summarize only — writes nothing, needs no Supabase key.
  [switch] $DryRun,
  # Print catalog coverage and exit.
  [switch] $StatusOnly,
  # Forget recorded progress for the selected regions and start them over.
  [switch] $Restart,
  # Emit SQL chunks to this directory instead of writing via PostgREST.
  [string] $SqlOut = '',
  # Seconds to pause between tiles — the public Overpass server rate-limits.
  [double] $PauseSec = 2,
  # Force a specific Overpass endpoint. Blank = probe the mirror list below and
  # use the first one that answers.
  [string] $OverpassUrl = ''
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

function Step($msg) { Write-Host ""; Write-Host "==== $msg ====" -ForegroundColor Cyan }
function Info($msg) { Write-Host "  $msg" }
function Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }
function Fail($msg, $code) { Write-Host "FAILED: $msg (exit $code)" -ForegroundColor Red; exit $code }

# Bounding boxes as "south west north east" — the order fetch-overpass-venues.mjs expects.
$REGIONS = [ordered]@{
  'alameda'        = @{ Box = @(37.72, -122.34, 37.81, -122.21); Label = 'City of Alameda' }
  'alameda-county' = @{ Box = @(37.45, -122.37, 37.91, -121.46); Label = 'Alameda County' }
  'oakland'        = @{ Box = @(37.70, -122.36, 37.89, -122.11); Label = 'Oakland + Berkeley' }
  'bay-area'       = @{ Box = @(36.85, -123.55, 38.90, -121.20); Label = 'Greater Bay Area (9 counties)' }
  'california'     = @{ Box = @(32.50, -124.50, 42.05, -114.10); Label = 'California' }
}

$regionList = @($Region.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($regionList -contains 'all') { $regionList = @('alameda', 'bay-area', 'california') }
foreach ($r in $regionList) {
  if (-not $REGIONS.Contains($r)) {
    Fail "unknown region '$r'. Known: $($REGIONS.Keys -join ', ')" 2
  }
}

# ── Secrets ───────────────────────────────────────────────────────────────────
Step "Loading secrets"
$secretsPath = Join-Path $repoRoot 'tools\toolbox\toolbox.secrets.json'
if (-not (Test-Path $secretsPath)) { Fail "not found: $secretsPath" 4 }
$s = Get-Content $secretsPath -Raw | ConvertFrom-Json
foreach ($k in @('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'OVERPASS_URL')) {
  if ($s.PSObject.Properties.Name -contains $k -and -not [string]::IsNullOrWhiteSpace($s.$k)) {
    Set-Item -Path "env:$k" -Value $s.$k
  }
}
# A dry run parses only, and SQL_OUT writes files — neither needs a key.
if (-not $DryRun -and -not $SqlOut) {
  if (-not $env:SUPABASE_URL -or -not $env:SUPABASE_SERVICE_ROLE_KEY) {
    Fail "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in toolbox.secrets.json" 5
  }
}
Info "loaded (values not shown)"

# ── Status ────────────────────────────────────────────────────────────────────
if ($StatusOnly) {
  Step "Catalog coverage"
  node scripts/venue-coverage-report.mjs
  if ($LASTEXITCODE -ne 0) { Fail "coverage report failed" $LASTEXITCODE }
  Info "wrote scripts/venue-coverage-report.md"

  Step "Local tile progress"
  $stateDir = Join-Path $PSScriptRoot '.enrich-state'
  if (-not (Test-Path $stateDir)) {
    Info "no tiles recorded yet"
  } else {
    foreach ($r in $REGIONS.Keys) {
      $f = Join-Path $stateDir "venues-$r.json"
      if (Test-Path $f) {
        $st = Get-Content $f -Raw | ConvertFrom-Json
        Info ("{0,-16} {1} tiles done, {2} failed" -f $r, @($st.done).Count, @($st.failed).Count)
      }
    }
  }
  exit 0
}

# ── Overpass endpoint ─────────────────────────────────────────────────────────
# The main instance goes down, and when it does node reports a bare "fetch
# failed" with no status code — which looks like a bug in the script rather than
# a dead server. So probe before starting, say which endpoint won, and rotate
# automatically if the chosen one starts refusing mid-run.
$DEFAULT_MIRRORS = @(
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
)

function Test-OverpassEndpoint($url) {
  $statusUrl = $url -replace '/api/interpreter/?$', '/api/status'
  # Two attempts: these are volunteer-run mirrors that blink in and out, and a
  # single timeout was enough to write off one that was healthy seconds later.
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      $resp = Invoke-WebRequest -Uri $statusUrl -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop
      if ($resp.StatusCode -eq 200) { return $true }
    } catch {
      if ($attempt -lt 2) { Start-Sleep -Seconds 3 }
    }
  }
  return $false
}

if ($OverpassUrl) {
  $script:Mirrors = @($OverpassUrl)
} elseif ($env:OVERPASS_URL) {
  # A value from toolbox.secrets.json is preferred but not trusted blindly — it
  # can be stale too, so the public mirrors stay behind it as fallbacks.
  $script:Mirrors = @($env:OVERPASS_URL) + $DEFAULT_MIRRORS
} else {
  $script:Mirrors = $DEFAULT_MIRRORS
}
$script:MirrorIndex = -1

function Select-NextOverpass {
  for ($i = $script:MirrorIndex + 1; $i -lt $script:Mirrors.Count; $i++) {
    $candidate = $script:Mirrors[$i]
    Info "probing $candidate"
    if (Test-OverpassEndpoint $candidate) {
      $script:MirrorIndex = $i
      $env:OVERPASS_URL = $candidate
      Info "using $candidate"
      return $true
    }
    Warn "no answer: $candidate"
  }
  return $false
}

Step "Choosing an Overpass endpoint"
if (-not (Select-NextOverpass)) {
  Fail "no reachable Overpass endpoint (tried $($script:Mirrors.Count)). Check your connection, or pass -OverpassUrl" 7
}

# ── Tile planning ─────────────────────────────────────────────────────────────
function Get-Tiles($box, $deg) {
  $south = [double]$box[0]; $west = [double]$box[1]
  $north = [double]$box[2]; $east = [double]$box[3]
  $tiles = New-Object System.Collections.ArrayList
  for ($lat = $south; $lat -lt $north; $lat += $deg) {
    for ($lon = $west; $lon -lt $east; $lon += $deg) {
      $n = [Math]::Min($lat + $deg, $north)
      $e = [Math]::Min($lon + $deg, $east)
      # 4dp keeps the id stable across runs despite float accumulation.
      # The -f arguments must be parenthesized: inside a hash literal a bare
      # comma is read as the entry separator, not as an argument list.
      [void]$tiles.Add([pscustomobject]@{
        S  = [Math]::Round($lat, 4); W = [Math]::Round($lon, 4)
        N  = [Math]::Round($n, 4);   E = [Math]::Round($e, 4)
        Id = ("{0:F4}_{1:F4}" -f ([Math]::Round($lat, 4)), ([Math]::Round($lon, 4)))
      })
    }
  }
  return $tiles
}

$stateDir = Join-Path $PSScriptRoot '.enrich-state'
if (-not (Test-Path $stateDir)) { [void](New-Item -ItemType Directory -Path $stateDir) }

function Get-State($region) {
  # Dry runs start from a clean slate too, so a preview always previews the whole
  # region rather than only whatever a previous real run hadn't reached yet.
  $f = Join-Path $stateDir "venues-$region.json"
  if ((Test-Path $f) -and -not $Restart -and -not $DryRun) {
    $raw = Get-Content $f -Raw | ConvertFrom-Json
    return @{ done = [System.Collections.ArrayList]@($raw.done); failed = [System.Collections.ArrayList]@($raw.failed) }
  }
  return @{ done = (New-Object System.Collections.ArrayList); failed = (New-Object System.Collections.ArrayList) }
}
function Save-State($region, $state) {
  # A dry run writes nothing to the database, so it must not claim tiles as done
  # either — otherwise the next REAL run skips every tile you previewed.
  if ($DryRun) { return }
  $f = Join-Path $stateDir "venues-$region.json"
  [pscustomobject]@{ done = @($state.done); failed = @($state.failed); updatedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json -Depth 4 | Set-Content -Path $f -Encoding utf8
}

# ── Run ───────────────────────────────────────────────────────────────────────
$deadline = if ($HoursToRun -gt 0) { (Get-Date).AddHours($HoursToRun) } else { [DateTime]::MaxValue }
$tmpOut = Join-Path $env:TEMP "pl-venues-$PID.geojsonseq"
$tmpErr = Join-Path $env:TEMP "pl-venues-$PID.err"
$grandTotal = 0
$stopped = $false
# Rotate endpoints after a short run of failures rather than burning the rest of
# the ladder against a server that has stopped answering.
$consecutiveFetchFails = 0
$FAILS_BEFORE_ROTATE = 3

foreach ($r in $regionList) {
  if ($stopped) { break }
  $meta = $REGIONS[$r]
  # @() because PowerShell unrolls a returned collection — a one-tile region
  # would otherwise come back as a bare object with no .Count.
  $tiles = @(Get-Tiles $meta.Box $TileDeg)
  $state = Get-State $r
  $todo = @($tiles | Where-Object { $state.done -notcontains $_.Id })

  Step "$($meta.Label)  [$r]"
  Info ("{0} tiles at {1} deg — {2} already done, {3} to go" -f $tiles.Count, $TileDeg, $state.done.Count, $todo.Count)
  if ($todo.Count -eq 0) { Info "nothing left for this region"; continue }

  $i = 0
  foreach ($t in $todo) {
    if ((Get-Date) -ge $deadline) {
      Warn "time budget reached — stopping cleanly (progress is saved)"
      $stopped = $true
      break
    }
    $i++
    $label = "{0}/{1}  {2},{3} -> {4},{5}" -f $i, $todo.Count, $t.S, $t.W, $t.N, $t.E
    Write-Host ("  [{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $label) -NoNewline

    # Start-Process, not a PowerShell pipe: PS 5.1 re-encodes native stdout, which
    # both mangles UTF-8 and is very slow on large payloads. Redirecting to a file
    # keeps the bytes exactly as node wrote them.
    $fetchArgs = @('scripts/fetch-overpass-venues.mjs', $t.S, $t.W, $t.N, $t.E)
    $p = Start-Process -FilePath 'node' -ArgumentList $fetchArgs -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
    if ($p.ExitCode -ne 0) {
      $msg = ''
      if (Test-Path $tmpErr) { $msg = (Get-Content $tmpErr -Raw) -replace '\s+', ' ' }
      Write-Host "  FETCH FAILED" -ForegroundColor Yellow
      if ($msg) { Warn ($msg.Substring(0, [Math]::Min(200, $msg.Length))) }
      # Recorded, not fatal: Overpass refuses bursts, and the tile is retried on
      # the next run rather than taking the whole session down.
      if ($state.failed -notcontains $t.Id) { [void]$state.failed.Add($t.Id) }
      Save-State $r $state

      $consecutiveFetchFails++
      if ($consecutiveFetchFails -ge $FAILS_BEFORE_ROTATE) {
        Warn "$consecutiveFetchFails failures in a row — trying the next Overpass mirror"
        if (Select-NextOverpass) {
          $consecutiveFetchFails = 0
        } else {
          Fail "every Overpass endpoint stopped answering. Progress is saved — re-run later." 7
        }
      }
      Start-Sleep -Seconds ([Math]::Max(5, $PauseSec * 3))
      continue
    }
    $consecutiveFetchFails = 0

    $size = 0
    if (Test-Path $tmpOut) { $size = (Get-Item $tmpOut).Length }
    if ($size -eq 0) {
      Write-Host "  empty" -ForegroundColor DarkGray
      [void]$state.done.Add($t.Id)
      Save-State $r $state
      Start-Sleep -Seconds $PauseSec
      continue
    }

    if ($DryRun)      { $env:DRY_RUN = '1' } else { Remove-Item env:DRY_RUN -ErrorAction SilentlyContinue }
    if ($SqlOut)      { $env:SQL_OUT = $SqlOut } else { Remove-Item env:SQL_OUT -ErrorAction SilentlyContinue }

    $loadOut = & node scripts/load-osm-venues.mjs $tmpOut 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  LOAD FAILED" -ForegroundColor Yellow
      Warn (($loadOut | Out-String) -replace '\s+', ' ')
      if ($state.failed -notcontains $t.Id) { [void]$state.failed.Add($t.Id) }
      Save-State $r $state
      Start-Sleep -Seconds $PauseSec
      continue
    }

    # Match the totals line by shape, not by position: the loader prints a
    # per-sport breakdown after it, so -Last 1 grabbed the wrong line.
    $lines = @($loadOut | ForEach-Object { "$_" })
    $summary = $lines | Where-Object { $_ -match '\d+\s+venues' } | Select-Object -Last 1
    if (-not $summary) { $summary = $lines | Select-Object -Last 1 }
    $summary = "$summary" -replace '^\s+', ''
    Write-Host "  $summary" -ForegroundColor Green
    if ($summary -match '(\d+)\s+venues') { $grandTotal += [int]$Matches[1] }

    [void]$state.done.Add($t.Id)
    if ($state.failed -contains $t.Id) { [void]$state.failed.Remove($t.Id) }
    Save-State $r $state
    Start-Sleep -Seconds $PauseSec
  }

  Info ("region done: {0}/{1} tiles complete, {2} failed" -f $state.done.Count, $tiles.Count, $state.failed.Count)
}

Remove-Item $tmpOut, $tmpErr -ErrorAction SilentlyContinue

Step "Summary"
Info ("{0} venues seen across this session" -f $grandTotal)
if ($DryRun) { Warn "DRY RUN — nothing was written" }
Info "re-run any time; finished tiles are skipped"
Info "coverage: powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -StatusOnly"
exit 0
