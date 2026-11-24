# Studio and Blender: what matches and what is missing

Blender is the reference for how a person models. This page compares the flows a modeller uses every day in Blender with what Studio does today, and lists the gaps in the order they will be closed. It is the working list for Studio modelling work: when a gap closes, its row here changes in the same pull request.

Studio does not aim to copy all of Blender. It keeps the essential building blocks and the editing tools, and leaves ready-made content and expert-only tools out ([what Studio does not copy](#what-studio-does-not-copy)).

## Interaction forms

A feature is not only there or missing: it has a form, the way a person reaches it. Blender puts snapping behind a toggle with a target menu, so a person who knows Blender looks for a toggle. A Studio feature that Blender has takes the same form as in Blender. When Studio uses a different form, the row says why.

| Form | What it is | Blender example |
| --- | --- | --- |
| `tool` | Owns the pointer until another tool is chosen. | Tweak, Box Select, Measure |
| `toggle` | A state that is on or off and that tools obey. | Snapping, Proportional Editing, Auto Merge |
| `mode` | Changes what the whole editor edits. | Object mode, Edit mode, the vertex, edge and face select modes |
| `operator` | A one-shot command from a key or a menu, possibly with a held interactive phase. | G, R, S, Extrude, Merge, Undo |
| `modifier` | A non-destructive step in a stack. | Mirror, Subdivision Surface |
| `setting` | A stored choice from a menu. | Pivot Point, Transform Orientation, Viewport Shading |
| `panel` | A place that shows properties. | Properties editor, Adjust Last Operation, Timeline |

Two more words fill the two form columns when no form applies: `missing` in the Studio column (Studio has no way to do it), and `unconfirmed` in the Blender column (the manual page was not found or did not settle it; never guessed). A cell with two forms joins them with ` + `, as in `tool + operator` for Blender's Extrude, which is a toolbar tool and a key.

### The rule

- A feature Blender has takes the same form in Studio: every form Studio uses must be one that Blender uses too.
- A different form needs a written reason in the row's Note, starting with `Reason:`.
- A mismatch that is a known mistake, with no reason, starts its Note with `To fix:`. The row changes when the fix lands.
- A tool on the Studio tool rail (`STUDIO_TOOLS`) accepts only a matching form or a `Reason:`. `tests/studio-blender-parity.test.js` checks this on every unit pass.
- To write a row: find the Blender manual page, read its Reference block (Tool, Menu, Header, Shortcut, Panel), pick the form, then fill both columns. A row for a Studio rail tool carries its id in the Studio today cell, such as `tool:translate`, which is how the test finds it.

## Where Studio stands

Studio matches Blender well in object mode for one object at a time. The gap is almost all in edit mode and in the modifier stack. The scene recipe already holds most of the operations, so most gaps need Studio controls only, not new engine work.

## Parity table

Blender 5.3 manual, read 2026-11-24. Studio at commit `740d33d56`. Status words in the Studio today column: Has, Partial, Missing, Different. Every Blender link below was fetched on that date and resolved; a row marked `unconfirmed` has no page that settles its form.

### Tools and transform

| Blender feature (default key) | Blender form | Studio form | Studio today | Note |
| --- | --- | --- | --- | --- |
| [Tweak select and move](https://docs.blender.org/manual/en/latest/interface/selecting.html) (W, click) | tool | tool | `tool:select` Has. `src/studio-templates.js:1`, `src/studio-keymap.js:21` | Studio's Select tool is on Q and also clicks, so it plays Tweak and click select in one. |
| [Box, circle, lasso select](https://docs.blender.org/manual/en/latest/interface/selecting.html) (B, C, Ctrl+right drag) | tool + operator | missing | Missing. Search finds none | The object selecting page lists lasso as Ctrl+Alt+left drag; the interface page lists Ctrl+right drag. |
| [Cursor](https://docs.blender.org/manual/en/latest/editors/3dview/3d_cursor.html) (Shift+right click) | tool | missing | Missing. Search finds none | Studio leaves the 3D cursor out on purpose, see below. |
| [Move](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/transform/move.html) (G) | tool + operator | tool + operator | `tool:translate` Has. `src/studio-keymap.js:22`, rail at `src/studio.js:1935`, pick up at `src/studio.js:4660` | The key picks the object up under the pointer. Handles work too. |
| [Rotate](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/transform/move.html) (R) | tool + operator | tool + operator | `tool:rotate` Has. `src/studio-keymap.js:23` | Same as Move. |
| [Scale](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/transform/move.html) (S) | tool + operator | tool + operator | `tool:scale` Has. `src/studio-keymap.js:24` | Same as Move. |
| [Transform (combined) and Scale Cage](https://docs.blender.org/manual/en/latest/scene_layout/object/tools/toolbar.html) | tool | missing | Missing. Search finds none | The three single tools cover the daily use. |
| [Annotate](https://docs.blender.org/manual/en/latest/scene_layout/object/tools/toolbar.html) (D+drag) | tool | missing | Missing. Search finds none | Four toolbar entries: freehand, line, polygon, eraser. |
| [Measure](https://docs.blender.org/manual/en/latest/editors/3dview/toolbar/measure.html) (toolbar) | tool | panel | Different. `src/studio.js:2064` | The readout shows the selected object's size in metres. No ruler. To fix: a ruler that owns the pointer. |
| [Add primitive, interactive](https://docs.blender.org/manual/en/latest/scene_layout/object/tools/toolbar.html) (toolbar Add Cube and five more) | tool + operator | operator | Partial. `src/studio.js:1375` | A shape drops in at a default size; Blender lets the tool drag it to size. |
| [Add menu](https://docs.blender.org/manual/en/latest/modeling/meshes/primitives.html) (Shift+A) | operator | operator | Has. `src/studio-keymap.js:26`, `src/studio-templates.js:5` | Eight mesh shapes, 3D text and three lights. No empty, camera or curve entry. |
| [Snapping](https://docs.blender.org/manual/en/latest/editors/3dview/controls/snapping.html) (Shift+Tab toggle, hold Ctrl) | toggle + setting | toggle + setting | Partial. `src/studio-controller.js`, `src/studio-snapping.js`, `docs/studio.md` | A magnet on the rail (Shift+Tab) and a target menu: Increment, Vertex and Face. Ctrl flips it for one move, and move, rotate and scale share the state, by handle and by key. One target at a time, no edge target, and Vertex and Face snap only a free move, not one kept to an axis. In edit mode moves obey the toggle and its Increment target; Vertex and Face leave an edit-mode move free. |
| [Proportional editing](https://docs.blender.org/manual/en/latest/editors/3dview/controls/proportional_editing.html) (O) | toggle + setting | missing | Missing in Studio | The recipe moves take a `falloff` with Blender's curves (`src/mesh-recipe.js:134`, `src/mesh-ops.js:459`). |
| [Pivot point](https://docs.blender.org/manual/en/latest/editors/3dview/controls/pivot_point/index.html) (Period) | setting | missing | Missing. `src/studio-mesh-edit.js:483` | The pivot is the object's origin, or the selection centre in edit mode. |
| [Transform orientation](https://docs.blender.org/manual/en/latest/editors/3dview/controls/orientation.html) (Comma) | setting | missing | Missing | Handles sit on the object's own axes. |
| [Axis constraint](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/transform/control/axis_locking.html) (X, Y, Z while G, R, S) | operator | operator | Different. `src/studio-keymap.js:65` | The held phase of an operator in both. Studio locks to the object's own axis and the same key frees it; Blender locks to the current transform orientation first. |
| [Plane constraint](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/transform/control/axis_locking.html) (Shift+X, Y, Z) | operator | missing | Missing. `src/studio-keymap.js:65` | The bindings ignore Shift, so Shift+X acts as X. The handles do have plane squares. |
| [Numeric input](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/transform/control/numeric_input.html) (G X 2, Tab for the next axis) | operator | missing | Missing. `docs/studio.md` says so | Held phase of G, R, S. Numbers are typed in Properties instead. |
| [Auto merge](https://docs.blender.org/manual/en/latest/modeling/meshes/tools/tool_settings.html) (Options panel, edit mode) | toggle | missing | Missing | Welds vertices that land on each other while moving. |
| [Mirror axis X, Y, Z in edit mode](https://docs.blender.org/manual/en/latest/modeling/meshes/tools/tool_settings.html) (Options panel) | toggle | missing | Missing | Moves the mirrored vertex with the picked one. |

### Selecting, view and display

| Blender feature (default key) | Blender form | Studio form | Studio today | Note |
| --- | --- | --- | --- | --- |
| [Select all, none, invert](https://docs.blender.org/manual/en/latest/scene_layout/object/selecting.html) (A, Alt+A, Ctrl+I) | operator | operator | Has in object mode. `src/studio-keymap.js:32-35` | Hidden objects stay out of Select all and Invert. Esc still deselects. |
| [Object mode and edit mode](https://docs.blender.org/manual/en/latest/editors/3dview/modes.html) (Tab) | mode | mode | Partial. `src/studio-keymap.js:51`, `src/studio.js:4506` | A mesh, or any shape of the Add menu, which Tab turns into a mesh on the spot. A mesh with a modifier stack is still refused. |
| [Vertex, edge, face select modes](https://docs.blender.org/manual/en/latest/modeling/meshes/selecting/introduction.html) (1, 2, 3) | mode | mode | Has. `src/studio-keymap.js:59-61`, `src/studio.js:1952` | The manual calls it Select Mode in the header. One mode at a time here; Shift adds modes in Blender, Ctrl expands. |
| [Click and Shift+click pick](https://docs.blender.org/manual/en/latest/interface/selecting.html) | tool | tool | Has. `src/studio-mesh-edit.js:198`, `src/studio.js:3514`, `src/studio.js:4374` | Part of the Select tool. Shift+click or Ctrl+click toggles an object and makes it active; a click on empty space clears. |
| [Edge loop and ring select](https://docs.blender.org/manual/en/latest/modeling/meshes/selecting/loops.html) (Alt+click, Ctrl+Alt+click) | operator | missing | Missing | In no slice. |
| [Linked and shortest path](https://docs.blender.org/manual/en/latest/modeling/meshes/selecting/linked.html) (Ctrl+L, Ctrl+click) | operator | missing | Missing | In no slice. |
| [Grow and shrink](https://docs.blender.org/manual/en/latest/modeling/meshes/selecting/more_less.html) (Ctrl+Numpad plus, minus) | operator | missing | Missing | The recipe has a `grow` face rule (`docs/mesh.md`), but the live selection is Studio state. |
| [Local view](https://docs.blender.org/manual/en/latest/editors/3dview/navigate/local_view.html) (Numpad slash) | operator | missing | Missing. Search finds none | Isolates the selection to work on one part. |
| [Hide, show all, hide unselected](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/show_hide.html) (H, Alt+H, Shift+H) | operator | operator | Partial. `src/studio-keymap.js:36-37`, `src/studio.js:1466` | H and Alt+H work, and each Scene row has an eye (`src/studio.js:3529`). Hide unselected is missing. |
| [Frame selected](https://docs.blender.org/manual/en/latest/editors/3dview/navigate/navigation.html) (Numpad period) | operator | operator | Has. `src/studio-keymap.js:43` | F and period. |
| [Orbit, pan, zoom](https://docs.blender.org/manual/en/latest/editors/3dview/navigate/navigation.html) (middle drag, Shift+middle drag, wheel) | operator | operator | Has. `src/studio.js:4311`, `src/studio.js:4405` | Left drag on empty space orbits too, which Blender does not do. |
| [Front, right, top view](https://docs.blender.org/manual/en/latest/editors/3dview/navigate/viewpoint.html) (Numpad 1, 3, 7) | operator | operator | Has. `src/studio-keymap.js:44-46`, chips at `src/studio.js:2036` | Studio uses 1, 3, 7 and 5 for the projection switch. |
| Perspective or orthographic (Numpad 5) | unconfirmed | operator | Has. `src/studio-keymap.js:47`, pill at `src/studio.js:2043` | The viewpoint page lists the keypad views but no Reference block settles this one. |
| [Navigation gizmo](https://docs.blender.org/manual/en/latest/editors/3dview/display/gizmo.html) (header Gizmos) | toggle | setting | Different. `src/studio.js:1188`, `src/studio.js:2056` | The axis widget is switched in the Settings dialog, not on the viewport bar. To fix: a toggle on the bar. |
| [Overlays, master switch](https://docs.blender.org/manual/en/latest/editors/3dview/display/overlays.html) (header Overlays) | toggle | missing | Missing | One switch for every overlay; Studio has per-feature switches only. |
| [Grid overlay](https://docs.blender.org/manual/en/latest/editors/3dview/display/overlays.html) | toggle | toggle | `toggle:grid` Has. `src/studio.js:1976`, `src/studio.js:1505` | Rail button, View menu item and a Settings row. |
| [Axes overlay](https://docs.blender.org/manual/en/latest/editors/3dview/display/overlays.html) | toggle | missing | Missing | The ground lines are always drawn. |
| [Statistics overlay](https://docs.blender.org/manual/en/latest/editors/3dview/display/overlays.html) | toggle | setting | Different. `src/studio.js:1189`, `src/studio.js:2064` | The camera and size readout is a Settings row. To fix: with the viewport bar toggle for overlays. |
| [Show or hide the panels](https://docs.blender.org/manual/en/latest/editors/3dview/index.html) (N sidebar, T toolbar) | toggle | toggle | `toggle:toggleDocks` Has. `src/studio.js:1975`, `src/studio-keymap.js:48` | Rail button and the N key for Properties. Blender hides regions through the View menu. |
| [Viewport shading](https://docs.blender.org/manual/en/latest/editors/3dview/display/shading.html) (Z pie, Shift+Z wireframe) | setting + operator | missing | Missing. Search finds none | One shaded view. |
| [X-ray](https://docs.blender.org/manual/en/latest/editors/3dview/display/shading.html) (Alt+Z) | toggle | missing | Missing. Search finds none | Nothing lets a person see or pick through a mesh. |
| [3D cursor placement](https://docs.blender.org/manual/en/latest/editors/3dview/3d_cursor.html) (Shift+right click) | operator | missing | Missing | A new object lands on the ground beside the others. |

### Object mode operators

| Blender feature (default key) | Blender form | Studio form | Studio today | Note |
| --- | --- | --- | --- | --- |
| [Duplicate](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/duplicate.html) (Shift+D) | operator | operator | Different. `src/studio-keymap.js:29`, `src/studio-controller.js:2392` | The copy keeps the same geometry, like Blender's linked duplicate. Edit mode gives it its own geometry on entry (`src/studio-mesh-edit.js:245`). |
| [Duplicate linked](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/duplicate_linked.html) (Alt+D) | operator | operator | Different. Same code as above | There is one duplicate command, and it is the linked kind. |
| [Delete](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/delete.html) (X or Delete) | operator | operator | Has. `src/studio-keymap.js:30` | Deletes at once, with no confirm menu. |
| [Clear location, rotation, scale](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/clear.html) (Alt+G, Alt+R, Alt+S) | operator | operator | Has. `src/studio-keymap.js:38-40` | Same keys. |
| [Parent and clear parent](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/parent.html) (Ctrl+P, Alt+P) | operator | panel | Partial. `src/studio.js:2113`, `src/studio.js:2121` | A dropdown in the Object panel, no key. The world position is probably not kept (not verified by running). To fix: an operator on a key and a menu entry. |
| [Join](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/join.html) (Ctrl+J) | operator | missing | Missing. No join operation found in the scene or mesh code read | Needs engine work and multi-object selection. |
| [Separate](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/separate.html) (P, edit mode) | operator | missing | Missing. No operation found in the files read | Splits one mesh into two objects. |
| [Apply transforms](https://docs.blender.org/manual/en/latest/scene_layout/object/editing/apply.html) (Ctrl+A) | operator | missing | Missing. No action in `src/studio-keymap.js:21-62` | Whether existing operations can express it is not verified. |
| [Set origin](https://docs.blender.org/manual/en/latest/scene_layout/object/origin.html) (Object menu) | operator | missing | Missing | The pivot is always the object's own origin. |
| [Rename](https://docs.blender.org/manual/en/latest/editors/outliner/editing.html) (F2) | unconfirmed | panel | Different. `src/studio.js:3522` | A double click on a Scene row focuses the name field. No F2. The outliner page has no Reference block. |
| [Collections](https://docs.blender.org/manual/en/latest/scene_layout/collections/collections.html) (M, Ctrl+G) | operator + panel | missing | Missing. Search finds none | The Scene list shows the parent tree instead. |
| Copy and paste (Ctrl+C, Ctrl+V) | unconfirmed | operator | Has. `src/studio-keymap.js:27-28` | No manual page was read for these. |

### Edit mode

| Blender feature (default key) | Blender form | Studio form | Studio today | Note |
| --- | --- | --- | --- | --- |
| [Select all, none, invert](https://docs.blender.org/manual/en/latest/modeling/meshes/selecting/introduction.html) (A, Alt+A, Ctrl+I) | operator | missing | Missing. No action in the `mesh` context | Select all is in slice 5. Invert is in no slice. |
| [Box, circle, lasso](https://docs.blender.org/manual/en/latest/modeling/meshes/selecting/introduction.html) (B, C, Ctrl+right drag) | tool + operator | missing | Missing | Box select is in slice 5. Circle and lasso are in no slice. |
| [Move](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/transform/basic.html) (G) | tool + operator | tool | Partial. `src/studio-mesh-edit.js:562`, `src/studio.js:1943` | Handle drag only; the G key does nothing in edit mode. At most 19 loose vertices until PR #3278 lands. |
| [Rotate and scale](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/transform/basic.html) (R, S) | tool + operator | missing | Missing in Studio | The recipe has `transform_selection` (`src/mesh-operations.js:40`). Slice 5. |
| [Extrude](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/face/extrude_faces.html) (E) | tool + operator | missing | Missing in Studio | The recipe has `extrude_face_region`, `extrude_individual` and `extrude_edges` (`src/mesh-operations.js:33-34`, `:68`). Slice 6. The toolbar page lists five extrude tools. |
| [Inset](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/face/inset_faces.html) (I) | tool + operator | missing | Missing in Studio | The recipe has `inset_region` (`src/mesh-operations.js:35`). Slice 6. |
| [Bevel](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/edge/bevel.html) (Ctrl+B) | tool + operator | missing | Missing in Studio | The recipe has `bevel` (`src/mesh-operations.js:47`). Picked edges need the edge pair rule of PR #3278. Slice 6. |
| [Loop cut](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/edge/loopcut_slide.html) (Ctrl+R) | tool + operator | missing | Missing in Studio | The recipe has `loop_cut` (`src/mesh-operations.js:48`). Slice 6. |
| [Knife](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/knife_topology_tool.html) (K) | tool + operator | missing | Missing | The recipe has `knife_project` and `bisect_plane` (`src/mesh-operations.js:58`, `:62`), not a freehand knife. |
| [Bisect](https://docs.blender.org/manual/en/latest/modeling/meshes/tools/toolbar.html) (toolbar) | tool | missing | Missing | The recipe has `bisect_plane`. |
| [Poly build](https://docs.blender.org/manual/en/latest/modeling/meshes/tools/poly_build.html) (toolbar) | tool | missing | Missing | Used weekly at most. |
| [Spin](https://docs.blender.org/manual/en/latest/modeling/meshes/tools/spin.html) (toolbar) | tool | missing | Missing | Used weekly at most. |
| [Smooth and randomize vertices](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/transform/randomize.html) (Mesh, Transform menu) | tool + operator | missing | Missing | Smooth is a toolbar tool; the manual page for it was not found, so only Randomize is read. |
| [Edge slide](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/edge/edge_slide.html) (G twice) and [vertex slide](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/vertex/slide_vertices.html) (Shift+V) | tool + operator | missing | Missing | No slide operation in the recipe. |
| [Shrink and fatten, push and pull](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/transform/shrink-fatten.html) (Alt+S) | tool | missing | Missing | Toolbar entries; the operator key is unconfirmed. |
| [Shear](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/transform/shear.html) (Shift+Ctrl+Alt+S) | tool + operator | missing | Missing | Used weekly at most. |
| [Rip](https://docs.blender.org/manual/en/latest/modeling/meshes/tools/toolbar.html) (V) | tool | missing | Missing | Rip region and rip edge are toolbar entries. |
| [Merge](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/merge.html) (M) | operator | missing | Missing | The recipe has `merge_by_distance` with no selection (`src/mesh-operations.js:41`). Merging a picked set needs engine work. |
| [Delete and dissolve](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/delete.html) (X, Ctrl+X) | operator | missing | Missing in Studio. `src/studio-keymap.js:62` makes X do nothing | The recipe deletes faces only (`src/mesh-operations.js:37`) and dissolves faces, edges and vertices (`:54-56`). Delete is in slice 6. |
| [Fill](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/face/fill.html) (Alt+F) and [new face from vertices](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/vertex/make_face_edge.html) (F) | operator | missing | Missing | The recipe fills whole open loops with `fill_holes` and `grid_fill` (`src/mesh-operations.js:53`, `:61`). A face from picked vertices has no operation. |
| [Bridge edge loops](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/edge/bridge_edge_loops.html) (menu only) | operator | missing | Missing in Studio | The recipe has `bridge_edge_loops` (`src/mesh-operations.js:59`). |
| [Subdivide](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/edge/subdivide.html) (menu only) | operator | missing | Missing in Studio | The recipe has `subdivide_edges` and `subdivide` (`src/mesh-operations.js:52`, `:60`). |
| [Mirror](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/mirror.html) (Ctrl+M) and [Symmetrize](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/symmetrize.html) (menu only) | operator | missing | Missing in Studio | The recipe has `mirror` and `symmetrize` (`src/mesh-operations.js:44`, `:66`). |
| [Recalculate normals](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/mesh/normals.html) (Shift+N) | operator | missing | Missing | The recipe has `flip_normals` only (`src/mesh-operations.js:38`). |

### Modifiers, editors and animation

| Blender feature (default key) | Blender form | Studio form | Studio today | Note |
| --- | --- | --- | --- | --- |
| [Modifier stack](https://docs.blender.org/manual/en/latest/modeling/modifiers/introduction.html) (Properties, Modifiers tab) | modifier | missing | Missing in Studio. `src/studio.js:2091` has no such tab | The recipe has a stack of up to 16 nodes and a `set-mesh-stack` operation (`src/mesh-operations.js:92-93`). |
| [Subdivision surface](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/subdivision_surface.html) (Ctrl+1), [mirror](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/mirror.html), [array](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/array.html), [bevel](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/bevel.html), [solidify](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/solidify.html) | modifier | missing | Missing in Studio | All five are stack operations in the recipe (`src/mesh-operations.js:92`). |
| [Boolean modifier](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/booleans.html) | modifier | missing | Different. `src/mesh-operations.js:43` | In the recipe a boolean is an entry of the edit log, not a stack node. It needs the optional `manifold-3d` library (`docs/studio.md`). Studio shows no control for it. |
| [Outliner](https://docs.blender.org/manual/en/latest/editors/outliner/introduction.html) | panel | panel | Partial. `src/studio.js:1806`, `src/studio.js:3522`, `src/studio.js:3529` | A tree by parent, an eye per row, a search filter and a right click menu. No multi-select, no collections. |
| [Properties editor](https://docs.blender.org/manual/en/latest/editors/properties_editor.html) | panel | panel | Partial. `src/studio.js:2091`, `src/studio-properties.js` | Object, Material, Look and Camera tabs. No Modifiers tab and no shape settings such as segments. |
| [Materials](https://docs.blender.org/manual/en/latest/editors/properties_editor.html) (Properties, Material tab) | panel | panel | Has. `src/studio.js:1810`, `src/studio.js:2367` | A swatch dock beside the Scene list and a Material tab. |
| Auto keying (Timeline record button) | unconfirmed | toggle | Has. `src/studio.js:2450`, `src/studio-controller.js:2816` | The manual pages read for animation named no such button. |
| [Insert keyframe](https://docs.blender.org/manual/en/latest/animation/keyframes/introduction.html) (I) | unconfirmed | operator | Has. `src/studio-keymap.js:49` | Studio binds both I and K. |
| [Timeline playhead](https://docs.blender.org/manual/en/latest/editors/timeline.html) | panel | panel | Has. `src/studio.js:2452` | A scrub bar in the bottom panel. Play is on Space (`src/studio-keymap.js:50`). |
| [Undo and redo](https://docs.blender.org/manual/en/latest/interface/undo_redo.html) (Ctrl+Z, Shift+Ctrl+Z) | operator | operator | Has. `src/studio-keymap.js:41-42`, `src/studio-controller.js:645` | 32 steps. Rail buttons and Edit menu items call the same operator. |
| [Undo history](https://docs.blender.org/manual/en/latest/interface/undo_redo.html) (Edit menu) | operator | missing | Missing | No list of steps. |
| [Adjust last operation](https://docs.blender.org/manual/en/latest/interface/undo_redo.html) (Edit menu, F9) | panel | missing | Missing | No panel to tune the last action. |
| [Repeat last](https://docs.blender.org/manual/en/latest/interface/undo_redo.html) (Shift+R) | operator | missing | Missing | Repeats the last command on the new selection. |
| [Search menu](https://docs.blender.org/manual/en/latest/interface/controls/buttons/menus.html) (F3, Space in a menu) | operator | missing | Missing | The only search is the Scene list filter (`src/studio.js:1806`). |
| [Pie menus](https://docs.blender.org/manual/en/latest/interface/controls/buttons/menus.html) (Z, Period, Comma, Tab held) | operator | missing | Missing | Opened by a key; they hold operators and settings. Left out on purpose, see below. |
| Quick favourites (Q) | unconfirmed | missing | Missing | No manual page found by the paths tried. |
| Default keymap | unconfirmed | setting | Has. `src/studio-keymap.js:319` | Blender keys are the default, with Maya and Cinema 4D presets chosen in Settings. |

## Gaps, in order

Size: S is one small pull request, M is one pull request, L is several. A new mesh operation changes the agent tool schema, so it is never S.

| # | Gap | Priority | Why | Size | Recipe | Issue |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | Vertex and edge moves without the 19 limit | must | Moving a few loose vertices is the most common edit. | M | Engine, in PR #3278 | #3262, PR #3278 |
| 3 | Box select, select all, rotate and scale with axis lock, G R S keys in edit mode | must | Used in every edit session. | M to L | Supported, vertex and edge forms need #3278 | #3262 slice 5 |
| 4 | Extrude, inset, loop cut, bevel, delete | must | The five that turn a box into a shape. Each is a toolbar tool and a key in Blender. | M to L | Supported, picked edges need #3278 | #3262 slice 6 |
| 5 | Edit cost and the 64 entry cap | must | Every tool use spends one of 64 entries. | M | Engine | #3262 slice 3, cap is an owner call |
| 6 | Typed numbers and plane lock while holding | must | Exact sizes are daily work. | S to M | UI only | #3291 |
| 7 | Modifier panel for the daily five | must | Mirror and subdivision are how most models are built. | M | Supported | #3292 |
| 8 | Several objects selected at once | must | Select all, box select, join and parenting in object mode all need it. | L | UI only | #2816 |
| 9 | Loop, ring, linked, grow and shrink select | should | Loop select is the fastest way to pick a band. | M | UI only | #3293 |
| 10 | Select none, invert, circle select in edit mode | should | Small, and they complete slice 5. | S | UI only | #3294 |
| 11 | Dissolve, and merge of a picked set | should | Cleaning up topology. | M | Dissolve supported, merge needs engine work | #3295 |
| 12 | Proportional editing, as a toggle with a falloff setting | should | Soft shaping of organic forms. | S to M | Supported | #3296 |
| 13 | See and pick through the mesh, as an X-ray toggle | should | Without it, back faces cannot be box selected. | M | Viewport work | #3297 |
| 14 | Fill, bridge, subdivide, symmetrize as operators | should | Closing and joining shapes. | M | Supported, face from picked vertices is not | #3298 |
| 15 | Shape settings in Properties | should | Blender's adjust last operation after an add. | S to M | Supported | #3299 |
| 16 | Parent with a key, world position kept, drag in the Scene list | should | Grouping parts of a model. | M | UI only | #3300 |
| 17 | Apply transforms and set origin | should | Needed before mirror and bevel behave. | M | Not verified | #3301 |
| 18 | Join and separate | should | Splitting and merging parts. | L | Engine work | #3302 |
| 19 | Undo history list | could | The stack exists, only the list is missing. | S | UI only | `ROADMAP.md` idea |
| 20 | Snap to edges, and Vertex and Face targets in edit mode | could | Precise assembly. Object-mode Increment, Vertex and Face are done (#3342). | M | Engine query | #3342 |
| 21 | Pivot and orientation choice, as settings | could | Rotating about another point. | M | UI only | `ROADMAP.md` idea |
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
- **Material preview and rendered shading modes.** The viewport is already the real renderer. Only a see-through toggle is worth adding.
- **The rare transform tools.** Shear, bend, to sphere, spin and poly build are used weekly at most.
- **A text header of tool settings.** A tool is an icon on the rail and its fields sit in Properties, which keeps to the icon and text rule. This is about where a tool's own fields go, not about which form a feature takes: an operator such as fill or bridge has no rail icon and takes a key and a menu entry.
