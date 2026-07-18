#!/bin/bash
set -euo pipefail

# Bootstrap the superpowers plugin for ephemeral web containers (#299).
# The checked-in .claude/settings.json ENABLES the plugin but does not
# INSTALL it: a fresh container starts without it (project settings for
# external plugins don't install them). This hook makes provisioning
# real — idempotent, non-interactive, web-only.

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

if ! claude plugin list 2>/dev/null | grep -q "superpowers@claude-plugins-official"; then
  claude plugin marketplace add anthropics/claude-plugins-official >/dev/null 2>&1 || true
  claude plugin install superpowers@claude-plugins-official >/dev/null 2>&1 || true
fi

if claude plugin list 2>/dev/null | grep -q "superpowers@claude-plugins-official"; then
  echo "superpowers plugin available"
else
  echo "WARNING: superpowers plugin could not be installed; see .claude/README.md for manual setup"
fi
