# Issue 2822 audit (origin/main 291f20c6, 1440x900, shots in audit/)

| Page | Verdict | Reason | Source |
|---|---|---|---|
| film.html (film-1440.png) | replace | the frame is mostly black; Newton's cradle is readable but dark and flat-lit | src/film.js, code-built parts |
| motion.html (motion-1440.png) | keep | clockwork orbit is lit, glossy, clear, and the subject moves | src/motion.js |
| modeling.html (modeling-1440.png) | replace (soft) | lantern is nice but sits on a near-black floor with a hard horizon band | src/modeling-scene.js |
| nature.html (nature-1440.png) | replace | stylised low-poly trees and rocks read dated next to the scanned look | src/nature.js |
| assets.html (assets-1440.png) | replace | shows the same clockwork as motion.html, tiny in a grey void; no imported-model feel | src/asset-viewer.js via createMotionScene |
| docs.html cards (docs-full-1440.png) | keep | airport and Cook monk cloister are strong | public/previews/showcase-airport.webp, cook-monk.webp (docs/learn/introduction.md); resources.md uses showcase-port.webp, cook-pabellon.webp (not shot) |

Candidate flaws, not hidden: nature ground is yellow-green and tiles at the horizon; film candidate is static (the page needs a camera move) and its ground is flat gravel; modeling has a dark HDRI panel behind the left and tea cups that sit close to the table edge; assets uses the viewer's default grey.
