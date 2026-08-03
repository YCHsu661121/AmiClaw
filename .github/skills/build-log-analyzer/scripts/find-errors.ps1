<#
.SYNOPSIS
    Stream-scan a build.log for failure points without loading the entire file.
.PARAMETER LogPath
    Path to the build log. Defaults to auto-detect in current directory.
.PARAMETER ContextLines
    Lines of context to show around each error (default: 8).
.PARAMETER MaxErrors
    Maximum distinct errors to report (default: 10).
.EXAMPLE
    .\find-errors.ps1 -LogPath D:\AMI\Build.log
    .\find-errors.ps1  # auto-detect
#>
param(
    [string]$LogPath     = '',
    [int]   $ContextLines = 8,
    [int]   $MaxErrors    = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Auto-detect log file ────────────────────────────────────────────────────
if (-not $LogPath) {
    $candidates = @('Build.log','build.log','build\Build.log','out\build.log','logs\build.log')
    foreach ($c in $candidates) {
        $full = Join-Path (Get-Location) $c
        if (Test-Path $full) { $LogPath = $full; break }
    }
}
if (-not $LogPath -or -not (Test-Path $LogPath)) {
    Write-Error "build.log not found. Pass -LogPath <path> or run from build directory."
    exit 1
}

$fileSize = (Get-Item $LogPath).Length
Write-Host "Log: $LogPath  ($([math]::Round($fileSize/1KB, 1)) KB)" -ForegroundColor Cyan

# ── Error patterns ───────────────────────────────────────────────────────────
$patterns = @(
    # TypeScript
    'error TS\d+:',
    # AMI / EDKII
    'ERROR\s*-\s',
    'FAILED\s*-\s*stopping',
    'Build FAILED',
    # make
    'make\[?\d*\]?:\s*\*\*\*',
    # GCC / Clang / MSVC
    ':\s*error\s*[C\d]*:',
    'LINK\s*:\s*fatal error',
    # npm / Node
    'npm ERR!',
    # generic (lower priority — only if no specific match)
    '^\s*ERROR\b',
    'error:',
    '\bFAILED\b'
)
$combinedPattern = ($patterns | ForEach-Object { "(?:$_)" }) -join '|'

# ── Stream scan with Select-String (no full load) ───────────────────────────
Write-Host "Scanning for errors..." -ForegroundColor Yellow
$matches_ = Select-String -Path $LogPath -Pattern $combinedPattern -CaseSensitive:$false |
    Select-Object LineNumber, Line

if (-not $matches_ -or $matches_.Count -eq 0) {
    Write-Host "No errors found in build log." -ForegroundColor Green
    exit 0
}

Write-Host "Found $($matches_.Count) matching lines. Showing root cause + top errors:`n" -ForegroundColor Red

# ── Read file lines for context (only the ranges we need) ───────────────────
$allLines = [System.IO.File]::ReadAllLines($LogPath)
$totalLines = $allLines.Length

function Show-Context {
    param([int]$lineNo)  # 1-based
    $start = [math]::Max(0, $lineNo - 1 - $ContextLines)
    $end   = [math]::Min($totalLines - 1, $lineNo - 1 + $ContextLines)
    for ($i = $start; $i -le $end; $i++) {
        $prefix = if ($i -eq $lineNo - 1) { '>>> ' } else { '    ' }
        $color  = if ($i -eq $lineNo - 1) { 'Red' } else { 'Gray' }
        Write-Host ("{0}{1,5}: {2}" -f $prefix, ($i+1), $allLines[$i]) -ForegroundColor $color
    }
}

# ── Report root cause (first error) ─────────────────────────────────────────
$first = $matches_[0]
Write-Host "═══ ROOT CAUSE — Line $($first.LineNumber) ═══" -ForegroundColor Magenta
Show-Context $first.LineNumber
Write-Host ""

# ── Remaining errors (deduplicated by message prefix) ──────────────────────
$reported = 1
$seen = [System.Collections.Generic.HashSet[string]]::new()
[void]$seen.Add($first.Line.Trim().Substring(0, [math]::Min(80, $first.Line.Trim().Length)))

$matches_ | Select-Object -Skip 1 | ForEach-Object {
    if ($reported -ge $MaxErrors) { return }
    $key = $_.Line.Trim().Substring(0, [math]::Min(80, $_.Line.Trim().Length))
    if ($seen.Contains($key)) { return }
    [void]$seen.Add($key)

    Write-Host "─── Error at Line $($_.LineNumber) ───" -ForegroundColor Yellow
    Show-Context $_.LineNumber
    Write-Host ""
    $reported++
}

# ── Summary ─────────────────────────────────────────────────────────────────
Write-Host "═══ Summary ═══" -ForegroundColor Cyan
Write-Host "Total matching lines : $($matches_.Count)"
Write-Host "Distinct errors shown: $reported"
if ($matches_.Count -gt $MaxErrors) {
    Write-Host "(Use -MaxErrors $($matches_.Count) to see all)" -ForegroundColor DarkYellow
}
