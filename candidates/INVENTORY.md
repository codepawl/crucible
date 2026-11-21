# Aster lantern inventory (origin/main af0fd962)

Method: `git grep -nIi lantern`, plus `-a` for binaries, plus a name search of tracked files. "aster" alone is not a key (raster, faster, master, plaster).

Carries the lantern: 7 files, 17 matching lines.

| File | Lines | Carries | Becomes |
| --- | --- | --- | --- |
| `src/modeling-scene.js` | 6, 7, 67, 68, 72 (whole file, 87 lines) | `createLanternScene`, the lathe, tube and gear parts, the `Lantern assembly` root, `name: 'Aster lantern'` | Replaced by the picked scene (same shape: `name`, `parts`, `graph`, `sample(time, aspect)`); function renamed `createScene` |
| `src/modeling-player.js` | 4, 32, 95 | import of `createLanternScene`, its call (with the brushed brass textures), download name `crucible-aster-lantern.png` | import and call of the new scene; download name from the scene name (for example `crucible-chess-set.png`). The brass texture helper stays if the pick uses brass |
| `site/modeling.html` | 6, 7, 28, 29, 30 | meta description, `<title>`, `<h1>` and subtitle, section aria-label, canvas aria-label | the new scene's title and one subtitle, aria-labels naming the new subject. Text only: no chrome, CSS or layout change |
| `scripts/smoke-modeling.mjs` | 36 | `scene.graph.getNode('Lantern assembly')` | the new root node name. The rest of the smoke (moved-root checksum, animated checksum) holds if the new scene animates its parts or its root |
| `FEATURES.md` | 127 | `Name: Aster lantern (modeling player)` | `Name:` the new scene (modeling player) |
| `docs/modeling.md` | 181 | "The Aster lantern at `/modeling.html` combines these tools ..." | same sentence about the new scene, naming only the tools it really uses |
| `docs/learn/procedural-modeling.md` | 182 | "... modeling demo ... combines these tools in a lantern scene." | "... in a <new subject> scene." |

Unchanged on purpose:

- `CHANGELOG.md:1069` ("Add a lantern modeling study ..."): release history. `AGENTS.md` forbids editing it, and it stays true for that release.
- `docs/community-showcase.md:34` and `tests/community-showcase.test.js:21`: "A night market street with lanterns" is another scene's alt text.
- `public/showcase/port/scene.first.glb` and `scene.rest.glb`: the word is a node name inside the port showcase, not this scene. Not touched.
- `tests/site-chrome.test.js:46` and `vite.config.js:54`: they name `modeling-player` and `site/modeling.html`, which stay.

Checked, nothing to change: `README.md`, `public/previews/*` (no modeling or lantern image), `public/*` model files (no file named lantern), `tests/` (no test pins the lantern; the only coverage is the Playwright smoke above), `changes/` (no note names it). The Aster lantern has no committed preview image or model file: it is built from code on page load.

A new `changes/2822.md` bullet is needed in the removal PR (it touches `src/`).
