# Interactive Product Showcase

Scaffold a full-screen 3D product showcase viewer in one command:

```sh
npx crucible init my-showcase
cd my-showcase
npm install
npm run dev
```

`crucible init` defaults to `--template showcase` and creates a ready Vite project backed by `@codepawlhq/crucible/addons/showcase`. Pass `--template addon` to scaffold the addon starter instead, `--name` to override the package name, and `--force` to overwrite an existing folder.

## Themes, Grid Floor, and Lighting

`createShowcaseViewer` switches live between two built-in themes:

- `prototype` (default): paper background (`#f8f7f1`), Molten accent (`#df5829`), and a crisp radial-fading CAD grid floor.
- `studio`: charcoal studio backdrop (`#17161a`), warm amber accent (`#fc9132`), and bright anodized metal highlights.

Both themes run with `viewTransform: 'agx'` and `fogDensity: 0`, so dark hardware stays high-contrast without atmospheric haze.

## Viewer API

Import helpers from `@codepawlhq/crucible/addons/showcase`:

- `createShowcaseViewer({ container, title, parts, modelUrl, recipe, initialView, views, theme, actions, onFrame, onThemeChange, showGrid, gridRadius, floorHeight })`
- `createCadGridFloor({ radius, height, theme, majorStep, subdivisions, textureSize })`
- `createShowcaseLighting({ theme, intensity, rotation, lightDirection, exposure })`
- `SHOWCASE_THEMES`

Pass `parts` directly for procedural assemblies, `modelUrl` to load a `.glb`/`.gltf` file, or `recipe` to render an agent scene. Each item in `actions` renders either a toggle pill (`type: 'toggle'`) or a range slider (`type: 'range'`) in the bottom action dock.

## Camera Controls

Every Crucible showcase viewer and site canvas shares the same orbit controller:

- Left-drag to orbit
- Right-drag, middle-drag, or Shift + drag to pan
- Wheel or two-finger pinch to zoom toward or away from the cursor target
- `W`, `A`, `S`, `D` or arrow keys to move on the floor plane, `Q` / `E` to move vertically
- `R` or double-click to smoothly reset back to the home view (instant when `prefers-reduced-motion: reduce` is set)
- Camera presets (`Hero`, `Front`, `Side`, `Top`, `Reset`) in the top-right bar
