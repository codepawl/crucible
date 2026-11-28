// Styles of the Animate timeline's property rows and key editor (studio-timeline-rows.js) and of the key button on the
// Object panel's rows (studio-property-key-buttons.js).
import { SCRUB_THUMB_WIDTH } from './studio-timeline-keys.js';
import { registerStudioStyle } from './studio-registry.js';

const STUDIO_TIMELINE_ROWS_CSS = `
/* The rows sit above the scrub row, so the bar wraps: rows and editor take a full line, the scrub row and bookmarks share the last. */
.crucible-studio-bottombar { flex-wrap: wrap; }
.crucible-studio-keyrows,
.crucible-studio-keyeditor {
  flex: 0 0 100%;
  min-inline-size: 0;
}
.crucible-studio-keyrows[hidden],
.crucible-studio-keyeditor[hidden] { display: none; }
.crucible-studio-keyrows {
  display: flex;
  flex-direction: column;
  gap: 0;
  max-block-size: 120px;
  overflow-y: auto;
}
/* The title column is as wide as the buttons of the scrub row, so a lane lies over the scrub track and keys line up. */
.crucible-studio-keyrow {
  display: grid;
  grid-template-columns: var(--studio-scrub-lead, 114px) minmax(0, 1fr) var(--studio-scrub-tail, 94px);
  align-items: center;
  min-block-size: 28px;
}
.crucible-studio-keyrow-title {
  padding-inline-start: var(--studio-space-8);
  font-size: 11.5px;
  color: var(--studio-muted);
}
.crucible-studio-keylane {
  position: relative;
  block-size: 28px;
}
.crucible-studio-keylane::before {
  content: "";
  position: absolute;
  inset-inline: ${SCRUB_THUMB_WIDTH / 2}px;
  inset-block-start: 50%;
  block-size: 1px;
  background: color-mix(in srgb, var(--studio-text) 14%, transparent);
}
.crucible-studio-keyplayhead {
  position: absolute;
  inset-block: 4px;
  inline-size: 2px;
  margin-inline-start: -1px;
  border-radius: 1px;
  background: var(--studio-accent);
  opacity: 0.7;
  pointer-events: none;
}
.crucible-studio .crucible-studio-lane-key {
  position: absolute;
  inset-block-start: 50%;
  transform: translate(-50%, -50%);
  min-inline-size: 0;
  min-block-size: 0;
  inline-size: 20px;
  block-size: 24px;
  padding: 0;
  color: var(--studio-muted);
  touch-action: none;
}
.crucible-studio button.crucible-studio-lane-key[aria-pressed="true"] {
  background: transparent;
  color: var(--studio-accent);
}
.crucible-studio-lane-key .crucible-studio-icon {
  inline-size: 12px;
  block-size: 12px;
  fill: currentColor;
}
.crucible-studio-keyeditor {
  display: flex;
  align-items: center;
  gap: var(--studio-space-4);
  padding-block-end: var(--studio-space-4);
}
.crucible-studio-keyeditor input[type="number"] {
  flex: 1 1 0;
  min-inline-size: 0;
  inline-size: 0;
  min-block-size: 28px;
  font-family: var(--studio-font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 11.5px;
}
.crucible-studio-keyeditor select {
  flex: 2 1 0;
  min-inline-size: 0;
  min-block-size: 28px;
  font-size: 11.5px;
}
/* The key button of an Object panel row: an outline diamond, filled when the object has a key on that property here. */
.crucible-studio button.crucible-studio-key-toggle { margin-inline-start: auto; }
.crucible-studio button.crucible-studio-key-toggle[aria-pressed="true"] { color: var(--studio-accent); background: transparent; }
.crucible-studio-key-toggle[aria-pressed="true"] .crucible-studio-icon { fill: currentColor; }
.crucible-studio-properties [data-driven="true"] button.crucible-studio-key-toggle { opacity: 1; }
`;

registerStudioStyle(STUDIO_TIMELINE_ROWS_CSS);
