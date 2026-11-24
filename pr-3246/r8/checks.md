| # | Check | Measured | Result |
|---|---|---|---|
| 1 | Front-face mean vs path-traced reference, CIEDE2000, limit 12 (worst of red, blue, default sets) | plastic 2.8, wood 0.4, grass 1.2, neon 9.4, glass 5.2, brick 0.8 | pass |
| 2 | Reads as its material without labels | sheet-rows-glass.png: plastic, wood, grass, neon, glass, brick | for the reader |
| 3 | Clear glass rim luma contrast against the grey backdrop, limit 25 (left, right, top, bottom) | 61.7, 49.7, 60.5, 54.0 | pass |
| 4 | Coloured glass hue and saturation, limit 0.30 | red hue 357 sat 0.33, blue hue 212 sat 0.38 | pass |
| 5 | Grass repeat inside one face (autocorrelation, repeat above 0.5) | 0.22 in the rows, 0.20 on a close face | pass |
| 6 | Neon ring 8 px outside the cube, bloom on minus off, limit 30 (top, bottom, left, right) | red 5.2, 4.9, 8.4, 41.8; blue 6.8, 6.1, 10.2, 52.3; default 5.8, 5.6, 7.1, 37.3 | fail, see Known limits |
| 7 | Largest luma step across a face, limit 20 | max 19.8 (blue brick); neon 4.8, wood 8.0, grass 6.7 | pass |
| 8 | Preset tests pass, two renders identical bytes | 13 of 13 pass; glass-grey.png and row-blue.png md5 equal across two renders | pass |
