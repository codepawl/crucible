# Idle sleep and pausing

When a 3D embed is still, off screen or in a background tab, drawing 60 frames a second wastes battery and GPU time. Crucible separates **sleeping when idle** (`isIdle` + `wake()`) from **pausing when hidden or off screen**.

## Sleep on idle in createRuntime

`createRuntime` in `crucible/addons/runtime` uses a frame governor that sleeps automatically whenever `isIdle(context)` returns `true` and `idleSleep` is enabled (the default). While sleeping (`runtime.sleeping === true`), it schedules zero `requestAnimationFrame` callbacks and makes zero WebGL draw calls.

```js
import { CrucibleRenderer, box } from 'crucible';
import { createRuntime } from 'crucible/addons/runtime';

const canvas = document.querySelector('#scene');
const cube = {
  name: 'Cube',
  geometry: box(),
  matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 1]),
  material: { color: [0.85, 0.45, 0.2], metallic: 0, roughness: 0.4 },
};
const renderer = new CrucibleRenderer(canvas, [cube]);

let dirty = true;
const runtime = createRuntime(renderer, {
  element: canvas,
  isIdle: () => !dirty,
  frame: () => {
    dirty = false;
    return { eye: [2.8, 2.2, 3.6], target: [0, 0.5, 0] };
  },
});

runtime.start();

// Call wake() after pointer input, resize or any state change:
canvas.addEventListener('pointermove', () => {
  dirty = true;
  runtime.wake();
});
```

Without `isIdle`, a runtime with systems never guesses whether something changed and stays active every frame. When `wake()` runs after sleep, the next frame starts with a zero time step so sleep duration is never simulated.

## Visibility and offscreen pausing

| Option | Default | Behaviour |
| --- | --- | --- |
| `idleSleep` | `true` | Stops scheduling frames when `isIdle(context)` returns `true` until `runtime.wake()` is called. Pass `false` to keep drawing every frame. |
| `pauseWhenHidden` | `true` | Pauses the loop when `document.hidden` is `true` and resumes when the tab becomes visible again. |
| `pauseWhenOffscreen` | `true` | With `element` passed, uses `IntersectionObserver` to pause while the canvas is scrolled outside the viewport. |

## Built-in sleep in <crucible-scene>

If you embed a packed scene with [the <crucible-scene> element](#crucible-scene-element), idle sleep is built in: the element renders one frame when loaded, attaches scroll listeners only while intersecting the viewport, and requests frames only on resize or while `scroll`, `hover-tilt` or `view` is moving the camera.

See the [Runtime contract](/runtime.md) for all loop modes, options and `stats`.
