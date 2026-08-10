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
  [string] $OverpassUrl = '',
  # Walk tiles in raw west-to-east order instead of nearest-metro-first.
  [switch] $NoPrioritize,
  # Skip tiles further than this many km from any population centre. 0 = visit
  # every tile. California is mostly ocean, desert and national forest: at 120
  # this drops roughly half the state's tiles, none of which hold a court.
  # Skipped tiles are NOT recorded as done, so raising the radius later picks
  # them up.
  [double] $MaxMetroKm = 0,
  # How many times a failing tile may be quartered and retried. Overpass answers
  # 504 when a query is too expensive for it, which is what a dense metro tile
  # is — four smaller queries usually all succeed where the whole tile could not.
  # 0 disables splitting.
  [int] $SplitDepth = 1
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
        $doneN = @($st.done).Count
        $total = @(Get-Tiles $REGIONS[$r].Box $TileDeg).Count
        # Yield, not just progress: "194 tiles done" says nothing about whether
        # the state actually holds courts. Tiles fetched before counts existed
        # are reported separately rather than being silently counted as zero.
        $withCounts = 0; $venues = 0; $productive = 0
        if ($st.PSObject.Properties.Name -contains 'counts' -and $st.counts) {
          foreach ($p in $st.counts.PSObject.Properties) {
            $withCounts++; $venues += [int]$p.Value
            if ([int]$p.Value -gt 0) { $productive++ }
          }
        }
        Info ("{0,-16} {1}/{2} tiles done, {3} failed" -f $r, $doneN, $total, @($st.failed).Count)
        if ($withCounts -gt 0) {
          Info ("{0,-16}   {1} venues from {2} productive of {3} measured tiles" -f '', $venues, $productive, $withCounts)
        }
        if ($doneN -gt $withCounts) {
          Info ("{0,-16}   {1} tiles done before yields were recorded" -f '', ($doneN - $withCounts))
        }
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

# How long to wait for a mirror's status page. Deliberately generous: under load
# these took 20-22s to answer a *status* page while serving real queries fine, so
# a 15s probe declared all three dead and the script exited rather than working.
# A slow mirror is still a working mirror; the ranking below handles preferring
# the quick one.
$PROBE_TIMEOUT_SEC = 45

# Returns response time in ms, or -1 when the endpoint is not usable.
function Measure-OverpassEndpoint($url) {
  $statusUrl = $url -replace '/api/interpreter/?$', '/api/status'
  # Two attempts: these are volunteer-run mirrors that blink in and out, and a
  # single timeout was enough to write off one that was healthy seconds later.
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $resp = Invoke-WebRequest -Uri $statusUrl -TimeoutSec $PROBE_TIMEOUT_SEC -UseBasicParsing -ErrorAction Stop
      $sw.Stop()
      if ($resp.StatusCode -eq 200) { return [int]$sw.ElapsedMilliseconds }
    } catch {
      if ($attempt -lt 2) { Start-Sleep -Seconds 3 }
    }
  }
  return -1
}

function Test-OverpassEndpoint($url) { return ((Measure-OverpassEndpoint $url) -ge 0) }

# Rank the mirrors by how quickly they answer, fastest first, and drop the dead
# ones. Worth doing: on the same dense tile one mirror answered in 30s and
# another took 182s for identical data, and the old "first that responds" rule
# had no way to prefer the quick one.
function Initialize-OverpassRanking {
  $healthy = @()
  foreach ($m in $script:Mirrors) {
    $ms = Measure-OverpassEndpoint $m
    if ($ms -ge 0) {
      Info ("{0,6} ms  {1}" -f $ms, $m)
      $healthy += [pscustomobject]@{ Url = $m; Ms = $ms }
    } else {
      Warn "no answer: $m"
    }
  }
  if ($healthy.Count -eq 0) { return $false }
  $script:Mirrors = @($healthy | Sort-Object Ms | ForEach-Object { $_.Url })
  $script:MirrorIndex = 0
  $env:OVERPASS_URL = $script:Mirrors[0]
  Info "using $($script:Mirrors[0])"
  return $true
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
  # Wraps around the list rather than walking off the end. A mirror that was
  # refusing traffic ten minutes ago is usually serving again, so exhausting the
  # list once is not a reason to give up — only a full cycle with nothing
  # healthy is.
  $n = $script:Mirrors.Count
  for ($step = 1; $step -le $n; $step++) {
    $i = ($script:MirrorIndex + $step) % $n
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
if (-not (Initialize-OverpassRanking)) {
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

# Population centres, used only to ORDER tiles — nothing is skipped because of
# this list. A region's bounding box starts at its southwest corner, so a plain
# west-to-east sweep of California opens with about fourteen tiles of open
# Pacific: ten minutes of "empty" before the first court. Working outward from
# the metros instead means the tiles that actually hold venues are done first,
# and the time budget only ever cuts off the empty margins.
$CA_METROS = @(
  @(37.77, -122.42), @(37.34, -121.89), @(37.96, -121.29), @(38.58, -121.49),
  @(38.44, -122.71), @(36.60, -121.89), @(36.74, -119.79), @(36.33, -119.29),
  @(35.37, -119.02), @(35.28, -120.66), @(34.42, -119.70), @(34.05, -118.24),
  @(33.70, -117.83), @(33.95, -117.40), @(33.83, -116.55), @(32.72, -117.16),
  @(37.64, -120.99), @(39.73, -121.84), @(40.59, -122.39), @(40.80, -124.16)
)

function Get-MetroDistanceKm($lat, $lon) {
  $best = [double]::MaxValue
  foreach ($m in $CA_METROS) {
    # Equirectangular approximation: plenty for ranking tiles, and far cheaper
    # than haversine across 420 tiles x 20 centres.
    $dLat = ($lat - $m[0]) * 111.0
    $dLon = ($lon - $m[1]) * 111.0 * [Math]::Cos($lat * [Math]::PI / 180.0)
    $d = [Math]::Sqrt($dLat * $dLat + $dLon * $dLon)
    if ($d -lt $best) { $best = $d }
  }
  return $best
}

$stateDir = Join-Path $PSScriptRoot '.enrich-state'
if (-not (Test-Path $stateDir)) { [void](New-Item -ItemType Directory -Path $stateDir) }

function Get-State($region) {
  # Dry runs start from a clean slate too, so a preview always previews the whole
  # region rather than only whatever a previous real run hadn't reached yet.
  $f = Join-Path $stateDir "venues-$region.json"
  if ((Test-Path $f) -and -not $Restart -and -not $DryRun) {
    $raw = Get-Content $f -Raw | ConvertFrom-Json
    # `counts` post-dates the first state files, so its absence is normal — those
    # tiles simply have no recorded yield until they are fetched again.
    $counts = @{}
    if ($raw.PSObject.Properties.Name -contains 'counts' -and $raw.counts) {
      foreach ($p in $raw.counts.PSObject.Properties) { $counts[$p.Name] = [int]$p.Value }
    }
    return @{
      done   = [System.Collections.ArrayList]@($raw.done)
      failed = [System.Collections.ArrayList]@($raw.failed)
      counts = $counts
    }
  }
  return @{
    done   = (New-Object System.Collections.ArrayList)
    failed = (New-Object System.Collections.ArrayList)
    counts = @{}
  }
}
function Save-State($region, $state) {
  # A dry run writes nothing to the database, so it must not claim tiles as done
  # either — otherwise the next REAL run skips every tile you previewed.
  if ($DryRun) { return }
  # A tile that later succeeded must not stay on the failed list. Pruning here
  # rather than at each call site because the empty-tile path forgot to, which
  # left 72 California tiles counted as both and made the run look far worse
  # than it was.
  if ($state.done.Count -gt 0 -and $state.failed.Count -gt 0) {
    $doneLookup = [System.Collections.Generic.HashSet[string]]::new([string[]]@($state.done))
    $stillFailed = @($state.failed | Where-Object { -not $doneLookup.Contains($_) })
    $state.failed = [System.Collections.ArrayList]@($stillFailed)
  }
  $f = Join-Path $stateDir "venues-$region.json"
  [pscustomobject]@{
    done      = @($state.done)
    failed    = @($state.failed)
    counts    = $state.counts
    updatedAt = (Get-Date).ToString('o')
  } | ConvertTo-Json -Depth 4 | Set-Content -Path $f -Encoding utf8
}

# ── One bounding box, fetched and loaded ──────────────────────────────────────
# Returns @{ Ok; Venues; Empty; Summary; Error }. Split out of the tile loop so
# a failing box can be quartered and retried through the same path.
function Invoke-Bbox($s, $w, $n, $e) {
  # Start-Process, not a PowerShell pipe: PS 5.1 re-encodes native stdout, which
  # both mangles UTF-8 and is very slow on large payloads. Redirecting to a file
  # keeps the bytes exactly as node wrote them.
  $fetchArgs = @('scripts/fetch-overpass-venues.mjs', $s, $w, $n, $e)
  $p = Start-Process -FilePath 'node' -ArgumentList $fetchArgs -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
  if ($p.ExitCode -ne 0) {
    $msg = ''
    if (Test-Path $tmpErr) { $msg = (Get-Content $tmpErr -Raw) -replace '\s+', ' ' }
    return @{ Ok = $false; Venues = 0; Empty = $false; Error = $msg }
  }

  $size = 0
  if (Test-Path $tmpOut) { $size = (Get-Item $tmpOut).Length }
  if ($size -eq 0) { return @{ Ok = $true; Venues = 0; Empty = $true; Summary = 'empty' } }

  if ($DryRun) { $env:DRY_RUN = '1' } else { Remove-Item env:DRY_RUN -ErrorAction SilentlyContinue }
  if ($SqlOut) { $env:SQL_OUT = $SqlOut } else { Remove-Item env:SQL_OUT -ErrorAction SilentlyContinue }

  $loadOut = & node scripts/load-osm-venues.mjs $tmpOut 2>&1
  if ($LASTEXITCODE -ne 0) {
    return @{ Ok = $false; Venues = 0; Empty = $false; Error = (($loadOut | Out-String) -replace '\s+', ' ') }
  }

  # Match the totals line by shape, not by position: the loader prints a
  # per-sport breakdown after it, so -Last 1 grabbed the wrong line.
  $lines = @($loadOut | ForEach-Object { "$_" })
  $summary = $lines | Where-Object { $_ -match '\d+\s+venues' } | Select-Object -Last 1
  if (-not $summary) { $summary = $lines | Select-Object -Last 1 }
  $summary = "$summary" -replace '^\s+', ''
  $venues = 0
  if ($summary -match '(\d+)\s+venues') { $venues = [int]$Matches[1] }
  return @{ Ok = $true; Venues = $venues; Empty = ($venues -eq 0); Summary = $summary }
}

# Quarter a failing box and retry the pieces. A 504 means the gateway gave up on
# the query's cost, not that the data is unreachable — so the same area asked for
# in four cheaper questions typically answers fine. Sub-tiles are transient: only
# the parent tile id is ever recorded, so this cannot fragment the resume state.
function Invoke-BboxWithSplit($s, $w, $n, $e, $depth) {
  $res = Invoke-Bbox $s $w $n $e
  if ($res.Ok -or $depth -le 0) { return $res }

  Write-Host ""
  Warn ("    too expensive — splitting {0},{1} -> {2},{3} into 4" -f $s, $w, $n, $e)
  $midLat = ($s + $n) / 2
  $midLon = ($w + $e) / 2
  $quads = @(
    @($s, $w, $midLat, $midLon), @($s, $midLon, $midLat, $e),
    @($midLat, $w, $n, $midLon), @($midLat, $midLon, $n, $e)
  )
  $total = 0
  foreach ($q in $quads) {
    Start-Sleep -Seconds $PauseSec
    $sub = Invoke-BboxWithSplit $q[0] $q[1] $q[2] $q[3] ($depth - 1)
    if (-not $sub.Ok) {
      # Partial success is still a failed tile: the parent is retried whole next
      # run. Re-fetching a quadrant is cheap and venues upsert by OSM id.
      return @{ Ok = $false; Venues = $total; Empty = $false; Error = $sub.Error }
    }
    $total += $sub.Venues
  }
  return @{ Ok = $true; Venues = $total; Empty = ($total -eq 0); Summary = "$total venues (split)" }
}

# ── Run ───────────────────────────────────────────────────────────────────────
$deadline = if ($HoursToRun -gt 0) { (Get-Date).AddHours($HoursToRun) } else { [DateTime]::MaxValue }
$tmpOut = Join-Path $env:TEMP "pl-venues-$PID.geojsonseq"
$tmpErr = Join-Path $env:TEMP "pl-venues-$PID.err"
$grandTotal = 0
$stopped = $false
# Endpoint health is judged on a ROLLING WINDOW, not a consecutive streak.
# The consecutive-failure test was wrong in practice: an overloaded mirror fails
# most tiles but still lets the occasional one through, and every success reset
# the counter — so a run recorded 402 failures out of 447 tiles without ever
# rotating once. Half the recent window failing is the signal that matters.
$recentResults = New-Object System.Collections.ArrayList
$WINDOW = 10
$WINDOW_FAIL_TRIP = 5
# Escalating cool-off after a failure: hammering a struggling mirror at the
# normal cadence is what turns a busy patch into a wall of 504s.
$failStreak = 0
$rotationsSinceProgress = 0

foreach ($r in $regionList) {
  if ($stopped) { break }
  $meta = $REGIONS[$r]
  # @() because PowerShell unrolls a returned collection — a one-tile region
  # would otherwise come back as a bare object with no .Count.
  $tiles = @(Get-Tiles $meta.Box $TileDeg)
  # Nearest-metro-first. Ordering only; every tile is still visited.
  if (-not $NoPrioritize -and $tiles.Count -gt 1) {
    $tiles = @($tiles | Sort-Object @{ Expression = {
      Get-MetroDistanceKm (($_.S + $_.N) / 2) (($_.W + $_.E) / 2)
    } })
  }
  $skippedFar = 0
  if ($MaxMetroKm -gt 0 -and $tiles.Count -gt 1) {
    $before = $tiles.Count
    $tiles = @($tiles | Where-Object {
      (Get-MetroDistanceKm (($_.S + $_.N) / 2) (($_.W + $_.E) / 2)) -le $MaxMetroKm
    })
    $skippedFar = $before - $tiles.Count
    if ($tiles.Count -eq 0) {
      # Loudly, not silently. The metro list is California-only, so pointing this
      # at another state with -MaxMetroKm set would filter away every tile and
      # report a clean "nothing to do" — success-looking output for a run that
      # did nothing at all.
      Fail ("-MaxMetroKm $MaxMetroKm removed all $before tiles in '$r'. The population-centre list only covers California; raise the radius or drop -MaxMetroKm.") 8
    }
  }
  $state = Get-State $r
  $todo = @($tiles | Where-Object { $state.done -notcontains $_.Id })

  Step "$($meta.Label)  [$r]"
  Info ("{0} tiles at {1} deg — {2} already done, {3} to go" -f $tiles.Count, $TileDeg, $state.done.Count, $todo.Count)
  if ($skippedFar -gt 0) {
    # Not recorded as done: raising -MaxMetroKm later picks these up.
    Info ("{0} tiles skipped as further than {1} km from any population centre" -f $skippedFar, $MaxMetroKm)
  }
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

    $res = Invoke-BboxWithSplit $t.S $t.W $t.N $t.E $SplitDepth
    if (-not $res.Ok) {
      $msg = "$($res.Error)"
      Write-Host "  FAILED" -ForegroundColor Yellow
      if ($msg) { Warn ($msg.Substring(0, [Math]::Min(200, $msg.Length))) }
      # Recorded, not fatal: Overpass refuses bursts, and the tile is retried on
      # the next run rather than taking the whole session down.
      if ($state.failed -notcontains $t.Id) { [void]$state.failed.Add($t.Id) }
      Save-State $r $state

      [void]$recentResults.Add($false)
      while ($recentResults.Count -gt $WINDOW) { $recentResults.RemoveAt(0) }
      $failStreak++

      $recentFails = @($recentResults | Where-Object { -not $_ }).Count
      if ($recentResults.Count -ge $WINDOW -and $recentFails -ge $WINDOW_FAIL_TRIP) {
        Warn "$recentFails of the last $($recentResults.Count) tiles failed — rotating Overpass mirror"
        if (Select-NextOverpass) {
          $recentResults.Clear()
          $rotationsSinceProgress++
          if ($rotationsSinceProgress -ge ($script:Mirrors.Count * 2)) {
            Fail "every mirror is failing. Progress is saved — re-run later; failed tiles retry automatically." 7
          }
        } else {
          Fail "no Overpass endpoint is answering. Progress is saved — re-run later." 7
        }
      }
      # Back off harder the longer the failures persist (5s, 15s, 30s, 60s cap).
      $cool = [Math]::Min(60, 5 * [Math]::Pow(2, [Math]::Min(4, $failStreak - 1)))
      Start-Sleep -Seconds $cool
      continue
    }
    [void]$recentResults.Add($true)
    while ($recentResults.Count -gt $WINDOW) { $recentResults.RemoveAt(0) }
    $failStreak = 0
    $rotationsSinceProgress = 0

    if ($res.Empty) {
      Write-Host "  empty" -ForegroundColor DarkGray
    } else {
      Write-Host "  $($res.Summary)" -ForegroundColor Green
    }
    $grandTotal += $res.Venues

    [void]$state.done.Add($t.Id)
    # Remember what the tile yielded, so a later run can tell "checked, genuinely
    # empty" from "never successfully fetched" — the two were indistinguishable
    # once a tile was marked done.
    $state.counts[$t.Id] = $res.Venues
    if ($state.failed -contains $t.Id) { [void]$state.failed.Remove($t.Id) }
    Save-State $r $state
    Start-Sleep -Seconds $PauseSec
  }

  Info ("region done: {0}/{1} tiles complete, {2} failed" -f $state.done.Count, $tiles.Count, $state.failed.Count)
}

Remove-Item $tmpOut, $tmpErr -ErrorAction SilentlyContinue

# ── Backfill city ─────────────────────────────────────────────────────────────
# load-osm-venues.mjs deliberately never writes `city` (see its comment: the
# column is owned by the offline geocoder so re-running an ingest can't clobber a
# geocoded value). Nothing was re-running that geocoder afterwards, though, so
# every ingest quietly grew the null-city count — 319 rows by the time anyone
# looked, and city is what venue search displays. The function is idempotent and
# only touches `city is null`, so running it after each ingest is free.
if (-not $DryRun -and -not $SqlOut -and $grandTotal -gt 0) {
  Step "Backfilling city from coordinates"
  try {
    $hdr = @{ apikey = $env:SUPABASE_SERVICE_ROLE_KEY
              Authorization = "Bearer $($env:SUPABASE_SERVICE_ROLE_KEY)"
              'Content-Type' = 'application/json' }
    $n = Invoke-RestMethod -Method Post -Uri "$($env:SUPABASE_URL)/rest/v1/rpc/backfill_venue_cities" `
      -Headers $hdr -Body '{}' -TimeoutSec 120
    Info "$n venues given a city"
  } catch {
    # Never fatal: the venues are already ingested, and the backfill is safe to
    # re-run by hand or on the next pass.
    Warn "city backfill failed (venues are still saved): $($_.Exception.Message)"
  }
}

Step "Summary"
Info ("{0} venues seen across this session" -f $grandTotal)
if ($DryRun) { Warn "DRY RUN — nothing was written" }
Info "re-run any time; finished tiles are skipped"
Info "coverage: powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -StatusOnly"
exit 0
