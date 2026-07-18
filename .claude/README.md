# Claude Code configuration

`settings.json` is shared, checked-in configuration for Claude Code sessions
on this repo. It registers the official plugin marketplace, enables the
`superpowers` skill bundle (TDD, systematic debugging, planning, and
verification workflows), and runs `hooks/session-start.sh` at session start.

Enabling alone does not INSTALL the plugin in a fresh environment — web
sessions run in ephemeral containers that start without it — so the
SessionStart hook performs an idempotent install on the web
(`$CLAUDE_CODE_REMOTE` only). If a session ever reports the plugin missing,
install it manually:

```bash
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install superpowers@claude-plugins-official
```

On a local machine that one-time manual install persists in `~/.claude`, so
the hook deliberately does nothing there.

`settings.local.json` is machine-local state (tool permissions) and stays
git-ignored.
