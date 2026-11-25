---
paths:
  - "src/*shader*"
  - "src/*light*"
  - "src/*material*"
  - "src/*environment*"
  - "src/*shadow*"
  - "src/*fog*"
  - "src/*sky*"
  - "src/*post*"
  - "src/*bloom*"
  - "src/*exposure*"
  - "src/*glsl*"
---

# Look rules

These load only when you touch a file that can change pixels. AGENTS.md still applies.

- A pixel change gets `hold:look-approval` from a bot. Never remove it and never merge it ([Look changes](../../CONTRIBUTING.md#look-changes)).
- Put a before and an after picture in the pull request, made with `node scripts/evidence.mjs`, and run each through `node scripts/check-preview.mjs <file>` first.
- Run the GPU and reference checks that apply ([Checks](../../CONTRIBUTING.md#checks)) and say which you ran. Unit tests do not prove a look.
- A change that touches a look file without changing a pixel says "The look is unchanged." in the description.
