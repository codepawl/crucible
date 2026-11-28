// Styles of the light reach overlay (studio-light-reach-view.js). The overlay sits over the dark viewport in both themes,
// so like the sun ray it takes the accent and trace colours, with the trace edge as a thin halo under every line.
export const LIGHT_REACH_STYLE_ID = 'crucible-studio-light-reach-styles';
export const LIGHT_REACH_CSS = `
.crucible-studio-light-reach { pointer-events: none; }
.crucible-studio-light-reach-fill {
  fill: color-mix(in srgb, var(--studio-accent) 8%, transparent);
  stroke: none;
}
.crucible-studio-light-reach-line,
.crucible-studio-light-reach-handle-dot {
  filter: drop-shadow(0 0 1px var(--studio-trace-edge)) drop-shadow(0 0 1.5px var(--studio-trace-edge));
}
.crucible-studio-light-reach-line {
  fill: none;
  stroke: var(--studio-accent);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.crucible-studio-light-reach-line[data-role="sun"] { stroke-width: 2; }
.crucible-studio-light-reach-line[data-role="link"] { stroke: var(--studio-accent); stroke-width: 1.5; }
.crucible-studio-light-reach-line[data-role="faint"] { stroke: var(--studio-trace); stroke-width: 1; opacity: 0.3; filter: none; }
.crucible-studio-light-reach-handle-dot {
  fill: var(--studio-accent);
  stroke: var(--studio-trace-edge);
  stroke-width: 1.5;
  pointer-events: all;
  cursor: grab;
}
.crucible-studio-light-reach-hit {
  fill: transparent;
  stroke: transparent;
  stroke-width: 14;
  pointer-events: all;
  cursor: grab;
}
`;

/** Adds the light reach overlay rules to the page once. */
export function ensureLightReachStyles(documentReference) {
  if (!documentReference.head || documentReference.getElementById(LIGHT_REACH_STYLE_ID)) {
    return;
  }
  const style = documentReference.createElement('style');
  style.id = LIGHT_REACH_STYLE_ID;
  style.textContent = LIGHT_REACH_CSS;
  documentReference.head.append(style);
}
