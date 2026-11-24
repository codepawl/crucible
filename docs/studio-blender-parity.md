# Studio and Blender: what matches and what is missing

Blender is the reference for how a person models. This page compares the flows a modeller uses every day in Blender with what Studio does today, and lists the gaps in the order they will be closed. It is the working list for Studio modelling work: when a gap closes, its row here changes in the same pull request.

Studio does not aim to copy all of Blender. It keeps the essential building blocks and the editing tools, and leaves ready-made content and expert-only tools out ([what Studio does not copy](#what-studio-does-not-copy)).

## Where Studio stands

Studio matches Blender well in object mode for one object at a time. The gap is almost all in edit mode and in the modifier stack. The scene recipe already holds most of the operations, so most gaps need Studio controls only, not new engine work.

## Parity table

Blender 5.3 manual, read 2026-11-24. Studio at commit `71aa78ab5`. Status words: Has, Partial, Missing, Different.

### Object mode

| Blender feature (default key) | Studio today | Note |
| --- | --- | --- |
| [Add menu](https://docs.blender.org/manual/en/latest/modeling/meshes/primitives.html) (Shift+A) | Has. `src/studio-keymap.js:26`, `src/studio-templates.js:5` | Eight mesh shapes, 3D text and three lights. No empty, camera or curve entry. |
| [Click select, Shift+click adds](https://docs.blender.org/manual/en/latest/interface/selecting.html) | Has. `selectNodes` and `pickAt` in `src/studio-controller.js`, `finishPointer` in `src/studio.js` | Shift+click or Ctrl+click toggles an object and makes it active, a plain click replaces, a click on empty space clears. The panels follow the active object. |
| [Select all, none, invert](https://docs.blender.org/manual/en/latest/scene_layout/object/selecting.html) (A, Alt+A, Ctrl+I) | Has. `select.all`, `select.none` and `select.invert` in `src/studio-keymap.js` | Hidden objects stay out of Select all and Invert. Esc still deselects. |
| [Box, circle, lasso select](https://docs.blender.org/manual/en/latest/interface/selecting.html) (B, C, Ctrl+right drag) | Missing. Search finds none | The object selecting page lists lasso as Ctrl+Alt+left drag; the interface page lists Ctrl+right drag. |
| [Move, rotate, scale](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/transform/move.html) (G, R, S) | Has. `src/studio-keymap.js:22-24`, `src/studio.js:3880` | The key picks the object up under the pointer. Handles work too. |
| [Axis lock](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/transform/control/axis_locking.html) (X, Y, Z) | Different. `src/studio.js:3924`, `src/studio-controller.js:1127` | Studio locks to the object's own axis and the same key frees it. Blender locks to the current transform orientation first. |
| [Plane lock](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/transform/control/axis_locking.html) (Shift+X, Y, Z) | Missing. `src/studio-keymap.js:61-63` | The bindings ignore Shift, so Shift+X acts as X. The handles do have plane squares (`src/studio-controller.js:468`). |
| [Typed numbers](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/transform/control/numeric_input.html) (G X 2, Tab for the next axis) | Missing. `docs/studio.md:132` says so | Numbers are typed in Properties instead. |
| [Snap while transforming](https://docs.blender.org/manual/en/latest/editors/3dview/controls/snapping.html) (Shift+Tab, hold Ctrl) | Different. `src/studio-controller.js:1342`, `docs/studio.md:37` | Studio has a surface snap tool on T and step snap on Shift. No vertex, edge or grid targets. |
| [Duplicate](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/duplicate.html) (Shift+D) | Different. `src/studio-controller.js:2168` | The copy keeps the same geometry, like Blender's linked duplicate. Edit mode gives it its own geometry on entry (`src/studio-mesh-edit.js:245`). |
| [Duplicate linked](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/duplicate_linked.html) (Alt+D) | Different. Same code as above | There is one duplicate command, and it is the linked kind. |
| [Delete](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/delete.html) (X or Delete) | Has. `src/studio-keymap.js:30` | Deletes at once, with no confirm menu. |
| [Clear location, rotation, scale](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/clear.html) (Alt+G, Alt+R, Alt+S) | Has. `src/studio-keymap.js:34-36` | Same keys. |
| [Parent and clear parent](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/parent.html) (Ctrl+P, Alt+P) | Partial. `src/studio.js:1898`, `src/studio-controller.js:1802-1812` | A dropdown in the Object panel, no key. The world position is probably not kept (not verified by running). |
| [Join](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/join.html) (Ctrl+J) | Missing. No join operation found in the scene or mesh code read | Needs engine work and multi-object selection. |
| [Apply transforms](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/apply.html) (Ctrl+A) | Missing. No action in `src/studio-keymap.js:20-67` | Whether existing operations can express it is not verified. |
| [Set origin](https://docs.blender.org/manual/en/latest/scene_layout/object/origin.html) (Object menu) | Missing. `src/studio-controller.js:984` | The pivot is always the object's own origin. |
| [Hide, show all, hide unselected](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/show_hide.html) (H, Alt+H, Shift+H) | Partial. `src/studio-keymap.js:32-33`, `src/studio.js:1257` | H and Alt+H work. Hide unselected is missing. |
| [Collections](https://docs.blender.org/manual/en/latest/scene_layout/collections/collections.html) (M, Ctrl+G) | Missing. Search finds none | The Scene list shows the parent tree instead (`src/studio.js:938`). |
| [Rename](https://docs.blender.org/manual/en/latest/editors/outliner/editing.html) (F2) | Different. `src/studio.js:3294` | A double click on a Scene row focuses the name field. No F2. |
| [Front, right, top view](https://docs.blender.org/manual/en/latest/editors/3dview/navigate/viewpoint.html) (Numpad 1, 3, 7) | Has. `src/studio-keymap.js:40-43` | Studio uses 1, 3, 7 and 5 for the projection switch. |

### Edit mode

| Blender feature (default key) | Studio today | Note |
| --- | --- | --- |
| [Enter edit mode](https://docs.blender.org/manual/en/latest/editors/3dview/modes.html) (Tab) | Partial. `src/studio-keymap.js`, `src/studio-mesh-edit.js` | A mesh, or any shape of the Add menu, which Tab turns into a mesh on the spot. A mesh with a modifier stack is still refused (the cage of a stack is #3292's open part). |
| [Vertex, edge, face modes](https://docs.blender.org/manual/en/latest/modeling/meshes/selecting/introduction.html) (1, 2, 3) | Has. `src/studio-keymap.js:55-57` | One mode at a time. No Shift for several modes, no Ctrl to expand. |
| [Click and Shift+click pick](https://docs.blender.org/manual/en/latest/interface/selecting.html) | Has. `src/studio-mesh-edit.js:457`, `src/studio.js:4131` | Nearest vertex or edge, or the face under the pointer. |
| [Select all, none, invert](https://docs.blender.org/manual/en/latest/modeling/meshes/selecting/introduction.html) (A, Alt+A, Ctrl+I) | Missing. No action in the `mesh` context | Select all is in slice 5. Invert is in no slice. |
| [Box, circle, lasso](https://docs.blender.org/manual/en/latest/modeling/meshes/selecting/introduction.html) (B, C, Ctrl+right drag) | Missing | Box select is in slice 5. Circle and lasso are in no slice. |
| [Edge loop and ring](https://docs.blender.org/manual/en/latest/modeling/meshes/selecting/loops.html) (Alt+click, Ctrl+Alt+click) | Missing | In no slice. |
| [Linked and shortest path](https://docs.blender.org/manual/en/latest/modeling/meshes/selecting/linked.html) (Ctrl+L, Ctrl+click) | Missing | In no slice. |
| [Grow and shrink](https://docs.blender.org/manual/en/latest/modeling/meshes/selecting/more_less.html) (Ctrl+Numpad plus, minus) | Missing | The recipe has a `grow` face rule (`docs/mesh.md:128`), but the live selection is Studio state. |
| [Move](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/transform/basic.html) (G) | Partial. `src/studio-mesh-edit.js:527`, `src/studio.js:4307` | Handle drag only; the G key does nothing in edit mode. At most 19 loose vertices until PR #3278 lands. |
| [Rotate and scale](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/transform/basic.html) (R, S) | Missing in Studio | The recipe has `transform_selection` (`src/mesh-operations.js:40`). Slice 5. |
| [Extrude](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/face/extrude_faces.html) (E) | Missing in Studio | The recipe has `extrude_face_region`, `extrude_individual` and `extrude_edges` (`src/mesh-operations.js:33-34`, `:68`). Slice 6. |
| [Inset](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/face/inset_faces.html) (I) | Missing in Studio | The recipe has `inset_region` (`src/mesh-operations.js:35`). Slice 6. |
| [Bevel](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/edge/bevel.html) (Ctrl+B) | Missing in Studio | The recipe has `bevel` (`src/mesh-operations.js:47`). Picked edges need the edge pair rule of PR #3278. Slice 6. |
| [Loop cut](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/edge/loopcut_slide.html) (Ctrl+R) | Missing in Studio | The recipe has `loop_cut` (`src/mesh-operations.js:48`). Slice 6. |
| [Knife](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/knife_topology_tool.html) (K) | Missing | The recipe has `knife_project` and `bisect_plane` (`src/mesh-operations.js:58`, `:62`), not a freehand knife. |
| [Merge](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/merge.html) (M) | Missing | The recipe has `merge_by_distance` with no selection (`src/mesh-operations.js:41`). Merging a picked set needs engine work. |
| [Delete and dissolve](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/delete.html) (X, Ctrl+X) | Missing in Studio. `src/studio-keymap.js:58` makes X do nothing | The recipe deletes faces only (`src/mesh-operations.js:37`) and dissolves faces, edges and vertices (`:54-56`). Delete is in slice 6. |
| [Fill](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/face/fill.html) (Alt+F) and [new face from vertices](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/vertex/make_face_edge.html) (F) | Missing | The recipe fills whole open loops with `fill_holes` and `grid_fill` (`src/mesh-operations.js:53`, `:61`). A face from picked vertices has no operation. |
| [Bridge edge loops](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/edge/bridge_edge_loops.html) (menu only) | Missing in Studio | The recipe has `bridge_edge_loops` (`src/mesh-operations.js:59`). |
| [Subdivide](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/edge/subdivide.html) (menu only) | Missing in Studio | The recipe has `subdivide_edges` and `subdivide` (`src/mesh-operations.js:52`, `:60`). |
| [Mirror](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/mirror.html) (Ctrl+M) and [Symmetrize](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/symmetrize.html) (menu only) | Missing in Studio | The recipe has `mirror` and `symmetrize` (`src/mesh-operations.js:44`, `:66`). |
| [Proportional editing](https://docs.blender.org/manual/en/latest/editors/3dview/controls/proportional_editing.html) (O) | Missing in Studio | The recipe moves take a `falloff` with Blender's curves (`src/mesh-recipe.js:134`, `src/mesh-ops.js:459`). |
| [Snapping](https://docs.blender.org/manual/en/latest/editors/3dview/controls/snapping.html) (Shift+Tab) | Missing | No snap of any kind in edit mode. |
| [Pivot point](https://docs.blender.org/manual/en/latest/editors/3dview/controls/pivot_point/index.html) (Period) and [orientation](https://docs.blender.org/manual/en/latest/editors/3dview/controls/orientation.html) (Comma) | Missing. `src/studio-mesh-edit.js:483` | The handles sit at the centre of the selection, on the object's own axes. |
| [Edge slide](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/edge/edge_slide.html) (G twice) and [vertex slide](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/vertex/slide_vertices.html) (Shift+V) | Missing | No slide operation in the recipe. |
| [Recalculate normals](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/normals.html) (Shift+N) | Missing | The recipe has `flip_normals` only (`src/mesh-operations.js:38`). |
| [Separate](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/separate.html) (P) | Missing | No operation found in the files read. |

### Modifiers, editors and viewport

| Blender feature (default key) | Studio today | Note |
| --- | --- | --- |
| [Modifier stack](https://docs.blender.org/manual/en/latest/modeling/modifiers/introduction.html) (Properties, Modifiers tab) | Has. `src/studio-modifier-panel.js`, tab in `src/studio.js` | Form: modifier in Blender (a stack of collapsible blocks in the wrench tab of Properties) and modifier in Studio (the Modifiers tab of Properties, same blocks). Each block has a show-in-viewport switch, move up and down, Apply, Delete and a drag grip; Add Modifier is a menu above the stack. A shape becomes a mesh with its first modifier. The stack holds up to 16 nodes (`set-mesh-stack`, `src/mesh-operations.js:92-93`). |
| [Subdivision surface](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/subdivision_surface.html) (Ctrl+1), [mirror](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/mirror.html), [array](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/array.html), [bevel](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/bevel.html), [solidify](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/solidify.html) | Has. `MODIFIERS` in `src/studio-modifier-panel.js` | Form: modifier in both. The main fields of each: levels, mirror axis and merge distance, count and offsets, bevel width, segments and profile, solidify thickness, offset and even thickness. Crease, bevel edge rules and the other twenty-odd stack operations stay for agents. |
| [Boolean modifier](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/booleans.html) | Different. `src/mesh-operations.js:43` | In the recipe a boolean is an entry of the edit log, not a stack node. It needs the optional `manifold-3d` library (`docs/studio.md:232`). |
| [Outliner](https://docs.blender.org/manual/en/latest/editors/outliner/introduction.html) | Partial. `src/studio.js:938`, `:1635`, `:3276` | A tree by parent, an eye per row, a search filter and a right click menu. No multi-select, no collections. |
| [Properties editor](https://docs.blender.org/manual/en/latest/editors/properties_editor.html) | Partial. `src/studio.js:1876`, `src/studio-properties.js` | Object, Material, Look and Camera tabs. No Modifiers tab and no shape settings such as segments. |
| [Viewport shading](https://docs.blender.org/manual/en/latest/editors/3dview/display/shading.html) (Z, Shift+Z wireframe, Alt+Z X-ray) | Missing. Search finds none | One shaded view. Nothing lets a person see or pick through a mesh. |
| [Overlays](https://docs.blender.org/manual/en/latest/editors/3dview/display/overlays.html) | Partial. `src/studio.js:1289-1299`, `src/studio-viewport-aids.js` | Grid switch, axis widget, selection outline. No per-overlay switches. |
| [3D cursor](https://docs.blender.org/manual/en/latest/editors/3dview/3d_cursor.html) (Shift+right click) | Missing. Search finds none | A new object lands on the ground beside the others. |
| [Measure](https://docs.blender.org/manual/en/latest/editors/3dview/toolbar/measure.html) (toolbar) | Different. `src/studio.js:2637` | The readout shows the selected object's size in metres. No ruler. |
| [Undo and redo](https://docs.blender.org/manual/en/latest/interface/undo_redo.html) (Ctrl+Z, Shift+Ctrl+Z) | Has. `src/studio-keymap.js:37-38`, `src/studio-controller.js:637` | 32 steps. |
| [Undo history, adjust last operation, repeat last](https://docs.blender.org/manual/en/latest/interface/undo_redo.html) (Edit menu, F9, Shift+R) | Missing | No list of steps and no panel to tune the last action. |
| Default keymap | Has. `src/studio-keymap.js:313-317` | Blender keys are the default, with Maya and Cinema 4D presets. |

## Gaps, in order

Size: S is one small pull request, M is one pull request, L is several. A new mesh operation changes the agent tool schema, so it is never S.

| # | Gap | Priority | Why | Size | Recipe | Issue |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | Vertex and edge moves without the 19 limit | must | Moving a few loose vertices is the most common edit. | M | Engine, in PR #3278 | #3262, PR #3278 |
| 3 | Box select, select all, rotate and scale with axis lock, G R S keys in edit mode | must | Used in every edit session. | M to L | Supported, vertex and edge forms need #3278 | #3262 slice 5 |
| 4 | Extrude, inset, loop cut, bevel, delete | must | The five tools that turn a box into a shape. | M to L | Supported, picked edges need #3278 | #3262 slice 6 |
| 5 | Edit cost and the 64 entry cap | must | Every tool use spends one of 64 entries. | M | Engine | #3262 slice 3, cap is an owner call |
| 6 | Typed numbers and plane lock while holding | must | Exact sizes are daily work. | S to M | UI only | #3291 |
| 7 | Modifier panel for the daily five | must | Mirror and subdivision are how most models are built. | M | Done, except the edit-mode cage | #3292 |
| 8 | Several objects selected at once | must | Select all, box select, join and parenting in object mode all need it. | L | UI only | #2816 |
| 9 | Loop, ring, linked, grow and shrink select | should | Loop select is the fastest way to pick a band. | M | UI only | #3293 |
| 10 | Select none, invert, circle select in edit mode | should | Small, and they complete slice 5. | S | UI only | #3294 |
| 11 | Dissolve, and merge of a picked set | should | Cleaning up topology. | M | Dissolve supported, merge needs engine work | #3295 |
| 12 | Proportional editing | should | Soft shaping of organic forms. | S to M | Supported | #3296 |
| 13 | See and pick through the mesh | should | Without it, back faces cannot be box selected. | M | Viewport work | #3297 |
| 14 | Fill, bridge, subdivide, symmetrize as tools | should | Closing and joining shapes. | M | Supported, face from picked vertices is not | #3298 |
| 15 | Shape settings in Properties | should | Blender's adjust last operation after an add. | S to M | Supported | #3299 |
| 16 | Parent with a key, world position kept, drag in the Scene list | should | Grouping parts of a model. | M | UI only | #3300 |
| 17 | Apply transforms and set origin | should | Needed before mirror and bevel behave. | M | Not verified | #3301 |
| 18 | Join and separate | should | Splitting and merging parts. | L | Engine work | #3302 |
| 19 | Undo history list | could | The stack exists, only the list is missing. | S | UI only | `ROADMAP.md` idea |
| 20 | Snap to vertices, edges and grid | could | Precise assembly. | M | Engine query | `ROADMAP.md` idea |
| 21 | Pivot and orientation choice, global and local | could | Rotating about another point. | M | UI only | `ROADMAP.md` idea |
| 22 | Knife, edge slide, vertex slide, recalculate normals | could | Useful, each needs a new operation. | L | Engine work | `ROADMAP.md` idea |
| 23 | Ruler, hide unselected, lasso | could | Small comforts. | S each | UI only | `ROADMAP.md` idea |

Rows 1 to 5 belong to the edit mode work of #3262. Row 8 comes early in the order, right after rows 1 and 2, because the object mode rows for select all, box select, join and parent wait on it.

## What Studio does not copy

- **Collections and view layers.** The parent tree already groups objects, and the recipe has no collections.
- **The 3D cursor.** It is a known stumbling block for new users. The selection centre and the view centre cover its two daily uses.
- **Sculpt, paint and UV editing as interactive modes.** They are heavy for a web editor. The recipe operations stay available to agents.
- **A node editor for geometry.** Field expressions in the recipe serve agents; a node canvas is a second product.
- **The full modifier list.** The recipe has over thirty stack operations. Show the daily five and leave the rest to agents.
- **Ready-made content in the add menu.** The monkey, asset libraries and add-on objects break the essential blocks limit.
- **Splitting the window into editors.** Three fixed workspaces are simpler.
- **Pie menus and several selection modes at once.** They are expert speed-ups with a learning cost.
- **The knife's sub-modes.** If a knife ships, click to cut is enough; angle constraints and cut through can wait.
- **Material preview and rendered shading modes.** The viewport is already the real renderer. Only a see-through switch is worth adding.
- **The rare transform tools.** Shear, bend, to sphere, spin and poly build are used weekly at most.
- **A text header of tool settings.** A tool is an icon on the rail and its fields sit in Properties, which keeps to the icon and text rule.
