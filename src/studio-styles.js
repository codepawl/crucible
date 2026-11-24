import { SCRUB_THUMB_WIDTH } from './studio-timeline-keys.js';

// Studio is one full-bleed viewport with floating islands on top: the scene keeps the screen.
export const STUDIO_CSS = `
.crucible-studio {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  min-height: 480px;
  overflow: hidden;
  --studio-bg: var(--site-bg, #17161a);
  --studio-panel: var(--site-sidebar, #201f24);
  --studio-surface: var(--site-surface, #2a282d);
  --studio-text: var(--site-text, #f1f0ec);
  --studio-muted: var(--site-muted, #a09ea6);
  --studio-border: var(--site-border, #fefefd1f);
  --studio-accent: var(--site-focus, #fc9132);
  --studio-ok: #5fc48a;
  /* Drawn over the viewport, which is dark in both themes: these two do not follow the theme. */
  --studio-trace: #f1f0ec;
  --studio-trace-edge: #17161a;
  --studio-font: Inter, system-ui, sans-serif;
  --studio-font-heading: 'Plus Jakarta Sans', Inter, system-ui, sans-serif;
  --studio-font-mono: 'JetBrains Mono', ui-monospace, monospace;
  --studio-edge: 12px;
  /* The one spacing scale: every padding and gap in Studio is one of these steps (0 and a 2px hairline between touching controls aside). scripts/studio-layout-audit.mjs checks it. */
  --studio-space-4: 4px;
  --studio-space-8: 8px;
  --studio-space-12: 12px;
  --studio-space-16: 16px;
  --studio-space-24: 24px;
  --studio-top: 68px;
  --studio-rail: 44px;
  --studio-bar-clear: 54px;
  --studio-shadow: 0 10px 28px rgb(0 0 0 / 0.26);
  --studio-motion-quick: var(--site-motion-quick, 110ms);
  --studio-motion-base: var(--site-motion-base, 170ms);
  /* The agent pointer's glide to a new object (studio-agent-presence.js reads it); 0ms under reduced motion means it snaps. */
  --studio-motion-travel: 360ms;
  /* An opacity fade carries no movement, so reduced motion keeps it; the durations above go to 0ms there. */
  --studio-motion-fade: 100ms;
  /* A menu leaves with an opacity fade alone, which carries no movement, so reduced motion keeps it. */
  --studio-motion-exit: 80ms;
  --studio-ease-out: var(--site-ease-out, cubic-bezier(0.2, 0, 0, 1));
  background: var(--studio-bg);
  color: var(--studio-text);
  font-family: var(--studio-font);
  font-size: 12.5px;
  user-select: none;
}
/* A forced theme: the colours come from the tokens of site-tokens.css; the native controls and scrollbars follow the scheme. */
.crucible-studio[data-theme="light"] { color-scheme: light; }
.crucible-studio[data-theme="dark"] { color-scheme: dark; }
.crucible-studio * { box-sizing: border-box; }
.crucible-studio input,
.crucible-studio textarea { user-select: text; }

.crucible-studio button,
.crucible-studio select,
.crucible-studio input,
.crucible-studio textarea {
  font: inherit;
  color: inherit;
}

.crucible-studio button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-inline-size: 32px;
  min-block-size: 32px;
  padding: 4px 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
}
.crucible-studio button[data-icon] {
  inline-size: 32px;
  padding: 0;
  flex-shrink: 0;
}
.crucible-studio-icon[data-brand] {
  fill: currentColor;
  stroke: none;
}
.crucible-studio-icon {
  inline-size: 17px;
  block-size: 17px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.crucible-studio button[aria-pressed="true"] {
  background: color-mix(in srgb, var(--studio-text) 14%, transparent);
}
.crucible-studio button[aria-disabled="true"] {
  opacity: 0.35;
  cursor: not-allowed;
}
.crucible-studio :focus-visible {
  outline: 2px solid var(--studio-accent);
  outline-offset: 2px;
}
@media (hover: hover) {
  .crucible-studio button:not([aria-disabled="true"]):not([aria-pressed="true"]):hover {
    background: color-mix(in srgb, var(--studio-text) 8%, transparent);
  }
}
@media (prefers-reduced-motion: no-preference) {
  .crucible-studio button {
    transition: background var(--studio-motion-quick) var(--studio-ease-out), color var(--studio-motion-quick) var(--studio-ease-out), opacity var(--studio-motion-quick) var(--studio-ease-out);
  }
}
@media (prefers-reduced-motion: reduce) {
  .crucible-studio {
    --studio-motion-quick: 0ms;
    --studio-motion-base: 0ms;
    --studio-motion-travel: 0ms;
  }
}
@media (pointer: coarse) {
  .crucible-studio button {
    min-inline-size: 40px;
    min-block-size: 40px;
  }
  .crucible-studio button[data-icon] { inline-size: 40px; }
  .crucible-studio { --studio-rail: 52px; }
}

.crucible-studio-island {
  display: flex;
  align-items: center;
  /* The gap equals the inset the eye sees: 5px of padding plus the 1px border. */
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--studio-border);
  border-radius: 13px;
  background: var(--studio-panel);
  box-shadow: var(--studio-shadow);
  pointer-events: auto;
}

.crucible-studio-viewport {
  position: absolute;
  inset: 0;
  background: var(--studio-bg);
  overflow: hidden;
}
.crucible-studio-canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
  cursor: grab;
}
.crucible-studio-canvas:active { cursor: grabbing; }
.crucible-studio-gizmo {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
/* The cage of edit mode. A dark line with a light halo reads on every surface the viewport can show, in either theme; the far
   side of the mesh is the same line, quieter. The picked elements are the accent, drawn over the handles with a dark ring. */
.crucible-studio-gizmo :is(.crucible-studio-cage-halo, .crucible-studio-cage-edges, .crucible-studio-cage-edges-far, .crucible-studio-cage-vertices-halo, .crucible-studio-cage-vertices, .crucible-studio-cage-vertices-far, .crucible-studio-cage-selected-halo) {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.crucible-studio-gizmo .crucible-studio-cage-halo {
  stroke: var(--studio-trace);
  stroke-opacity: 0.9;
  stroke-width: 3.6;
}
.crucible-studio-gizmo .crucible-studio-cage-edges {
  stroke: var(--studio-trace-edge);
  stroke-width: 1.2;
}
.crucible-studio-gizmo .crucible-studio-cage-edges-far {
  stroke: var(--studio-trace-edge);
  stroke-opacity: 0.3;
  stroke-width: 1;
}
.crucible-studio-gizmo .crucible-studio-cage-vertices-halo {
  stroke: var(--studio-trace);
  stroke-opacity: 0.95;
  stroke-width: 8;
}
.crucible-studio-gizmo .crucible-studio-cage-vertices {
  stroke: var(--studio-trace-edge);
  stroke-width: 5;
}
.crucible-studio-gizmo .crucible-studio-cage-vertices-far {
  stroke: var(--studio-trace-edge);
  stroke-opacity: 0.3;
  stroke-width: 4;
}
.crucible-studio-gizmo .crucible-studio-cage-selected-halo {
  stroke: var(--studio-trace-edge);
  stroke-opacity: 0.7;
}
.crucible-studio-gizmo .crucible-studio-cage-selected-halo-vertex { stroke-width: 17; }
.crucible-studio-gizmo .crucible-studio-cage-selected-halo-edge { stroke-width: 7.5; }
.crucible-studio-gizmo .crucible-studio-cage-selected {
  fill: none;
  stroke: var(--studio-accent);
  stroke-linecap: round;
  stroke-linejoin: round;
}
.crucible-studio-gizmo .crucible-studio-cage-selected-vertex { stroke-width: 12; }
.crucible-studio-gizmo .crucible-studio-cage-selected-edge { stroke-width: 4; }
.crucible-studio-gizmo .crucible-studio-cage-selected-face {
  fill: color-mix(in srgb, var(--studio-accent) 46%, transparent);
  stroke-width: 2;
}
.crucible-studio-gizmo [data-gizmo-axis] {
  pointer-events: all;
  cursor: pointer;
}
/* The wide area that answers for a thin handle. It is never drawn, whatever the hover rules below give the handle. */
.crucible-studio-gizmo [data-gizmo-hit] {
  stroke: transparent !important;
  filter: none !important;
}
.crucible-studio-gizmo [data-gizmo-hit="line"] { stroke-width: 22px !important; }
.crucible-studio-gizmo [data-gizmo-hit="disc"] { stroke-width: 0 !important; }
.crucible-studio-gizmo [data-gizmo-hit="ring"] { pointer-events: stroke; }
.crucible-studio-gizmo [data-gizmo-ring] { pointer-events: none; }
.crucible-studio-gizmo[data-hover-axis="x"] [data-gizmo-axis="x"],
.crucible-studio-gizmo[data-hover-axis="y"] [data-gizmo-axis="y"],
.crucible-studio-gizmo[data-hover-axis="z"] [data-gizmo-axis="z"],
.crucible-studio-gizmo[data-hover-axis="xy"] [data-gizmo-axis="xy"],
.crucible-studio-gizmo[data-hover-axis="xz"] [data-gizmo-axis="xz"],
.crucible-studio-gizmo[data-hover-axis="yz"] [data-gizmo-axis="yz"],
.crucible-studio-gizmo[data-hover-axis="screen"] [data-gizmo-axis="screen"],
.crucible-studio-gizmo[data-hover-axis="uniform"] [data-gizmo-axis="uniform"],
.crucible-studio-gizmo[data-hover-axis="surface"] [data-gizmo-axis="surface"] {
  filter: brightness(1.1) saturate(1.35);
}
.crucible-studio-gizmo[data-hover-axis="x"] [data-gizmo-axis="x"]:is(line, polyline),
.crucible-studio-gizmo[data-hover-axis="y"] [data-gizmo-axis="y"]:is(line, polyline),
.crucible-studio-gizmo[data-hover-axis="z"] [data-gizmo-axis="z"]:is(line, polyline),
.crucible-studio-gizmo[data-hover-axis="xy"] [data-gizmo-axis="xy"]:is(line, polyline),
.crucible-studio-gizmo[data-hover-axis="xz"] [data-gizmo-axis="xz"]:is(line, polyline),
.crucible-studio-gizmo[data-hover-axis="yz"] [data-gizmo-axis="yz"]:is(line, polyline),
.crucible-studio-gizmo[data-hover-axis="screen"] [data-gizmo-axis="screen"]:is(line, polyline),
.crucible-studio-gizmo[data-hover-axis="uniform"] [data-gizmo-axis="uniform"]:is(line, polyline),
.crucible-studio-gizmo[data-hover-axis="surface"] [data-gizmo-axis="surface"]:is(line, polyline) {
  stroke-width: 5px;
}
.crucible-studio-gizmo[data-hover-axis="x"] [data-gizmo-axis="x"]:is(polygon, rect, circle),
.crucible-studio-gizmo[data-hover-axis="y"] [data-gizmo-axis="y"]:is(polygon, rect, circle),
.crucible-studio-gizmo[data-hover-axis="z"] [data-gizmo-axis="z"]:is(polygon, rect, circle),
.crucible-studio-gizmo[data-hover-axis="xy"] [data-gizmo-axis="xy"]:is(polygon, rect, circle),
.crucible-studio-gizmo[data-hover-axis="xz"] [data-gizmo-axis="xz"]:is(polygon, rect, circle),
.crucible-studio-gizmo[data-hover-axis="yz"] [data-gizmo-axis="yz"]:is(polygon, rect, circle),
.crucible-studio-gizmo[data-hover-axis="screen"] [data-gizmo-axis="screen"]:is(polygon, rect, circle),
.crucible-studio-gizmo[data-hover-axis="uniform"] [data-gizmo-axis="uniform"]:is(polygon, rect, circle),
.crucible-studio-gizmo[data-hover-axis="surface"] [data-gizmo-axis="surface"]:is(polygon, rect, circle) {
  stroke: var(--studio-trace);
  stroke-width: 4.5px;
  paint-order: stroke;
}
.crucible-studio-gizmo[data-hover-axis="xy"] [data-gizmo-axis="xy"],
.crucible-studio-gizmo[data-hover-axis="xz"] [data-gizmo-axis="xz"],
.crucible-studio-gizmo[data-hover-axis="yz"] [data-gizmo-axis="yz"] {
  fill-opacity: 0.6;
}

.crucible-studio-scene-mark {
  color: var(--studio-text);
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.crucible-studio-scene-mark[data-selected="true"] { color: var(--studio-accent); }
.crucible-studio-scene-mark-disc {
  fill: color-mix(in srgb, var(--studio-bg) 72%, transparent);
  stroke: none;
}
.crucible-studio-scene-mark-ray {
  stroke: var(--studio-text);
  stroke-width: 1.6;
  stroke-linecap: round;
  pointer-events: none;
}
.crucible-studio-scene-mark-ray[data-selected="true"] { stroke: var(--studio-accent); }
.crucible-studio-gizmo [data-scene-object] {
  pointer-events: all;
  cursor: pointer;
}
.crucible-studio-selection-silhouette {
  fill: #fff;
  stroke: none;
  pointer-events: none;
}
.crucible-studio-selection-mask {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.crucible-studio-mask-filters {
  position: absolute;
  width: 0;
  height: 0;
}
.crucible-studio-silhouette-colour {
  flood-color: var(--studio-accent);
}
/* Both layers use the full accent with a ring of the viewport's own dark outside it, so the outline reads on light and
   dark surfaces alike. The viewport is dark in both themes, so the ring takes the trace-edge dark and never the UI
   theme's --studio-bg, which would glow pale on the floor in the light theme. The active object's outline is the
   wider one (4 px against 2 px: the filters round the thin ring to 2 px, so 3 against 1.5 drew as 3 against 2). */
.crucible-studio-silhouette-casing {
  flood-color: var(--studio-trace-edge);
}
.crucible-studio-selection-outline {
  fill: none;
  stroke: var(--studio-accent);
  stroke-width: 4;
  stroke-linejoin: round;
  pointer-events: none;
}
.crucible-studio-selection-outline[data-layer="others"] {
  stroke-width: 2;
}
.crucible-studio-selection-outline-casing {
  fill: none;
  stroke: var(--studio-trace-edge);
  stroke-width: 6;
  stroke-linejoin: round;
  pointer-events: none;
}
.crucible-studio-selection-outline-casing[data-layer="others"] {
  stroke-width: 4;
}
/* The axis widget stands at the top right of the viewport, beside the panel column. Floating, that is left of the
   Scene card, level with its top and one edge gap from it; --studio-gizmo-clear is the room the cards take. */
.crucible-studio-view-widget {
  position: absolute;
  inset-inline-end: calc(var(--studio-edge) + var(--studio-gizmo-clear, 0px));
  inset-block-start: var(--studio-top);
  width: 76px;
  height: 76px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--studio-panel) 70%, transparent);
  user-select: none;
}
.crucible-studio-view-widget [data-view] { cursor: pointer; }
.crucible-studio-view-letter {
  fill: #17161a;
  font: 700 9.5px var(--studio-font);
  pointer-events: none;
}
.crucible-studio-readout {
  position: absolute;
  inset-inline-start: var(--studio-edge);
  inset-block-end: var(--studio-edge);
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: var(--studio-muted);
  font: 500 11.5px/1.45 var(--studio-font-mono);
  font-variant-numeric: tabular-nums;
  padding: 4px 8px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--studio-panel) 72%, transparent);
  pointer-events: none;
  user-select: none;
}
.crucible-studio-readout-selection { color: var(--studio-text); }
.crucible-studio-readout-selection:empty { display: none; }
.crucible-studio[data-compact="true"] .crucible-studio-readout { display: none; }
/* A compact window stacks the cards over the scene, so the widget keeps the top right corner under the bar. */
.crucible-studio[data-compact="true"] .crucible-studio-view-widget {
  inset-inline-end: var(--studio-edge);
}
.crucible-studio-agent-outline {
  fill: none;
  stroke-width: 2;
  stroke-dasharray: 5 4;
  stroke-linejoin: round;
  pointer-events: none;
}
.crucible-studio-agent-cursor {
  position: absolute;
  inset: 0 auto auto 0;
  translate: var(--studio-agent-x, 0px) var(--studio-agent-y, 0px);
  z-index: 3;
  display: flex;
  align-items: flex-start;
  pointer-events: none;
  color: var(--studio-accent);
}
.crucible-studio-agent-cursor[hidden] { display: none; }
.crucible-studio-agent-cursor svg {
  flex: none;
  width: 28px;
  height: 28px;
  fill: currentColor;
  stroke: var(--studio-bg);
  stroke-width: 1.2;
  stroke-linejoin: round;
}
.crucible-studio-agent-name {
  margin: 22px 0 0 -8px;
  padding: 4px 12px;
  border-radius: 5px 11px 11px 11px;
  color: #17161a;
  font: 700 12.5px/1.5 var(--studio-font);
  white-space: nowrap;
}
.crucible-studio-drop-overlay {
  position: absolute;
  inset: var(--studio-edge);
  display: none;
  place-items: center;
  border: 2px dashed color-mix(in srgb, var(--studio-text) 45%, transparent);
  border-radius: 13px;
  background: color-mix(in srgb, var(--studio-bg) 85%, transparent);
  color: var(--studio-text);
  font-family: var(--studio-font-heading);
  font-weight: 600;
  font-size: 15px;
  pointer-events: none;
  z-index: 8;
}
.crucible-studio-viewport[data-drop-active="true"] .crucible-studio-drop-overlay {
  display: grid;
}

/* Shown while the picture is paused (a lost graphics context or a frame that failed). It sits over the viewport, under the menu bar. */
.crucible-studio-paused,
.crucible-studio-draft {
  position: absolute;
  inset-block-start: var(--studio-top);
  inset-inline: calc(var(--studio-rail) + 2 * var(--studio-edge)) calc(var(--studio-side-width, 284px) + 2 * var(--studio-edge));
  inline-size: fit-content;
  max-inline-size: 520px;
  margin-inline: auto;
  gap: 8px;
  padding: 12px 12px;
  color: var(--studio-text);
  font-family: var(--studio-font);
  font-size: 13px;
  z-index: 9;
}
.crucible-studio[data-compact="true"] .crucible-studio-draft { inset-inline: var(--studio-edge); }
/* Docked, the viewport is already the room between the rail and the column, so the notice only keeps the edge gap. */
.crucible-studio[data-floating="false"]:not([data-compact="true"]) .crucible-studio-draft {
  inset-block-start: var(--studio-edge);
  inset-inline: var(--studio-edge);
}
.crucible-studio-paused[hidden],
.crucible-studio-draft[hidden] { display: none; }
.crucible-studio-paused p,
.crucible-studio-draft p { margin: 0; }
.crucible-studio-paused .crucible-studio-icon,
.crucible-studio-draft .crucible-studio-icon { flex: none; color: var(--studio-accent); }

/* Names each post pass the viewport cannot draw. It sits low and centred, above the hint pill and the readout, where the notices at the top never reach. */
.crucible-studio-pass-notice {
  position: absolute;
  inset-inline: calc(var(--studio-rail) + 2 * var(--studio-edge)) calc(var(--studio-side-width, 284px) + 2 * var(--studio-edge));
  inset-block-end: 170px;
  inline-size: fit-content;
  max-inline-size: 520px;
  margin-inline: auto;
  gap: 8px;
  padding: 12px 12px;
  color: var(--studio-text);
  font-family: var(--studio-font);
  font-size: 13px;
  z-index: 9;
}
.crucible-studio[data-compact="true"] .crucible-studio-pass-notice { inset-inline: var(--studio-edge); }
/* Docked, the viewport is already the room between the rail and the column, so the notice only keeps the edge gap. */
.crucible-studio[data-floating="false"]:not([data-compact="true"]) .crucible-studio-pass-notice { inset-inline: var(--studio-edge); }
.crucible-studio-pass-notice[hidden] { display: none; }
.crucible-studio-pass-notice p { margin: 0; text-wrap: balance; }
.crucible-studio-pass-notice .crucible-studio-icon { flex: none; color: var(--studio-accent); }

/* Shown while an edit's light bake runs. It sits under the status pill, the one place the viewport keeps for state, and does not take clicks. */
.crucible-studio-bake-mark {
  position: absolute;
  inset-inline-start: 50%;
  inset-block-start: calc(var(--studio-top) + 38px);
  transform: translateX(-50%);
  gap: 4px;
  padding: 8px 12px;
  border-radius: 15px;
  color: var(--studio-text);
  font-family: var(--studio-font);
  font-size: 12px;
  inline-size: max-content;
  pointer-events: none;
  z-index: 7;
}
.crucible-studio-bake-mark[hidden] { display: none; }
.crucible-studio-bake-mark .crucible-studio-icon { flex: none; color: var(--studio-accent); }
.crucible-studio[data-floating="false"]:not([data-compact="true"]) .crucible-studio-bake-mark { inset-block-start: calc(var(--studio-edge) + 38px); }
@media (prefers-reduced-motion: no-preference) {
  .crucible-studio-bake-mark .crucible-studio-icon { animation: crucible-studio-bake-pulse 1.6s ease-in-out infinite; }
  @keyframes crucible-studio-bake-pulse {
    50% { opacity: 0.45; }
  }
}

.crucible-studio-menubar {
  position: absolute;
  inset: var(--studio-edge) var(--studio-edge) auto;
  display: grid;
  grid-template-columns: minmax(max-content, 1fr) auto minmax(max-content, 1fr);
  align-items: center;
  gap: 8px;
  pointer-events: none;
  z-index: 6;
}
.crucible-studio-menubar > .crucible-studio-island:first-child { justify-self: start; }
.crucible-studio-menubar > .crucible-studio-spacer { display: none; }
.crucible-studio-menubar > .crucible-studio-spacer + .crucible-studio-island { justify-self: end; }
.crucible-studio[data-tight="true"] .crucible-studio-filepill { display: none; }
.crucible-studio[data-desktop="true"] .crucible-studio-menubar {
  -webkit-app-region: drag;
  pointer-events: auto;
  padding-inline-end: 146px;
}
.crucible-studio[data-desktop="true"] .crucible-studio-menubar button,
.crucible-studio[data-desktop="true"] .crucible-studio-menubar a,
.crucible-studio[data-desktop="true"] .crucible-studio-menubar [popover],
.crucible-studio[data-desktop="true"] .crucible-studio-menubar input {
  -webkit-app-region: no-drag;
}
.crucible-studio-brand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: 32px;
  block-size: 32px;
  border-radius: 8px;
  color: var(--studio-text);
}
.crucible-studio-brand svg {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
}
/* The mark's own colours, from the brand kit. On a dark panel the kit makes the body one step lighter. */
.crucible-studio-mark-body { fill: #393842; }
.crucible-studio-mark-shadow { fill: #2a282d; }
.crucible-studio[data-theme="dark"] .crucible-studio-mark-body { fill: #4f4e5a; }
.crucible-studio[data-theme="dark"] .crucible-studio-mark-shadow { fill: #3b3a44; }
@media (prefers-color-scheme: dark) {
  .crucible-studio:not([data-theme]) .crucible-studio-mark-body { fill: #4f4e5a; }
  .crucible-studio:not([data-theme]) .crucible-studio-mark-shadow { fill: #3b3a44; }
}
.crucible-studio-mark-molten-deep { fill: #df5829; }
.crucible-studio-mark-molten { fill: #fc9132; }
.crucible-studio-mark-face-shadow { fill: #c8c7ce; }
.crucible-studio-mark-face { fill: #fefefd; }
.crucible-studio-mark-eye { fill: #111114; }
.crucible-studio button.crucible-studio-filepill {
  display: inline-block;
  max-inline-size: 220px;
  padding: 4px 8px;
  font-family: var(--studio-font-heading);
  font-weight: 600;
  font-size: 13px;
  letter-spacing: -0.01em;
  line-height: 22px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.crucible-studio-filepill[data-dirty="true"]::after {
  content: "";
  display: inline-block;
  inline-size: 6px;
  block-size: 6px;
  margin-inline-start: 7px;
  border-radius: 999px;
  background: var(--studio-accent);
  vertical-align: middle;
}
.crucible-studio-watch-pill {
  inline-size: 8px;
  block-size: 8px;
  margin-inline: 2px 8px;
  border-radius: 999px;
  background: var(--studio-ok);
  flex-shrink: 0;
}
.crucible-studio-watch-pill[hidden] { display: none; }
.crucible-studio-spacer { flex: 1 1 auto; }
.crucible-studio button.crucible-studio-primary-btn {
  padding-inline: 12px 16px;
  background: transparent;
  color: var(--studio-text);
  font-weight: 600;
}
@media (hover: hover) {
  .crucible-studio button.crucible-studio-primary-btn:not([aria-disabled="true"]):hover {
    background: color-mix(in srgb, var(--studio-text) 7%, transparent);
  }
}

.crucible-studio-popover {
  margin: 0;
  inset: auto;
  padding: 8px;
  min-width: 224px;
  max-width: 280px;
  border: 1px solid var(--studio-border);
  border-radius: 13px;
  background: var(--studio-panel);
  color: var(--studio-text);
  box-shadow: var(--studio-shadow);
  pointer-events: auto;
  -webkit-app-region: no-drag;
  /* On the closed rule too, so a menu keeps its layout while it fades out. */
  gap: 2px;
}
.crucible-studio-popover:popover-open { display: grid; }
/* A menu grows from the corner nearest its trigger (the script writes the origin and the shift when it opens). */
@supports (transition-behavior: allow-discrete) {
  @media (prefers-reduced-motion: no-preference) {
    .crucible-studio-popover {
      opacity: 0;
      transform-origin: var(--studio-popover-origin, 0 0);
      transition: opacity var(--studio-motion-exit) var(--studio-ease-out), display var(--studio-motion-exit) var(--studio-ease-out) allow-discrete, overlay var(--studio-motion-exit) var(--studio-ease-out) allow-discrete;
    }
    .crucible-studio-popover:popover-open {
      opacity: 1;
      transition: opacity var(--studio-motion-quick) var(--studio-ease-out), scale var(--studio-motion-quick) var(--studio-ease-out), translate var(--studio-motion-quick) var(--studio-ease-out);
    }
    @starting-style {
      .crucible-studio-popover:popover-open {
        opacity: 0;
        scale: 0.97;
        translate: var(--studio-popover-shift, 0 -4px);
      }
    }
    .crucible-studio-menubar[data-switching] .crucible-studio-popover { transition: none; }
    /* A menu opened from the keyboard is a shortcut: it appears at once, with no starting style playing. */
    .crucible-studio[data-input="keyboard"] .crucible-studio-popover { transition: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .crucible-studio-popover {
      opacity: 0;
      transition: opacity var(--studio-motion-fade) var(--studio-ease-out), display var(--studio-motion-fade) var(--studio-ease-out) allow-discrete, overlay var(--studio-motion-fade) var(--studio-ease-out) allow-discrete;
    }
    .crucible-studio-popover:popover-open {
      opacity: 1;
      transition: opacity var(--studio-motion-fade) var(--studio-ease-out);
    }
    @starting-style {
      .crucible-studio-popover:popover-open { opacity: 0; }
    }
    .crucible-studio-menubar[data-switching] .crucible-studio-popover { transition: none; }
    .crucible-studio[data-input="keyboard"] .crucible-studio-popover { transition: none; }
  }
}
.crucible-studio-popover-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
}
.crucible-studio-popover-grid + .crucible-studio-popover-grid { margin-block-start: 10px; }
#crucible-studio-pop-add { max-width: 348px; max-block-size: calc(100dvh - 16px); overflow-y: auto; }
#crucible-studio-pop-add .crucible-studio-popover-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.crucible-studio-popover button[aria-expanded="true"] { background: color-mix(in srgb, var(--studio-text) 8%, transparent); }
.crucible-studio-tree-section { display: grid; }
.crucible-studio-tree-section[hidden], .crucible-studio-tree-controls[hidden] { display: none; }
.crucible-studio-tree-controls { display: grid; gap: 12px; }
.crucible-studio-tree-controls > .crucible-studio-field-head { margin-block-end: -8px; }
.crucible-studio-tree-seed {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px;
}
.crucible-studio-popover > button { gap: 8px; }
.crucible-studio-popover > button[hidden] { display: none; }
.crucible-studio-popover button {
  justify-content: flex-start;
  width: 100%;
  padding: 8px 12px;
  text-align: left;
}
.crucible-studio-popover > button > .crucible-studio-icon { color: var(--studio-muted); }
.crucible-studio-popover > button:hover > .crucible-studio-icon,
.crucible-studio-popover > button:focus-visible > .crucible-studio-icon { color: inherit; }
.crucible-studio-menu-gap {
  flex: none;
  inline-size: 17px;
  block-size: 17px;
}
.crucible-studio-popover button[data-shortcut]::after {
  content: attr(data-shortcut);
  margin-inline-start: auto;
  padding-inline-start: 24px;
  font-family: var(--studio-font-mono);
  font-size: 11px;
  color: var(--studio-muted);
}
/* A row that switches something keeps its icon and shows a dot at its end while it is on. */
.crucible-studio-popover button[role="menuitemcheckbox"]::before {
  content: "";
  order: 2;
  flex: none;
  inline-size: 8px;
  block-size: 8px;
  margin-inline-start: auto;
  border-radius: 50%;
  background: transparent;
}
.crucible-studio-popover button[role="menuitemcheckbox"][data-shortcut]::before { margin-inline-start: var(--studio-space-4); }
.crucible-studio-popover button[role="menuitemcheckbox"][data-shortcut]::after { order: 1; }
/* Rows beside the switches leave the dot's column free, so every key in the menu ends on one line. */
#crucible-studio-pop-view button:not([role]) { padding-inline-end: 24px; }
.crucible-studio-popover button[role="menuitemcheckbox"][aria-checked="true"]::before {
  background: var(--studio-text);
}
.crucible-studio-menus {
  display: flex;
  align-items: center;
}
.crucible-studio button.crucible-studio-menu-button {
  min-inline-size: 0;
  padding: 4px 8px;
  font-size: 13px;
}
.crucible-studio button.crucible-studio-menu-button:hover,
.crucible-studio button.crucible-studio-menu-button:has(+ *):focus-visible {
  background: color-mix(in srgb, var(--studio-text) 7%, transparent);
}
.crucible-studio[data-compact="true"] .crucible-studio-menu-button[popovertarget="crucible-studio-pop-view"],
.crucible-studio[data-compact="true"] .crucible-studio-menu-button[popovertarget="crucible-studio-pop-help"],
.crucible-studio[data-compact="true"] .crucible-studio-filepill,
.crucible-studio[data-compact="true"] .crucible-studio-primary-btn span {
  display: none;
}
.crucible-studio-popover-note {
  margin: 8px 10px 2px;
  font-size: 11.5px;
  color: var(--studio-muted);
  line-height: 1.4;
  word-break: break-word;
}

.crucible-studio-toolbar {
  position: absolute;
  inset-block-start: var(--studio-top);
  inset-inline-start: var(--studio-edge);
  flex-direction: column;
  gap: 12px;
  z-index: 5;
}
/* The one line in the rail: scene tools above it, show and hide switches below. */
.crucible-studio-toolbar-rule {
  inline-size: 20px;
  block-size: 1px;
  border-radius: 1px;
  background: color-mix(in srgb, var(--studio-text) 18%, transparent);
}
.crucible-studio-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.crucible-studio-group[hidden] { display: none; }
/* Edit mode's own group: set apart from the tools by room around it and read as one unit by the tight spacing inside, in the accent while the mode is on. */
.crucible-studio-group[data-mesh-group] {
  margin-block: 10px;
  gap: 2px;
}
.crucible-studio-group[data-mesh-group] button[aria-pressed="true"] {
  background: color-mix(in srgb, var(--studio-accent) 28%, transparent);
  color: var(--studio-accent);
}
/* What the three mode icons draw over their square. */
.crucible-studio-icon-dot {
  stroke-width: 6;
}
.crucible-studio-icon-heavy {
  stroke-width: 3.4;
  stroke-linecap: butt;
}
.crucible-studio-icon-tint {
  fill: currentColor;
  fill-opacity: 0.35;
  stroke: none;
}

.crucible-studio-dock {
  position: absolute;
  inset-block-start: var(--studio-top);
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--studio-border);
  border-radius: 13px;
  background: var(--studio-panel);
  box-shadow: var(--studio-shadow);
  overflow: hidden;
  z-index: 4;
}
/* Scene above, Properties below, in one column across from the tools. Floating, each card is its own window with its own
   width, kept to the right edge, so the column is as wide as the wider card. */
.crucible-studio-side {
  position: absolute;
  inset-block: var(--studio-top) var(--studio-edge);
  inset-inline-end: var(--studio-edge);
  inline-size: max(var(--studio-scene-width, 284px), var(--studio-properties-width, 284px));
  max-inline-size: calc(100% - var(--studio-edge) * 3 - var(--studio-rail) - 160px);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  pointer-events: none;
  z-index: 4;
}
.crucible-studio-side > .crucible-studio-dock {
  position: relative;
  flex: 0 1 auto;
  max-inline-size: 100%;
  pointer-events: auto;
}
/* The cards lie in the column, so the edge offsets that place them on their own in a compact window do not apply. */
.crucible-studio:not([data-compact="true"]) .crucible-studio-side > .crucible-studio-dock { inset: auto; }
.crucible-studio-side > .crucible-studio-outliner { inline-size: var(--studio-scene-width, 284px); }
.crucible-studio-side > .crucible-studio-inspector { inline-size: var(--studio-properties-width, 284px); }
/* The Scene card keeps one height whatever is selected, so the Properties card below it does not jump. */
.crucible-studio-side > .crucible-studio-outliner { flex: 0 0 35%; }
.crucible-studio[data-outliner-minimized="true"] .crucible-studio-side > .crucible-studio-outliner { flex: 0 0 auto; }
/* Properties takes the rest of the column, down to its bottom margin. */
.crucible-studio-side > .crucible-studio-inspector { flex: 1 1 0; }
.crucible-studio[data-inspector-minimized="true"] .crucible-studio-side > .crucible-studio-inspector { flex: 0 0 auto; }
.crucible-studio[data-scene-sized="true"]:not([data-outliner-minimized="true"]) .crucible-studio-side > .crucible-studio-outliner {
  flex-basis: var(--studio-scene-share);
}
/* A card someone sized keeps that height, and the other card keeps its own. A minimized card ignores it. */
.crucible-studio[data-floating="true"][data-scene-height-sized="true"]:not([data-outliner-minimized="true"]) .crucible-studio-side > .crucible-studio-outliner {
  flex: 0 1 var(--studio-scene-height);
}
.crucible-studio[data-floating="true"][data-properties-height-sized="true"]:not([data-inspector-minimized="true"]) .crucible-studio-side > .crucible-studio-inspector {
  flex: 0 1 var(--studio-properties-height);
}
.crucible-studio[data-outliner-minimized="true"] .crucible-studio-outliner > :not(.crucible-studio-dock-head):not(.crucible-studio-grip),
.crucible-studio[data-inspector-minimized="true"] .crucible-studio-inspector > :not(.crucible-studio-dock-head):not(.crucible-studio-grip) {
  display: none;
}
/* The axis widget stands left of the cards. A minimized Scene card is short, so a wider Properties card shows under
   the widget and the widget clears that one too. With both cards away it takes the corner. */
.crucible-studio {
  --studio-gizmo-clear: calc(var(--studio-scene-width, 284px) + var(--studio-edge));
}
.crucible-studio[data-outliner-minimized="true"]:not([data-inspector-collapsed="true"]) {
  --studio-gizmo-clear: calc(max(var(--studio-scene-width, 284px), var(--studio-properties-width, 284px)) + var(--studio-edge));
}
.crucible-studio[data-outliner-collapsed="true"] {
  --studio-gizmo-clear: calc(var(--studio-properties-width, 284px) + var(--studio-edge));
}
.crucible-studio[data-outliner-collapsed="true"][data-inspector-collapsed="true"] {
  --studio-gizmo-clear: 0px;
}
.crucible-studio[data-outliner-minimized="true"] .crucible-studio-outliner > .crucible-studio-dock-head,
.crucible-studio[data-inspector-minimized="true"] .crucible-studio-inspector > .crucible-studio-dock-head {
  padding-block-end: 8px;
}
/* The grips of the panel column: nothing to see until the pointer or the keyboard is on one. */
.crucible-studio-grip {
  position: relative;
  flex: none;
  pointer-events: auto;
  touch-action: none;
  outline: none;
}
.crucible-studio-grip::after {
  content: "";
  position: absolute;
  border-radius: 999px;
  background: var(--studio-accent);
  opacity: 0;
  transition: opacity var(--studio-motion-quick) var(--studio-ease-out);
}
.crucible-studio-grip:focus-visible::after,
.crucible-studio-grip[data-dragging="true"]::after {
  opacity: 1;
}
@media (hover: hover) {
  .crucible-studio-grip:hover::after { opacity: 0.7; }
}
.crucible-studio-grip-width {
  position: absolute;
  inset-block: 0;
  inset-inline-start: -7px;
  inline-size: 8px;
  cursor: ew-resize;
}
.crucible-studio-grip-width::after {
  inset-block: 12px;
  inset-inline-start: 3px;
  inline-size: 2px;
}
/* The split grip lies in the gap between the two cards without adding to it. */
.crucible-studio-grip-split {
  block-size: 6px;
  margin-block: -6px;
  cursor: ns-resize;
}
.crucible-studio-grip-split::after {
  inset-inline: 12px;
  inset-block-start: 2px;
  block-size: 2px;
}
/* Floating, a card's own grips sit on its inner left and bottom edges, which stay inside the rounded corners. */
.crucible-studio-grip-card-width {
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  inline-size: 8px;
  cursor: ew-resize;
  z-index: 2;
}
.crucible-studio-grip-card-width::after {
  inset-block: 14px;
  inset-inline-start: 2px;
  inline-size: 2px;
}
.crucible-studio-grip-card-height {
  position: absolute;
  inset-inline: 0;
  inset-block-end: 0;
  block-size: 8px;
  cursor: ns-resize;
  z-index: 3;
}
.crucible-studio-grip-card-height::after {
  inset-inline: 14px;
  inset-block-end: 2px;
  block-size: 2px;
}
/* Docked, the column's own two grips do this work and the cards' grips stay away; floating, the other way round. */
.crucible-studio[data-floating="false"] .crucible-studio-grip-card-width,
.crucible-studio[data-floating="false"] .crucible-studio-grip-card-height,
.crucible-studio[data-floating="true"] .crucible-studio-grip-width,
.crucible-studio[data-floating="true"] .crucible-studio-grip-split,
.crucible-studio[data-outliner-minimized="true"] .crucible-studio-grip-scene-height,
.crucible-studio[data-inspector-minimized="true"] .crucible-studio-grip-properties-height,
.crucible-studio[data-outliner-minimized="true"] .crucible-studio-grip-split,
.crucible-studio[data-inspector-minimized="true"] .crucible-studio-grip-split,
.crucible-studio[data-outliner-collapsed="true"] .crucible-studio-grip,
.crucible-studio[data-inspector-collapsed="true"] .crucible-studio-grip-split,
.crucible-studio[data-compact="true"] .crucible-studio-grip {
  display: none;
}
@media (prefers-reduced-motion: reduce) {
  .crucible-studio-grip::after { transition: none; }
}
.crucible-studio-outliner {
  inset-inline-start: calc(var(--studio-edge) * 2 + var(--studio-rail));
}
.crucible-studio-inspector {
  inset-inline-end: var(--studio-edge);
}
.crucible-studio[data-readout="off"] .crucible-studio-readout,
.crucible-studio[data-view-widget="off"] .crucible-studio-view-widget {
  display: none;
}
.crucible-studio[data-outliner-collapsed="true"] .crucible-studio-outliner,
.crucible-studio[data-inspector-collapsed="true"] .crucible-studio-inspector {
  display: none;
}
.crucible-studio-dock-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 4px 12px;
  font-family: var(--studio-font-heading);
  font-weight: 600;
  font-size: 13px;
}
.crucible-studio-dock-title {
  display: flex;
  align-items: center;
  gap: 4px;
}
.crucible-studio-dock-title .crucible-studio-icon,
.crucible-studio-selection-count .crucible-studio-icon {
  inline-size: 15px;
  block-size: 15px;
}
.crucible-studio-selection-count {
  display: flex;
  align-items: center;
  gap: 4px;
  font-family: var(--studio-font);
  font-weight: 500;
  font-size: 12px;
  color: var(--studio-muted);
}
.crucible-studio-selection-count[hidden] { display: none; }
.crucible-studio-filter {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  margin: 2px 8px 6px;
}
.crucible-studio-filter[hidden] { display: none; }
.crucible-studio-filter input {
  flex: 1 1 auto;
  min-inline-size: 0;
  font-family: var(--studio-font);
  font-size: 12px;
}
.crucible-studio-dock-head .crucible-studio-spacer { flex: 1 1 auto; }
.crucible-studio-filter .crucible-studio-icon {
  position: absolute;
  inset-inline-start: 8px;
  inline-size: 13px;
  block-size: 13px;
  color: var(--studio-muted);
  pointer-events: none;
}
.crucible-studio .crucible-studio-filter input {
  inline-size: 100%;
  padding-inline-start: 27px;
}
.crucible-studio-dock-head input {
  flex: 1 1 auto;
  min-inline-size: 0;
  font-family: var(--studio-font);
  font-weight: 400;
  font-size: 12px;
}
.crucible-studio-tree {
  flex: 1 1 auto;
  overflow-y: auto;
  /* The list scrolls a whole row at a time, and studio.js sizes the rows so a whole number of them fills it. */
  scroll-snap-type: y mandatory;
  scroll-padding-block: 4px;
  padding: 4px 8px 0;
  display: grid;
  align-content: start;
  gap: var(--studio-space-4);
}
.crucible-studio-tree-row {
  display: flex;
  align-items: center;
  min-block-size: var(--studio-tree-row-size, auto);
  scroll-snap-align: start;
  gap: var(--studio-space-4);
  padding: 0 2px 0 var(--studio-space-8);
  border-radius: 8px;
}
/* Every selected row is tinted; the active one, which the panels follow, more strongly. */
.crucible-studio-tree-row[data-selected="true"] {
  background: color-mix(in srgb, var(--studio-text) 10%, transparent);
}
.crucible-studio-tree-row[data-active="true"] {
  background: color-mix(in srgb, var(--studio-text) 18%, transparent);
}
@media (hover: hover) {
  .crucible-studio-tree-row:not([data-selected="true"]):hover {
    background: color-mix(in srgb, var(--studio-text) 6%, transparent);
  }
  .crucible-studio .crucible-studio-tree .crucible-studio-tree-row button:hover {
    background: transparent;
  }
  .crucible-studio .crucible-studio-tree .crucible-studio-tree-row button.crucible-studio-tree-eye:hover {
    color: var(--studio-text);
  }
}
.crucible-studio button.crucible-studio-tree-select {
  flex: 1 1 auto;
  min-width: 0;
  justify-content: flex-start;
  padding: 2px 4px;
  background: transparent;
  overflow: hidden;
}
.crucible-studio button.crucible-studio-tree-select { min-block-size: 28px; }
.crucible-studio-tree-select[data-hidden="true"] { color: var(--studio-muted); }
.crucible-studio-tree-badge {
  inline-size: 15px;
  block-size: 15px;
  stroke: var(--studio-text);
  stroke-width: 1.6;
  fill-opacity: 0.45;
}
.crucible-studio-tree-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crucible-studio button.crucible-studio-tree-eye {
  min-inline-size: 28px;
  min-block-size: 28px;
  inline-size: 28px;
  color: var(--studio-muted);
  opacity: 0;
}
.crucible-studio-tree-row:hover .crucible-studio-tree-eye,
.crucible-studio-tree-row:focus-within .crucible-studio-tree-eye,
.crucible-studio-tree-row[data-selected="true"] .crucible-studio-tree-eye,
.crucible-studio-tree-eye[data-hidden="true"] { opacity: 1; }
@media (hover: none) {
  .crucible-studio button.crucible-studio-tree-eye { opacity: 1; }
}
.crucible-studio-palette-section {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  /* The right inset matches the fields below: the panel padding plus the room its scrollbar keeps. */
  padding: 12px 24px 12px 12px;
}
/* One row that scrolls sideways, so it never sits beside the list's own scrollbar. The padding keeps the ring of the chosen swatch inside the strip. */
.crucible-studio-swatches {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px;
  min-inline-size: 0;
  padding: 4px;
  margin: -4px 0 -4px -4px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  container-type: scroll-state;
}
.crucible-studio-swatches::-webkit-scrollbar { display: none; }
/* While more swatches lie to the right, the last one in view dissolves into the panel instead of being sliced. */
.crucible-studio-swatches::after {
  content: "";
  position: sticky;
  inset-inline-end: -4px;
  flex: none;
  inline-size: 28px;
  block-size: 24px;
  margin-inline-start: -28px;
  background: linear-gradient(to right, transparent, var(--studio-panel) 85%);
  opacity: 0;
  pointer-events: none;
}
@container scroll-state(scrollable: right) {
  .crucible-studio-swatches::after { opacity: 1; }
}
.crucible-studio-swatches > button { flex: none; }
.crucible-studio button.crucible-studio-swatch-btn,
.crucible-studio button.crucible-studio-swatch-add {
  min-inline-size: 24px;
  min-block-size: 24px;
  inline-size: 24px;
  block-size: 24px;
  padding: 0;
  border-radius: 999px;
}
.crucible-studio button.crucible-studio-swatch-btn {
  border: 1px solid var(--studio-border);
}
.crucible-studio button.crucible-studio-swatch-btn[aria-pressed="true"] {
  box-shadow: 0 0 0 2px var(--studio-panel), 0 0 0 3.5px var(--studio-text);
}
.crucible-studio button.crucible-studio-swatch-add {
  flex: none;
  color: var(--studio-muted);
  border: 1px dashed color-mix(in srgb, var(--studio-text) 30%, transparent);
}
.crucible-studio-swatch-add .crucible-studio-icon {
  inline-size: 13px;
  block-size: 13px;
}

.crucible-studio-hintbar {
  position: absolute;
  inset-inline-start: 50%;
  inset-block-end: 76px;
  transform: translateX(-50%);
  padding: 4px 12px;
  border-radius: 999px;
  background: var(--studio-panel);
  border: 1px solid var(--studio-border);
  color: var(--studio-text);
  box-shadow: var(--studio-shadow);
  font-family: var(--studio-font-mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
  z-index: 3;
}
.crucible-studio-hintbar:empty { display: none; }
/* While a key holds the object the pill lists the keys that act on it. */
.crucible-studio[data-modal] .crucible-studio-hintbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  /* Wider than the distance readout it replaces, so it sits above the readout in the corner instead of over it. */
  inset-block-end: 118px;
}
.crucible-studio[data-modal] .crucible-studio-viewport { cursor: move; }
.crucible-studio-hint-delta { min-inline-size: 9ch; }
.crucible-studio-hint-typed { font-variant-numeric: tabular-nums; color: var(--studio-text); font-weight: 600; }
.crucible-studio-hint-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--studio-font);
  font-size: 12px;
  color: var(--studio-muted);
}
.crucible-studio-hintbar kbd[aria-pressed="true"] {
  background: var(--studio-text);
  color: var(--studio-panel);
}
.crucible-studio-status {
  position: absolute;
  inset-inline-start: 50%;
  /* Under the top bar: the workspace tabs hold its centre. */
  inset-block-start: var(--studio-top);
  transform: translateX(-50%);
  max-inline-size: calc(100% - 420px);
  margin: 0;
  padding: 8px 16px;
  /* Half the height of one line, so a short message is still a pill and a long one wraps into a rounded card. */
  border-radius: 15px;
  background: var(--studio-panel);
  border: 1px solid var(--studio-border);
  box-shadow: var(--studio-shadow);
  font-size: 12px;
  color: var(--studio-text);
  inline-size: max-content;
  overflow-wrap: anywhere;
  text-wrap: balance;
  pointer-events: none;
  z-index: 7;
}
.crucible-studio-status:empty { display: none; }
/* The box stays mounted and the script sets data-state: in while a message shows, out while it leaves. The individual
   translate property leaves the centring transform alone. */
@supports (transition-behavior: allow-discrete) {
  @media (prefers-reduced-motion: no-preference) {
    .crucible-studio-status {
      opacity: 0;
      translate: 0 -4px;
      transition: opacity var(--studio-motion-quick) var(--studio-ease-out), translate var(--studio-motion-quick) var(--studio-ease-out);
    }
    .crucible-studio-status[data-state="in"] {
      opacity: 1;
      translate: 0 0;
      transition: opacity var(--studio-motion-base) var(--studio-ease-out), translate var(--studio-motion-base) var(--studio-ease-out);
    }
    @starting-style {
      .crucible-studio-status[data-state="in"] {
        opacity: 0;
        translate: 0 -6px;
      }
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .crucible-studio-status {
      opacity: 0;
      transition: opacity var(--studio-motion-fade) var(--studio-ease-out);
    }
    .crucible-studio-status[data-state="in"] {
      opacity: 1;
      transition: opacity var(--studio-motion-fade) var(--studio-ease-out);
    }
    @starting-style {
      .crucible-studio-status[data-state="in"] { opacity: 0; }
    }
  }
}

.crucible-studio-tablist {
  display: flex;
  gap: 2px;
  padding: 4px;
}
.crucible-studio-tablist[hidden],
.crucible-studio .crucible-studio-tablist button[hidden] {
  display: none;
}
/* The two side columns of the top bar share the spare room evenly, which centres the tabs on the window; when the menus
   need more than their half, the tabs give way instead of sliding under them. Below the compact width only the open
   tab keeps its name. */
.crucible-studio[data-compact="true"] .crucible-studio-workspaces button[aria-selected="false"] .crucible-studio-workspace-label {
  display: none;
}
.crucible-studio[data-compact="true"] .crucible-studio-workspaces button[aria-selected="false"] {
  padding-inline: 8px;
}
.crucible-studio-workspaces .crucible-studio-icon {
  inline-size: 15px;
  block-size: 15px;
}
.crucible-studio-workspaces button {
  position: relative;
  padding-inline: 12px;
  font-family: var(--studio-font-heading);
  font-weight: 600;
  font-size: 13px;
  color: var(--studio-muted);
}
.crucible-studio-workspaces button[aria-selected="true"] {
  color: var(--studio-text);
}
.crucible-studio-workspaces button[aria-selected="true"]::after {
  content: "";
  position: absolute;
  inset-inline-start: calc(50% - 2px);
  inset-block-end: 1px;
  inline-size: 4px;
  block-size: 4px;
  border-radius: 999px;
  background: var(--studio-accent);
}
.crucible-studio-tablist button {
  position: relative;
  flex: 1 1 0;
  inline-size: auto;
  color: var(--studio-muted);
}
.crucible-studio-tablist button[aria-selected="true"] {
  color: var(--studio-text);
  background: color-mix(in srgb, var(--studio-text) 11%, transparent);
}
.crucible-studio-tablist button[aria-selected="true"]::after {
  content: "";
  position: absolute;
  inset-inline-start: calc(50% - 2px);
  inset-block-end: 2px;
  inline-size: 4px;
  block-size: 4px;
  border-radius: 999px;
  background: var(--studio-accent);
}
.crucible-studio-panels {
  flex: 1 1 auto;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
/* Rows dissolve into the card at the bottom edge while more of the panel lies below, instead of being cut. */
.crucible-studio-panels::after {
  content: "";
  position: sticky;
  inset-block-end: 0;
  z-index: 3;
  display: block;
  block-size: 14px;
  margin-block-start: -14px;
  background: linear-gradient(to bottom, transparent, var(--studio-panel));
  pointer-events: none;
}
.crucible-studio-panel-body {
  display: grid;
  gap: 12px;
  padding: 8px 12px 16px;
}
.crucible-studio-name-row {
  display: flex;
  align-items: center;
  gap: 2px;
}
.crucible-studio-name-row input {
  flex: 1 1 auto;
  min-inline-size: 0;
  margin-inline-end: 4px;
  font-family: var(--studio-font-heading);
  font-weight: 600;
}
.crucible-studio-field {
  display: grid;
  gap: 4px;
}
.crucible-studio-field-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--studio-space-4);
  font-size: 11.5px;
  color: var(--studio-muted);
}
.crucible-studio-field output {
  font-variant-numeric: tabular-nums;
  color: var(--studio-text);
}
.crucible-studio-vector {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}
.crucible-studio-vector label {
  display: grid;
  gap: 4px;
  font-size: 11px;
  color: var(--studio-muted);
}
.crucible-studio-axis-scrub {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: ew-resize;
  font-weight: 600;
}
.crucible-studio input[type="number"],
.crucible-studio input[type="text"],
.crucible-studio input[type="search"],
.crucible-studio select,
.crucible-studio textarea {
  width: 100%;
  min-block-size: 30px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: color-mix(in srgb, var(--studio-text) 7%, transparent);
  color: var(--studio-text);
  font-variant-numeric: tabular-nums;
}
.crucible-studio select {
  appearance: none;
  padding-inline-end: 24px;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--studio-muted) 50%),
    linear-gradient(135deg, var(--studio-muted) 50%, transparent 50%);
  background-position: calc(100% - 15px) 13px, calc(100% - 10px) 13px;
  background-size: 5px 5px;
  background-repeat: no-repeat;
}
.crucible-studio select option {
  background: var(--studio-panel);
  color: var(--studio-text);
}
.crucible-studio input[type="range"] {
  width: 100%;
  accent-color: var(--studio-text);
  cursor: pointer;
}
.crucible-studio-field:has(> input[type="color"]) {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.crucible-studio input[type="color"] {
  width: 44px;
  height: 28px;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--studio-border);
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}
.crucible-studio-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.crucible-studio-chips button,
.crucible-studio-panel-body > button,
.crucible-studio-bookmark-row button,
.crucible-studio-viewcube button {
  background: color-mix(in srgb, var(--studio-text) 6%, transparent);
}
.crucible-studio-chips button[aria-pressed="true"],
.crucible-studio-viewcube button[aria-pressed="true"] {
  background: var(--studio-text);
  color: var(--studio-bg);
}
.crucible-studio button.crucible-studio-mini-btn {
  min-inline-size: 24px;
  min-block-size: 24px;
  inline-size: 24px;
  color: var(--studio-muted);
}
.crucible-studio button.crucible-studio-mini-btn[aria-pressed="true"] { color: var(--studio-text); }
.crucible-studio-mini-btn .crucible-studio-icon {
  inline-size: 14px;
  block-size: 14px;
}
.crucible-studio-viewcube {
  display: flex;
  gap: 4px;
}
.crucible-studio-viewcube-row {
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px;
}
.crucible-studio-viewcube button {
  min-inline-size: 0;
  min-block-size: 26px;
  padding: 2px 8px;
  font-size: 11px;
}
/* The property panels: one line per property, the label on the left and the control in a value column on the right. */
.crucible-studio-panel-rows {
  gap: 0;
  padding-block-end: 8px;
}
.crucible-studio-panel-rows > .crucible-studio-field { margin-block-start: 10px; }
.crucible-studio-properties {
  display: grid;
}
/* One uniform gap above every group title lives on the group, so the title can stick to the very top of the scroll area. */
.crucible-studio-property-section {
  display: grid;
  align-content: start;
  padding-block-start: 12px;
}
.crucible-studio button.crucible-studio-property-title {
  position: sticky;
  inset-block-start: 0;
  z-index: 2;
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  justify-content: stretch;
  justify-items: start;
  align-items: center;
  column-gap: 4px;
  inline-size: 100%;
  min-inline-size: 0;
  min-block-size: 28px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: var(--studio-panel);
  font-family: var(--studio-font-heading);
  font-size: 12px;
  font-weight: 600;
  color: var(--studio-text);
  text-align: start;
  cursor: pointer;
  container-type: scroll-state;
}
/* While a title is pinned to the top, the rows scrolling under it dissolve over 16px instead of being sliced; the title itself stays opaque. */
.crucible-studio button.crucible-studio-property-title::after {
  content: "";
  position: absolute;
  inset-inline: 0;
  inset-block-start: 100%;
  block-size: 16px;
  background: linear-gradient(to bottom, var(--studio-panel) 35%, transparent);
  opacity: 0;
  pointer-events: none;
}
@container scroll-state(stuck: top) {
  .crucible-studio button.crucible-studio-property-title::after { opacity: 1; }
}
@media (hover: hover) {
  .crucible-studio button.crucible-studio-property-title:not([aria-disabled="true"]):not([aria-pressed="true"]):hover {
    background: var(--studio-panel);
    box-shadow: inset 0 0 0 999px color-mix(in srgb, var(--studio-text) 6%, transparent);
  }
}
.crucible-studio-property-title .crucible-studio-icon {
  inline-size: 14px;
  block-size: 14px;
  transition: transform var(--studio-motion-quick) var(--studio-ease-out);
}
@media (prefers-reduced-motion: reduce) {
  .crucible-studio-property-title .crucible-studio-icon { transition: none; }
}
.crucible-studio-property-section[data-open="true"] .crucible-studio-property-title .crucible-studio-icon { transform: rotate(90deg); }
.crucible-studio-property-rows {
  display: grid;
  gap: 4px;
  padding-block-end: 2px;
}
.crucible-studio-properties[hidden], .crucible-studio-properties [hidden] { display: none; }
/* One value column: numbers end at the same edge with or without a unit, and the unit sits in a fixed slot after them. */
.crucible-studio-prop {
  --studio-unit-slot: 20px;
  --studio-value-edge: 8px;
  --studio-number-inset: calc(var(--studio-value-edge) + var(--studio-unit-slot) + 2px);
  display: grid;
  /* A label is never cut: its column grows to the label when 45% is too narrow, and the head keeps a gap before the control. */
  grid-template-columns: minmax(min-content, 45%) minmax(0, 1fr);
  column-gap: 8px;
  align-items: center;
  min-block-size: 28px;
}
.crucible-studio-prop[data-control="slider"] {
  grid-template-columns: minmax(min-content, 45%) minmax(0, 1fr) 32px calc(var(--studio-unit-slot) + var(--studio-value-edge));
  column-gap: 4px;
}
.crucible-studio-prop[data-control="slider"] > output { margin-inline-end: -4px; }
.crucible-studio-prop-head {
  grid-column: 1;
  grid-row: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  min-inline-size: 0;
  padding-inline-end: 8px;
  font-size: 11.5px;
  color: var(--studio-muted);
}
.crucible-studio-prop-label {
  min-inline-size: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crucible-studio-prop > :is(input, select, button, svg) { min-inline-size: 0; }
.crucible-studio-prop > input[type="number"],
.crucible-studio-prop > select,
.crucible-studio-prop > input[type="color"],
.crucible-studio-prop > .crucible-studio-switch,
.crucible-studio-prop > .crucible-studio-sun-control,
.crucible-studio-prop-unit { grid-column: 2; grid-row: 1; }
.crucible-studio-prop > input[type="number"],
.crucible-studio-prop > select {
  min-block-size: 28px;
  padding-block: 4px;
}
.crucible-studio-prop > input[type="number"] {
  padding-inline-end: var(--studio-number-inset);
  text-align: end;
  appearance: textfield;
}
.crucible-studio-prop > input[type="number"]::-webkit-inner-spin-button,
.crucible-studio-prop > input[type="number"]::-webkit-outer-spin-button { appearance: none; }
/* A choice reads like a number: its text ends at the digits' edge and the arrow sits in the unit slot. */
.crucible-studio-prop > select {
  padding-inline-end: var(--studio-number-inset);
  text-align: end;
  text-align-last: end;
  background-position: calc(100% - 15px) 12px, calc(100% - 10px) 12px;
}
.crucible-studio-prop-unit {
  justify-self: end;
  inline-size: var(--studio-unit-slot);
  margin-inline-end: var(--studio-value-edge);
  font-size: 11px;
  text-align: start;
  color: var(--studio-muted);
  pointer-events: none;
}
.crucible-studio-prop[data-control="slider"] > .crucible-studio-prop-unit {
  grid-column: 4;
  justify-self: start;
  margin-inline-end: 0;
}
/* A colour is a field like the number fields: same height, radius and soft fill, with its swatch ending at the digits' edge. */
.crucible-studio-prop > input[type="color"] {
  inline-size: 100%;
  block-size: 28px;
  padding: 4px var(--studio-number-inset) 4px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: color-mix(in srgb, var(--studio-text) 7%, transparent);
}
.crucible-studio-prop > input[type="color"]::-webkit-color-swatch-wrapper { padding: 0; }
.crucible-studio-prop > input[type="color"]::-webkit-color-swatch {
  flex: none;
  inline-size: 44px;
  margin-inline-start: auto;
  border: 0;
  border-radius: 5px;
}
/* A row whose condition fails (the f-stop while depth of field is off) stays readable but dimmed. */
.crucible-studio-prop[data-dimmed="true"] > :not(.crucible-studio-prop-head) { opacity: 0.55; }
.crucible-studio-prop > input[type="range"] { margin: 0; }
.crucible-studio-prop > output {
  text-align: end;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.crucible-studio-prop[data-control="sunpad"] .crucible-studio-prop-head {
  align-self: start;
  padding-block-start: 8px;
}
.crucible-studio-sun-control {
  display: flex;
  align-items: center;
  gap: 8px;
  min-inline-size: 0;
}
.crucible-studio-sun-readout {
  display: grid;
  gap: 2px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--studio-text);
}
.crucible-studio-sun-readout span {
  margin-inline-end: 5px;
  color: var(--studio-muted);
}
.crucible-studio-prop .crucible-studio-sunpad {
  inline-size: 72px;
  block-size: 72px;
  flex: none;
}
.crucible-studio-prop > .crucible-studio-switch { justify-self: end; }
.crucible-studio button.crucible-studio-switch {
  justify-content: flex-start;
  min-inline-size: 34px;
  inline-size: 34px;
  min-block-size: 20px;
  block-size: 20px;
  padding: 2px;
  border: 1.5px solid color-mix(in srgb, var(--studio-text) 55%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--studio-text) 10%, transparent);
}
.crucible-studio-switch-knob {
  inline-size: 13px;
  block-size: 13px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--studio-text) 70%, transparent);
  transition: transform var(--studio-motion-quick) var(--studio-ease-out);
}
.crucible-studio button.crucible-studio-switch[aria-checked="true"] {
  border-color: var(--studio-text);
  background: var(--studio-text);
}
.crucible-studio-switch[aria-checked="true"] .crucible-studio-switch-knob {
  background: var(--studio-bg);
  transform: translateX(13px);
}
.crucible-studio-properties .crucible-studio-field { gap: 4px; }
.crucible-studio-properties .crucible-studio-field-head {
  justify-content: flex-start;
  gap: 4px;
  min-block-size: 20px;
}
/* A vector is its label above one line of fields; the axis letter sits inside each field. */
.crucible-studio-properties .crucible-studio-vector {
  grid-template-columns: none;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: 4px;
}
.crucible-studio-properties .crucible-studio-vector label {
  position: relative;
  display: block;
}
.crucible-studio-properties .crucible-studio-axis-scrub {
  position: absolute;
  inset-block: 0;
  inset-inline-start: 8px;
  z-index: 1;
  font-size: 11px;
}
.crucible-studio-properties .crucible-studio-vector input {
  min-block-size: 28px;
  padding-block: 4px;
  padding-inline: 22px 8px;
  text-align: end;
  appearance: textfield;
}
.crucible-studio-properties .crucible-studio-vector input::-webkit-inner-spin-button,
.crucible-studio-properties .crucible-studio-vector input::-webkit-outer-spin-button { appearance: none; }
.crucible-studio-chips-row { flex-wrap: nowrap; }
.crucible-studio-chips-row button {
  flex: 1 1 0;
  min-inline-size: 0;
  min-block-size: 26px;
  padding: 2px 4px;
  font-size: 11px;
  text-transform: capitalize;
}
.crucible-studio-chips-row button[data-focal] { text-transform: none; }
.crucible-studio-driven-mark {
  display: inline-flex;
  align-items: center;
  color: var(--studio-text);
}
.crucible-studio-driven-mark .crucible-studio-icon {
  inline-size: 14px;
  block-size: 14px;
}
/* A driven row is read-only: its text stays at the muted colour instead of fading, so it keeps its contrast. */
.crucible-studio-properties [data-driven="true"] input { color: var(--studio-muted); }
.crucible-studio-properties [data-driven="true"] :is(button, svg.crucible-studio-sunpad) { opacity: 0.6; }
.crucible-studio-properties [data-driven="true"] .crucible-studio-driven-mark { opacity: 1; }
.crucible-studio-field-head .crucible-studio-driven-mark[hidden] { display: none; }
.crucible-studio-field[data-driven="true"] input { color: var(--studio-muted); }
.crucible-studio-field-head > span:has(> .crucible-studio-driven-mark) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.crucible-studio-sunpad {
  width: 120px;
  height: 120px;
  border-radius: 999px;
  background: radial-gradient(circle at 50% 50%, var(--studio-surface), var(--studio-bg));
  border: 1px solid var(--studio-border);
  cursor: crosshair;
  touch-action: none;
}
/* The scroll areas of the panel column share one thin, arrowless scrollbar in the Studio colours. */
.crucible-studio-scroll::-webkit-scrollbar {
  inline-size: 8px;
  block-size: 8px;
}
.crucible-studio-scroll::-webkit-scrollbar-button { display: none; }
.crucible-studio-scroll::-webkit-scrollbar-track,
.crucible-studio-scroll::-webkit-scrollbar-corner { background: transparent; }
.crucible-studio-scroll::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--studio-text) 30%, transparent);
}
@supports not selector(::-webkit-scrollbar) {
  .crucible-studio-scroll {
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--studio-text) 30%, transparent) transparent;
  }
}
@media (prefers-reduced-motion: reduce) {
  .crucible-studio-switch-knob { transition: none; }
}
/* The Shots group is a plain heading in the type of a group title, indented to the titles' text, under the same group gap. */
.crucible-studio-property-heading {
  display: flex;
  align-items: center;
  min-block-size: 28px;
  padding-inline-start: 16px;
  font-family: var(--studio-font-heading);
  font-size: 12px;
  font-weight: 600;
  color: var(--studio-text);
}
.crucible-studio-bookmark-list {
  display: grid;
  gap: 4px;
}
.crucible-studio-bookmark-row {
  display: flex;
  gap: 4px;
  align-items: center;
}
.crucible-studio-bookmark-row button { flex-shrink: 0; }
.crucible-studio-bookmark-row button:first-child {
  flex: 1;
  justify-content: flex-start;
}

.crucible-studio-bottombar {
  position: absolute;
  inset-inline-start: 50%;
  inset-block-end: var(--studio-edge);
  transform: translateX(-50%);
  inline-size: min(620px, calc(100% - var(--studio-edge) * 2));
  gap: 8px;
  z-index: 5;
}
.crucible-studio:not([data-workspace="animate"]) .crucible-studio-bottombar {
  display: none;
}
/* The timeline bar is centred along the bottom, so the readout steps above it and, floating, so does the panel column. */
.crucible-studio[data-workspace="animate"] .crucible-studio-readout,
.crucible-studio[data-workspace="animate"] .crucible-studio-side {
  inset-block-end: calc(var(--studio-edge) + var(--studio-bar-clear));
}
/* Raised above the timeline, the readout would meet the tool rail in a short window, so there it stands beside it. */
.crucible-studio[data-workspace="animate"] .crucible-studio-readout {
  inset-inline-start: calc(var(--studio-edge) * 2 + var(--studio-rail));
}
.crucible-studio-scrub {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1 1 240px;
  min-inline-size: 0;
}
/* The thumb has a set width, so the key markers over the track can be placed under it (studio-timeline-keys.js). */
.crucible-studio-track {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-inline-size: 60px;
  block-size: 32px;
  margin-inline: 6px;
}
.crucible-studio-track input[type="range"] {
  inline-size: 100%;
  margin: 0;
  appearance: none;
  background: transparent;
  cursor: pointer;
}
.crucible-studio-track input[type="range"]:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.crucible-studio-track input[type="range"]::-webkit-slider-runnable-track {
  block-size: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--studio-text) 22%, transparent);
}
.crucible-studio-track input[type="range"]::-moz-range-track {
  block-size: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--studio-text) 22%, transparent);
}
.crucible-studio-track input[type="range"]::-webkit-slider-thumb {
  appearance: none;
  inline-size: ${SCRUB_THUMB_WIDTH}px;
  block-size: ${SCRUB_THUMB_WIDTH}px;
  margin-block-start: calc((2px - ${SCRUB_THUMB_WIDTH}px) / 2);
  border: 0;
  border-radius: 50%;
  background: var(--studio-text);
}
.crucible-studio-track input[type="range"]::-moz-range-thumb {
  inline-size: ${SCRUB_THUMB_WIDTH}px;
  block-size: ${SCRUB_THUMB_WIDTH}px;
  border: 0;
  border-radius: 50%;
  background: var(--studio-text);
}
.crucible-studio-keys {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.crucible-studio .crucible-studio-key {
  position: absolute;
  inset-block-start: 50%;
  transform: translate(-50%, -50%);
  min-inline-size: 0;
  min-block-size: 0;
  inline-size: 20px;
  block-size: 28px;
  padding: 0;
  color: var(--studio-muted);
  pointer-events: auto;
  touch-action: none;
}
.crucible-studio button.crucible-studio-key[aria-pressed="true"] {
  background: transparent;
  color: var(--studio-accent);
}
.crucible-studio-key .crucible-studio-icon {
  inline-size: 12px;
  block-size: 12px;
  fill: currentColor;
}
.crucible-studio button[data-icon="autoKey"][aria-pressed="true"] .crucible-studio-icon { fill: currentColor; }
.crucible-studio-scrub output {
  white-space: nowrap;
  flex-shrink: 0;
  padding-inline-end: 8px;
  font-family: var(--studio-font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 11.5px;
  color: var(--studio-muted);
}
.crucible-studio-shots {
  display: flex;
  gap: 4px;
  max-inline-size: 42%;
  overflow: hidden;
}
.crucible-studio-shots:empty { display: none; }
.crucible-studio-shots button {
  min-block-size: 28px;
  padding: 2px 12px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--studio-text) 7%, transparent);
  font-size: 11.5px;
}

.crucible-studio[data-compact="true"] .crucible-studio-side { display: contents; }
.crucible-studio[data-compact="true"] .crucible-studio-side > .crucible-studio-dock { position: absolute; }
/* Both cards start right of the tool rail and share the room between the bar and the bottom bar, so neither covers the rail and
   the two never overlap: each takes at most half of that room, less the gap between them. */
.crucible-studio[data-compact="true"] .crucible-studio-outliner {
  inline-size: min(228px, calc(100% - var(--studio-edge) * 3 - var(--studio-rail)));
  max-block-size: min(300px, calc((100% - var(--studio-top) - 72px - 6px) / 2));
  z-index: 5;
}
.crucible-studio[data-compact="true"] .crucible-studio-inspector {
  inset-block-start: auto;
  inset-block-end: 72px;
  inset-inline: calc(var(--studio-edge) * 2 + var(--studio-rail)) var(--studio-edge);
  inline-size: auto;
  max-block-size: min(320px, calc((100% - var(--studio-top) - 72px - 6px) / 2));
}
.crucible-studio[data-compact="true"] .crucible-studio-shots { display: none; }
.crucible-studio[data-compact="true"] .crucible-studio-status {
  inset-block-start: var(--studio-top);
  max-inline-size: calc(100% - 140px);
}
.crucible-studio[data-compact="true"] button.crucible-studio-filepill { max-inline-size: 190px; }

.crucible-studio dialog {
  width: min(560px, calc(100vw - 32px));
  padding: 16px;
  border: 1px solid var(--studio-border);
  border-radius: 14px;
  background: var(--studio-panel);
  color: var(--studio-text);
}
.crucible-studio dialog h2 {
  margin: 0 0 10px;
  font-family: var(--studio-font-heading);
  font-size: 15px;
}
.crucible-studio dialog:modal {
  overscroll-behavior: contain;
}
.crucible-studio dialog::backdrop {
  background: color-mix(in srgb, var(--studio-bg) 74%, transparent);
  overflow: hidden;
  overscroll-behavior: contain;
}
.crucible-studio-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
.crucible-studio dialog button {
  background: color-mix(in srgb, var(--studio-text) 7%, transparent);
}
.crucible-studio dialog.crucible-studio-settings-dialog {
  width: min(380px, calc(100vw - 32px));
}
.crucible-studio-settings {
  display: grid;
  gap: 2px;
  font-size: 12.5px;
}
.crucible-studio-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-block-size: 34px;
}
.crucible-studio-setting select {
  inline-size: 132px;
}
.crucible-studio-setting input[type="checkbox"] {
  inline-size: 16px;
  block-size: 16px;
  margin: 0;
  accent-color: var(--studio-text);
}
.crucible-studio dialog.crucible-studio-setup-dialog {
  width: min(780px, calc(100vw - 32px));
  max-block-size: calc(100vh - 48px);
  border: 1px solid var(--studio-border);
}
.crucible-studio dialog.crucible-studio-setup-dialog:focus { outline: none; }
.crucible-studio dialog.crucible-studio-setup-dialog[open] {
  display: flex;
  flex-direction: column;
  gap: var(--studio-space-16);
  padding: var(--studio-space-24);
}
.crucible-studio dialog.crucible-studio-setup-dialog h2 { margin: 0; }
.crucible-studio-setup-steps {
  display: flex;
  flex-wrap: wrap;
  gap: var(--studio-space-4);
  margin-inline-start: calc(var(--studio-space-8) * -1);
}
.crucible-studio dialog button.crucible-studio-setup-step {
  padding-inline: var(--studio-space-8);
  background: transparent;
  color: var(--studio-muted);
  font-weight: 600;
}
/* The step you are on is told apart by its text colour and a soft fill, not by weight, so no label changes width. */
.crucible-studio dialog button.crucible-studio-setup-step[data-current="true"] {
  background: color-mix(in srgb, var(--studio-text) 8%, transparent);
  color: var(--studio-text);
}
.crucible-studio-setup-body {
  flex: 1 1 auto;
  min-block-size: 0;
  display: grid;
  gap: var(--studio-space-16);
  align-content: start;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--studio-muted) transparent;
}
.crucible-studio-setup-group {
  display: grid;
  gap: var(--studio-space-16);
}
/* Every step shares one grid cell, so the dialog takes the height of the tallest step and never jumps. A step that is not
   shown is invisible and inert, not removed. A step with one block (the theme cards, the tiers, the prompt) fills the cell. */
.crucible-studio-setup-body { grid-template-columns: minmax(0, 1fr); }
.crucible-studio-setup-group {
  grid-area: 1 / 1;
  align-content: start;
}
.crucible-studio-setup-group[data-fill="true"] { grid-template-rows: minmax(0, 1fr); }
.crucible-studio-setup-group[inert] { visibility: hidden; }
/* The step row names the step, so a heading would say it twice. */
.crucible-studio dialog .crucible-studio-setup-group h3 { display: none; }
.crucible-studio-setup-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  align-items: start;
  gap: var(--studio-space-16);
}
/* A card has one inset on all four sides. Its groups (logo and name, the keys, the numbers) sit one step apart, wider than
   the 8px inside a group, and its content fills the width, so the right inset is the same as the left. */
.crucible-studio-setup-card {
  position: relative;
  display: grid;
  align-content: start;
  justify-items: stretch;
  gap: var(--studio-space-16);
  min-inline-size: 0;
  padding: var(--studio-space-16);
  border: 1px solid var(--studio-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--studio-text) 6%, transparent);
  cursor: pointer;
}
.crucible-studio-setup-card input {
  position: absolute;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.crucible-studio-setup-card[data-selected="true"] {
  border-color: var(--studio-text);
  box-shadow: inset 0 0 0 1px var(--studio-text);
}
/* Keyboard focus is one ring that takes the selected border's place, never a second ring beside it. */
.crucible-studio-setup-card:has(input:focus-visible) {
  border-color: var(--studio-accent);
  box-shadow: inset 0 0 0 1px var(--studio-accent);
}
.crucible-studio-setup-card-name {
  display: flex;
  align-items: baseline;
  gap: var(--studio-space-4);
  max-inline-size: 100%;
  padding-inline-end: var(--studio-space-24);
}
.crucible-studio-setup-card-label { font-weight: 600; }
.crucible-studio-setup-card-name > .crucible-studio-icon { align-self: center; }
/* A tier card is tall, so its icon is the picture of the tier: large, above the name. */
.crucible-studio-setup-cards-wide .crucible-studio-setup-card-name,
.crucible-studio-setup-cards-keys .crucible-studio-setup-card-name {
  flex-direction: column;
  align-items: start;
  gap: var(--studio-space-8);
}
.crucible-studio-setup-cards-wide .crucible-studio-setup-card-name > .crucible-studio-icon,
.crucible-studio-setup-cards-keys .crucible-studio-setup-card-name > .crucible-studio-icon {
  align-self: start;
  inline-size: 44px;
  block-size: 44px;
}
.crucible-studio-setup-cards-wide .crucible-studio-setup-card-detail { white-space: normal; }
.crucible-studio-setup-card-detail {
  inline-size: 100%;
  overflow: hidden;
  color: var(--studio-muted);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crucible-studio-setup-facts {
  display: flex;
  gap: var(--studio-space-12);
  font-family: var(--studio-font-heading);
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.crucible-studio-setup-check {
  position: absolute;
  inset-block-start: var(--studio-space-16);
  inset-inline-end: var(--studio-space-16);
  display: none;
  inline-size: 18px;
  block-size: 18px;
  place-items: center;
  border-radius: 999px;
  background: var(--studio-text);
  color: var(--studio-bg);
}
.crucible-studio-setup-card[data-selected="true"] .crucible-studio-setup-check { display: grid; }
.crucible-studio-setup-check .crucible-studio-icon {
  inline-size: 12px;
  block-size: 12px;
  stroke-width: 2.4;
}
/* The three theme cards fill the row. Each card holds a miniature of the real Studio at the real window's proportions. */
.crucible-studio-setup-cards-theme {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.crucible-studio-setup-cards-theme .crucible-studio-setup-card { justify-items: stretch; }
/* The tick sits beside the label under the miniature, the same place on every card, never over a half that may be dark. */
.crucible-studio-setup-cards-theme .crucible-studio-setup-check {
  inset-block-start: auto;
  inset-block-end: var(--studio-space-16);
}
/* The miniature is a Studio root laid out at 960 by 600 pixels and scaled to the card's width, so every proportion is the
   real one. It is a root of its own with a forced theme, so its tokens resolve again on that element and it shows its
   own theme whatever theme the Studio around the dialog is in. The outer border takes the dialog's theme, so Light stays
   visible on a light dialog and Dark on a dark one. The fixed scale is the fallback for a browser without typed arithmetic. */
.crucible-studio-setup-preview {
  position: relative;
  display: block;
  inline-size: 100%;
  aspect-ratio: 8 / 5;
  container-type: inline-size;
  overflow: hidden;
  border: 1px solid var(--studio-border);
  border-radius: 6px;
  pointer-events: none;
}
.crucible-studio-setup-preview > .crucible-studio-miniature {
  position: absolute;
  inset-block-start: 0;
  inset-inline-start: 0;
  inline-size: 960px;
  block-size: 600px;
  min-block-size: 0;
  --studio-side-width: 284px;
  transform-origin: 0 0;
  scale: 0.22;
  scale: calc(100cqw / 960px);
}
.crucible-studio-miniature[data-half="left"] { clip-path: inset(0 50% 0 0); }
.crucible-studio-miniature[data-half="right"] { clip-path: inset(0 0 0 50%); }
.crucible-studio-setup-cards-wide {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
.crucible-studio-setup-cards-keys {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
/* The key caps of a keymap card: each tool's icon over its key, the same four in every card so the rows compare. */
.crucible-studio-setup-keycaps {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--studio-space-8);
}
.crucible-studio-setup-keycap {
  display: grid;
  justify-items: center;
  gap: var(--studio-space-8);
  color: var(--studio-text);
}
.crucible-studio-setup-keycap > .crucible-studio-icon {
  inline-size: 18px;
  block-size: 18px;
}
.crucible-studio .crucible-studio-setup-keycap kbd {
  box-sizing: border-box;
  inline-size: 100%;
  padding: var(--studio-space-12) 0;
  border: 1px solid var(--studio-border);
  border-radius: 6px;
  background: var(--studio-bg);
  color: var(--studio-text);
  font-family: var(--studio-font);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.2;
  text-align: center;
}
.crucible-studio-setup-row {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  align-items: start;
  gap: var(--studio-space-12);
}
.crucible-studio-setup-row-label {
  display: flex;
  align-items: center;
  gap: var(--studio-space-8);
  min-block-size: 36px;
}
/* One chip grid for every row: six equal columns, each row starting at the first, so a row is one line and the
   columns line up from row to row. The tick has a box of its own after the label in every chip, selected or not and
   only transparent when not (visibility would show through a hidden step), so a chip never changes width and the label and tick keep one even gap. */
.crucible-studio-setup-chips {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: var(--studio-space-8);
}
.crucible-studio-setup-chips .crucible-studio-setup-card {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--studio-space-4);
  block-size: 36px;
  padding: 0 var(--studio-space-8);
}
.crucible-studio-setup-chips .crucible-studio-setup-card-name { padding-inline-end: 0; }
.crucible-studio-setup-chips .crucible-studio-setup-card-label { font-weight: 500; }
.crucible-studio-setup-chips .crucible-studio-setup-check {
  position: static;
  display: grid;
  flex: none;
  inline-size: 12px;
  block-size: 12px;
  opacity: 0;
}
.crucible-studio-setup-chips .crucible-studio-setup-card[data-selected="true"] .crucible-studio-setup-check { opacity: 1; }
/* A handle chip carries a dot and a workspace chip an icon beside the name and the tick, which one column cannot hold, so they take two. */
.crucible-studio-setup-chips .crucible-studio-setup-card:has(.crucible-studio-setup-handle),
.crucible-studio-setup-chips .crucible-studio-setup-card:has(.crucible-studio-setup-card-name > .crucible-studio-icon) { grid-column: span 2; }
.crucible-studio-setup-chips .crucible-studio-setup-check .crucible-studio-icon {
  inline-size: 9px;
  block-size: 9px;
}
/* The dot sits in a box of one size, so the labels of the three sizes share a baseline. */
.crucible-studio-setup-handle {
  display: grid;
  place-items: center;
  flex: none;
  inline-size: 18px;
  block-size: 18px;
}
.crucible-studio-setup-handle::before {
  content: "";
  border-radius: 999px;
  background: var(--studio-text);
}
.crucible-studio-setup-handle[data-size="small"]::before { inline-size: 8px; block-size: 8px; }
.crucible-studio-setup-handle[data-size="medium"]::before { inline-size: 12px; block-size: 12px; }
.crucible-studio-setup-handle[data-size="large"]::before { inline-size: 18px; block-size: 18px; }
/* The chat mark stands beside the prompt box, which is as tall as its text; the block rests in the middle of the step. */
.crucible-studio-setup-agent {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-content: center;
  align-items: start;
  gap: 12px;
}
.crucible-studio-setup-agent > button,
.crucible-studio-setup-agent > textarea { grid-column: 2; justify-self: start; }
.crucible-studio-setup-agent > textarea { justify-self: stretch; }
.crucible-studio-setup-agent-mark {
  display: grid;
  place-items: center;
  inline-size: 40px;
  block-size: 40px;
  border: 1px solid var(--studio-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--studio-text) 6%, transparent);
}
.crucible-studio-setup-agent-mark .crucible-studio-icon {
  inline-size: 22px;
  block-size: 22px;
}
.crucible-studio textarea.crucible-studio-setup-prompt {
  inline-size: 100%;
  field-sizing: content;
  max-block-size: 160px;
  padding: 12px;
  border: 1px solid var(--studio-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--studio-text) 6%, transparent);
  color: var(--studio-text);
  font-family: var(--studio-font-mono);
  font-size: 12px;
  line-height: 1.5;
  overflow: auto;
  resize: none;
  user-select: text;
}
.crucible-studio-setup-actions { align-items: center; margin-top: 10px; }
.crucible-studio dialog button.crucible-studio-setup-skip {
  margin-inline: -11px auto;
  background: transparent;
  color: var(--studio-text);
}
.crucible-studio dialog button.crucible-studio-setup-primary {
  min-inline-size: 88px;
  background: var(--studio-text);
  color: var(--studio-bg);
  font-weight: 600;
}
.crucible-studio dialog button[hidden] { display: none; }
@media (prefers-reduced-motion: no-preference) {
  .crucible-studio-setup-card { transition: border-color var(--studio-motion-quick) var(--studio-ease-out), box-shadow var(--studio-motion-quick) var(--studio-ease-out); }
}
.crucible-studio-shortcuts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 16px;
  font-size: 12.5px;
}
.crucible-studio-shortcut-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}
.crucible-studio kbd {
  padding: 2px 8px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--studio-text) 8%, transparent);
  font-family: var(--studio-font-mono);
  font-size: 11px;
  color: var(--studio-text);
  white-space: nowrap;
}
.crucible-studio dialog.crucible-studio-shortcuts-dialog {
  width: min(680px, calc(100vw - 32px));
}
/* Docked panels: the bar, the rail and the column take the edges of the window and the viewport is the room they
   leave, so the scene is drawn at that size and nothing lies over it. Below the compact width the panels float. */
.crucible-studio[data-floating="false"]:not([data-compact="true"]) {
  --studio-dock-bar: 52px;
  --studio-dock-side: min(var(--studio-side-width, 284px), calc(100% - var(--studio-rail) - 160px));
}
.crucible-studio[data-floating="false"][data-outliner-collapsed="true"][data-inspector-collapsed="true"] {
  --studio-dock-side: 0px;
}
.crucible-studio[data-floating="false"]:not([data-compact="true"]) .crucible-studio-viewport {
  inset: var(--studio-dock-bar) var(--studio-dock-side) 0 var(--studio-rail);
}
.crucible-studio[data-floating="false"]:not([data-compact="true"]) .crucible-studio-menubar {
  inset: 0 0 auto;
  box-sizing: border-box;
  block-size: var(--studio-dock-bar);
  padding-inline: 4px;
  background: var(--studio-panel);
  pointer-events: auto;
}
.crucible-studio[data-floating="false"]:not([data-compact="true"]) .crucible-studio-menubar .crucible-studio-island,
.crucible-studio[data-floating="false"]:not([data-compact="true"]) .crucible-studio-toolbar {
  border-color: transparent;
  border-radius: 0;
  box-shadow: none;
}
/* The Scene list and Properties keep their outline and a gap in the docked column, so they read as two cards. */
.crucible-studio[data-floating="false"]:not([data-compact="true"]) .crucible-studio-side > .crucible-studio-dock {
  border-radius: 8px;
  box-shadow: none;
}
.crucible-studio[data-floating="false"]:not([data-compact="true"]) .crucible-studio-toolbar {
  inset-block: var(--studio-dock-bar) 0;
  inset-inline-start: 0;
  box-sizing: border-box;
  inline-size: var(--studio-rail);
}
.crucible-studio[data-floating="false"]:not([data-compact="true"]) .crucible-studio-side {
  inset-block: var(--studio-dock-bar) 0;
  inset-inline-end: 0;
  inline-size: var(--studio-dock-side);
  max-inline-size: none;
  box-sizing: border-box;
  padding: 8px;
  gap: 4px;
  align-items: stretch;
  background: var(--studio-panel);
  pointer-events: auto;
}
/* One column width and one split: the cards fill the column whatever the floating cards were sized to. */
.crucible-studio[data-floating="false"]:not([data-compact="true"]) .crucible-studio-side > .crucible-studio-dock {
  inline-size: auto;
  max-inline-size: none;
}
/* The viewport already ends where the column starts, so the widget takes its top right corner. */
.crucible-studio[data-floating="false"]:not([data-compact="true"]) .crucible-studio-view-widget {
  inset-inline-end: var(--studio-edge);
  inset-block-start: var(--studio-edge);
}
.crucible-studio[data-floating="false"][data-outliner-collapsed="true"][data-inspector-collapsed="true"] .crucible-studio-side {
  display: none;
}
/* A docked column runs the whole window height, so the Scene list takes more of it and less is left empty under a short Properties panel. */
.crucible-studio[data-floating="false"]:not([data-compact="true"]):not([data-scene-sized="true"]):not([data-outliner-minimized="true"]) .crucible-studio-side > .crucible-studio-outliner {
  flex-basis: 45%;
}
/* Inside the docked viewport nothing has to step around the rail or the bar. */
.crucible-studio[data-floating="false"]:not([data-compact="true"]) .crucible-studio-readout {
  inset-inline-start: var(--studio-edge);
}
.crucible-studio[data-floating="false"]:not([data-compact="true"]) .crucible-studio-status {
  inset-block-start: var(--studio-edge);
}
.crucible-studio[data-floating="false"]:not([data-compact="true"]) .crucible-studio-bottombar {
  inset-inline-start: calc(var(--studio-rail) + (100% - var(--studio-rail) - var(--studio-dock-side)) / 2);
  inline-size: min(620px, calc(100% - var(--studio-rail) - var(--studio-dock-side) - var(--studio-edge) * 2));
}
@media (forced-colors: active) {
  .crucible-studio button[aria-pressed="true"] {
    outline: 2px solid Highlight;
  }
}
`;
