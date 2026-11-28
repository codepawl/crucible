# Crucible Product Showcase

Interactive 3D product showcase starter powered by `@codepawlhq/crucible/addons/showcase`.

## Run locally

```sh
npm install
npm run dev
```

## Build for production

```sh
npm run build
```

## Controls

- Left-drag to orbit around the product
- Right-drag, middle-drag, or Shift + drag to pan
- Mouse wheel or pinch to zoom
- `W` `A` `S` `D` or arrow keys to move across the stage, `Q` / `E` to move vertically
- `R` or double-click to reset the camera
- Click `Hero`, `Front`, `Side`, `Top`, or `Reset`, or switch between `Prototype` paper and `Studio` dark themes

## Customize

Replace `parts: assembly.parts` in `src/main.js` with `modelUrl: '/your-model.glb'` or a Crucible `recipe` object.
