# Rain weather effect

Camera-local falling rain streaks, ground splash ripples and wet-surface pairing for scenes and render jobs.

`rain` ships as `@codepawlhq/crucible/addons/rain`, adding zero bytes to the core bundle and evaluating every drop and splash directly from the seed and frame time so seeks back in time always draw the same frame.

## Usage

```js
import { CrucibleRenderer } from '@codepawlhq/crucible';
import { installRain, resolveRain } from '@codepawlhq/crucible/addons/rain';

const renderer = installRain(new CrucibleRenderer(canvas, parts, { depth: true, hdr: true }));
renderer.render({
  ...camera,
  time: 1.5,
  rain: resolveRain({ intensity: 0.85, density: 2800, splashes: true, wetness: 0.75 }),
});
```

## Declarative scenes and MCP render jobs

Add `environment.rain` directly to a `crucible.scene` recipe or update it atomically with `set-environment`:

```json
{
  "type": "set-environment",
  "environment": {
    "rain": { "intensity": 0.85, "density": 2800, "splashes": true, "wetness": 0.75 },
    "puddles": { "coverage": 0.5 }
  }
}
```

- `await loadAgentSceneModules(recipe)` loads the rain module on demand when `environment.rain` is present; clearing it with `{ "rain": null }` turns rain off.
- When `rain.wetness` is set and `environment.wetness` is omitted, each frame pairs surface wetness (and `environment.puddles` mirrors) scaled by the evaluated rain intensity.
- `scene_review` (`shots[].rendererTime`) and `scene_render_submit` (`rendererTime`, or advancing `video` / `stills` frames) evaluate `intensityCurve` deterministically by time.
- Path tracers ignore `environment.rain` and report it in `ignored`.

## Options (`resolveRain`)

- `intensity` (`0..1`, default `0.6`): scales drawn streak and splash counts plus paired wetness.
- `intensityCurve`: optional array of `2..64` `{ time, value }` keyframes (`time >= 0`, `value` in `0..1`) for deterministic animation across shots.
- `density` (`100..6000`, default `2400`): camera-local streak instances inside the repeating volume.
- `volume` (`[width, height, depth]`, default `[24, 18, 28]`): camera-local wrapping box in metres.
- `speed` (`2..40`, default `16`), `streakLength` (`0.05..2.0`, default `0.45`), `streakWidth` (`0.002..0.06`, default `0.014`).
- `wind` (`[x, z]`, default `[1.2, 0.4]`): horizontal drift velocity tilting and moving drops.
- `color` (`[r, g, b]`, default `[0.78, 0.85, 0.94]`), `opacity` (`0..1`, default `0.42`).
- `splashes` (boolean, default `true`), `splashCount` (`0..1200`, default `400`), `groundHeight` (default `0`).
- `wetness` (`0..1` or `null`, default `null`): sets `environment.wetness` when not already specified on the frame.
- `seed` (integer, default `1`): deterministic drop and splash pattern seed.
