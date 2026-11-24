// Styles of the Modifiers tab (studio-modifier-panel.js). Spacing uses the Studio scale: a card has the same padding on all four
// sides, the gap inside a card is smaller than the gap between cards, and the gap between the bar and the list is the larger step.
export const MODIFIER_CSS = `
.crucible-studio-modifiers,
.crucible-studio-modifier-list,
.crucible-studio-modifier {
  grid-template-columns: minmax(0, 1fr);
}
.crucible-studio-modifiers {
  display: grid;
  align-content: start;
  gap: var(--studio-space-12);
}
.crucible-studio-modifiers [hidden] { display: none; }
.crucible-studio-modifier-bar {
  display: flex;
  align-items: center;
  gap: var(--studio-space-8);
}
.crucible-studio-modifier-bar > select { flex: 1; min-inline-size: 0; }
.crucible-studio-modifier-empty {
  margin: 0;
  color: var(--studio-muted);
}
.crucible-studio-modifier-list {
  display: grid;
  gap: var(--studio-space-12);
}
.crucible-studio-modifier {
  display: grid;
  gap: var(--studio-space-8);
  padding: var(--studio-space-8);
  border-radius: 8px;
  background: var(--studio-surface);
}
/* Rows sit 8px apart, as far as the gap inside a row, so the audit reads them as groups; values end on the 24px step. */
.crucible-studio-modifier .crucible-studio-property-rows { gap: var(--studio-space-8); }
.crucible-studio-modifier .crucible-studio-prop { --studio-number-inset: var(--studio-space-24); }
.crucible-studio-modifier[data-enabled="false"] .crucible-studio-modifier-title,
.crucible-studio-modifier[data-enabled="false"] .crucible-studio-property-rows { opacity: 0.5; }
.crucible-studio-modifier-menu {
  display: flex;
  flex-wrap: wrap;
  gap: var(--studio-space-4);
}
.crucible-studio-modifier-menu > button { min-block-size: 28px; padding: 4px 8px; }
.crucible-studio-modifier-head {
  min-inline-size: 0;
  display: flex;
  align-items: center;
  gap: var(--studio-space-4);
}
.crucible-studio button.crucible-studio-modifier-title {
  flex: 1;
  justify-content: flex-start;
  min-inline-size: 0;
  padding: 0;
  font-family: var(--studio-font-heading);
  font-size: 12px;
  font-weight: 600;
}
.crucible-studio-modifier-title > span { overflow: hidden; text-overflow: ellipsis; }
.crucible-studio-modifier-title .crucible-studio-icon:first-child { transition: transform var(--studio-motion-quick) var(--studio-ease-out); }
.crucible-studio-modifier[data-open="true"] .crucible-studio-modifier-title .crucible-studio-icon:first-child { transform: rotate(90deg); }
.crucible-studio button.crucible-studio-modifier-grip { cursor: grab; color: var(--studio-muted); }
.crucible-studio-modifier[data-drop] { background: color-mix(in srgb, var(--studio-accent) 18%, var(--studio-surface)); }
@media (pointer: fine) {
  .crucible-studio .crucible-studio-modifier-head button[data-icon] {
    inline-size: 24px;
    min-inline-size: 24px;
    min-block-size: 24px;
  }
  .crucible-studio .crucible-studio-modifier-head button.crucible-studio-modifier-grip { inline-size: 20px; min-inline-size: 20px; }
}
`;
