# Evidence for PR 2825, desk flat lay (issue 2822)

Stills of the real asset viewer page (`/assets.html`), headless Chrome on the GPU, 4 samples: `assets/deskC-desktop.png` (1440x900), `assets/deskC-phone.png` (390x844).

Bytes (old to new):
- demo model: `treasure-chest.glb` 972,316 -> `desk-flat-lay.glb` 3,849,660 (textures about 2.2 MB, geometry about 1.6 MB; table and camera 1024 px, props 512 px, JPEG quality 72; the spectacles' alpha texture stays PNG)
- sky: `kloofendal_48d_partly_cloudy_puresky_1k.hdr` (kept, used for files you open) plus new `kloofendal_28d_misty_puresky_1k.hdr` 1,235,831
- the first desk C candidate was 4,862,168 bytes with a room, window, plant and eight props; this one has no room and four props

What changed from the first desk C:
- no room, window, wall strip or plant; the table is scaled up so no table edge shows
- camera scaled 1.8x and centred; props cut to a dark notebook, spectacles and two pens, smaller than the camera, placed in a row around it; postcards, cup, magnifier and pencil cup removed
- the view fits a box around the desk; a tall canvas turns the desk a quarter turn so the row runs up the picture
- high angle (pitch 1.15 rad) to reduce the low-angle wood smear (anisotropic filtering is issue 2836)

Known faults: the wood still blurs along the grain (no anisotropic filtering); on the phone the pens touch the bottom edge; the phone page's canvas is nearly square, so the 390x844 still is not a tall frame.
