#!/usr/bin/env bash
# CI helper: opens ONE issue per problem and adds a comment on repeats, instead of
# a new issue every night.   scripts/report-failure.sh "TITLE" "BODY"
set -uo pipefail
title="$1"; body="$2"
n=$(gh issue list --repo "$GITHUB_REPOSITORY" --state open --search "in:title \"$title\"" \
      --json number,title -q ".[] | select(.title == \"$title\") | .number" | head -1)
if [ -n "$n" ]; then
  gh issue comment "$n" --repo "$GITHUB_REPOSITORY" --body "Still failing on $(date -u +%Y-%m-%d). $body"
else
  gh issue create --repo "$GITHUB_REPOSITORY" --title "$title" --body "$body"
fi
