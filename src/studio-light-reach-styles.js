// Styles of the light reach overlay (studio-light-reach-view.js). The overlay sits over the dark viewport in both themes,
// so like the sun ray it takes the accent and trace colours, with the trace edge as a thin halo under every line.
export const LIGHT_REACH_STYLE_ID = 'crucible-studio-light-reach-styles';
export const LIGHT_REACH_CSS = `
.crucible-studio-light-reach { pointer-events: none; }
.crucible-studio-light-reach-fill {
  fill: color-mix(in srgb, var(--studio-accent) 16%, transparent);
  stroke: none;
}
.crucible-studio-light-reach-line {
  fill: none;
  stroke: var(--studio-accent);
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 1px var(--studio-trace-edge));
}
.crucible-studio-light-reach-line[data-role="soft"] { stroke-dasharray: 4 4; opacity: 0.75; }
.crucible-studio-light-reach-line[data-role="source"] { stroke: var(--studio-trace); }
.crucible-studio-light-reach-line[data-role="link"] { stroke: var(--studio-trace); stroke-width: 1; opacity: 0.8; }
.crucible-studio-light-reach-line[data-role="faint"] { stroke: var(--studio-trace); stroke-width: 1; opacity: 0.45; }
`;

/** Adds the overlay's rules to the page once, so the shared Studio stylesheet does not grow while the look is being chosen. */
export function ensureLightReachStyles(documentReference) {
  if (!documentReference.head || documentReference.getElementById(LIGHT_REACH_STYLE_ID)) {
    return;
  }
  const style = documentReference.createElement('style');
  style.id = LIGHT_REACH_STYLE_ID;
  style.textContent = LIGHT_REACH_CSS;
  documentReference.head.append(style);
}
