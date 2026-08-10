#!/usr/bin/env bash
# Stop: a turn may not end with broken types or failing tests — correctness is
# expressed by these checks, so they gate the handoff back to the user.
#
# Every stop is re-checked rather than skipped on stop_hook_active, so a fix is
# verified instead of assumed. Claude Code caps consecutive blocks
# (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP, default 8), so this cannot trap the session.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 0

output=$(pnpm typecheck 2>&1 && pnpm test 2>&1)
[ $? -eq 0 ] && exit 0

jq -n --arg out "$output" \
  '{decision: "block", reason: ("`pnpm typecheck` or `pnpm test` failed. Fix before finishing:\n" + $out)}'
