# Phase 1.5 QA polling script (PowerShell)
# Polls every 10 minutes for up to 90 minutes.
# Appends review findings to .qa-findings.md

$repo = "C:\Users\Ben\sales-dashboard"
$findings = "$repo\.qa-findings.md"
$stopPattern = "Phase 1.5 complete"
$maxRuns = 9
$run = 0
$lastReviewedCommit = ""

function af($line) {
    Add-Content -Path $findings -Value $line -Encoding UTF8
}

function Review-Commit($commit) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $commitMsg = git -C $repo log -1 --format="%s" $commit 2>&1
    $changedFiles = git -C $repo diff-tree --no-commit-id -r --name-only $commit 2>&1

    af ""
    af "### Poll $ts — commit $($commit.Substring(0,8))"
    af "**Commit:** $commitMsg"
    af ""
    af "**Files changed:**"
    $changedFiles | ForEach-Object { if ($_) { af "- $_" } }
    af ""

    # Build check
    $buildResult = & npm --prefix $repo run build 2>&1
    $buildExit = $LASTEXITCODE
    if ($buildExit -eq 0) {
        af "BUILD: npm run build PASSED."
    } else {
        af "HIGH: npm run build FAILED:"
        $buildResult | Select-Object -Last 20 | ForEach-Object { af "  $_" }
    }

    # Hardcoded hex check in JSX files
    $changedFiles | Where-Object { $_ -match '\.jsx$' } | ForEach-Object {
        $fpath = "$repo\$($_.Replace('/', '\'))"
        if (Test-Path $fpath) {
            $hexHits = Select-String -Path $fpath -Pattern "'#[0-9a-fA-F]{3,8}'|""#[0-9a-fA-F]{3,8}""" -AllMatches 2>$null
            if ($hexHits) {
                af "MEDIUM (hard rule 3): hardcoded hex in $_"
                $hexHits | Select-Object -First 5 | ForEach-Object { af "  $($_.Line.Trim())" }
            }
        }
    }

    # Library schema check in JSX (hard rule 11)
    $changedFiles | Where-Object { $_ -match '\.jsx?$' } | ForEach-Object {
        $fpath = "$repo\$($_.Replace('/', '\'))"
        if (Test-Path $fpath) {
            $badQuery = Select-String -Path $fpath -Pattern "supabase\.from\('(components|variants|performance_daily|legacy_ad_mapping|orphan_ads)'\)" 2>$null
            if ($badQuery) {
                af "HIGH (hard rule 11): $_ queries library schema table without .schema('library')."
            }
        }
    }

    # Credential check
    $allFiles = $changedFiles | ForEach-Object {
        "$repo\$($_.Replace('/', '\'))"
    } | Where-Object { Test-Path $_ }
    foreach ($fpath in $allFiles) {
        $credHit = Select-String -Path $fpath -Pattern "wp_username|wp_app_password|EAAq[a-zA-Z0-9]{15}" 2>$null
        if ($credHit) {
            af "CRITICAL (hard rule 6): possible credential in $fpath"
        }
    }

    # Migration 012 checks (if present in this commit)
    if ($changedFiles -match "012_ad_variant_link") {
        $sqlPath = "$repo\migrations\012_ad_variant_link.sql"
        if (Test-Path $sqlPath) {
            $sql = Get-Content $sqlPath -Raw
            if ($sql -match "NOTIFY pgrst") { af "OK: NOTIFY pgrst present in migration 012." }
            else { af "HIGH: NOTIFY pgrst MISSING from migration 012." }
            if ($sql -match "SECURITY DEFINER" -and $sql -match "SET search_path") { af "OK: SECURITY DEFINER has pinned search_path in migration 012." }
        }
    }

    # Stop pattern check
    if ($commitMsg -match [regex]::Escape($stopPattern)) {
        af ""
        af "### STOP: Phase 1.5 complete commit detected. QA session ended."
        return $true
    }
    return $false
}

# Get baseline
$lastReviewedCommit = git -C $repo log -1 --format="%H" 2>&1
Write-Host "[poll] Started. Baseline: $($lastReviewedCommit.Substring(0,8)). Polling every 10 min for 90 min."

while ($run -lt $maxRuns) {
    $run++
    Write-Host "[poll] Sleeping 10 minutes (run $run/$maxRuns)..."
    Start-Sleep -Seconds 600

    Write-Host "[poll] Woke up. Checking for new commits..."
    $currentCommit = git -C $repo log -1 --format="%H" 2>&1

    if ($currentCommit -eq $lastReviewedCommit) {
        Write-Host "[poll] No new commits."
        continue
    }

    Write-Host "[poll] New commits detected!"
    $newCommits = git -C $repo log --format="%H" "$lastReviewedCommit..HEAD" 2>&1
    # Reverse to review oldest first
    [array]::Reverse($newCommits)

    foreach ($commit in $newCommits) {
        if (-not $commit) { continue }
        Write-Host "[poll] Reviewing $($commit.Substring(0,8))..."
        $done = Review-Commit $commit
        if ($done) {
            Write-Host "[poll] Stop pattern found. Exiting."
            exit 0
        }
    }

    $lastReviewedCommit = $currentCommit
}

af ""
af "### QA session ended — 90-minute timeout reached without 'Phase 1.5 complete' commit."
Write-Host "[poll] Session ended — timeout."
