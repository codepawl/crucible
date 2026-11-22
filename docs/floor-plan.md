# Walls, doors and windows from a floor plan

A `floorPlan` geometry turns a flat plan into walls with cut openings, a floor and a ceiling over every closed room, and door and window presets. Points are `[x, z]` in metres and the floor is `y = 0`.

```json
{
  "id": "house", "type": "floorPlan", "height": 2.7,
  "walls": [
    { "from": [0, 0], "to": [8, 0] }, { "from": [8, 0], "to": [8, 5] },
    { "from": [8, 5], "to": [0, 5] }, { "from": [0, 5], "to": [0, 0] },
    { "from": [4, 0], "to": [4, 5], "thickness": 0.12 }
  ],
  "openings": [
    { "wall": 0, "offset": 1, "kind": "door" },
    { "wall": 0, "offset": 5, "kind": "window" },
    { "wall": 4, "offset": 2, "kind": "door" }
  ]
}
```

| Field | Meaning | Default |
| --- | --- | --- |
| `walls` | 1 to 256 of `{ from, to, thickness? }`, each at least 0.1 m long | required |
| `thickness` | wall thickness for walls that give none, 0.02 to 2 m | `0.2` |
| `height` | wall height, 0.5 to 20 m | `2.7` |
| `openings` | up to 256 of `{ wall, offset, width?, height?, sill?, kind? }` | none |
| `part` | `all`, `walls`, `floor`, `ceiling`, `doors`, `windows` or `glass` | `all` |

A wall is drawn on its centre line from `from` to `to`, and `thickness` is split to both sides.

## Joins

- Walls that share an end point are mitred, so an L corner has one outer and one inner corner point, and three or more walls meeting at a point get a cap over the middle. Wall tops tile with no gap and no overlap.
- A wall that ends on the side of another wall, or crosses it, is split there, so a T or an X needs no extra walls. A wall that runs on top of another is refused.
- Walls at a joint must be at least 15 degrees apart, and a wall must stay at least 0.01 m long between its two mitred ends.
- Walls of different thickness meet with a vertical step, not a gap.

## Openings

`wall` is the index in `walls`, and `offset` is the distance in metres along that wall from `from` to the start of the opening. `kind: "door"` defaults to 0.9 m wide, 2.1 m tall with `sill: 0`; `kind: "window"` to 1.2 m by 1.2 m with `sill: 0.9`. Without a `kind`, a `sill` of 0 or none means a door.

An opening is cut through both faces with a jamb on each side, a lintel, and a sill when `sill` is above 0. It is refused with the number to use instead when it:

- passes the end of its wall (`offset + width` over the wall length),
- reaches into a mitred corner or across a joint where another wall meets this wall,
- comes within 0.01 m of another opening on the same wall,
- has `sill + height` within 0.01 m of the wall height.

## Floor, ceiling and presets

The floor and ceiling cover the inside of every closed loop of walls: each room is one polygon from the inner corner points. A doorway (`sill: 0`) gets a floor strip across the wall thickness. Walls that do not close into a room have no floor or ceiling, and a loop that sits inside another loop with no wall joining them is not separated from it, so join them. The floor is up facing at `y = 0`, and the ceiling is down facing at the wall height.

A door is a frame (two posts and a head) and a closed leaf. A window is a frame and a thin glass pane. Both are inside the opening, recessed 0.02 m from each wall face.

`part` builds one piece, so several geometries with the same plan can each take a material: `walls`, `floor`, `ceiling`, `doors`, `windows` (frames) and `glass`. `all` builds them in one mesh. A part the plan does not have (a floor without a closed room, `doors` without a door opening) is an error.

The output is deterministic and flat shaded, with one metre of wall per texture unit. The vertex count is bounded by the scene `maxVertices`. `scene_capabilities` with topic `floorPlan` lists the same limits.
