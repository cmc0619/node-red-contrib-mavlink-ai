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

if claude plugin list 2>/dev/null | grep "superpowers@claude-plugins-official" >/dev/null; then
  echo "superpowers plugin available"
  exit 0
fi

claude plugin marketplace add anthropics/claude-plugins-official >/dev/null 2>&1 || true
claude plugin install superpowers@claude-plugins-official >/dev/null 2>&1 || true

if claude plugin list 2>/dev/null | grep "superpowers@claude-plugins-official" >/dev/null; then
  # A plugin installed DURING SessionStart may not activate until the
  # harness rescans (there is no non-interactive /reload-plugins); in
  # practice skills appear by the next turn, and the cached container
  # state makes every later session start with the plugin present.
  echo "superpowers plugin installed (fresh container); skills activate on rescan if not immediately visible"
else
  echo "WARNING: superpowers plugin could not be installed; see .claude/README.md for manual setup"
fi
