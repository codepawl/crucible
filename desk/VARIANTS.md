# Desk setting for the asset viewer (issue 2822, PR 2825): stage 1 previews

Low quality previews (2 samples, 1440x900 and 390x844), rendered by Crucible's scene-file path (`scripts/render-media.mjs --scene file`) from a composed GLB. Camera_01 sits on a wooden table in front of a window; the sun comes through the window (cascaded shadows, `sunAngularRadius` for the soft edge, sun bounce on). The GLB is built in Blender 5.2 from CC0 Poly Haven models; props are scaled down and darker than the camera. No lens or SD card model exists on Poly Haven or ambientCG (searched), so a magnifying glass, spectacles, postcards, a notebook, a cup and saucer, a pencil cup with pens and a potted succulent stand in.

| variant | what changes | GLB bytes | textures | geometry | biggest files |
|---|---|---|---|---|---|
| A morning window | oak table, neutral sky, sun patch near the camera, warm bounce lamps | 4,033,096 | 2,145,724 | 1,845,770 | WoodenTable_01 ARM 198 KB, Camera_01 normal 189 KB, WoodenTable_01 diffuse 160 KB, Camera_01 metal/rough 158 KB |
| B golden hour | walnut table, low orange sun (belfast_sunset_puresky sky), rim light on the camera | 4,629,788 | 2,479,057 | 2,108,526 | round_spectacles diffuse 304 KB, Camera_01 normal 189 KB, wooden_table_02 diffuse 178 KB, wooden_table_02 ARM 175 KB |
| C flat lay | walnut table, high angle, soft overcast window light (kloofendal_28d_misty_puresky), larger sun radius | 4,862,168 | 2,526,439 | 2,290,558 | same as B |

Sky files (HDR, 1K) are extra: kloofendal 1,235,831 (shipped already), belfast_sunset_puresky 1,190,247, kloofendal_28d_misty_puresky 1,235,831. Textures: table and camera 1024 px, props 512 px, JPEG quality 72 (the Poly Haven camera was 2K and 4.7 MB in the earlier candidate; the desk's camera is 1K). Whole-scene GLB is about 4.0 to 4.9 MB, against 4.72 MB for the earlier camera alone, because everything else shares a smaller texture budget. KTX2 not tried.

Faults of the earlier full view, now: camera is about a fifth of the width at desktop and fills the phone frame in A and B (was small); it is lit by the window sun instead of sitting dark on a flat floor; centred or left of centre, not off right; the viewfinder windows read as dark glass with a glint, not white (the earlier blown white was sky reflection on a bare floor scene).

## Known problems (found, not hidden)
- Wood on the table smears at low angles: textures are sampled without anisotropic filtering (A and the table in the phone shot of C). Filed as an issue.
- Window frame faces that look away from the sun pick up a cold teal sky tint.
- The plaster walls get their warmth from two hand-placed warm point lights (the sky alone left the room grey and blue).
- The pot on the sill and the cup are lighter than the camera in A and B; darker props would lift the camera more.
- No dust in the air: the renderer has no particle or dust-mote feature (see issue).

## Credits (all CC0, Poly Haven, https://polyhaven.com/a/<id>)
Camera_01 (Rajil Jose Macatangay), WoodenTable_01, wooden_table_02, binder_notebook, postcard_set_01, tea_set_01, stationery_supplies, magnifying_glass_01, round_spectacles, potted_plant_04, and the skies kloofendal_48d_partly_cloudy_puresky, belfast_sunset_puresky, kloofendal_28d_misty_puresky. Room, window and lamps: built for this preview.
