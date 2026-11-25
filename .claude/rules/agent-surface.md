---
paths:
  - "src/agent-*"
  - "src/mcp*"
  - "scripts/mcp-server*"
  - "skills/**"
---

# Agent tool surface rules

These load only when you change the MCP tools, their schemas or the shipped skills. AGENTS.md still applies.

- Bench what changed with Haiku: `node bench/agent-modeling/bench.mjs --suggest origin/main` prints the command. Paste the comparison table in the pull request ([Tool schema and skill changes](../../CONTRIBUTING.md#tool-schema-and-skill-changes)).
- A skill change under `skills/build-crucible-scene/` runs with `--skill-mode references` and compares base against head.
- Tool cost has a budget. Growth needs a reason in `changes/<issue>.size.md`; never edit `bench/tool-cost-budgets.json`.
- Tools take no arbitrary code and no remote asset URLs, and every count and size is bounded ([SECURITY.md](../../.github/SECURITY.md)).
- Errors say what failed and what to pass instead: agents read them.
