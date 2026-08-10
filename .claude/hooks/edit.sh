#!/usr/bin/env bash
# PostToolUse(Write|Edit): keep every written file in Prettier's shape, so
# formatting never becomes a reviewable diff of its own.
set -uo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd) || exit 0
cd "$root" || exit 0

file=$(jq -r '.tool_response.filePath // .tool_input.file_path // empty')
[ -n "$file" ] && [ -f "$file" ] || exit 0

# This repo's formatting is not this repo's business to impose elsewhere:
# files written outside the project keep whatever conventions they came with.
abs=$(cd "$(dirname "$file")" && printf '%s/%s' "$PWD" "$(basename "$file")") || exit 0
case "$abs" in
"$root"/*) ;;
*) exit 0 ;;
esac

# format:file skips files Prettier has no parser for; .prettierignore still applies.
pnpm run format:file "$abs" >/dev/null 2>&1 || true
