# Studio interaction forms

A feature has a form: the way a person reaches it. This page lists the form of every Studio feature and why that form fits, so a person looking for a feature knows where to look, and a new feature picks a form that matches the ones around it.

| Form | What it is | Studio example |
| --- | --- | --- |
| `tool` | Owns the pointer until another tool is chosen. | Select, Move, Rotate, Scale |
| `toggle` | A state that is on or off and that every tool obeys. | The grid, the panels |
| `mode` | Changes what the whole editor edits. | Object mode, edit mode, the vertex, edge and face select modes |
| `operator` | A one-shot command from a key or a menu, possibly with a held interactive phase. | Duplicate, Delete, Undo, G R S while held |
| `modifier` | A non-destructive step in a stack. | None in Studio yet; the scene recipe has the stack |
| `setting` | A stored choice from a menu. | The keymap, the navigation gizmo |
| `panel` | A place that shows properties. | Properties, Scene list, Timeline |

A cell with two forms joins them with ` + `, as in `tool + operator` for Move, which is a rail tool and a key.

## How to pick a form

Pick the form by how a person reaches the feature:

- A thing they keep doing with the pointer is a `tool`.
- A state they leave on while doing other things is a `toggle`.
- A different thing being edited is a `mode`.
- A single action is an `operator`, with a key and a menu entry.
- A choice they rarely change is a `setting`.
- A value they read or type is a `panel` field.

## How to write a row

- Name the feature, its form, where it lives and why that form fits.
- `Where` is a code or doc anchor. A row for a rail tool (`STUDIO_TOOLS` in `src/studio-templates.js`) carries its id there, such as `tool:translate`, and its form contains `tool`.
- `Reason` says in plain words why the form fits. It is never empty.
- Add or update the row in the same pull request that changes the feature. `tests/studio-interaction-forms.test.js` checks the rail tools, the form words and the reasons on every unit pass.

## Tools and transform

| Studio feature | Form | Where | Reason |
| --- | --- | --- | --- |
| Select | tool | `tool:select`, `src/studio-templates.js:1`, `src/studio-keymap.js:21` | The pointer picks objects until another tool is chosen. Q selects it and a plain click also picks, so one tool covers every pick. |
| Move | tool + operator | `tool:translate`, `src/studio-keymap.js:22`, `src/studio.js:1935`, `src/studio.js:4660` | The rail tool shows handles. The G key is the same action as an operator: it picks the object up under the pointer with no handle to aim at. |
| Rotate | tool + operator | `tool:rotate`, `src/studio-keymap.js:23` | Same as Move: handles from the tool, a held phase from the R key. |
| Scale | tool + operator | `tool:scale`, `src/studio-keymap.js:24` | Same as Move: handles from the tool, a held phase from the S key. |
| Snapping | toggle + setting | the magnet on the rail, Shift+Tab, `src/studio-snapping.js` | A state every transform obeys; the target (Increment, Vertex, Face) is a setting of that state. |
| Add primitive | operator | `src/studio.js:1375` | One action that drops a shape in at a default size. |
| Add menu | operator | `src/studio-keymap.js:26`, `src/studio-templates.js:5` | Shift+A and the rail button open the same menu of eight mesh shapes, 3D text and three lights. |
| Measure readout | panel | `src/studio.js:2064` | The size of the selected object is a value to read, so it sits in a panel and owns no pointer. |
| Axis lock | operator | `src/studio-keymap.js:65` | X, Y and Z are the held phase of G, R and S. The key locks to the object's own axis and the same key frees it. |

## Selecting, view and display

| Studio feature | Form | Where | Reason |
| --- | --- | --- | --- |
| Select all, none, invert | operator | `src/studio-keymap.js:32-35` | One action on the whole selection, in object mode. Hidden objects stay out of Select all and Invert. |
| Object mode and edit mode | mode | `src/studio-keymap.js:51`, `src/studio.js:4506` | Tab changes what the whole editor edits, so every tool and panel follows it. Works on a mesh or any shape of the Add menu, which Tab turns into a mesh. |
| Vertex, edge and face select | mode | `src/studio-keymap.js:59-61`, `src/studio.js:1952` | The pick kind changes what a click selects for the whole edit session. One at a time. |
| Click and Shift+click pick | tool | `src/studio-mesh-edit.js:198`, `src/studio.js:3514`, `src/studio.js:4374` | Part of the Select tool: Shift or Ctrl toggles an object and makes it active, and a click on empty space clears. |
| Hide and show all | operator | `src/studio-keymap.js:36-37`, `src/studio.js:1466`, `src/studio.js:3529` | H and Alt+H are single actions. Each Scene row also has an eye for one object. |
| Frame selected | operator | `src/studio-keymap.js:43` | One action on the camera, on F or period. |
| Orbit, pan, zoom | operator | `src/studio.js:4311`, `src/studio.js:4405` | The view moves while a drag or the wheel is held, and every tool keeps working. Left drag on empty space orbits too. |
| Front, right, top view | operator | `src/studio-keymap.js:44-46`, `src/studio.js:2036` | Each view is a single jump of the camera, from a key or a chip. |
| Perspective or orthographic | operator | `src/studio-keymap.js:47`, `src/studio.js:2043` | One switch of the projection, from a key or the pill on the viewport bar. |
| Navigation gizmo | setting | `src/studio.js:1188`, `src/studio.js:2056` | A stored choice made once in Settings, not a state a person flips while working. |
| Grid | toggle | `toggle:grid`, `src/studio.js:1976`, `src/studio.js:1505` | A state every tool obeys. The rail button, the View menu item and a Settings row show the same state. |
| Statistics readout | setting | `src/studio.js:1189`, `src/studio.js:2064` | The camera and size readout is a stored choice in Settings. |
| Show or hide the panels | toggle | `toggle:toggleDocks`, `src/studio.js:1975`, `src/studio-keymap.js:48` | A state of the layout. The rail button and the N key flip the same state. |
| Export workspace | mode | the Export tab, `src/studio.js`, `src/studio-export.js` | One action per export. The scene is read-only and navigation is off there, because the viewport shows exactly the saved shot. |

## Object mode operators

| Studio feature | Form | Where | Reason |
| --- | --- | --- | --- |
| Duplicate | operator | `src/studio-keymap.js:29`, `src/studio-controller.js:2392` | A single action on the selection. The copy shares the same geometry; edit mode gives it its own on entry (`src/studio-mesh-edit.js:245`). |
| Duplicate linked | operator | `src/studio-keymap.js:29`, `src/studio-controller.js:2392` | There is one duplicate command and it is the linked kind, so one key covers both. |
| Delete | operator | `src/studio-keymap.js:30` | A single action on the selection. It deletes at once and undo brings it back. |
| Clear location, rotation, scale | operator | `src/studio-keymap.js:38-40` | Three single actions, Alt+G, Alt+R and Alt+S. |
| Parent and clear parent | panel | `src/studio.js:2113`, `src/studio.js:2121` | A dropdown in the Object panel: parent is a value of the object, so it is edited where the other values are. |
| Rename | operator | F2, double click on a list row, one click on the file name; `src/studio-name-editor.js` | One action that turns the name into an edit field in place. |
| Copy and paste | operator | `src/studio-keymap.js:27-28` | Two single actions on the selection, Ctrl+C and Ctrl+V. |

## Edit mode

| Studio feature | Form | Where | Reason |
| --- | --- | --- | --- |
| Move picked vertices, edges and faces | tool | `src/studio-mesh-edit.js:562`, `src/studio.js:1943` | The Move tool shows handles on the pick and owns the pointer, the same tool as in object mode. At most 19 loose vertices at a time. |
| Proportional editing | toggle | `src/studio-proportional.js:36`, `src/studio.js:4706`, `src/studio-keymap.js:65` | A state the held move obeys: O or the rail button turns it on, a popover sets the falloff curve and size, and the wheel sets the size while a move is held. It is not a tool of its own. |

## Panels, animation and keys

| Studio feature | Form | Where | Reason |
| --- | --- | --- | --- |
| Scene list | panel | `src/studio.js:1806`, `src/studio.js:3522`, `src/studio.js:3529` | A tree by parent, an eye per row, a search filter and a right click menu. It shows what exists and picks it. |
| Properties | panel | `src/studio.js:2091`, `src/studio-properties.js` | Object, Material, Look and Camera tabs hold the values of the selection. |
| Materials | panel | `src/studio.js:1810`, `src/studio.js:2367` | A swatch dock beside the Scene list and a Material tab: a material is a value of an object, so it is picked and edited with the other values. |
| Auto keying | toggle | `src/studio.js:2450`, `src/studio-controller.js:2816` | A state that every edit obeys: while it is on, each change writes a keyframe. |
| Insert keyframe | operator | `src/studio-keymap.js:49` | One action on the selection, on I and K. |
| Timeline | panel | `src/studio.js:2452`, `src/studio-keymap.js:50` | A scrub bar in the bottom panel shows time. Play is a key, Space. |
| Undo and redo | operator | `src/studio-keymap.js:41-42`, `src/studio-controller.js:645` | Single actions, 32 steps deep. The rail buttons and Edit menu items call the same operator. |
| Keymap | setting | `src/studio-keymap.js:319` | A stored choice made once in Settings: the default keys or another keymap preset. |
| Keyboard shortcuts | panel | Help menu, the ? key; src/studio-help.js | A sheet to read, built from the active keymap. |
| Documentation | operator | Help menu | One action that opens the guide. |
| Settings | panel | Edit menu > Settings, Ctrl+, `src/studio-keymap.js:55` | One place for preferences, in sections with an icon each, so a person finds a choice by its section. |
| Motion | setting | `src/studio-preferences.js`, `src/studio-settings.js` | A stored choice made once: follow the system or reduce Studio's own motion. |
| Zoom direction | setting | `src/studio-preferences.js`, `src/studio-settings.js` | A stored choice made once for which way the wheel and a pinch zoom. |
| Account | panel | Settings > Account, `src/studio-account.js` | Shows who is signed in and the host's sign-in and sign-out actions in one section; Studio holds no token. |
| Keyboard settings | panel | Settings > Keyboard, `src/studio-keyboard-settings.js` | Every shortcut of the preset by area, a filter above, a warning on a clash and Reset shortcuts with a confirm that defaults to Keep; nothing leaves the panel until a key is chosen. |
| Each key binding | setting | Settings > Keyboard, `src/studio-key-overrides.js` | A stored choice per preset and action: click the key, press the new combination; Esc cancels, Backspace clears, Swap or Cancel settles a clash, the row's reset returns the preset key. |
| History | panel | `src/studio.js` (the History card in the right column), View > History, Edit > History | A log of the edits that stays on screen beside Properties: a viewer of a recording follows it downward, and the person editing steps back or forward from it. A tab of Properties would be swapped out when the selection changes tabs, so it is its own card, shown and hidden by a toggle. |
