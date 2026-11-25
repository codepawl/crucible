---
paths:
  - "src/studio*"
  - "tests/studio*"
  - "docs/studio*"
---

# Studio rules

These load only when you work on the Studio. AGENTS.md still applies.

- Name the interaction form of a Studio feature (tool, toggle, mode, operator, modifier, setting or panel) in the pull request and add its row to [docs/studio-interaction-forms.md](../../docs/studio-interaction-forms.md).
- Spacing comes from one scale: even padding on every side, and a gap between groups larger than the gap inside one. `node scripts/studio-layout-audit.mjs` measures the rendered screens and names the selector and the fix.
- Colours come from the tokens in `src/site-tokens.css` and the `--studio-*` variables, never a literal value.
- Check every change on the rendered screen at real size in dark and light (`node scripts/drive.mjs shot <id>`), and put a before and an after still in the pull request ([evidence](../../CONTRIBUTING.md#show-the-evidence)).
- A still from the author is checked against the scene by someone else before merge: the author does not review their own pictures.
- Public text names what Studio does, never another program it resembles.
