# AGENTS.md

Shorts Block is a Manifest V3 Chrome extension (`manifest.json`, `content.js`, `block.css`, `managed_schema.json`). The shared rules in any parent `AGENTS.md` apply. Use Australian English in prose, and do not hard-wrap Markdown.

This file is the single set of agent instructions for the repository. `GEMINI.md` only imports it, for Gemini CLI, which reads `GEMINI.md` by default.

## Maintenance

When the user asks to maintain, update, fix, check, re-test or verify the extension, or says YouTube changed or Shorts are showing again, run:

```bash
node maintain/cli.mjs guide
```

It prints the full procedure (check, apply fixes, reason about the rest, re-check, commit), and the harness's own output says what to do next at each step. Needs Node 22 or later and network access; nothing else to install by hand.
