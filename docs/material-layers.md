# Material layer stack

Real surfaces layer full materials over each other: rock under soil under moss, or bare steel under chipping paint. `layers` on a surface material (or `pattern: { "type": "layers", "layers": [...] }`) stacks up to four full PBR materials and sharpens transitions by each layer's height with `heightBlend`, so high ridges poke through cover instead of blurring into a soft fade.

The stack bakes once per texel into standard colour, normal, and metallic-roughness maps, so the rasterizer, WebGPU path tracer, CPU path tracer, and native path tracer all render the same surface.

## Quick example

Two-layer rock with height-blended soil filling lower crevices:

```json
{
  "id": "rock-and-soil",
  "layers": [
    { "pattern": { "type": "stone", "count": 4, "seed": 2 }, "roughness": 0.85 },
    {
      "color": [0.28, 0.16, 0.08],
      "roughness": 0.96,
      "metallic": 0,
      "height": 0.36,
      "mask": { "noise": { "scale": 3, "octaves": 4, "seed": 9 } },
      "heightBlend": 0.92
    }
  ]
}
```

Use `pattern: { "type": "layers", "resolution": 1024, "bump": 1.2, "size": 1.5, "mapping": "uv", "layers": [...] }` when you also need stack-level placement or UV-space `surface` / `vertexGroup` / `meshMap` masks.

## Layer fields

| Field | Layer | Meaning |
| --- | --- | --- |
| `pattern` | any | Preset pattern object (such as `stone`, `wood`, `metal`, or `rust`). Cannot combine with `graph` on the same layer. |
| `graph` | any | Material graph object with `color`, `roughness`, `metallic`, or `height` outputs. |
| `color` | any | Linear RGB `[r, g, b]` literal or graph node (defaults to `[0.5, 0.5, 0.5]` when standalone, or overrides `pattern`). |
| `roughness` | any | Scalar 0 to 1 or graph node (defaults to `0.5` when standalone, or overrides `pattern`). |
| `metallic` | any | Scalar 0 to 1 or graph node (defaults to `0` for dielectric presets, `metal` curve for `metal`/`rust`). |
| `height` | any | Scalar 0 to 1 height or graph node used both for `heightBlend` and the baked normal map. |
| `mask` | 1 to 3 | Scalar 0 to 1 or scalar graph node controlling cover over the layers below. Not allowed on base layer `0`. |
| `heightBlend` | 1 to 3 | `0` to `1` (default `0`). `0` is a linear cross-fade; values near `1` snap transitions around height differences. |

## Limits

- 1 to 4 layers per material (`layer 0` is the base and cannot set `mask` or `heightBlend`).
- All graphs, plain expressions, and masks across the stack share the material graph node cap (`maxNodes = 64`) and bake work cap (`60,000,000` work units).
- Surface, mesh map, and vertex group mask nodes require `"mapping": "uv"` inside `pattern: { "type": "layers", "mapping": "uv", ... }` and UVs on the mesh.
- `layers` and top-level `pattern` cannot both be set on the same material (`"layers"` expands internally to a stacked pattern).

## Before and after

One layer (`stone` alone) versus two height-blended layers (rock base + soil with `heightBlend: 0` soft fade and `heightBlend: 0.9` crisp crevice fill). See the pull request evidence comparison and [material maps](material-maps.md).
