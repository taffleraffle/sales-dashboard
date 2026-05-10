#!/usr/bin/env bash
# Phase 1.5 QA polling loop
# Polls every 10 minutes for up to 90 minutes.
# Appends findings to .qa-findings.md

REPO="C:/Users/Ben/sales-dashboard"
FINDINGS="$REPO/.qa-findings.md"
STOP_PATTERN="Phase 1.5 complete"
MAX_RUNS=9
run=0
last_reviewed_commit=""

log() {
  echo "[poll $(date '+%H:%M:%S')] $*"
}

af() {
  printf '%s\n' "$1" >> "$FINDINGS"
}

review_commit() {
  local commit="$1"
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')

  local commit_msg
  commit_msg=$(git -C "$REPO" log -1 --format="%s" "$commit" 2>/dev/null)

  local changed_files
  changed_files=$(git -C "$REPO" diff-tree --no-commit-id -r --name-only "$commit" 2>/dev/null)

  af ""
  af "### Poll $ts — commit ${commit:0:8}"
  af "**Commit:** $commit_msg"
  af ""
  af "**Files changed:**"
  while IFS= read -r f; do
    [ -n "$f" ] && af "- $f"
  done <<< "$changed_files"
  af ""

  # node -c syntax check on .js/.jsx files
  while IFS= read -r f; do
    if [[ "$f" =~ \.(jsx?)$ ]]; then
      local fpath="$REPO/$f"
      if [ -f "$fpath" ]; then
        local result
        result=$(node -c "$fpath" 2>&1)
        if echo "$result" | grep -qi "SyntaxError"; then
          af "SYNTAX ERROR in $f: $result"
        else
          af "OK (syntax): $f"
        fi
      fi
    fi
  done <<< "$changed_files"

  # Migration 012 checks
  if echo "$changed_files" | grep -q "012_ad_variant_link.sql"; then
    local sql_file="$REPO/migrations/012_ad_variant_link.sql"
    if [ -f "$sql_file" ]; then
      local sql_content
      sql_content=$(cat "$sql_file")

      if echo "$sql_content" | grep -qi "SECURITY DEFINER"; then
        af "MEDIUM: migration 012 uses SECURITY DEFINER — verify search_path is pinned (SET search_path = public, library) in the function body."
      fi
      if ! echo "$sql_content" | grep -qiE "SECURITY DEFINER|SECURITY INVOKER"; then
        af "LOW: migration 012 trigger functions omit SECURITY INVOKER/DEFINER declaration. Defaults to INVOKER (safe) but explicit is better per hard rule 10."
      fi
      if echo "$sql_content" | grep -qi "NOTIFY pgrst"; then
        af "OK: NOTIFY pgrst present in migration 012."
      else
        af "HIGH: NOTIFY pgrst MISSING from migration 012."
      fi

      # Check the legacy_match type cast issue noted in plan analysis
      if echo "$sql_content" | grep -q "lm.variant_id::text"; then
        af "MEDIUM: migration 012 — legacy_ad_mapping.variant_id is UUID; casting to text then comparing via WHERE id::text = legacy_match is unnecessarily indirect. Compare UUIDs directly: WHERE v.id = lm.variant_id."
      fi

      # Check for credential leaks
      if echo "$sql_content" | grep -qiE "wp_username|wp_app_password|Bearer |EAAq[A-Za-z0-9]{10}"; then
        af "CRITICAL: Possible credential in migration 012."
      fi

      # RLS — migration 012 adds columns to existing tables, no new tables, so no new RLS needed
      af "NOTE: migration 012 adds columns to public.ads (no new tables) — existing RLS on public.ads covers new variant_id/variant_match_status columns."
    fi
  fi

  # Hardcoded hex colors in JSX
  while IFS= read -r f; do
    if [[ "$f" =~ \.jsx$ ]]; then
      local fpath="$REPO/$f"
      if [ -f "$fpath" ]; then
        local hex_hits
        hex_hits=$(grep -nE "'#[0-9a-fA-F]{3,8}'|\"#[0-9a-fA-F]{3,8}\"" "$fpath" 2>/dev/null || true)
        if [ -n "$hex_hits" ]; then
          af "MEDIUM (hard rule 3): hardcoded hex in $f:"
          while IFS= read -r line; do
            af "  $line"
          done <<< "$(echo "$hex_hits" | head -5)"
        fi
      fi
    fi
  done <<< "$changed_files"

  # Emoji check in JSX
  while IFS= read -r f; do
    if [[ "$f" =~ \.jsx$ ]]; then
      local fpath="$REPO/$f"
      if [ -f "$fpath" ]; then
        if grep -Pq '[\x{1F300}-\x{1FFFF}]' "$fpath" 2>/dev/null; then
          af "HIGH (hard rule 2): emoji found in $f."
        fi
      fi
    fi
  done <<< "$changed_files"

  # Meta write check (hard rule 1)
  while IFS= read -r f; do
    local fpath="$REPO/$f"
    if [ -f "$fpath" ]; then
      if grep -qiE "(method.*POST|method.*PUT|method.*PATCH|method.*DELETE).*graph\.facebook\.com|graph\.facebook\.com.*(POST|PUT|PATCH|DELETE)" "$fpath" 2>/dev/null; then
        af "CRITICAL (hard rule 1): non-GET call to graph.facebook.com in $f."
      fi
    fi
  done <<< "$changed_files"

  # Hardcoded credential check
  while IFS= read -r f; do
    local fpath="$REPO/$f"
    if [ -f "$fpath" ]; then
      if grep -qiE "wp_username|wp_app_password|EAAq[a-zA-Z0-9]{20}" "$fpath" 2>/dev/null; then
        af "CRITICAL (hard rule 6): possible hardcoded credential in $f."
      fi
    fi
  done <<< "$changed_files"

  # Library schema read pattern check (hard rule 11)
  while IFS= read -r f; do
    if [[ "$f" =~ \.jsx?$ ]]; then
      local fpath="$REPO/$f"
      if [ -f "$fpath" ]; then
        # If file uses library schema tables without .schema('library')
        if grep -qE "supabase\.from\('(components|variants|performance_daily|legacy_ad_mapping|orphan_ads)'\)" "$fpath" 2>/dev/null; then
          af "HIGH (hard rule 11): $f queries library schema table without .schema('library'). Use supabase.schema('library').from('...')."
        fi
      fi
    fi
  done <<< "$changed_files"

  # Build check
  local build_out
  build_out=$(cd "$REPO" && npm run build 2>&1)
  local build_exit=$?
  if [ $build_exit -eq 0 ]; then
    af "BUILD: npm run build PASSED."
  else
    af "HIGH: npm run build FAILED. Last 20 lines:"
    while IFS= read -r line; do
      af "  $line"
    done <<< "$(echo "$build_out" | tail -20)"
  fi

  af ""
  af "---"
}

log "Phase 1.5 QA poll starting. Baseline commit: $(git -C "$REPO" log -1 --format="%H" 2>/dev/null | cut -c1-8)"
last_reviewed_commit=$(git -C "$REPO" log -1 --format="%H" 2>/dev/null)

while [ $run -lt $MAX_RUNS ]; do
  run=$((run + 1))
  log "Sleeping 10 minutes (run $run/$MAX_RUNS)..."
  sleep 600

  log "Woke up. Checking for new commits..."
  current_commit=$(git -C "$REPO" log -1 --format="%H" 2>/dev/null)
  commit_msg=$(git -C "$REPO" log -1 --format="%s" 2>/dev/null)

  if [ "$current_commit" = "$last_reviewed_commit" ]; then
    log "No new commits since last check."
    continue
  fi

  log "New commits detected. Reviewing..."

  # Get all new commits since last reviewed
  new_commits=$(git -C "$REPO" log --format="%H" "${last_reviewed_commit}..HEAD" 2>/dev/null | tac)

  for commit in $new_commits; do
    log "Reviewing commit: $(echo "$commit" | cut -c1-8)"
    review_commit "$commit"

    # Check for stop pattern
    cmsg=$(git -C "$REPO" log -1 --format="%s" "$commit" 2>/dev/null)
    if echo "$cmsg" | grep -qi "$STOP_PATTERN"; then
      log "STOP PATTERN FOUND in: $cmsg"
      af ""
      af "### QA session complete — stop pattern matched at commit $(echo "$commit" | cut -c1-8)."
      exit 0
    fi
  done

  last_reviewed_commit="$current_commit"
done

log "90-minute timeout reached."
printf '\n### QA session ended — 90-minute timeout reached without "Phase 1.5 complete" commit.\n' >> "$FINDINGS"
