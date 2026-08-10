#!/usr/bin/env bash
# PostToolUse(Write|Edit): keep every written file in Prettier's shape, so
# formatting never becomes a reviewable diff of its own.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 0

file=$(jq -r '.tool_response.filePath // .tool_input.file_path // empty')
[ -n "$file" ] && [ -f "$file" ] || exit 0

# format:file skips files Prettier has no parser for; .prettierignore still applies.
pnpm run format:file "$file" >/dev/null 2>&1 || true
