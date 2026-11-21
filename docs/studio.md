# Studio

Crucible Studio lets designers and AI agents work on the same `crucible.scene` recipe. It is an addon (`crucible/addons/studio`) that an app embeds; it is not a page of the public site. It adds zero bytes to the core library entry (`crucible`).

## Open Studio

An app mounts it with `createStudio(container, options)` (see below). To try it from a checkout, run `npm run dev` and open `/bench/studio/index.html`. Drop a `scene.json` on the window, or click the file name at the top left and choose **Open**.

## The screen

The scene fills the window and the controls float on top of it.

| Where | What it does |
| --- | --- |
| Top left | The menus. **File**: open, save, the recipe JSON, the three exports and the starting scenes. **Edit**: undo, redo, copy, paste, duplicate, delete, deselect and Settings. **View**: front, right and top view, perspective or orthographic, frame the selection, the grid and the panels. **Agent**: copy a prompt for an AI agent and reload when it edits the file. **Help**: the keyboard shortcuts. Each row shows its key. |
| Top centre | The workspaces, in the order the work runs: **Build** (objects and their place), **Look** (materials, lighting, sun, exposure, fog) and **Animate** (camera, lens, shots and the timeline). Each one shows only the panels its step needs. Opening a panel from anywhere, or adding a keyframe, brings its workspace forward. A workspace is a way of looking at the scene: it is not saved in the recipe and undo does not touch it. |
| Top right | The file name, which opens the File menu, and **Export** (PNG image, GLB model, web pack). A green dot beside the name means Studio reloads the file when an agent edits it. |
| Left rail | The tools that change the scene come first: select, move, rotate, scale, snap to a surface, then add an object or a light, undo and redo. Under one line sit the switches that only change what you see: show or hide the grid, show or hide the panels. |
| Scene card | At the top of the right column, across from the rail. The list shows whole rows only: it scrolls a row at a time and the rows stretch by a pixel or two so a whole number of them fills it. The materials are one row of swatches that scrolls sideways, with the add button fixed beside it. Its head has a search button, which opens a box that filters the list as you type (Esc closes it and clears the filter), and an add button with the same menu as the rail. Every object in the scene, drawn as the shape of its geometry (cube, sphere, cylinder, cone, torus, plane, or a stack for a group) in the colour of its material, an eye to hide each one, and the scene materials as swatches. |
| Properties | Under the Scene card, in the same column. The panels of the open workspace: the object in Build, material and look in Look, the camera (views, lens, shots) in Animate, with the object one tab away: picking an object there opens its panel and stays in Animate. |
| Bottom, in Animate | Play, add a keyframe, scrub the time, jump to a saved shot. The readout moves up to make room for it, and floating panels stop above it. |
| Bottom left | The camera (perspective and lens, or orthographic), the grid step, and the size of the selected object in metres. |
| Top right, beside the right column | The view widget: the X, Y and Z axes as the camera sees them. Click an end to look from the right, left, top, front or back. |

The ground carries a grid that covers the floor far out, with the X axis in red and the Z axis in blue. Up close it has one line per metre; as you zoom out the step grows tenfold (10 m, 100 m) and as you zoom in it shrinks (10 cm), and the readout at the bottom left names the step. Every tenth line is stronger, and the lines thin and fade with distance instead of crowding the far floor. The grid is a working aid: it is not part of the recipe and stays out of PNG, GLB and pack exports. `studio.setGridVisible(false)` hides it from code.

The floor of the viewport reaches the horizon however far you zoom out (up to 400 m from the target), and the viewport keeps drawing the scene beyond the `far` of the scene camera. A PNG export still uses the scene camera as it is saved.

The selected object gets an outline that follows its shape: it goes in between the points of a star and around each letter of a text. An object with more than 8,000 triangles gets a simpler outline around its hull. Docked, drag the inner edge of the right column to make it wider or narrower (240 to 520 px), and drag the gap between the two cards to give the Scene card more or less of the column. Floating, each card is its own window: drag its left edge to change only its width, and its bottom edge to change only its height, and the other card keeps its size (the Properties card just moves when the Scene card above it grows). Hold Ctrl (Meta on a Mac) while dragging a width edge to resize both cards together, or while dragging the Scene card's bottom edge to take height from the Properties card as the docked split does; docking the panels again also gives one shared column. The grips show only under the pointer or the keyboard, take the arrow keys (Ctrl for both cards), and a double click puts that card back to its automatic size (with Ctrl, both cards in that direction). The view widget stands at the top right of the viewport, left of the column and level with the Scene card, so it moves with the card as it is resized. The arrow in the head of each card folds that card down to its head. Studio keeps these sizes and folded cards in the browser (`sceneWidth`, `propertiesWidth`, `sceneHeight` and `propertiesHeight` for floating cards, `panelWidth` and `sceneShare` for the docked column; a size of 0 means automatic). The bar, the rail and the column sit on the edges of the window by default, so nothing covers the scene: the viewport is the room they leave and the scene is drawn at that size, with its proportions true. Turn on **Floating panels** in Settings to let the scene fill the window with the panels over it. Below 820 px wide the two cards start closed so the scene keeps the screen; the panels button on the rail opens them.

When the browser drops the WebGL context, Studio pauses the picture, shows a notice over the viewport and draws again by itself when the context returns, with the scene, selection and camera untouched; the notice offers **Reload** if the context has not returned after a few seconds. A frame that throws is handled the same way: the notice names the error and the next change to the view tries again.

## Move, rotate and scale

Each tool has its own handle shape, so the shape says what a drag will do: arrows move, rings turn, squares scale. A handle does not have to be hit exactly: a press within about 11 pixels of an axis or ring, or 16 pixels of its tip, takes it. The handles follow the object, not the camera: the three axes are the object's own X, Y and Z, so a turned object moves along the way it faces. The handles have no border at rest; the one under the pointer grows thicker and brighter and gets a pale border, so you see what a press will grab. An axis that points almost at the camera is drawn longer, so it never shrinks to a stub you cannot catch.

- **Move** drags the object exactly as far as the pointer travels along the axis. Hold Shift to move in steps (0.25 m unless you change it in Settings). While you drag, a dashed outline stays where the object was and a dashed line runs from there to where it is now; scale and rotate drags keep the outline too. The dashed lines are pale with a dark border, so they show over a pale object and over the dark ground. A new object lands on the ground beside the ones already there, not inside them.
- **Rotate** turns the object by the angle the pointer sweeps on the ring. Hold Shift to turn in steps (15 degrees unless you change it in Settings). While you drag, the other two rings leave, a dashed spoke stays where the drag began, a solid spoke follows the object, and a faint wedge between them fills the angle turned so far. A turn can go past half a circle and keeps counting.
- **Scale** on an axis handle scales by how far you pull it: twice the distance doubles that axis. The centre handle scales all three.

One drag is one undo step, and undo leaves the viewport camera where you put it.

## Add an object or a light

The add button on the rail and the one in the Scene head (or Shift+A) open the same menu. The shapes come in three groups, then the lights (point, spot and area):

| Group | Shapes |
| --- | --- |
| Solids | box, sphere, icosphere, cylinder, cone, torus, capsule, dome, pyramid, prism, hexagon, wedge, pipe, arch, gem |
| Flat shapes | plane, disc, ring, star, heart, 3D text |
| Swept and grown shapes | vase, bowl, spring, knot, stairs, terrain |

Each shape is an ordinary recipe geometry, so an agent can keep editing it: a ring is a `circle` with `innerRadius`, a vase and a capsule are a `lathe`, a star, a heart, a prism, a wedge and stairs are an `extrude`, a spring and a knot are a `tube` along a path, and a pyramid, a dome, a pipe, a bowl and a gem are a `mesh` around a `lathe` with a `smoothAngle` that keeps their edges hard. A new shape is about a metre wide and rests on the ground. A menu that opens low on the screen grows upward, so it stays inside the window.

## Camera and lights in the Scene list

The scene camera, the sun and every point, spot and area light are listed above the nodes in the Scene list, each with its own icon, and a mark for each light and the sun is drawn in the viewport. Click a row or a mark to select it: the camera opens the Camera tab, the sun and the lights open the Look tab. With the Move tool a light drags in the plane through it that faces the view, as one undo step. Delete removes a selected light. A light added from the Add menu is selected and its panel opens. After an object is deleted nothing is selected, so a second Delete removes nothing; undo and redo bring back the selection of the step they restore. The camera is drawn only while the viewport looks away from it, after you orbit a scene whose camera a track moves. These are not recipe nodes: they edit `camera` and `environment`, so a light a motion track moves cannot be dragged, and the camera and the sun cannot be deleted. In code, `listSceneObjects()`, `selectSceneObject(key)`, `moveSceneObject(key, position)` and `deleteSceneObject(key)` on the controller do the same, with keys `camera`, `sun`, `point:0`, `spot:0` and `area:0`.

## World, fog, film, effects and shadow properties

The Look tab lists every scene-level look setting an agent can write, in groups with a title row you click to fold. **World** holds the HDRI choice (None, `sky-clouds`, `studio-softbox`; a catalog file the scene names shows as the current value), Show sky, Ground, HDRI strength and rotation, the sky top and bottom colors, Daylight, Fill and Ambient strength. **Fog** holds the fog density and color and the main volume fog fields: density (0 is off), color, anisotropy, steps, noise amount and scale, and distance. **Film** has Exposure, Contrast, Saturation, Temperature, Vignette and Grain, and the **Color look** select as its first row. **Effects** has ambient occlusion and its radius, bloom strength, threshold and radius, depth of field blur and focus, and motion blur shutter and object blur. **Shadows** edits the shadow box (target, extent, distance, clip start and end) and **Quality** the render switches (object reflections, floor sky trace, resolve coplanar, shadow cascades, sun bounce, specular AA). Only the first group of a tab starts open; which groups you open or fold is kept in the browser with the other Settings, not in the recipe. A group's title row stays at the very top of the panel, on the panel color, while its rows scroll under it and dissolve over a short fade below the title; the same fade closes the bottom edge while more of the panel lies below. Numbers end at one edge with or without a unit, and the unit sits in a slot after them. The slider readout, a choice's text and a color swatch end at that same edge, and a label always gets its full name with a gap before its control. Choices read as names (ACES, AgX, Neutral, Standard) while the recipe keeps its own values, and a color is a field like the number fields.

Every property is one line, as in Blender's Properties editor: the label on the left, the control in a value column on the right. A bounded number is a slim slider with its value beside it, an unbounded one a number field you can type in or scrub with the arrow keys, a switch is a track that is filled with the knob at the right when on, and a vector keeps its X, Y and Z fields under the label. Units sit quietly beside the number, not in the label: millimetres for focal length and sensor width, metres for lengths, and degrees for every angle, including the HDRI rotation and the sun size, which the recipe keeps in radians. Typing a value in degrees writes the recipe in radians. A number shows three decimals at most with trailing zeros trimmed; the stored value changes only when you edit it. A catalog HDRI shows its name, or Custom and the first eight characters of its ID.

World, Fog, Quality and Shadows describe the whole scene, so they leave the tab while a light is selected and return with the sun. Each edit is one undo step, a field a motion track animates (sky, fog, volume density, exposure, focus distance) is dimmed, locked and marked, and a change an agent makes shows in the controls. A shadow box the renderer cannot use (near past far) is refused and the controls return to the recipe. In code, `controller.updateSceneShadow(patch)` joins `updateLook`, and `describeSceneObject('world' | 'quality' | 'effects' | 'shadow')` gives the record a panel reads.

Not shown yet: `volumeFog` bounds, ambient, drift, height falloff, shadow ambient, profile, detail and flow fields, `localVolumes`, `liquid`, `wind`, `sky` (the physical sky), `lines`, `keyAffects` and the `look` cube file.

## Light, sun and camera properties

Select a light in the Scene list and the Look tab lists what the agent can set on it, grouped as Blender's Object Data tab groups it: **Light** (color, intensity, and for point and spot lights radius and range), **Shape** (width and height of an area light, angle and penumbra of a spot light), **Shadows** (shadow, soft falloff, portal) and **Transform** (position, and direction for spot and area lights). With no light selected the tab shows the sun: its direction pad with the azimuth and elevation in degrees beside it, strength, color and size. The Camera tab adds, under the view buttons (Front, Right, Top, Iso and the projection switch on one row), a **Lens** group that opens with the lens chips (24, 35, 50 and 85 mm) and holds focal length in millimetres, sensor width, field of view, orthographic size, an Ortho switch, clip start and end, shift, depth of field (f-stop and focus distance) and the eye and target as numbers. Each edit is one undo step, a slider, colour or scrub drag included. An empty f-stop (the field shows "Off") turns depth of field off. A lens chip lights when the focal length is within half a millimetre of it.

A field that a motion track or driver animates is locked, shown in the muted color and marked with a keyframe diamond named "Animated by a track": edit its keyframes instead. When an agent changes the scene file, Studio reloads it and the controls show the new values. Not shown yet: a light's `ies` profile, `affects` links and `lines`. In code, `controller.updateSceneLight(key, patch, { recordUndo })`, `controller.updateSceneCamera(patch)` and `controller.describeSceneObject(key)` do the same, and the rows come from the table in `src/studio-properties.js`, so a later area adds rows and no panel code.

## Keys

The keys follow Blender where Studio has the same action. **Help ▸ Keyboard shortcuts** (or **?**) lists them all.

| Key | Action |
| --- | --- |
| Q, T | Select, snap to a surface |
| G, R, S | Pick the selected object up to move, rotate or scale it |
| X, Y, Z | While holding an object: keep it to that axis; the same key again frees it |
| Click or Enter, Esc or right click | While holding an object: place it, put it back |
| Shift+A | Add an object or a light |
| Ctrl+C, Ctrl+V | Copy the selected object, paste a copy of it (one undo step, still works after the original is deleted) |
| Shift+D or Ctrl+D | Duplicate |
| X, Delete or Backspace | Delete |
| Esc | Deselect |
| H, Alt+H | Hide the selection, show everything that is hidden |
| Alt+G, Alt+R, Alt+S | Reset the position, rotation or scale of the selection |
| Right click | Menu of the object under the pointer |
| F or . | Fly to the selection, or to the whole scene when nothing is selected |
| 1, 3, 7 | Front, right and top view |
| 5 | Perspective or orthographic |
| N | Show or hide Properties |
| I or K | Insert a keyframe |
| Space | Play |
| Ctrl+Z, Ctrl+Shift+Z | Undo, redo |
| Ctrl+O, Ctrl+S, Ctrl+Shift+S | Open, save, save as |
| Ctrl+, | Settings |
| ? | List the keys |

F keeps the direction you look from and stands back just far enough for the object to fill the view. The camera flies there in a third of a second, so you can follow where the view went; any other camera input takes over at once, and with reduced motion the view jumps. Like an orbit, it is not an undo step.

When a motion track moves the camera, the track decides what the scene camera sees. So the first orbit, zoom, pan, F or view preset there starts a free view: the viewport looks around on its own, and the recipe, the animated camera and a still stay as they were. **View → Animated camera** takes you back to the animated camera, and a saved view keeps what the viewport shows.

Keys do nothing while you type in a field or while a dialog is open.

G, R and S work as in Blender. With an object selected and the pointer over the viewport, the key picks the object up: it follows the pointer with no handle to aim at, and a pill at the bottom of the viewport shows how far it has gone and the keys that act on it. X, Y or Z keeps the move to that axis of the object, a click or Enter places it, and Esc or a right click puts it back as if nothing happened. A placed move is one undo step. With nothing selected, or the pointer over a panel, the key only switches the tool, and the handles work as before. Typing a number while holding an object is not supported: type it in Properties instead.

A right click on an object, in the viewport or in the Scene list, selects it and opens its menu at the pointer: Frame, Duplicate, Hide, the three resets and Delete. They are the same rows as in **Edit**, with the same keys. A menu row starts with its icon when one fits and with an empty square when none does, so the labels line up. Dragging with the right button still pans. Alt takes back what the plain key does: G, R and S change a transform and Alt+G, Alt+R and Alt+S reset it, H hides the selection and Alt+H shows everything again, as one undo step.

## Settings

**Edit ▸ Settings** (Ctrl+,) opens Settings: the step and the angle a Shift drag snaps to, the size of the handles, the workspace Studio opens in, the theme (System, Light or Dark), the performance tier, and whether the grid, the readout, the axis widget and the agent cursor show. They are kept in the browser (`localStorage`, key `crucible-studio-preferences`), not in the scene recipe, so a scene looks the same for everyone and each person keeps their own setup. **Reset** brings back the defaults. An app can pass `preferences` to `createStudio` to start from other values, `preferenceStorage: null` to keep nothing, and call `studio.setPreference(name, value)`.

**Theme** forces the Studio light or dark whatever the system says; System follows the system. The dialogs and menus follow it too. An app that wants to theme its own frame passes `onThemeChange(theme)` to `createStudio`; it is called with `'light'` or `'dark'` at the start and on each change.

**Performance** sets what the viewport draws with, by the tier. Light draws at 0.75 of the screen's pixel ratio (never above 1) with 2x anti-aliasing, Balanced at the screen's ratio up to 1.5 with 2x, and Sharp at the screen's ratio up to 2 with 4x, which is what Studio always drew. Automatic picks a tier from the graphics card the browser reports and the cores: software renderers and small integrated chips go Light, other integrated chips Balanced, dedicated cards and Apple M-series Sharp, and a card the browser hides Balanced. A new pixel ratio is set on the live renderer; a new anti-aliasing count makes Studio build a new renderer. The tier changes only the viewport; it is never written into the scene recipe, so renders and exports look the same on every machine. A `pixelRatio` or `samples` passed in `rendererOptions` stays as given.

## Set up Studio

The setup is four steps, one page each, named in a row at the top with an icon apiece (each is a button that jumps to it; the step you are on shows its text and icon at full strength, the others muted): **Theme**, **Performance**, **Modelling** and **AI agent**. Every choice carries an icon that shows what it does.

- **Theme.** Each card is a miniature of the real Studio in that theme, and a choice changes the Studio behind the dialog at once. The miniature is built from Studio's own classes, so the real stylesheet draws it: the top bar, the tool rail with its real icons, the two panel cards as empty surfaces and the viewport as a plain block, with every label, row and field left out. It is a Studio root of its own with `data-theme` set, so the theme's tokens resolve again on that element and it shows its theme whatever theme Studio is in; **System** shows the light and the dark one side by side. It is laid out at the window's own proportions and scaled to the card, inert and hidden from assistive technology, and built once, the first time the dialog opens.
- **Performance.** One row of four cards with an icon that reads as a pixel grid getting finer (Light, Balanced, Sharp) and a loop for Automatic. Each tier shows its pixel ratio and anti-aliasing on this screen; Automatic names the tier it took and the graphics card and cores it found.
- **Modelling.** Move snap, rotate snap, handle size and start workspace, each row led by an icon and the workspace chips by the workspace's own icon.
- **AI agent.** The prompt the **Agent** menu copies, beside a chat mark, and a button that copies it.

Finishing, skipping or pressing Esc marks it done. Choices are the Settings preferences, so nothing is stored twice. All four steps share one grid cell, so the dialog is as tall as the tallest step (capped at the window height minus 48 pixels, then it scrolls inside) and never changes size between steps; a step with one block fills the cell.

Studio never opens the setup by itself, so tests, capture scripts and embedders get no modal. A host calls `studio.openSetup()`, usually when `studio.setupDone` is false. **Help ▸ Set up Studio…** opens it again. The development page opens it on a first visit, and `?setup=off` turns that off.

## Mount the Studio in an app

Import `createStudio` from `crucible/addons/studio` and pass a container element and a scene recipe.

```js
import { createStudio } from 'crucible/addons/studio';

const studio = createStudio(document.querySelector('#studio-root'), {
  homeHref: '/', // optional: makes the mark at the top left a link back to your app
  recipe: {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'clay', tag: 'surface', color: [0.8, 0.4, 0.3], roughness: 0.45, metallic: 0 }],
    nodes: [{ id: 'cube', geometry: 'box', material: 'clay', translation: [0, 0.5, 0] }],
    camera: { eye: [3, 2, 4], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45 },
  },
});

// Read back the updated recipe for your AI agent workflow.
const updatedRecipe = studio.exportRecipe();
```

## Open scenes that use catalog scans and HDRIs

A scene an agent builds through MCP often places scanned models and lights them with an HDRI. The recipe names those files by id (`node.asset.id`, `environment.hdri`, a `.cube` look in `environment.look`) and the MCP server reads them from its asset catalog. Studio runs in the browser, so your app hands it the files through the `catalog` option:

```js
const studio = createStudio(container, {
  recipe,
  catalog: {
    asset: async id => (await fetch(`/catalog/${id}.glb`)).arrayBuffer(),
    environment: async reference => (await fetch(`/catalog/${reference}.hdr`)).arrayBuffer(),
    look: async reference => (await fetch(`/catalog/${reference}.cube`)).text(),
  },
});
await studio.ready;
```

- Each function takes the id the recipe names and returns the file: a GLB and a Radiance `.hdr` as an `ArrayBuffer` or a `Uint8Array`, a `.cube` look as text. Pass only the ones your scenes use. An asset id is the SHA-256 of the file, which is how the MCP catalog names it.
- Studio asks for a file once and keeps the decoded result until `studio.dispose()`, so a reload of the watched file, undo and redo do not fetch again.
- `createStudio` still returns at once. When the recipe needs catalog files, Studio opens on the starting scene and swaps the recipe in when they have loaded; `studio.ready` settles then. Opening the scene is not an edit: nothing to undo, no unsaved mark.
- The unsaved mark follows every edit of the scene, camera rows, lens chips and view chips included. Orbiting, zooming and panning are navigation and do not set it. Picking a mesh while the Sun, a light or the camera is selected leaves the Look or Camera tab for the mesh's own tab (Material, or Object from the camera).
- Studio keeps the scene you are editing as a draft in the browser's `localStorage` (a moment after the edits pause; skipped when the recipe is above about 2 MB, which also drops the older draft). Save, New and Open clear it. When Studio starts and a draft differs from the scene that opened, a notice offers **Restore** (the draft comes back as one undo step) or **Discard**; the first edit made while it is on offer counts as carrying on with the current scene, so the notice closes and the draft follows the new work. A host with no storage gets no draft.
- `studio.loadExternalTextFile(text)`, the Open dialog and the recipe JSON dialog load catalog files the same way. `studio.openRecipe(recipe)` does it for a recipe object; `studio.loadRecipe(recipe)` stays synchronous and expects the files to be loaded already.
- Without the function a scene needs, the scene on screen stays as it was and the status line says which file is missing and which function to pass.
- Studio loads no Draco or KTX2 decoder. Serve a GLB that uses neither.

The viewport draws a scene's volume fog. Post passes written as shader code and other render-only steps show in the MCP preview and in renders, not in the Studio viewport.

## See the agent at work

When an agent edits the scene, Studio shows a pointer with the agent's name, the way a collaborator's cursor shows in a shared document. The pointer travels to each object the agent changed, a dashed outline marks that object, and the status line says what changed ("Claude edited hero, orb").

- A reload of the watched file counts as an agent edit. `createStudio(container, { agentName: 'Claude' })` sets the name on the pointer; without it the name is "Agent".
- `studio.loadExternalTextFile(text, { agent })` takes `agent: { name }` to name the agent for one edit, `agent: true` to mark any load as an agent edit, and `agent: false` to load without the pointer.
- `studio.showAgentEdit({ name, nodeIds })` points at objects directly, for a host that hears about each agent step as it happens.

Each agent gets its own colour, picked from its name out of five brand colours, so two agents are easy to tell apart; the pointer, the name tag and the outline share it. The pointer keeps to its object while you orbit, visits at most eight objects for one edit, and with reduced motion it steps from object to object without gliding.

## Headless controller for tools and tests

Import `createStudioController` to drive picking, gizmo drags, surface snapping, look edits and camera bookmarks without DOM rendering.

```js
import { createAgentScene } from 'crucible/addons/agent-scene';
import { createStudioController } from 'crucible/addons/studio';

const scene = createAgentScene(recipe);
const controller = createStudioController({ scene, viewportWidth: 960, viewportHeight: 540 });

controller.pickAt(480, 270);
controller.saveBookmark('Front');
controller.setSunAngles({ azimuthDegrees: -40, elevationDegrees: 52 });
```

`controller.gizmoHandles()` returns the pivot, the object's world axes (`basis`) and the screen points of each handle. `controller.selectionSilhouette()` returns the selected object's triangles on screen as a flat list of x, y pairs (six numbers a triangle), which the viewport fills and outlines; `controller.selectionOutline()` returns the hull polygon around it. Both return `null` when nothing is selected or part of the object is behind the camera. `controller.frameSelectionPose()` returns the camera that frames the selection without moving anything, and `controller.moveViewportCamera(patch)` moves the camera without an undo step.

## What Studio edits in the recipe

1. Viewport clicks and gizmo drags emit deterministic `set-node` updates on `translation`, `rotation` and `scale`, measured along the object's own axes.
2. Surface snap (`Snap` mode or Alt-click) raycasts against other scene parts and offsets the node along the surface normal.
3. Material and look controls update the active material, `environment` and `effects` sections directly. The Material tab has colour, roughness, metallic, clearcoat, clearcoat roughness, opacity, emission, glow colour and a Double sided switch.
4. Saved camera bookmarks read and write named shots in `recipe.timeline.shots`.
5. Every change exports cleanly with `exportRecipe()` so AI agents can continue from the same scene revision.
