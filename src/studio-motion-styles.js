// Motion rules for Studio dialogs, backdrop, file drop overlay, viewport notices, panel expands and button press feedback.
export const STUDIO_MOTION_CSS = `
@supports (transition-behavior: allow-discrete) {
  @media (prefers-reduced-motion: no-preference) {
    .crucible-studio dialog {
      opacity: 0;
      translate: 0 4px;
      pointer-events: none;
      transition: opacity var(--studio-motion-quick) var(--studio-ease-out), translate var(--studio-motion-quick) var(--studio-ease-out), display var(--studio-motion-quick) var(--studio-ease-out) allow-discrete, overlay var(--studio-motion-quick) var(--studio-ease-out) allow-discrete;
    }
    .crucible-studio dialog[open] {
      opacity: 1;
      translate: 0 0;
      pointer-events: auto;
      transition: opacity var(--studio-motion-base) var(--studio-ease-out), translate var(--studio-motion-base) var(--studio-ease-out);
    }
    @starting-style {
      .crucible-studio dialog[open] {
        opacity: 0;
        translate: 0 6px;
      }
    }
    .crucible-studio dialog::backdrop {
      opacity: 0;
      transition: opacity var(--studio-motion-quick) var(--studio-ease-out), display var(--studio-motion-quick) var(--studio-ease-out) allow-discrete, overlay var(--studio-motion-quick) var(--studio-ease-out) allow-discrete;
    }
    .crucible-studio dialog[open]::backdrop {
      opacity: 1;
      transition: opacity var(--studio-motion-base) var(--studio-ease-out);
    }
    @starting-style {
      .crucible-studio dialog[open]::backdrop { opacity: 0; }
    }
    .crucible-studio-drop-overlay {
      opacity: 0;
      transition: opacity var(--studio-motion-exit) var(--studio-ease-out), display var(--studio-motion-exit) var(--studio-ease-out) allow-discrete;
    }
    .crucible-studio-viewport[data-drop-active="true"] .crucible-studio-drop-overlay {
      opacity: 1;
      transition: opacity var(--studio-motion-quick) var(--studio-ease-out);
    }
    @starting-style {
      .crucible-studio-viewport[data-drop-active="true"] .crucible-studio-drop-overlay { opacity: 0; }
    }
    .crucible-studio-paused,
    .crucible-studio-draft,
    .crucible-studio-pass-notice,
    .crucible-studio-numpad-notice {
      opacity: 1;
      translate: 0 0;
      transition: opacity var(--studio-motion-base) var(--studio-ease-out), translate var(--studio-motion-base) var(--studio-ease-out);
    }
    .crucible-studio-paused[hidden],
    .crucible-studio-draft[hidden],
    .crucible-studio-pass-notice[hidden],
    .crucible-studio-numpad-notice[hidden] {
      opacity: 0;
      translate: 0 -4px;
      pointer-events: none;
      transition: opacity var(--studio-motion-quick) var(--studio-ease-out), translate var(--studio-motion-quick) var(--studio-ease-out), display var(--studio-motion-quick) var(--studio-ease-out) allow-discrete;
    }
    @starting-style {
      :is(.crucible-studio-paused, .crucible-studio-draft, .crucible-studio-pass-notice, .crucible-studio-numpad-notice):not([hidden]) {
        opacity: 0;
        translate: 0 -6px;
      }
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .crucible-studio dialog {
      opacity: 0;
      pointer-events: none;
      transition: opacity var(--studio-motion-fade) var(--studio-ease-out), display var(--studio-motion-fade) var(--studio-ease-out) allow-discrete, overlay var(--studio-motion-fade) var(--studio-ease-out) allow-discrete;
    }
    .crucible-studio dialog[open] {
      opacity: 1;
      pointer-events: auto;
      transition: opacity var(--studio-motion-fade) var(--studio-ease-out);
    }
    @starting-style {
      .crucible-studio dialog[open] { opacity: 0; }
    }
    .crucible-studio dialog::backdrop {
      opacity: 0;
      transition: opacity var(--studio-motion-fade) var(--studio-ease-out), display var(--studio-motion-fade) var(--studio-ease-out) allow-discrete, overlay var(--studio-motion-fade) var(--studio-ease-out) allow-discrete;
    }
    .crucible-studio dialog[open]::backdrop {
      opacity: 1;
      transition: opacity var(--studio-motion-fade) var(--studio-ease-out);
    }
    @starting-style {
      .crucible-studio dialog[open]::backdrop { opacity: 0; }
    }
    .crucible-studio-drop-overlay {
      opacity: 0;
      transition: opacity var(--studio-motion-fade) var(--studio-ease-out), display var(--studio-motion-fade) var(--studio-ease-out) allow-discrete;
    }
    .crucible-studio-viewport[data-drop-active="true"] .crucible-studio-drop-overlay {
      opacity: 1;
      transition: opacity var(--studio-motion-fade) var(--studio-ease-out);
    }
    @starting-style {
      .crucible-studio-viewport[data-drop-active="true"] .crucible-studio-drop-overlay { opacity: 0; }
    }
    .crucible-studio-paused,
    .crucible-studio-draft,
    .crucible-studio-pass-notice,
    .crucible-studio-numpad-notice {
      opacity: 1;
      transition: opacity var(--studio-motion-fade) var(--studio-ease-out);
    }
    .crucible-studio-paused[hidden],
    .crucible-studio-draft[hidden],
    .crucible-studio-pass-notice[hidden],
    .crucible-studio-numpad-notice[hidden] {
      opacity: 0;
      pointer-events: none;
      transition: opacity var(--studio-motion-fade) var(--studio-ease-out), display var(--studio-motion-fade) var(--studio-ease-out) allow-discrete;
    }
    @starting-style {
      :is(.crucible-studio-paused, .crucible-studio-draft, .crucible-studio-pass-notice, .crucible-studio-numpad-notice):not([hidden]) { opacity: 0; }
    }
  }
}
@media (prefers-reduced-motion: no-preference) {
  .crucible-studio-dock {
    opacity: 1;
    transition: opacity var(--studio-motion-quick) var(--studio-ease-out);
  }
  @starting-style {
    .crucible-studio-dock { opacity: 0; }
  }
  .crucible-studio[data-outliner-minimized="false"] .crucible-studio-outliner > :not(.crucible-studio-dock-head):not(.crucible-studio-grip),
  .crucible-studio[data-inspector-minimized="false"] .crucible-studio-inspector > :not(.crucible-studio-dock-head):not(.crucible-studio-grip),
  .crucible-studio[data-history-minimized="false"] .crucible-studio-history > :not(.crucible-studio-dock-head),
  .crucible-studio[data-agent-minimized="false"] .crucible-studio-agent > :not(.crucible-studio-dock-head) {
    opacity: 1;
    transition: opacity var(--studio-motion-quick) var(--studio-ease-out);
  }
  @starting-style {
    .crucible-studio[data-outliner-minimized="false"] .crucible-studio-outliner > :not(.crucible-studio-dock-head):not(.crucible-studio-grip),
    .crucible-studio[data-inspector-minimized="false"] .crucible-studio-inspector > :not(.crucible-studio-dock-head):not(.crucible-studio-grip),
    .crucible-studio[data-history-minimized="false"] .crucible-studio-history > :not(.crucible-studio-dock-head),
    .crucible-studio[data-agent-minimized="false"] .crucible-studio-agent > :not(.crucible-studio-dock-head) {
      opacity: 0;
    }
  }
  .crucible-studio-toolbar button,
  .crucible-studio button.crucible-studio-primary-btn,
  .crucible-studio dialog button.crucible-studio-dialog-primary,
  .crucible-studio dialog button.crucible-studio-setup-primary,
  .crucible-studio-agent button.crucible-studio-agent-send {
    transition: background var(--studio-motion-quick) var(--studio-ease-out), color var(--studio-motion-quick) var(--studio-ease-out), opacity var(--studio-motion-quick) var(--studio-ease-out), scale var(--studio-motion-quick) var(--studio-ease-out);
  }
  :is(
    .crucible-studio-toolbar button,
    .crucible-studio button.crucible-studio-primary-btn,
    .crucible-studio dialog button.crucible-studio-dialog-primary,
    .crucible-studio dialog button.crucible-studio-setup-primary,
    .crucible-studio-agent button.crucible-studio-agent-send
  ):not([aria-disabled="true"]):active {
    scale: 0.97;
  }
  .crucible-studio-popover button[data-keeps-menu="true"] > .crucible-studio-icon[data-recent-chevron],
  .crucible-studio-modifier-add > .crucible-studio-icon:last-child {
    transition: transform var(--studio-motion-quick) var(--studio-ease-out);
  }
  .crucible-studio-modifier {
    transition: background var(--studio-motion-quick) var(--studio-ease-out);
  }
}
.crucible-studio[data-motion="reduced"] dialog,
.crucible-studio[data-motion="reduced"] dialog::backdrop,
.crucible-studio[data-motion="reduced"] .crucible-studio-paused,
.crucible-studio[data-motion="reduced"] .crucible-studio-draft,
.crucible-studio[data-motion="reduced"] .crucible-studio-pass-notice,
.crucible-studio[data-motion="reduced"] .crucible-studio-numpad-notice {
  translate: none;
}
.crucible-studio[data-motion="reduced"] .crucible-studio-keyboard-dot,
.crucible-studio[data-motion="reduced"] .crucible-studio-name-busy .crucible-studio-icon {
  animation: none;
}
`;
