# Studio

Crucible Studio lets designers and AI agents work on the same `crucible.scene` recipe. It is an addon (`crucible/addons/studio`) that an app embeds; it is not a page of the public site. It adds zero bytes to the core library entry (`crucible`).

## Open Studio

An app mounts it with `createStudio(container, options)` (see below). To try it from a checkout, run `npm run dev` and open `/bench/studio/index.html`. Drop a `scene.json` on the window, or click the file name at the top left and choose **Open**.

## The screen

The scene fills the window and the controls float on top of it.

| Where | What it does |
| --- | --- |
| Top left | The menus. **File**: New scene, Open, Open recent, Save, Save as, the three exports and the recipe JSON (see [New scene and recent scenes](#new-scene-and-recent-scenes)). **Edit**: undo, redo, copy, paste, duplicate, delete, deselect and Settings. **View**: front, right and top view, perspective or orthographic, frame the selection, the grid and the panels. **Agent**: copy a prompt for an AI agent and reload when it edits the file. **Help**: the keyboard shortcuts. Each row shows its key. |
| Top centre | The workspaces, in the order the work runs: **Build** (objects and their place), **Look** (materials, lighting, sun, exposure, fog) and **Animate** (camera, lens, shots and the timeline). Each one shows only the panels its step needs. Opening a panel from anywhere, or adding a keyframe, brings its workspace forward. A workspace is a way of looking at the scene: it is not saved in the recipe and undo does not touch it. |
| Top right | The file name, which opens the File menu, and **Export** (PNG image, GLB model, web pack). A green dot beside the name means Studio reloads the file when an agent edits it. |
| Left rail | The tools that change the scene come first: select, move, rotate, scale, snap to a surface, then add an object or a light, undo and redo. Under one line sit the switches that only change what you see: show or hide the grid, show or hide the panels. |
| Scene card | At the top of the right column, across from the rail. The list shows whole rows only: it scrolls a row at a time and the rows stretch by a pixel or two so a whole number of them fills it. The materials are one row of swatches that scrolls sideways, with the add button fixed beside it. Its head has a search button, which opens a box that filters the list as you type (Esc closes it and clears the filter), and an add button with the same menu as the rail. Every object in the scene, drawn as the shape of its geometry (cube, sphere, cylinder, cone, torus, plane, or a stack for a group) in the colour of its material, an eye to hide each one, and the scene materials as swatches. |
| Properties | Under the Scene card, in the same column. The panels of the open workspace: the object in Build, material and look in Look, the camera (views, lens, shots) in Animate, with the object one tab away: picking an object there opens its panel and stays in Animate. |
| Bottom, in Animate | Play, add a keyframe, switch Auto-key, scrub the time, jump to a saved shot. The selected object's keys are diamonds on the scrub track: click one to select it and move the playhead there, drag it or press Left and Right (Shift for finer) to retime it, Delete to remove that key. The readout moves up to make room for it, and floating panels stop above it. |
| Bottom left | The camera (perspective and lens, or orthographic), the grid step, and the size of the selected object in metres. |
| Top right, beside the right column | The view widget: the X, Y and Z axes as the camera sees them. Click an end to look from the right, left, top, front or back. |

The ground carries a grid that covers the floor far out, with the X axis in red and the Z axis in blue. Up close it has one line per metre; as you zoom out the step grows tenfold (10 m, 100 m) and as you zoom in it shrinks (10 cm), and the readout at the bottom left names the step. Every tenth line is stronger, and the lines thin and fade with distance instead of crowding the far floor. The grid is a working aid: it is not part of the recipe and stays out of PNG, GLB and pack exports. `studio.setGridVisible(false)` hides it from code.

The floor of the viewport reaches the horizon however far you zoom out (up to 400 m from the target), and the viewport keeps drawing the scene beyond the `far` of the scene camera. A PNG export still uses the scene camera as it is saved. The viewport leaves its own floor out when the recipe sets `environment.ground` to false or one of its parts already forms the floor, as the MCP preview does.

The selected object gets an outline that follows its shape: it goes in between the points of a star and around each letter of a text. An object with more than 8,000 triangles (a scan) is outlined the same way from a mask the graphics card draws, so a ship's masts show and no polygon cuts across it, even when part of it is behind the camera; without WebGL2 it gets the outline around its hull. Docked, drag the inner edge of the right column to make it wider or narrower (240 to 520 px), and drag the gap between the two cards to give the Scene card more or less of the column. Floating, each card is its own window: drag its left edge to change only its width, and its bottom edge to change only its height, and the other card keeps its size (the Properties card just moves when the Scene card above it grows). Hold Ctrl (Meta on a Mac) while dragging a width edge to resize both cards together, or while dragging the Scene card's bottom edge to take height from the Properties card as the docked split does; docking the panels again also gives one shared column. The grips show only under the pointer or the keyboard, take the arrow keys (Ctrl for both cards), and a double click puts that card back to its automatic size (with Ctrl, both cards in that direction). The view widget stands at the top right of the viewport, left of the column and level with the Scene card, so it moves with the card as it is resized. The arrow in the head of each card folds that card down to its head. Studio keeps these sizes and folded cards in the browser (`sceneWidth`, `propertiesWidth`, `sceneHeight` and `propertiesHeight` for floating cards, `panelWidth` and `sceneShare` for the docked column; a size of 0 means automatic). The bar, the rail and the column sit on the edges of the window by default, so nothing covers the scene: the viewport is the room they leave and the scene is drawn at that size, with its proportions true. Turn on **Floating panels** in Settings to let the scene fill the window with the panels over it. Below 820 px wide the two cards start closed so the scene keeps the screen; the panels button on the rail opens them.

When the browser drops the WebGL context, Studio pauses the picture, shows a notice over the viewport and draws again by itself when the context returns, with the scene, selection and camera untouched; the notice offers **Reload** if the context has not returned after a few seconds. A frame that throws is handled the same way: the notice names the error and the next change to the view tries again.

## Move, rotate and scale

Each tool has its own handle shape, so the shape says what a drag will do: arrows move, rings turn, squares scale. A handle does not have to be hit exactly: a press within about 11 pixels of an axis or ring, or 16 pixels of its tip, takes it. The handles follow the object, not the camera: the three axes are the object's own X, Y and Z, so a turned object moves along the way it faces. The handles have no border at rest; the one under the pointer grows thicker and brighter and gets a pale border, so you see what a press will grab. An axis that points almost at the camera is drawn longer, so it never shrinks to a stub you cannot catch.

- **Move** drags the object exactly as far as the pointer travels along the axis. Hold Shift to move in steps (0.25 m unless you change it in Settings). While you drag, a dashed outline stays where the object was and a dashed line runs from there to where it is now; scale and rotate drags keep the outline too. The dashed lines are pale with a dark border, so they show over a pale object and over the dark ground. A new object lands on the ground beside the ones already there, not inside them.
- **Rotate** turns the object by the angle the pointer sweeps on the ring. Hold Shift to turn in steps (15 degrees unless you change it in Settings). While you drag, the other two rings leave, a dashed spoke stays where the drag began, a solid spoke follows the object, and a faint wedge between them fills the angle turned so far. A turn can go past half a circle and keeps counting.
- **Scale** on an axis handle scales by how far you pull it: twice the distance doubles that axis. The centre handle scales all three.

One drag is one undo step, and undo leaves the viewport camera where you put it. Undo and redo of an edit, of adding or duplicating an object, and of deleting one change the scene already built instead of building it again, so a large scene stays responsive. That holds for putting a deleted object back into the middle of the list and for undoing a lens change too.

## Edit a mesh

The form of each Studio feature (tool, toggle, mode, operator, modifier, setting or panel) and the reason for it are listed in [Studio interaction forms](https://github.com/codepawl/crucible/blob/main/docs/studio-interaction-forms.md).

Select an object and press **Tab**. A shape from the Add menu's Mesh group (plane, box, circle, sphere, icosphere, cylinder, cone, torus) turns into a mesh on the spot and edit mode starts, with no question asked; an object that is a mesh already just enters. Its cage appears over the picture: the polygon edges in pale lines, quieter on the far side of the mesh, with the vertices as dots in vertex mode. A group of three buttons joins the rail in the accent colour while you edit: vertex, edge or face, on **1**, **2** and **3**, with a button below them that leaves edit mode. The readout line at the bottom names the mode, and what you picked is drawn in the accent colour over the handles. Click picks the nearest vertex or edge or the face under the pointer; **Shift + click** adds or removes one; a click on nothing clears the selection. The move handles stand at the centre of the selection and work as they do for an object: drag an arrow or a square to move what you picked. They leave the pick in view: the centre dot gives way to a thin ring around the pick (drag it to move on the screen plane, as the dot did; a click inside it still picks), each arrow moves out whole, keeping its length, by the pick's reach on screen plus 12 pixels, and each plane square slides outward with its arrows. The ring and the arrows stop moving out at 100 pixels, so on a face larger than that they overlap the face. A plane square seen almost edge on, thinner than 4 pixels, is not drawn or grabbed. The arrow tips win over a square that lies over them. **Esc** during a drag puts it back; with nothing selected, **Esc** or **Tab** leaves edit mode.

A mesh is the shape of the edit log in the recipe (`type: "mesh"`, a `base` shape and `edits`), so what you do is written there, and undo, redo, save and agents all see it. One drag is one entry of the log: a `translate` of faces when what you moved is exactly some faces, else a `set_position` of the picked vertices. Moves are in the object's own space, so a turned or stretched object moves the way its mesh does. While you drag, the surface follows the pointer for a mesh that Studio can rewrite in place (no skin, shape keys or level-of-detail set); the edit is written when you let go.

The conversion keeps the object where it is, its size, material, name, parent, children and animation. A box and a cylinder lose their small bevel on the way, so their edges turn sharp and the cage is the plain shape: a box is 6 faces (1,482 with the bevel), a cylinder 96 (672). The other shapes keep every segment they had: plane 64 faces, circle 37, sphere 864, icosphere 320, cone 72, torus 1,344 (the Add menu's torus, 56 by 24 segments; a torus in a recipe with no segments given has 48 by 48, 2,304 faces). The conversion is one undo step that gives the shape back and leaves edit mode; redo makes the mesh again.

Not there yet, and said so on screen when you reach it:

- Text, a light, a group or an imported file has no mesh to edit, and the message says what it is and what to do instead.
- A mesh holds at most 64 edits, and a move needs one. At the limit Studio refuses the drag before it starts.
- A move of more than 19 vertices that are not whole faces cannot be written yet; pick whole faces, or fewer vertices.
- A mesh with a modifier stack is refused. A mesh of more than 8,000 triangles draws only the picked elements, with a notice.
- **Alt+A** selects none and **Ctrl+I** inverts the selection, in the mode you are in (vertices, edges or faces); the object stays selected. Inverting nothing selects everything of that mode. Like a pick, neither is an undo step.
- **C** starts circle select. A circle follows the pointer: drag with the left button to select what it passes over, drag with the middle button (or hold **Shift**) to deselect, turn the wheel to make the circle bigger or smaller (4 to 400 pixels, 25 to start), and press **Esc** or right click to stop. In vertex mode it takes the vertices inside the circle, in edge mode the edges it touches, in face mode the faces it overlaps. Only what faces the camera is taken. The circle keeps its size until you change it.
- Rotate, scale, box select, extrude and the other tools come next.

If another object uses the same geometry, entering edit mode gives this object a geometry of its own (the same conversion step), so the other one keeps its shape and does not move with it.

## Add an object or a light

The add button on the rail and the one in the Scene head (or Shift+A) open the same menu, which holds the basic building blocks in three groups:

| Group | Entries |
| --- | --- |
| Mesh | plane, box, circle, sphere, icosphere, cylinder, cone, torus |
| Text | 3D text |
| Light | point, spot and area |

Each shape is an ordinary recipe geometry, so an agent can keep editing it: a circle is a `circle` geometry, and the rest are `plane`, `box`, `sphere`, `icoSphere`, `cylinder`, `cone`, `torus` and `text`. A new shape is about a metre wide and rests on the ground. A menu that opens low on the screen grows upward, so it stays inside the window. People build everything else from these, and an agent can still write any other geometry (`extrude`, `lathe`, `tube`, `terrain` and the rest) into the recipe: a scene that holds one opens, shows in the Scene list, selects and moves like any other object.

### Shape settings

Select a plane, box, circle, sphere, icosphere, cylinder, cone or torus and the node panel shows a Shape section with the fields of its geometry: segments, rings, bevel, bevel segments, subdivisions, the radii of a cone, the inner radius of a circle, and the tube radius and sides of a torus. A shape's size is its scale, which stays in the Transform rows. Type a number and press Enter: the shape is rebuilt and the change is one undo step. A shape that another object uses is copied for the selected one, so the others keep theirs. A number outside the range, or text that is not a number, is refused with a message that names the range, and the field goes back to the recipe.

An edit in edit mode turns the shape into a mesh, which has no such fields. The section then says so instead of showing them; undoing the edit brings them back. A geometry that is not one of these shapes (text, lathe, extrude, terrain and the rest) shows no Shape section.

## Camera and lights in the Scene list

The scene camera, the sun and every point, spot and area light are listed above the nodes in the Scene list, each with its own icon, and a mark for each light and the sun is drawn in the viewport. Click a row or a mark to select it: the camera opens the Camera tab, the sun and the lights open the Look tab. With the Move tool a light drags in the plane through it that faces the view, as one undo step. Delete removes a selected light. A light added from the Add menu is selected and its panel opens. After an object is deleted nothing is selected, so a second Delete removes nothing; undo and redo bring back the selection of the step they restore. The camera is drawn only while the viewport looks away from it, after you orbit a scene whose camera a track moves. These are not recipe nodes: they edit `camera` and `environment`, so a light a motion track moves cannot be dragged, and the camera and the sun cannot be deleted. In code, `listSceneObjects()`, `selectSceneObject(key)`, `moveSceneObject(key, position)` and `deleteSceneObject(key)` on the controller do the same, with keys `camera`, `sun`, `point:0`, `spot:0` and `area:0`. The marks and the direction line of a light sit over the viewport, which is dark in both themes, so they use the trace colours, not the theme text; a selected row is tinted in the accent with its icon in the accent (3:1 on the tinted row), with no border.

## World, fog, film, effects and shadow properties

The Look tab lists every scene-level look setting an agent can write, in groups with a title row you click to fold. **World** holds the HDRI choice (None, `sky-clouds`, `studio-softbox`; a catalog file the scene names shows as the current value), Show sky, Ground, HDRI strength and rotation, the sky top and bottom colors, Daylight, Fill and Ambient strength. **Fog** holds the fog density and color and the main volume fog fields: density (0 is off), color, anisotropy, steps, noise amount and scale, and distance. **Film** has Exposure, Contrast, Saturation, Temperature, Vignette and Grain, and the **Color look** select as its first row. **Effects** has ambient occlusion and its radius, bloom strength, threshold and radius, depth of field blur and focus, and motion blur shutter and object blur. **Shadows** edits the shadow box (target, extent, distance, clip start and end) and **Quality** the render switches (object reflections, floor sky trace, resolve coplanar, shadow cascades, sun bounce, specular AA). Only the first group of a tab starts open; which groups you open or fold is kept in the browser with the other Settings, not in the recipe. A group's title row stays at the very top of the panel, on the panel color, while its rows scroll under it and dissolve over a short fade below the title; the same fade closes the bottom edge while more of the panel lies below. Numbers end at one edge with or without a unit, and the unit sits in a slot after them. The slider readout, a choice's text and a color swatch end at that same edge, and a label always gets its full name with a gap before its control. Choices read as names (ACES, AgX, Neutral, Standard) while the recipe keeps its own values, and a color is a field like the number fields.

Every property is one line: the label on the left, the control in a value column on the right. A bounded number is a slim slider with its value beside it, an unbounded one a number field you can type in or scrub with the arrow keys, a switch is a track that is filled with the knob at the right when on, and a vector keeps its X, Y and Z fields under the label. Units sit quietly beside the number, not in the label: millimetres for focal length and sensor width, metres for lengths, and degrees for every angle, including the HDRI rotation and the sun size, which the recipe keeps in radians. Typing a value in degrees writes the recipe in radians. A number shows three decimals at most with trailing zeros trimmed; the stored value changes only when you edit it. A catalog HDRI shows its name, or Custom and the first eight characters of its ID.

World, Fog, Quality and Shadows describe the whole scene, so they leave the tab while a light is selected and return with the sun. Each edit is one undo step, a field a motion track animates (sky, fog, volume density, exposure, focus distance) is dimmed, locked and marked, and a change an agent makes shows in the controls. A shadow box the renderer cannot use (near past far) is refused and the controls return to the recipe. In code, `controller.updateSceneShadow(patch)` joins `updateLook`, and `describeSceneObject('world' | 'quality' | 'effects' | 'shadow')` gives the record a panel reads.

Not shown yet: `volumeFog` bounds, ambient, drift, height falloff, shadow ambient, profile, detail and flow fields, `localVolumes`, `liquid`, `wind`, `sky` (the physical sky), `lines`, `keyAffects` and the `look` cube file.

## Post passes

The viewport draws a recipe's `postPasses` and `postPassesAntialias` as the MCP preview does, and stills taken from it include them. A scene with passes gets a renderer with a depth target, since passes may read `sceneDepth`. A pass the viewport cannot run is named in a notice at the bottom of the viewport, one line per pass (`Post pass "foam" is not drawn here: <reason>`): a pass that fails to compile (the first line of the compiler message is the reason), a renderer that cannot take passes, or a supplied renderer without depth when a pass reads it. The picture keeps drawing without that pass, the notice goes when the pass draws or leaves the recipe, and a refused pass is tried again only when its fragment text changes. The recipe is never touched: refused passes stay in it and save unchanged.

## Light, sun and camera properties

Select a light in the Scene list and the Look tab lists what the agent can set on it, in four groups: **Light** (color, intensity, and for point and spot lights radius and range), **Shape** (width and height of an area light, angle and penumbra of a spot light), **Shadows** (shadow, soft falloff, portal) and **Transform** (position, and direction for spot and area lights). With no light selected the tab shows the sun: its direction pad with the azimuth and elevation in degrees beside it, strength, color and size. The Camera tab adds, under the view buttons (Front, Right, Top, Iso and the projection switch on one row), a **Lens** group that opens with the lens chips (24, 35, 50 and 85 mm) and holds focal length in millimetres, sensor width, field of view, orthographic size, an Ortho switch, clip start and end, shift, depth of field (f-stop and focus distance) and the eye and target as numbers. Each edit is one undo step, a slider, colour or scrub drag included. An empty f-stop (the field shows "Off") turns depth of field off. A lens chip lights when the focal length is within half a millimetre of it.

A field that a motion track or driver animates is locked, shown in the muted color and marked with a keyframe diamond named "Animated by a track": edit its keyframes instead. A keyed object's Position, Rotation and Scale are editable with Auto-key on, where an edit writes the key at the playhead, and locked with it off. When an agent changes the scene file, Studio reloads it and the controls show the new values. Not shown yet: a light's `ies` profile, `affects` links and `lines`. In code, `controller.updateSceneLight(key, patch, { recordUndo })`, `controller.updateSceneCamera(patch)` and `controller.describeSceneObject(key)` do the same, and the rows come from the table in `src/studio-properties.js`, so a later area adds rows and no panel code.

## Selecting several objects

Click an object to select it. Shift+click (or Ctrl or Command+click) adds an object to the selection, or takes it out if it is already in; the one you added last is the **active** object. A click on empty space clears the selection, and Shift+click on empty space leaves it alone. Select all (A) takes every visible object, Select none (Alt+A) clears the selection and Invert (Ctrl+I) swaps selected and not selected.

Every selected object has an outline in the accent colour with a thin ring of the viewport's dark (`--studio-trace-edge`, the same in both themes, because the viewport is dark in both) on each side, so it reads on light and dark surfaces and leaves no pale glow on the floor in the light theme: the active object's outline is 4 px wide and the others' 2 px, twice as wide on screen (the filters draw a 1.5 px ring as 2 px, so a 3 and 1.5 pair only differed by half). In the Scene list every selected row is tinted, the active one more strongly (it also carries `aria-current`); a click on a row selects only that node, and Shift or Ctrl or Command+click on a row adds it or takes it out, as in the viewport. Where the shape outline cannot draw (no WebGL2, or part of the selection is behind the camera) Studio outlines the active node and at most 11 of the others by their convex hull, because each hull costs a pass over its vertices. A selection too dense for the shape outline (past 8,000 triangles) is drawn by the mask at the 2 px strength of the others, and the active object is drawn over it at 4 px: from its own shape when it alone fits the 8,000 triangles, else from a second mask of its own, so a dense imported model gets its true silhouette and not a hull across its holes. Only when that second mask cannot draw (no WebGL2) is the active object marked by its hull. One dense object selected alone is the mask at 4 px. The Properties card, the handles, the readout and every action (move, delete, duplicate, hide, keyframes) still work on the active object only, and the Properties head says how many are selected. Tab edits the mesh of the active object.

## Keys

**Help ▸ Keyboard shortcuts** (or **?**) lists every key.

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
| A, Alt+A, Ctrl+I | Select all, select none, invert the selection |
| Tab | Edit the mesh of the selected object; Tab again leaves |
| 1, 2, 3 | In edit mode: select vertices, edges or faces |
| Alt+A, Ctrl+I, C | In edit mode: select none, invert the selection, circle select (Esc or right click ends it) |
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

G, R and S: with an object selected and the pointer over the viewport, the key picks the object up: it follows the pointer with no handle to aim at, and a pill at the bottom of the viewport shows how far it has gone and the keys that act on it. X, Y or Z keeps the move to that axis of the object, a click or Enter places it, and Esc or a right click puts it back as if nothing happened. A placed move is one undo step. With nothing selected, or the pointer over a panel, the key only switches the tool, and the handles work as before. Typing a number while holding an object is not supported: type it in Properties instead.

A right click on an object, in the viewport or in the Scene list, selects it and opens its menu at the pointer: Frame, Duplicate, Hide, the three resets and Delete. They are the same rows as in **Edit**, with the same keys. A menu row starts with its icon when one fits and with an empty square when none does, so the labels line up. Dragging with the right button still pans. Alt takes back what the plain key does: G, R and S change a transform and Alt+G, Alt+R and Alt+S reset it, H hides the selection and Alt+H shows everything again, as one undo step.

## Help

The last menu of the top bar, **Help**, has four rows, each with an icon.

- **Keyboard shortcuts** (or **?**) opens a sheet in the middle of the window. It lists every action that has a key in the keymap you chose, in groups by what you are doing (File, History, Selection, Clipboard and objects, Transform and tools, View, Animation, Mesh editing, Holding an object, Mouse, Help and settings), one row per action with its key on the right. A keymap preset or a rebound key shows its new label the next time the sheet is filled. The groups sit in two columns, or one in a narrow window, and the sheet scrolls inside itself when the window is short. **Esc** or the close button in the title row closes it, and the focus goes back to the **Help** button when it was opened from there.
- **Documentation** opens this guide on GitHub in a new tab that cannot reach back into Studio. A host page that passes `openExternal(url)` to `createStudio` gets the address instead and opens it its own way.
- **Set up Studio** reopens the setup. **Save diagnostics report** downloads the report described under Diagnostics.

## Keymaps

**Settings ▸ Keyboard** (or the **Keys** step of the setup) switches the keys to those of another program: **Blender** (the table above, the default), **Maya** or **Cinema 4D**. The change is live: key presses, the keys beside menu rows, tooltips, the pill at the bottom of the viewport and the shortcuts dialog all follow it at once, with no reload. Only the keys the vendors list are set; every other action keeps its Blender key. The sources are Autodesk, [All Maya Hotkeys](https://help.autodesk.com/cloudhelp/2025/ENU/Maya-KeyboardShortcuts/files/GUID-30CACC9D-8FBE-4B85-8A8F-C5ADF32DDD4E.htm), and Maxon, [Keyboard Shortcuts](https://help.maxon.net/c4d/en-us/Content/html/Shortcuts.html).

| Action | Blender | Maya | Cinema 4D |
| --- | --- | --- | --- |
| Select | Q | Q | 9 |
| Move | G | W | E |
| Rotate | R | E | R |
| Scale | S | R | T |
| Snap to a surface | T | J | Shift+S |
| Duplicate | Shift+D, Ctrl+D | Ctrl+D | Shift+D, Ctrl+D |
| Delete | X, Delete, Backspace | Delete, Backspace | Backspace, Delete |
| Undo | Ctrl+Z | Ctrl+Z | Ctrl+Z |
| Redo | Ctrl+Shift+Z | Ctrl+Y, Ctrl+Shift+Z | Ctrl+Shift+Z |
| Hide the selection | H | Ctrl+H | H |
| Show all | Alt+H | Ctrl+Shift+H | Alt+H |
| Deselect | Esc | Esc | Ctrl+Shift+A, Esc |
| Select all | A | A | A |
| Select none | Alt+A | Alt+A | Alt+A |
| Invert the selection | Ctrl+I | Ctrl+I | Ctrl+I |
| Frame the selection | F, . | F | O, S |
| Show or hide Properties | N | Ctrl+A | Shift+F5 |
| Insert a keyframe | I, K | S | F9 |
| Play | Space | Alt+V | F8 |

In Maya and Cinema 4D a tool key only selects the tool and its handles appear; it does not pick the object up under the pointer the way G, R and S do in Blender, so the shortcuts dialog has no "while holding" rows there. Studio's **Show all** shows everything that is hidden; Maya's own Ctrl+Shift+H is "Show Last Hidden", the nearest key it lists. The keys of the Holding-an-object context (X, Y and Z for an axis, Enter, Esc) do not change, and the keys that switch between Move, Rotate and Scale while holding follow the preset.

Maya and Cinema 4D also take **Alt** with a mouse button on the viewport: Alt and the left button orbit, Alt and the middle button pan, Alt and the right button zoom (drag right or up to come closer). It works over the objects and the handles, and it never selects or drags a handle. Plain left drag orbits, Shift, middle or right drag pan and the wheel keep working in every preset.

### Change a shortcut

**Settings ▸ Keyboard** lists every shortcut of the chosen preset in the same groups as the Help sheet, one row per action with its key as a button. Click the key (or press Enter on it): the button reads **Press keys** with a dot, and the next combination becomes the binding. A modifier alone waits for the key that goes with it. **Esc** cancels, and **Backspace** or **Delete** clears the binding, leaving the action without a key until you set one. An action with several keys (Delete has X, Delete and Backspace) takes the new key in place of all of them; reset it to get them back. The mouse rows are shown and cannot be changed yet.

- **A clash.** If another action of the same context already has the combination, the row shows a warning, "Used by <action>", with **Swap** and **Cancel**. Nothing is saved until you choose: Swap gives the other action the key this one had, and keeps the other keys that action had.
- **Keys the browser keeps.** Combinations a page never receives (Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab, Ctrl+1 to 9, Ctrl+Shift+Q, F11, Alt+F4) are refused with a note on the row, and recording goes on so you can press another.
- **Reset.** A row that differs from its preset has a dot before its name and a reset button that returns just that action. **Reset all** returns every key of the preset after a confirm (**Reset keys** or **Keep**).
- **Find a shortcut.** The field above the list keeps the actions whose name contains what you type.

Changes are kept in the browser with the other Settings as `keyOverrides`, per preset: `{ "crucible": { "tool.select": { "key": "v", "shift": false } }, "maya": { "tool.rotate": null } }`. A value is a binding, a list of bindings, or `null` for no key. When the settings load, an unknown preset or action, a malformed or browser-reserved binding, or a set that gives one key to two actions is dropped and the preset's own keys stay. Key presses, menu labels, tooltips, the pill at the bottom of the viewport and the Help sheet all read the one keymap, so they follow a change at once.

## Settings

**Edit ▸ Settings** (Ctrl+,) opens Settings. A short list of sections stands on the left, each with an icon, and the rows of the chosen section are beside it; the dialog keeps the height of the tallest section, so it does not jump when you switch. On a narrow window the list shows only the icons.

| Section | Rows |
| --- | --- |
| Interface | Theme (System, Light or Dark), Open in (the workspace Studio opens in), Floating panels, Motion |
| Viewport | Performance tier, Grid, Camera and size readout, Axis widget, Agent cursor, Handle size, Zoom direction |
| Editing | Move snap step and Rotate snap angle for a Shift drag |
| Keyboard | The key preset (Blender, Maya or Cinema 4D), a field to find an action, and every shortcut of the preset as a button that records a new key ([Change a shortcut](#change-a-shortcut)) |
| Account | Only when the host page offers an account, see below |

They are kept in the browser (`localStorage`, key `crucible-studio-preferences`), not in the scene recipe, so a scene looks the same for everyone and each person keeps their own setup. **Reset** brings back the defaults of every row. **Run setup again** opens the first-run setup. An app can pass `preferences` to `createStudio` to start from other values, `preferenceStorage: null` to keep nothing, and call `studio.setPreference(name, value)`.

**Motion** is `motion`: `'system'` (the default) follows the system's reduced-motion setting, and `'reduced'` turns off Studio's own motion whatever the system says: menus, hover fades and the agent pointer's glide take no time, the bake pulse stops, and F frames the selection with a jump instead of a flight. Both ways go through one switch, so the system setting and the preference never disagree. Showing full motion over a system that asks for less is not offered: the motion rules are written as `prefers-reduced-motion` media queries, which a preference cannot turn back on.

**Zoom direction** is `zoomDirection`: `'normal'` (the default) moves the camera away when the wheel scrolls down, `'inverted'` brings it closer. A trackpad pinch arrives as a wheel with Ctrl held and follows the same choice.

**Units** (metres, centimetres, millimetres, feet and inches) are not a setting yet: the readout, the drag labels and the number fields each format lengths on their own, so a display unit needs one shared length formatter first.

### Account

When the host page provides `globalThis.crucibleShell.account`, Settings gets an **Account** section. Studio holds no token and makes no network call: it shows what the object reports and calls the functions it offers.

```js
globalThis.crucibleShell = {
  account: {
    // Required. Every optional field may be missing; text fields are shown as plain text.
    async get() {
      return { signedIn: true, name: 'Sample Person', email: 'sample.person@example.com', remainingText: '1,240 credits left', planText: 'Studio plan' };
    },
    async signIn() {},        // resolves when the sign-in is done; rejecting shows its message under the status
    async signOut() {},       // resolves when done; Sign out is shown only when this exists
    buyCredits() {},          // optional: "Buy more" is shown only when this exists
    manageBilling() {},       // optional: "Manage billing" is shown only when this exists
  },
};
// When the account changes, tell Studio and it reads get() again:
document.dispatchEvent(new Event('crucible-shell:account-changed'));
```

Signed out, the section shows a lock mark, "Signed out" and one **Sign in** button; while `signIn()` runs the button reads "Waiting" and is disabled. Signed in, it shows a check mark, the person in a round avatar with an initial (no remote images), then `remainingText` as "Left to use" and `planText` as "Plan" when given, and the buttons. A host that has only the older `crucibleShell.builtInAgent` (`isSignedIn()`, `signIn()`) gets the section with the state and Sign in. With neither, there is no Account section.

**Theme** forces the Studio light or dark whatever the system says; System follows the system. The dialogs and menus follow it too. An app that wants to theme its own frame passes `onThemeChange(theme)` to `createStudio`; it is called with `'light'` or `'dark'` at the start and on each change.

**Performance** sets what the viewport draws with, by the tier. Light draws at 0.75 of the screen's pixel ratio (never above 1) with 2x anti-aliasing, Balanced at the screen's ratio up to 1.5 with 2x, and Sharp at the screen's ratio up to 2 with 4x, which is what Studio always drew. Automatic picks a tier from the graphics card the browser reports and the cores: software renderers and small integrated chips go Light, other integrated chips Balanced, dedicated cards and Apple M-series Sharp, and a card the browser hides Balanced. A new pixel ratio is set on the live renderer; a new anti-aliasing count makes Studio build a new renderer. The tier changes only the viewport; it is never written into the scene recipe, so renders and exports look the same on every machine. A `pixelRatio` or `samples` passed in `rendererOptions` stays as given.

## Spacing

Studio spaces everything on one scale: 4, 8, 12, 16 and 24 px, as `--studio-space-4` to `--studio-space-24` on the Studio root, and 0. A 2 px step is allowed only between touching controls of one group (the buttons of a tool row); 6, 10, 14 and 18 px are not, because every use turned out to be a 4, 8, 12 or 16. Inside a group the gap is small (4 or 8), between groups it is larger (16 in a card), and the gap between groups is never smaller than the gap inside one. A card has the same inset on all four sides, measured from its real children.

`node scripts/studio-layout-audit.mjs [--json] [--only setup|settings|keyboard|studio|popover|newscene|dialog|notice|notices|helpmenu]` checks this on the real DOM in headless Chrome: the Studio page, each of its menus, the dialogs (Settings is measured section by section, with a sample signed-in host so Account is included, and its Keyboard section again in the states a person meets: waiting for a key, a clash and a refused combination), the notices (an error toast, a plain toast, the paused notice with and without Reload, the draft notice), the five steps of the setup dialog, the New scene chooser, its unsaved-changes question and the File menu with Open recent expanded, in the dark and the light theme at 1280 by 720 (`--width 720` checks a narrow window). It fails with the selector, the measured numbers and the token to use when a container with a visible edge shows unequal insets (more than 2 px apart), when a gap or padding is off the scale, or when the gap between groups is smaller than the gap inside them. A container with no gap is not held to the last rule, since it keeps its parts apart with padding or is one surface. The few insets that are meant to differ (the tool rail, the end of an outliner row, a menu row) are declared with a reason in `ALLOWLIST` of `scripts/studio-layout-audit.mjs`; fix a real finding in the CSS instead of listing it. The rules are plain functions in `scripts/studio-layout-rules.mjs`, tested without a browser in `tests/studio-layout-rules.test.js`; `tests/studio-layout-audit.test.js` runs the audit in Chrome with the unit tests and seeds a mistake it must catch.

## Selecting text

Nothing in Studio is selectable by click, drag, double click or Ctrl+A (Cmd+A), except text fields (`input`, `textarea`, number fields) and a block that a person copies from. A block opts in with one class, `crucible-studio-selectable`, such as the `<pre>` of a JSON or a prompt; it and what it holds then select as text. The rule is one named list at the top of `src/studio-styles.js`, and a dialog is named in it because the browser makes a modal dialog selectable. An error's own message is marked selectable where it shows: the status toast (its text only, not the box), and the reason in the paused notice; labels, headings, buttons and ordinary notices are not. Select all outside a field is blocked in every mode, over any dialog and menu, but only when the key event comes from Studio: its root is on the event path (so a shadow root is seen through), or focus fell to the body after the last click landed in Studio. A page that embeds Studio keeps select all for its own text and for its own fields. The layout audit reads every screen it opens (the page, menus, the Settings, shortcuts and Recipe JSON dialogs, the setup steps) and fails with the element path and text when chrome with text of its own computes to selectable, and then drags, double-clicks and presses Ctrl+A on the page, the Scene list and Settings and checks that the browser reports nothing selected. That behaviour probe runs on every call, whatever `--only` names. `tests/studio-text-selection.test.js` fails on any other `user-select: text` rule.


## New scene and recent scenes

**File ▸ New scene…** opens a centred dialog, **New scene**, with one card for each starting scene: **Blank** first, then Blockout, Gyro showcase, Product studio and Block courtyard. A card is a picture of that scene, rendered by Studio, over its name. One click, or Enter on the focused card, starts the scene and closes the dialog. The arrow keys, Home and End move between the cards, and Esc or the close button cancels. **Blank** is the template `empty`: one ground plane and one key light, with no object on it. The pictures are `assets/studio-templates/<name>.webp` (320 by 200); they load only when the dialog opens, and `node scripts/render-template-thumbnails.mjs` writes them again after a template changes.

New scene has no key of its own: browsers keep Ctrl+N for a new window, so a page never receives it. A host that owns its keys calls `studio.openNewScene()`.

**Unsaved changes.** Studio marks the scene as changed after an edit, an undo, a redo or an applied recipe, and marks it saved after Save, Save as, an open or a new scene. A camera move saved with the scene (a bookmark, a shot, the scene camera) counts as a change; orbiting the view does not. Choosing a new scene, opening a file (Open…, or dropping one on the viewport) or choosing a recent scene while the scene is changed asks first: **Discard** (at the left, the lesser choice), **Cancel** and **Save**, the one filled button (Esc is Cancel). Save writes the scene and goes on only when it was saved, so a save the host cancels keeps the scene where it is. Discard goes on, and the replacement is one undo step.

Limits by design:

- Undoing every edit back to the saved scene still counts as changed, so the question is asked for a scene that looks unchanged. The undo history is capped and merges gestures into one step, so its depth is not a reliable mark of the saved state.
- **Recipe JSON ▸ Apply** replaces the scene without the question, because it is one undo step; it marks the scene as changed.
- A host or an agent that loads a scene through `studio.loadExternalTextFile` (a watched file that was edited on disk), `studio.openRecipe` or `studio.loadRecipe` gets no question: an agent editing the file is the normal flow there, and a question would stop it. The scene that was replaced stays one undo step away, and a reload over unsaved edits says so in the status line ("Replaced unsaved changes. Undo brings them back."). A load with `recordUndo: false` keeps nothing, so a host that passes it asks the person first (`studio.dirty` says whether to).

**Open recent** lists up to 8 scenes you opened or saved, newest first, one entry per file. It is a row that opens its list in place and is disabled while the list is empty; the list ends with **Clear recent**. A browser page cannot reopen a path, so each entry is kept the way the browser allows:

| Where | What is kept | Where it is stored |
| --- | --- | --- |
| A browser with the File System Access API (Chrome, Edge) | The file handle of a scene opened with **Open…**. Choosing the entry asks the browser for permission again when needed and reads the file as it is now. | IndexedDB, database `crucible-studio` |
| Any other browser, and every scene saved by a download | A copy of the recipe JSON as it was opened or saved. | The page's storage, under `crucible.studio.recent` (the list) and `crucible.studio.recent.copy.<id>` (a copy) |
| A host that supplies its own list | Nothing here. | The host |

What is kept is the file name and, where handles are not available, the recipe text of the scene (its objects, materials, lights and camera). It stays in this browser's storage on this device and is never sent anywhere; **Clear recent** removes every name, copy and handle, and clearing the site's data does too. The list holds 8 entries at most, one for each file name (a handle entry and a copy entry of one name are one entry, the newer winning). The copies of all entries together stay under 1,000,000 characters of recipe text: the oldest copies are dropped to fit, and a scene over the cap is opened but not listed. An entry whose file is gone (moved, deleted, the copy lost) says so in the status line and is removed from the list. A refused or dismissed permission prompt only says that permission is needed and leaves the entry where it is. A host supplies the list with `desktop.recentScenes`, an option of `createStudio`: `{ list(): Promise<[{ id, name }]>, open(id): Promise<{ text, fileName, filePath? }>, remember?({ name, filePath }), remove?(id), clear?() }`.

## Set up Studio

The setup is five steps, one page each, named in a row at the top with an icon apiece (each is a button that jumps to it; the step you are on shows its text and icon at full strength, the others muted): **Theme**, **Performance**, **Modelling**, **Keys** and **AI agent**. Every choice carries an icon that shows what it does.

- **Theme.** Each card is a miniature of the real Studio in that theme, and a choice changes the Studio behind the dialog at once. The miniature is built from Studio's own classes, so the real stylesheet draws it: the top bar, the tool rail with its real icons, the two panel cards as empty surfaces and the viewport as a plain block, with every label, row and field left out. It is a Studio root of its own with `data-theme` set, so the theme's tokens resolve again on that element and it shows its theme whatever theme Studio is in; **System** shows the light and the dark one side by side. It is laid out at the window's own proportions and scaled to the card, inert and hidden from assistive technology, and built once, the first time the dialog opens.
- **Performance.** One row of four cards with an icon that reads as a pixel grid getting finer (Light, Balanced, Sharp) and a loop for Automatic. Each tier shows its pixel ratio and anti-aliasing on this screen; Automatic names the tier it took and the graphics card and cores it found.
- **Modelling.** Move snap, rotate snap, handle size and start workspace, each row led by an icon and the workspace chips by the workspace's own icon.
- **Keys.** Three cards, Blender, Maya and Cinema 4D, each with the program's logo and four of its real keys (Move, Rotate, Scale, Frame) read from the keymap, so the difference is shown.
- **AI agent.** One or two cards, each with its own icon and title. **Your own agent** holds the prompt the **Agent** menu copies in one box with a **Copy prompt** button on it; the button turns into a check and **Copied** once the prompt is on the clipboard. When the page runs inside a host that offers its own built-in agent (`window.crucibleShell.builtInAgent`, with async `isSignedIn()` and `signIn()`; `signIn()` resolves to `{ signedIn }`), a **Built-in AI** card sits above it with a **Sign in** button; it shows when it is waiting, then a check mark and **Signed in**. A host may also offer `window.crucibleShell.account.get()`, resolving to `{ signedIn, name?, email? }`: the card then follows it and reads **Signed in as** the name, or the email when there is no name. Without a host only the own-agent card shows. Nothing blocks: Skip still closes the setup, and the prompt stays the route for an agent of your own.

Finishing, skipping or pressing Esc marks it done. Choices are the Settings preferences, so nothing is stored twice. All five steps share one grid cell, so the dialog is as tall as the tallest step (capped at the window height minus 48 pixels, then it scrolls inside) and never changes size between steps; a step with one block fills the cell.

Studio never opens the setup by itself, so tests, capture scripts and embedders get no modal. A host calls `studio.openSetup()`, usually when `studio.setupDone` is false. **Help ▸ Set up Studio…** opens it again. The development page opens it on a first visit, and `?setup=off` turns that off. The development page paints its theme background and a loading state (the Crucible pot tipping over and pouring a curved stream of molten metal into the left end of a progress bar, with a few sparks where it lands) from the first frame, before any script has loaded; a saved Light or Dark theme is applied before that paint. The bar stays empty until the stream has reached it, then the fill follows real progress: it creeps from first paint, and at each step the page script reports (its modules loaded, scene modules loaded, Studio created, the scene file loaded) it eases on toward a point short of the next step and then drifts slowly on, so it keeps moving while the load waits and is full only when Studio is ready. Then the loading state stops taking input at once, the bar fills while the stream still pours (0.09 s), the stream shortens into the pot's lip and the sparks stop (0.08 s), the pot rights itself (0.1 s) and the loading state fades out (0.1 s), 0.37 s in all. A load that is ready before the stream has reached the bar waits for it first. With reduced motion the pot and stream stand still and the bar and the fade take 0.3 s. The setup opens only after Studio is ready and its first frame has painted, so it appears over the drawn app. When the page fails to start, the loading state turns into the error message with an icon.

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
- Studio asks for a file once and keeps the decoded result until `studio.dispose()`, so a reload of the watched file, undo and redo do not fetch again. A reload whose file differs from the open scene only by what scene operations can set (a node turned or moved, a light or the sun changed) is applied to the scene on screen, so the other parts and their textures stay. The z-fight search that ranks flush faces keeps its last result and searches only the triangles near a part that is new or moved, so adding a node to a scene of large scans takes milliseconds instead of seconds.
- `createStudio` still returns at once. When the recipe needs catalog files, Studio opens on the starting scene and swaps the recipe in when they have loaded; `studio.ready` settles then. Opening the scene is not an edit: nothing to undo, no unsaved mark.
- The unsaved mark follows every edit of the scene, camera rows, lens chips and view chips included. Orbiting, zooming and panning are navigation and do not set it. Picking a mesh while the Sun, a light or the camera is selected leaves the Look or Camera tab for the mesh's own tab (Material, or Object from the camera).
- Studio keeps the scene you are editing as a draft in the browser's `localStorage` (a moment after the edits pause; skipped when the recipe is above about 2 MB, which also drops the older draft). Save, New and Open clear it. When Studio starts and a draft differs from the scene that opened, a notice offers **Restore** (the draft comes back as one undo step) or **Discard**; the first edit made while it is on offer counts as carrying on with the current scene, so the notice closes and the draft follows the new work. A host with no storage gets no draft.
- `studio.loadExternalTextFile(text)`, the Open dialog and the recipe JSON dialog load catalog files the same way. `studio.openRecipe(recipe)` does it for a recipe object; `studio.loadRecipe(recipe)` stays synchronous and expects the files to be loaded already.
- A recipe with a light `bake` bakes at most once per load, and not at all when nothing the bake reads changed: the copy Studio builds on the side to learn the file's recipe skips the bake, and the bake it traced before is kept by content (see "What is reused" in `light-bake.md`). Moving a node or changing a material colour still traces again.
- Without the function a scene needs, the scene on screen stays as it was and the status line says which file is missing and which function to pass.
- A recipe with a boolean mesh edit (`"op": "boolean"`) loads the Manifold library first, in every one of those paths and for the recipe passed to `createStudio`, and only when a recipe needs it. Studio finds it with `import('manifold-3d')`, so install the optional peer `manifold-3d`. A host that serves it from elsewhere calls `setManifoldModuleLoader(() => import('/vendor/manifold.js'))` from `crucible/addons/agent-scene`, before opening the scene. When the library cannot load, the scene on screen stays as it was and the status line names the install command.
- Studio loads no Draco or KTX2 decoder. Serve a GLB that uses neither.

### Hooks

| Hook | Takes | Returns | Used for |
| --- | --- | --- | --- |
| `asset(id)` | the id in `node.asset.id` | GLB bytes | placed scans |
| `environment(reference)` | the id in `environment.hdri` | Radiance `.hdr` bytes | the sky |
| `look(reference)` | the id in `environment.look` | `.cube` text | the colour look |
| `image(id)` | an id in a material's `colorMap` (and the other map fields) | PNG, JPEG or WebP bytes | a colour image on an object |
| `store({ kind, id, name, extension, bytes })` | a file the person imported | a promise | keeping it, so the read hook of that `kind` (`'asset'`, `'environment'` or `'image'`) returns the same bytes |
| `name(id)` | an id | the file name kept for it, or `null` | showing the file name instead of the short id |

### Import a file from disk

With a `store` hook (and `crypto.subtle`, which browsers give secure pages), the File menu has **Import…** and the viewport takes a dropped file. Studio tells the kind from the bytes, not the extension:

- a **GLB** is placed at the origin as a new node named after the file, and selected;
- a Radiance **.hdr** becomes the sky (`environment.hdri`); the World group shows it by the file name, or `Custom` and the first characters of the id when no name is known;
- a **PNG, JPEG or WebP** becomes the base colour image (`colorMap`) of the selected object's material, and that material's colour goes to white so the old tint does not stain the picture. A material shared with other objects changes for all of them, as it does in the Material tab. A picture needs UV coordinates, which sphere, box (bevelled or not), cylinder, cone, torus, plane, grid and unwrapped meshes have (a box, cylinder or cone gets them when the picture goes on); an icosphere or an unedited mesh has none, and the renderer would pause the viewport on it. So the import is refused when any object wearing the selected material lacks UVs, and the refusal names those objects. Give them their own material, or pick a geometry with UVs.

Studio names the file by the SHA-256 of its bytes (the id), decodes it, calls `store`, then changes the scene in one undo step. Everything that can be refused is refused before `store` runs, and a refusal leaves the scene, the undo history and the decoded files as they were. A `store` that rejects shows its message as written, so a host can say "Save the scene first". The recipe holds only the id; `name` is how a host gets the file name back when the scene reopens, since Studio only remembers names for the session.

Refused, each with a sentence that says what to do:

- a GLB over 64 MiB, a `.hdr` over 8 MiB, an image over 2048 pixels on a side or 64 MiB;
- a GLB that needs Draco or KTX2 (re-export without it, or add it through the MCP asset catalog, which converts it);
- a GLB or glTF JSON that points at separate `.bin` or image files (export one self-contained `.glb`);
- an image with nothing selected, or whose material takes a pattern or a map sequence;
- any other file type. A scene.json still opens with Open or a drop.

Without `store`, or without `crypto.subtle`, the Import row is hidden and a dropped binary file gets one sentence saying so. A web pack of a scene that places an imported GLB carries the decoded geometry and its colour, and one with an imported image on a material carries the decoded pixels. Only `crucible pack` on the command line refuses a material that holds a catalog image, because it cannot read the catalog; its message says to export the web pack from Studio.

The viewport draws a scene's volume fog and its post passes (see Post passes above). Render-only steps such as path tracing are not drawn in the viewport; they show in renders.

## Scenes with a large scan

An edit of a baked scene shows before its light bake is done (issue #3052; [light bake](https://crucible.codepawl.com/light-bake.md#an-edit-that-shows-before-its-bake-issue-3052)). `createStudioController` takes `bakeWhileSettling`: `'previous'` (the default) draws the last light on the parts the edit left alone, `'none'` draws no light until the bake lands, `'wait'` keeps the edit waiting for its bake. `controller.bakePending` tells the page a bake is out of date, and `controller.settleBake()` finishes it before a still or an export. The controller watches `scene.bakePending` with the same 32 ms timer as the flush search and calls `onChange` once with `{ kind: 'flush' }` when the bake lands. While a bake is pending Studio shows a small sun icon with the words Baking light under the status pill, announced once to screen readers, with its pulse off under `prefers-reduced-motion`; it goes when the bake lands.

An edit of a scene that holds 100,000 or more triangles to rank returns at once and ranks the near-coplanar faces right after, in slices of about 8 ms (see [the agent scene](agent-scene.md)). The viewport draws on demand, so the controller watches `scene.flushPending` with one 32 ms timer while a search waits, and when it ends the controller calls `onChange` once with `{ kind: 'flush' }`. Studio answers with one redraw and no panel update. Nothing is scheduled while no search waits, and `dispose()` and a change of scene stop the timer.

Parts that arrive after the renderer was built can need a shader feature its main program left out: the first duplicate of an object makes two parts share one batch, which needs the instanced code. The driver takes about 190 ms to link that program. A scheduled frame does not wait for it: the viewport keeps its last picture, Studio asks the driver every 8 ms whether the program is linked (`KHR_parallel_shader_compile`), and draws the waiting scene when it is. `renderNow()` and a still wait for the driver instead, because their caller reads the canvas. Only the main program is deferred this way; a program that a pass builds on its first draw still links inside that frame.

## See the agent at work

When an agent edits the scene, Studio shows a pointer with the agent's name, the way a collaborator's cursor shows in a shared document. The pointer travels to each object the agent changed, a dashed outline marks that object, and the status line says what changed ("Claude edited hero, orb").

- A reload of the watched file counts as an agent edit. `createStudio(container, { agentName: 'Claude' })` sets the name on the pointer; without it the name is "Agent".
- `studio.loadExternalTextFile(text, { agent })` takes `agent: { name }` to name the agent for one edit, `agent: true` to mark any load as an agent edit, and `agent: false` to load without the pointer.
- `studio.showAgentEdit({ name, nodeIds })` points at objects directly, for a host that hears about each agent step as it happens.

Each agent gets its own colour, picked from its name out of five brand colours, so two agents are easy to tell apart; the pointer, the name tag and the outline share it. The pointer glides between objects in about a third of a second and sits exactly on its object while you orbit, so it never trails it; a new target mid-glide turns from where the pointer stands. It visits at most eight objects for one edit, and with reduced motion it steps from object to object without gliding.

## Chat with an agent through the host

Some people want one window: type to the agent inside the app that shows Studio and watch it edit the scene. Studio ships no model client, no chat panel and no key handling, so this adds zero bytes to it. The app that embeds Studio (the host) owns the chat and the agent, and Studio shows the result. Keeping your own agent app beside Studio works as before.

A trial host proved the path with what Studio has today: a message typed in the app reached an agent command-line tool the person was already signed in to, the agent edited the open scene through the Crucible MCP server, and Studio showed each edit with the agent pointer about a second after it was made. The contract below comes from that trial and needs nothing new from Studio. The trial ran steps 1 and 3 to 7 and the rules for the agent. `stop` and steps 2, 8 and 9 are read from Studio's code and no host has run them yet.

### What the host owns

| Part | Rule |
|---|---|
| The chat panel | The host draws it outside the Studio container and styles it with the brand tokens. Studio has no slot for it yet. |
| The agent | The host starts and stops it. An agent command-line tool with the Crucible MCP server is one way; a model API called from the host is another. |
| Keys and tokens | They stay in the host's secure storage or in the agent tool's own sign-in. Never in the page, in browser storage or in the scene recipe. |
| The scene file | The host reads and writes it. The page never gets a file path it can open by itself. |

### Messages between the panel and the host

The panel talks to the host over whatever channel the host has (an IPC bridge in a desktop app). Three messages are enough:

| Message | Direction | Fields |
|---|---|---|
| `send` | panel to host | `prompt`, a string. The host answers `{ started: true }`, or `{ started: false, reason }` when a run is in progress or no scene file is open. One run at a time. |
| `stop` | panel to host | None. The host ends the run and every process it started for it. Edits already made stay in the scene. |
| `event` | host to panel | `{ kind: 'text', text }` for each piece of the reply, `{ kind: 'step', toolName }` when the agent calls a tool, `{ kind: 'scene-written', toolName }` after an edit is in the scene file, `{ kind: 'done', failed, seconds }` and `{ kind: 'error', text }`. |

The host accepts `send` and `stop` only from its own page, and passes the prompt to the agent as one argument, never through a shell.

### One run, step by step

1. **Wait for the scene.** `studio.ready` covers the recipe passed to `createStudio`. A page that opens the scene file afterwards (from a URL or a dialog) must wait for that load too. Start a run only when the file name shows in the top bar, or `studio.exportRecipe()` lists the scene's nodes.
2. **Put the person's edits in the file.** The agent opens the scene from the file, so unsaved edits in Studio are not in it. Before a run the host writes `studio.exportRecipe()` to the file, or refuses to start while the scene is dirty (`onDirtyChange` reports it). A load of the agent's edit replaces what is on screen without asking, and an edit the person makes during a run never reaches the agent's session, so the host locks editing while a run is in progress or tells the person their edits will be replaced.
3. **Open the file in the agent's session before the agent's first tool call**, so the agent edits the open scene and does not build a new one. With the MCP server this is one `scene_create` call with the file's recipe. A request the host adds to the agent's session carries the same `_meta` envelope as the agent client's own requests, or the server refuses it.
4. **Write the exported form once.** The recipe the session exports spells out defaults a hand-written file leaves out, so the first export differs from the file in every node. Write it to the file once at open and load it with `agent: false`. After that, each step differs by what the agent changed.
5. **After each tool call that changes the scene, export and write the file before the agent sees the tool's answer.** The MCP server keeps the scene in memory and writes no file; `scene_export_recipe` returns the recipe. The tools that change the scene return a new revision: `scene_create`, `scene_create_asset`, `scene_apply`, `scene_restore`, `mesh_edit` and `mesh_stack`. Write the file in one move (a temporary file, then a rename).
6. **Show the step.** Call `studio.loadExternalTextFile(text, { agent: true, filePath, fileName })` with the text just written. Studio finds what changed, moves the pointer there and announces it ("Agent edited cushion"). Pass the same `filePath` and `fileName` on every load: a load without `filePath` clears the watched file, the green dot and the Save target. Pass `agent: { name }` to name the agent.
7. **One load at a time, in the order written.** Await each load before the next. Two edits can be written closer together than one load takes.
8. **Respect a paused reload.** While `studio.shouldAutoReloadExternal()` is false, keep the newest text and ask again on a timer: Studio sends no event when the person turns reload back on.
9. **Report a load that fails.** `loadExternalTextFile` rejects when the recipe cannot be loaded, and the scene on screen stays what it was. Send the message to the panel as an `error` event.

`studio.showAgentEdit({ name, nodeIds })` points at objects without a load, for a host that already applied the change another way.

### Keep the agent to the scene

An agent command-line tool started by the host should see only the scene tools:

- Start it in an empty folder, with only the Crucible MCP server configured and its built-in file and shell tools off.
- Do not load the person's own instructions or settings for that tool into the run. They change how the agent talks and what it may do.
- Tell it in the first line of the prompt that the scene is already open and that it should not create a new one.
- Small edits, one visible change each, give the person a pointer per step.

## Diagnostics

Studio keeps a short list of what went wrong or ran slow, so a bug report can come with facts. The list lives in memory (the last 200 entries) and goes nowhere on its own: Studio makes no network call and does no work for it while the scene is idle.

Recorded:

- `error` and `rejection`: an uncaught error or an unhandled promise rejection on the page, with its name, message and stack.
- `contextLost` and `contextRestored`: the graphics context going away and coming back.
- `longTask`: a stretch of 50 ms or more that blocked the page, where the browser reports it.
- `slowOperation`: an add, duplicate, paste, delete, undo, redo, recipe load or change that took 100 ms or longer, with its name, duration and the scene's size.

Never recorded: the recipe, node, material or file names, paths and keys. A scene is described by numbers only (`nodes`, `triangles`). Messages are cut to 300 characters, stacks to 2,000, and a URL or path in either keeps only its last segment. An error message from validation can still name an id, so read a report before you share it.

To save the report, open **Help** and choose **Save diagnostics report**. It downloads `crucible-studio-diagnostics.json`: the Crucible version, the browser, the graphics vendor and renderer when the browser exposes them, the viewport size and pixel ratio, the scene size, a count per kind and the entries, oldest first.

```js
const studio = createStudio(container, {
  diagnostics: { limit: 200, slowOperationMilliseconds: 100 }, // both optional
  onDiagnostic: entry => hostLog.write(entry), // each entry as it is recorded; a throwing hook is ignored
});

studio.diagnostics.report(); // the same object the menu saves
studio.diagnostics.entries(); // a copy of the entries
```

Entries are recorded only while the Studio exists: `dispose()` removes every listener.

## Headless controller for tools and tests

Import `createStudioController` to drive picking, gizmo drags, surface snapping, look edits and camera bookmarks without DOM rendering.

```js
import { createAgentScene } from 'crucible/addons/agent-scene';
import { createStudioController } from 'crucible/addons/studio';

const scene = createAgentScene(recipe);
const controller = createStudioController({ scene, viewportWidth: 960, viewportHeight: 540 });

controller.pickAt(480, 270);
controller.pickAt(300, 200, { mode: 'toggle' }); // adds the object there, or takes it out
controller.saveBookmark('Front');
controller.setSunAngles({ azimuthDegrees: -40, elevationDegrees: 52 });
```

The selection is an ordered set of node ids and one active id. `controller.selectedNodeId` is the active id (or `null`), `controller.selectedNodeIds` a copy of the set, and `controller.selectNode(id)` still replaces the selection with one node. `controller.selectNodes(ids, { mode, active })` changes the set: `mode` is `'replace'` (the default), `'add'`, `'toggle'` or `'remove'`, and `active` names the active node, which must be selected afterwards. Without `active`, the last node that joined becomes active; when none joined, the current active node stays active if it is still selected, and otherwise the last node left in the set is. The options argument may be left out or `null`; any other value that is not an object throws a `TypeError`. `controller.selectAll()` and `controller.invertSelection()` skip hidden nodes, and `controller.selectionRoots()` lists the selected nodes that have no selected ancestor, which is what a move or a delete has to act on so that a child is not handled twice. `controller.pickAt(x, y, { mode })` takes the same modes. A light or the camera is never selected together with nodes. A node that is deleted, or that an undo removes, leaves the set, and an undo step restores the set and the active node. `onChange` details carry `selectedNodeIds` beside `selectedNodeId`.

The object `createStudio` returns has the same calls for a host page: `studio.selectNodes(ids, { mode, active })` and `studio.selectAll()` and `studio.invertSelection()` work as on the controller and return the selected ids, and `studio.selectedNodeIds` is a copy of the selected ids in the order they joined.

`controller.gizmoHandles()` returns the pivot, the object's world axes (`basis`) and the screen points of each handle. `controller.selectionSilhouette()` returns the selected object's triangles on screen as a flat list of x, y pairs (six numbers a triangle), which the viewport fills and outlines, and `null` above 8,000 triangles; `controller.selectionMaskSource()` returns the parts of such a dense selection with the matrix that projects each one, for the mask canvas; `controller.selectionOutline()` returns the hull polygon around it. The silhouette and the hull return `null` when nothing is selected or part of the object is behind the camera. `controller.frameSelectionPose()` returns the camera that frames the selection without moving anything, and `controller.moveViewportCamera(patch)` moves the camera without an undo step.

## What Studio edits in the recipe

1. Viewport clicks and gizmo drags emit deterministic `set-node` updates on `translation`, `rotation` and `scale`, measured along the object's own axes.
2. Surface snap (`Snap` mode or Alt-click) raycasts against other scene parts and offsets the node along the surface normal.
3. Material and look controls update the active material, `environment` and `effects` sections directly. The Material tab has colour, roughness, metallic, clearcoat, clearcoat roughness, opacity, emission, glow colour and a Double sided switch.
4. Saved camera bookmarks read and write named shots in `recipe.timeline.shots`.
5. Every change exports cleanly with `exportRecipe()` so AI agents can continue from the same scene revision.

A menu opens with a short fade and a small grow from the corner nearest its trigger, about a tenth of a second, and leaves with an 80 ms fade; sliding the pointer from one top bar menu to the next switches at once. Icons lead the places a person looks first and stay off everything else: each property section title (beside its chevron), the basic shapes and the lights of the Add menu (each shape drawn as its silhouette), the dialog titles, and the notice under the top bar, whose mark has its own shape per outcome (a tick for done, a triangle for a warning, a crossed circle for an error, an "i" for information) in the status colour. List rows, fields, sliders and buttons that already have an icon gain none. The icons are decorative: the visible text stays the name. The notice under the top bar drops in a few pixels and leaves a little faster than it came, and a second message while one shows only swaps the text. All of it uses opacity, scale and translate, so it stays on the compositor, and with reduced motion only the fade remains.
