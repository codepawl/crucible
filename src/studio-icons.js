// Stroke icons for Studio, drawn on a 24 unit grid. Each value is one SVG path.
export const STUDIO_ICON_PATHS = Object.freeze({
  select: 'M5 3l14 7-6 2.5L10.5 19z',
  translate: 'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3',
  rotate: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5',
  scale: 'M4 20V10M4 20h10M4 20L20 4M14 4h6v6',
  snap: 'M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4zM6 8h4M14 8h4',
  undo: 'M8 5L3 10l5 5M3 10h11a5.5 5.5 0 0 1 0 11h-3',
  redo: 'M16 5l5 5-5 5M21 10H10a5.5 5.5 0 0 0 0 11h3',
  add: 'M12 5v14M5 12h14',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z',
  eyeOff: 'M3 3l18 18M10.6 5.2A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.5 6.6C3.6 8.5 2 12 2 12s3.6 7 10 7c1.6 0 3-.4 4.3-1M9.9 9.9a3 3 0 0 0 4.2 4.2',
  export: 'M12 15V3M7 8l5-5 5 5M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4',
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M8 5v14M16 5v14',
  warning: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  keyframe: 'M12 3l7 9-7 9-7-9z',
  autoKey: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z',
  duplicate:'M9 9h11v11H9zM5 15H4V4h11v1',
  remove: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  frame: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  panels: 'M3 5h18v14H3zM9 5v14M5.5 9h1M5.5 12h1',
  minimize: 'M6 15l6-6 6 6',
  expand: 'M6 9l6 6 6-6',
  chevron: 'M9 6l6 6-6 6',
  grid: 'M4 4h16v16H4zM9.33 4v16M14.67 4v16M4 9.33h16M4 14.67h16',
  link: 'M9.5 14.5l5-5M11 6.5l1.2-1.2a4.2 4.2 0 0 1 6 6L17 12.5M13 17.5l-1.2 1.2a4.2 4.2 0 0 1-6-6L7 11.5',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4.2-4.2',
  scene: 'M12 4l8 4-8 4-8-4 8-4zM4 12l8 4 8-4M4 16l8 4 8-4',
  help: 'M9.5 9a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1 1-1.1 1.8M12 17h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  node: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  material: 'M12 3s6.5 6.4 6.5 11.2a6.5 6.5 0 0 1-13 0C5.5 9.4 12 3 12 3zM9 14.5a3 3 0 0 0 3 3',
  look: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M5 19l1.4-1.4M17.6 6.4L19 5',
  camera: 'M3 7h12v10H3zM15 10.5l6-3v9l-6-3z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  pointLight: 'M9 17h6M10 20h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  spotLight: 'M3.5 8.5l5-5 3 3-5 5zM12 8.5l9 2.5M12.5 12.5l6.5 6.5M8.5 12.5L11 21',
  areaLight: 'M4 4h16v5H4zM8 12v5M12 12v6M16 12v5',
  sphere: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12c0 1.9 4 3.5 9 3.5s9-1.6 9-3.5',
  cylinder: 'M5 6.5C5 4.6 8.1 3 12 3s7 1.6 7 3.5v11c0 1.9-3.1 3.5-7 3.5s-7-1.6-7-3.5zM5 6.5C5 8.4 8.1 10 12 10s7-1.6 7-3.5',
  cone: 'M12 3L4.5 17.5c0 1.9 3.4 3.5 7.5 3.5s7.5-1.6 7.5-3.5zM4.5 17.5c0-1.9 3.4-3.5 7.5-3.5s7.5 1.6 7.5 3.5',
  torus: 'M12 5c5.5 0 10 3.1 10 7s-4.5 7-10 7S2 15.9 2 12s4.5-7 10-7zM12 9c-3 0-5.5 1.3-5.5 3s2.5 3 5.5 3 5.5-1.3 5.5-3-2.5-3-5.5-3z',
  plane: 'M6.5 8h15l-4 8h-15z',
  group: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  open: 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  save: 'M5 3h11l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1zM8 3v5h7V3M8 21v-7h8v7',
  saveAs: 'M12 4v10M8 10l4 4 4-4M5 17v2h14v-2',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  image: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM4 16l4.5-4.5 4 4 2.5-2.5 5 5M15.5 8.5h.01',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9s1.3-6.4 3.8-9z',
  keyboard: 'M4 7h16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM7 10.5h.01M11 10.5h.01M15 10.5h.01M8 14h8',
  agent: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  check: 'M5 12.5l4.5 4.5L19 7',
  theme: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 3v18M12 7.5h4.5M12 12h6M12 16.5h4.5',
  speed: 'M4 17a8 8 0 1 1 16 0M12 17l4-5M12 17h.01',
  // Edit mode selection: the same square each time; what is picked is drawn on top of it (STUDIO_ICON_ACCENTS).
  meshVertex: 'M5 5h14v14H5z',
  meshEdge: 'M19 5v14H5V5z',
  meshFace: 'M5 19V5h14v14z',
  tierLight: 'M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z',
  tierBalanced: 'M4 4h4v4H4zM10 4h4v4h-4zM16 4h4v4h-4zM4 10h4v4H4zM10 10h4v4h-4zM16 10h4v4h-4zM4 16h4v4H4zM10 16h4v4h-4zM16 16h4v4h-4z',
  tierSharp: 'M4 4h16v16H4zM7.2 4v16M10.4 4v16M13.6 4v16M16.8 4v16M4 7.2h16M4 10.4h16M4 13.6h16M4 16.8h16',
  tierAutomatic: 'M4 12a8 8 0 0 1 14-5.3M20 4v4h-4M20 12a8 8 0 0 1-14 5.3M4 20v-4h4',
  handle: 'M7 7h10v10H7zM3 3h4v4H3zM17 3h4v4h-4zM3 17h4v4H3zM17 17h4v4h-4z',
  account: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4.5 20a7.5 7.5 0 0 1 15 0',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3M12 15v2',
  // Action buttons: signIn is a door with an arrow going in, signOut the same door on the other side with the arrow coming out.
  signIn: 'M10 4h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7M3 12h11M10.5 8l4 4-4 4',
  signOut: 'M14 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7M10 12h11M17 8l4 4-4 4',
  buyMore: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v8M8 12h8',
  card: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 10h18M7 15h3',
  reset: 'M4 12a8 8 0 1 0 2.3-5.7L4 8.5M4 4v4.5h4.5',
  chat: 'M4 5h16v11h-9l-4.5 4v-4H4zM8 9.5h8M8 12.5h5',
  // Action buttons: reload turns clockwise, reset (put back) the other way, signIn is a door with an arrow going in.
  reload: 'M20 12a8 8 0 1 1-2.3-5.7L20 8.5M20 4v4.5h-4.5',
  reset: 'M4 12a8 8 0 1 0 2.3-5.7L4 8.5M4 4v4.5h4.5',
  signIn: 'M10 4h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7M3 12h11M10.5 8l4 4-4 4',
  // Silhouettes of the add menu shapes, and the marks of property sections and notices, drawn to stay readable at 16 px.
  box: 'M4 9l3-5h13v11l-3 5H4zM4 9h13l3-5M17 9v11',
  icoSphere: 'M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9zM12 7.5l4.5 7.5h-9z',
  disc: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  angle: 'M4 20h16M4 20L18 7M10 20a6 6 0 0 0-1.8-4.3',
  shadow: 'M9 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM9 18c0-1.4 2.7-2.5 6-2.5s6 1.1 6 2.5-2.7 2.5-6 2.5-6-1.1-6-2.5z',
  depthOfField: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M12 10.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z',
  fog: 'M6 15h12a3.5 3.5 0 0 0 0-7 4.5 4.5 0 0 0-8.5-1A4 4 0 0 0 6 15zM5 19.5h3M10.5 19.5h3M16 19.5h3',
  film: 'M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 3v18M16 3v18M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4',
  error: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.4 9.5l1.1-1.1L12 10.9l2.5-2.5 1.1 1.1L13.1 12l2.5 2.5-1.1 1.1L12 13.1l-2.5 2.5-1.1-1.1L10.9 12z',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01',
  // Brand marks, the official glyphs from Simple Icons (CC0), unaltered. They are filled shapes, not strokes.
  brandBlender: 'M12.51 13.214c.046-.8.438-1.506 1.03-2.006a3.424 3.424 0 0 1 2.212-.79c.85 0 1.631.3 2.211.79.592.5.983 1.206 1.028 2.005.045.823-.285 1.586-.865 2.153a3.389 3.389 0 0 1-2.374.938 3.393 3.393 0 0 1-2.376-.938c-.58-.567-.91-1.33-.865-2.152M7.35 14.831c.006.314.106.922.256 1.398a7.372 7.372 0 0 0 1.593 2.757 8.227 8.227 0 0 0 2.787 2.001 8.947 8.947 0 0 0 3.66.76 8.964 8.964 0 0 0 3.657-.772 8.285 8.285 0 0 0 2.785-2.01 7.428 7.428 0 0 0 1.592-2.762 6.964 6.964 0 0 0 .25-3.074 7.123 7.123 0 0 0-1.016-2.779 7.764 7.764 0 0 0-1.852-2.043h.002L13.566 2.55l-.02-.015c-.492-.378-1.319-.376-1.86.002-.547.382-.609 1.015-.123 1.415l-.001.001 3.126 2.543-9.53.01h-.013c-.788.001-1.545.518-1.695 1.172-.154.665.38 1.217 1.2 1.22V8.9l4.83-.01-8.62 6.617-.034.025c-.813.622-1.075 1.658-.563 2.313.52.667 1.625.668 2.447.004L7.414 14s-.069.52-.063.831zm12.09 1.741c-.97.988-2.326 1.548-3.795 1.55-1.47.004-2.827-.552-3.797-1.538a4.51 4.51 0 0 1-1.036-1.622 4.282 4.282 0 0 1 .282-3.519 4.702 4.702 0 0 1 1.153-1.371c.942-.768 2.141-1.183 3.396-1.185 1.256-.002 2.455.41 3.398 1.175.48.391.87.854 1.152 1.367a4.28 4.28 0 0 1 .522 1.706 4.236 4.236 0 0 1-.239 1.811 4.54 4.54 0 0 1-1.035 1.626',
  brandMaya: 'M4.348 0 .69 2.203v16.875l3.657-2.203h17.297V1.219c0-.67-.551-1.219-1.22-1.219H4.349zm18.297 3.75v14.125H4.627l-1.943 1.17v3.736c0 .67.55 1.219 1.218 1.219H23.31V3.75h-.664zm-14.471.025h2.937l1.885 7.508 1.977-7.48-.012-.028h2.857v9.354h-2.216v-6.04l-1.565 6.026v.014h-2.203l-1.656-6.28v6.28H8.174V3.775zm1.33 14.762h1.18l1.068 3.543h-.902l-.217-.773H9.568l-.197.773h-.88l1.013-3.543zm1.918 0h.932l.648 1.494.643-1.494h.894l-1.113 2.133v1.41h-.887v-1.406l-1.117-2.137zm3.826 0h1.18l1.068 3.543h-.9l-.217-.773h-1.065l-.197.773h-.88l1.011-3.543zm-5.156.582-.362 1.53h.73l-.368-1.53zm5.744 0-.36 1.53h.73l-.37-1.53z',
  brandCinema4d: 'M12.052 0C5.394-.007-.003 5.412 0 11.976.003 18.654 5.475 23.981 11.978 24c6.535.02 12.057-5.306 12.022-11.998-.009-1.665-.53-5.371-1.84-5.276-1.98.145-2.159 4.12-2.377 5.407-.417 2.46-1.346 5.08-2.953 6.99-1.88 2.359-4.697 3.634-7.662 3.158-3.55-.564-5.893-3.278-6.68-5.201-.753-1.723-1.035-4.162-.07-6.324 1.16-2.766 3.734-4.632 6.28-5.584 2.006-.827 4.103-1.151 5.357-1.375 2.516-.5 2.855-1.463 2.814-2.149-.015-.252-.256-.724-.785-.943C15.03.269 13.268.001 12.052 0zm5.098 1.342c.139.398.088.85-.148 1.256-.325.56-.972 1.05-1.897 1.29-1.636.428-2.976.554-4.34.96-1.312.39-3.397 1.018-5.316 2.552-.268.842-.341 1.892-.369 2.662.15 5.014 4.557 8.884 9.17 8.682.853-.037 1.921-.261 2.912-.68a13.56 13.56 0 0 0 1.387-2.683l.002-.002v-.002c.424-1.03.606-1.836.8-2.793.32-1.565.202-2.88 1.012-4.758.251-.582.71-1.113 1.258-1.346.25-.105.522-.133.79-.072-.89-2.471-3.115-4.326-5.26-5.066z',
});

/**
 * Parts of an icon that need more than the thin outline: a solid corner dot (vertex), a side at double weight (edge) and a
 * tinted fill (face). `kind` becomes the class `crucible-studio-icon-<kind>` on an extra path over the outline.
 */
export const STUDIO_ICON_ACCENTS = Object.freeze({
  meshVertex: Object.freeze([Object.freeze({ kind: 'dot', path: 'M19 5h.01' })]),
  meshEdge: Object.freeze([Object.freeze({ kind: 'heavy', path: 'M5 5v14' }), Object.freeze({ kind: 'dot', path: 'M5 5h.01M5 19h.01' })]),
  meshFace: Object.freeze([Object.freeze({ kind: 'tint', path: 'M5 5h14v14H5z' })]),
});

export const STUDIO_BRAND_ICON_NAMES = Object.freeze(['brandBlender', 'brandMaya', 'brandCinema4d']);

// The add menu shows the basic shapes and the lights with a picture; a shape not listed here gets no icon.
export const STUDIO_PRIMITIVE_ICONS = Object.freeze({
  plane: 'plane',
  box: 'box',
  disc: 'disc',
  sphere: 'sphere',
  icoSphere: 'icoSphere',
  cylinder: 'cylinder',
  cone: 'cone',
  torus: 'torus',
  text: 'text',
});
export const STUDIO_LIGHT_ICONS = Object.freeze({ point: 'pointLight', spot: 'spotLight', area: 'areaLight' });
// One icon for each property section id of PROPERTY_SECTIONS.
export const STUDIO_PROPERTY_SECTION_ICONS = Object.freeze({
  light: 'pointLight',
  shape: 'angle',
  shadow: 'shadow',
  transform: 'translate',
  lens: 'camera',
  depthOfField: 'depthOfField',
  sun: 'sun',
  world: 'globe',
  atmosphere: 'fog',
  film: 'film',
  effects: 'agent',
  sceneShadow: 'shadow',
  quality: 'speed',
});
// The mark a status notice leads with; its shape differs per outcome.
export const STUDIO_NOTICE_ICONS = Object.freeze({ success: 'check', warning: 'warning', error: 'error', info: 'info' });

/**
 * The icon each main action button of a notice or dialog leads with. A dismissal (Close, Skip, Done, Back, Next) has none:
 * its text says it. Buttons that sit together never share an icon, and none repeats the icon of the title above it.
 */
export const STUDIO_ACTION_ICONS = Object.freeze({
  reload: 'reload',
  restoreDraft: 'reset',
  discardDraft: 'remove',
  loadFile: 'open',
  applyJson: 'check',
  resetSettings: 'reset',
  signIn: 'signIn',
  signedIn: 'chat',
  copyPrompt: 'duplicate',
  copied: 'check',
});

/** Puts an action's icon before the label of its button and marks the button; the label stays its accessible name. */
export function leadWithActionIcon(button, icon, iconName) {
  const label = button.ownerDocument.createElement('span');
  label.textContent = button.textContent;
  button.dataset.actionIcon = iconName;
  button.replaceChildren(icon, label);
  return button;
}

// Glyphs drawn as solid shapes with the mark cut out of them, so they show as a weight apart from the outlined set.
export const STUDIO_FILLED_ICON_NAMES = Object.freeze(['error']);

export const STUDIO_ICON_NAMES = Object.freeze(Object.keys(STUDIO_ICON_PATHS));

export function studioIconPath(name) {
  const path = STUDIO_ICON_PATHS[name];
  if (!path) {
    throw new RangeError(`Unknown Studio icon "${name}". Use one of: ${STUDIO_ICON_NAMES.join(', ')}.`);
  }
  return path;
}
