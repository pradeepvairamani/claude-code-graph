#!/usr/bin/env bash
#
# Claude Git Intel — Post-commit hook
#
# Captures commit metadata and associates it with the active Claude Code session.
# Place this in .claude/hooks/post-commit.sh or symlink it to .git/hooks/post-commit.
#
# Environment variables used:
#   CLAUDE_SESSION_ID   — Current Claude Code session identifier
#   CLAUDE_AGENT        — Agent model name (e.g., claude-opus-4-6)
#   CLAUDE_PROMPT       — The prompt that triggered this commit
#   CLAUDE_PROMPT_HASH  — SHA-256 hash of the prompt
#

set -euo pipefail

INTEL_DIR=".claude/intel"
SESSIONS_DIR="${INTEL_DIR}/sessions"
INDEX_FILE="${INTEL_DIR}/index.json"

# Only run if we're in a Claude Code session
if [ -z "${CLAUDE_SESSION_ID:-}" ]; then
  # Try to detect from Claude Code temp files
  if [ -f "/tmp/claude-session-${USER}" ]; then
    CLAUDE_SESSION_ID=$(cat "/tmp/claude-session-${USER}")
  else
    exit 0
  fi
fi

# Defaults
CLAUDE_AGENT="${CLAUDE_AGENT:-unknown}"
CLAUDE_PROMPT="${CLAUDE_PROMPT:-<no prompt captured>}"
CLAUDE_PROMPT_HASH="${CLAUDE_PROMPT_HASH:-sha256:unknown}"

# Ensure directories exist
mkdir -p "${SESSIONS_DIR}"

# Capture commit details
COMMIT_SHA=$(git log -1 --format="%H")
COMMIT_SHORT=$(git log -1 --format="%h")
COMMIT_MSG=$(git log -1 --format="%s")
BRANCH=$(git rev-parse --abbrev-ref HEAD)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build files-changed JSON array
FILES_JSON="[]"
if git rev-parse HEAD~1 >/dev/null 2>&1; then
  FILES_JSON=$(git diff HEAD~1 --numstat | while IFS=$'\t' read -r added deleted file; do
    # Build linesAdded array (approximate: just the count for now)
    if [ "$added" = "-" ]; then added=0; fi
    if [ "$deleted" = "-" ]; then deleted=0; fi
    echo "{\"path\":\"${file}\",\"linesAdded\":${added},\"linesDeleted\":${deleted}}"
  done | jq -s '.' 2>/dev/null || echo "[]")
fi

SESSION_FILE="${SESSIONS_DIR}/${CLAUDE_SESSION_ID}.json"

# Create or update session file
if [ -f "${SESSION_FILE}" ]; then
  # Append a new entry to existing session
  ENTRY=$(cat <<ENTRY_EOF
{
  "prompt": $(echo "${CLAUDE_PROMPT}" | jq -Rs .),
  "promptHash": "${CLAUDE_PROMPT_HASH}",
  "timestamp": "${TIMESTAMP}",
  "commits": [
    {
      "sha": "${COMMIT_SHORT}",
      "message": $(echo "${COMMIT_MSG}" | jq -Rs .),
      "filesChanged": ${FILES_JSON}
    }
  ]
}
ENTRY_EOF
  )

  # Use jq to append the entry
  TMP_FILE=$(mktemp)
  jq --argjson entry "${ENTRY}" '.entries += [$entry]' "${SESSION_FILE}" > "${TMP_FILE}"
  mv "${TMP_FILE}" "${SESSION_FILE}"
else
  # Create new session file
  cat > "${SESSION_FILE}" <<SESSION_EOF
{
  "sessionId": "${CLAUDE_SESSION_ID}",
  "agent": "${CLAUDE_AGENT}",
  "branch": "${BRANCH}",
  "startedAt": "${TIMESTAMP}",
  "entries": [
    {
      "prompt": $(echo "${CLAUDE_PROMPT}" | jq -Rs .),
      "promptHash": "${CLAUDE_PROMPT_HASH}",
      "timestamp": "${TIMESTAMP}",
      "commits": [
        {
          "sha": "${COMMIT_SHORT}",
          "message": $(echo "${COMMIT_MSG}" | jq -Rs .),
          "filesChanged": ${FILES_JSON}
        }
      ]
    }
  ]
}
SESSION_EOF
fi

# Update index.json
ENTRY_INDEX=$(jq '.entries | length - 1' "${SESSION_FILE}")

if [ -f "${INDEX_FILE}" ]; then
  TMP_INDEX=$(mktemp)
  jq --arg sha "${COMMIT_SHORT}" \
     --arg file "${CLAUDE_SESSION_ID}.json" \
     --argjson idx "${ENTRY_INDEX}" \
     '.[$sha] = {"sessionFile": $file, "entryIndex": $idx}' \
     "${INDEX_FILE}" > "${TMP_INDEX}"
  mv "${TMP_INDEX}" "${INDEX_FILE}"
else
  cat > "${INDEX_FILE}" <<INDEX_EOF
{
  "${COMMIT_SHORT}": {
    "sessionFile": "${CLAUDE_SESSION_ID}.json",
    "entryIndex": ${ENTRY_INDEX}
  }
}
INDEX_EOF
fi

echo "[Claude Intel] Captured commit ${COMMIT_SHORT} for session ${CLAUDE_SESSION_ID}"
