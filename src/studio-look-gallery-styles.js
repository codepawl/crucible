// Styles of the Looks gallery (studio-look-gallery.js): two columns of pictures; a name sits close under its picture (4px) and the gap
// between rows is larger (12px), so a name belongs to its own picture. A look still being drawn is an empty slot: dashed, on a quiet surface.
import { registerStudioStyle } from './studio-registry.js';

registerStudioStyle(`
.crucible-studio-look-gallery { position: relative; }
.crucible-studio-look-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--studio-space-12) var(--studio-space-8);
}
.crucible-studio button.crucible-studio-look-card {
  display: grid;
  justify-items: stretch;
  gap: var(--studio-space-4);
  min-inline-size: 0;
  min-block-size: 0;
  padding: 0;
  text-align: start;
  background: transparent;
}
.crucible-studio-look-thumb {
  display: block;
  aspect-ratio: 8 / 5;
  overflow: hidden;
  border: 1px dashed var(--studio-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--studio-text) 4%, transparent);
}
.crucible-studio-look-thumb:has(img:not([hidden])) { border-style: solid; border-color: transparent; }
.crucible-studio-look-thumb img {
  display: block;
  inline-size: 100%;
  block-size: 100%;
  object-fit: cover;
}
.crucible-studio-look-name {
  font-size: 11.5px;
  color: var(--studio-muted);
}
.crucible-studio-look-card[aria-pressed="true"] .crucible-studio-look-thumb {
  outline: 2px solid var(--studio-text);
  outline-offset: 1px;
}
.crucible-studio-look-card[aria-pressed="true"] .crucible-studio-look-name { color: var(--studio-text); font-weight: 600; }
.crucible-studio-look-card:hover:not([aria-pressed="true"]) .crucible-studio-look-name { color: var(--studio-text); }
.crucible-studio-look-canvas {
  position: absolute;
  inset-block-start: 0;
  inset-inline-start: 0;
  inline-size: 256px;
  block-size: 160px;
  visibility: hidden;
  pointer-events: none;
}
`);
