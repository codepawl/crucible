# #3148 round 4 eye measurements (960 x 540, pupil diameter in px, edge at half between pupil core and brightest iris ring)

| view | before | r3 | r4 | tracer | r4 vs tracer |
|---|---|---|---|---|---|
| front pupil diameter | 66 | 82 | 84 | 88 | -4.5% |
| three-quarter pupil diameter | 50 | 106 | 106 | 110 | -3.6% |
| front iris outer diameter (equal-area) | 194.5 | 194.9 | 194.9 | 195.9 | -0.5% |
| three-quarter iris outer diameter (equal-area) | 197.0 | 216.4 | 216.6 | 197.0 | +10% |
| front pupil core luminance | 18.8 | 18.0 | 18.0 | 12.5 | +5.5 levels |
| three-quarter pupil core luminance | 15.6 | 16.1 | 14.4 | 9.6 | +4.8 levels |

Scripts: edge.py (pupil edge), measure.py (iris hull). GPU ms at 1920 x 1080, median of 120 frames: glass ball r3 0.787 -> r4 0.706, thin glass 0.698 -> 0.608, opaque 0.471 -> 0.468.
Default program hashes identical to r3 (hashes-r4.json); liquid fragment hash changed.
