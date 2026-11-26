# Explosions and volumes

![An explosion fireball, rising smoke plume and flying sparks between concrete pillars, rendered in Crucible](/previews/explosion-volumes.webp)

An explosion, fire or smoke plume is a grid of numbers: `shape: "grid"` fills a box with a 3D texture of `density` and, optionally, `temperature` and `flame`.

- Draw a grid or noise volume inside a scene: [Depth-clipped volume fog](/volumetric.md).
- Bake the grid yourself with the gas solver in `src/gas-sim.js`, described in the same guide.
- Fog and point lights that go with a volume: [Local lights and volume fog](#local-lights-and-volume-fog).
