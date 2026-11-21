# Evidence for PR 2825, desk flat lay (issue 2822)

Stills of the real asset viewer page (`/assets.html`), headless Chrome on the GPU, 4 samples: `assets/deskC-desktop.png` (1440x900), `assets/deskC-phone.png` (390x844).

Bytes (old to new):
- demo model: `treasure-chest.glb` 972,316 -> `desk-flat-lay.glb` 3,834,312 (table and camera 1024 px, props 512 px, JPEG quality 72; the spectacles alpha texture stays PNG)
- sky: `kloofendal_48d_partly_cloudy_puresky_1k.hdr` (kept, used for files you open) plus new `kloofendal_28d_misty_puresky_1k.hdr` 1,235,831
- the first desk C candidate was 4,862,168 bytes with a room, window, plant and eight props; this one has no room and four props

What changed from the first desk C:
- no room, window, wall strip or plant; the table is scaled up so no table edge shows
- camera scaled 1.8x and centred; props cut to a dark notebook, spectacles and two pens, smaller than the camera, placed in a row around it; postcards, cup, magnifier and pencil cup removed
- the view fits a box around the desk; a tall canvas turns the desk a quarter turn so the row runs up the picture
- high angle (pitch 1.15 rad) to reduce the low-angle wood smear (anisotropic filtering is issue 2836)

Known faults: the wood still blurs along the grain (no anisotropic filtering); on the phone the pens touch the bottom edge; the phone page's canvas is nearly square, so the 390x844 still is not a tall frame.

## Round 2 (tabletop texture, contact shadows, phone framing)

- Smear cause, measured: the tabletop used a 600 by 360 px island of a shared 1k atlas for a 1.64 m by 1.02 m top (about 370 px per metre), while the desktop view shows about 1,340 px per metre, so the wood was magnified 3.6x. Anisotropic filtering is already on for mipmapped glTF textures, and the viewer has no depth of field, so neither was the cause (#2836 does not apply to this view).
- Fix: the top faces use their own material with a mirrored crop of that island (diffuse only; the atlas normal map has baked bolt pockets), mapped from above at about 1 px per screen pixel. Crops: `assets/wood-before.png`, `assets/wood-after.png` (same screen region, 2x nearest-neighbour).
- Props sit on soft contact-shadow quads; notebook and spectacles moved clear of the camera; postcards lighter and spread apart; pens and postcards moved to the sides (outside the phone frame).
- Phone: a portrait focus box puts the camera at about 58 percent of the canvas width.
- GLB: 3,929,324 bytes.

## Round 3 (seamless tabletop)

- The mirrored atlas crop showed a mirror axis and a dark blob, so the tabletop now uses the CC0 Poly Haven `black_walnut_veneer_02` diffuse (2K reduced to 1536 px, mapped at 1 m per tile, about 1,536 px per metre, no mirroring), darkened, with a faint low-frequency brightness drift; constant roughness.
- Phone: the notebook corner and the pens reach into the frame; the camera stays at about 58 percent of the width. Desktop: postcards moved nearer the camera, tighter glasses shadow.
- GLB: 4,033,412 bytes. `assets/wood-after.png` is the new wood crop (`wood-before.png` is unchanged).

## Round 4

- Postcard lies flat, picture up (it stood on its edge in the source); phone focus box centred on the camera with more of the notebook; spectacles larger with darker frames. GLB: 3,941,056 bytes.
