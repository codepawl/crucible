# The <crucible-scene> element

`<crucible-scene>` embeds a packed scene in any HTML page as a standard custom element. It displays a poster image first, loads the compiled `scene.pack` and renderer in the background, draws the scene and fades the poster out.

The element ships in `@codepawlhq/crucible/addons/crucible-scene` and is written alongside `scene.pack` and `index.html` when you run `crucible pack`.

```html
<script type="module" src="https://example.com/scene/crucible-scene.js"></script>
<crucible-scene
  src="https://example.com/scene/scene.pack"
  poster="https://example.com/scene/poster.webp"
  scroll="orbit 0 90, dolly 1 0.7"
  hover-tilt="6"
  view="wide"
  style="display: block; height: 480px"
>
  <script type="application/json">
    {
      "wide": {},
      "close": { "orbit": 40, "elevation": 10, "dolly": 0.5 }
    }
  </script>
</crucible-scene>
```

## Loading and state

The element exposes a `state` attribute and property (`"loading"`, `"live"`, or `"error"`) and fires two custom events:

- `crucible-scene-ready`: fired when the pack and renderer finish loading, with `event.detail.parts` set to the part count.
- `crucible-scene-error`: fired when loading fails or a trigger attribute is invalid, with `event.detail.message` explaining what to pass instead. If loading fails, the poster stays visible. If only a trigger attribute is invalid, the error is reported and ignored while `state` remains `"live"`.

Changing `src` or `poster` reloads the scene or swaps the poster. The canvas also resizes and redraws automatically via `ResizeObserver`.

## Declarative triggers

Three attributes move the camera around the scene target without writing JavaScript:

| Attribute | Meaning |
| --- | --- |
| `scroll` | Scrubs the camera as the element crosses the viewport (`orbit -360..360`, `elevation -85..85`, `dolly 0.1..10`), joined by commas. Attaches the scroll listener only while the element is visible. |
| `hover-tilt` | Tilts the camera toward the pointer up to the given degrees (`> 0` and at most `30`), easing back when the pointer leaves. Disabled when `prefers-reduced-motion: reduce` matches. |
| `view` | Eases to a named view declared in a child `<script type="application/json">` element (`orbit`, `elevation`, `dolly` offsets). Remove `view` to return to the base camera. Jumps without easing under reduced motion. |

A still packed scene draws once after loading and sleeps with zero `requestAnimationFrame` work until the element resizes or a trigger animates. See [Pack](/pack.md) and [Triggers](/pack.md#triggers) for packing budgets and limits.
