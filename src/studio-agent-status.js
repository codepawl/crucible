// What the host reports about the agent, under and beside the Agent card's field: the model, the effort and the mode as one quiet
// row (the `status` event), and the credit that is left as a small ring (the `usage` event). This file reads both events, draws the
// row and the ring and holds no state about the conversation. The newest status replaces the one before as a whole, and so does the
// newest usage: a field a status leaves out disappears.
import { popoverOpeningStyle } from './studio-popover-motion.js';

export const AGENT_STATUS_LIMITS = Object.freeze({ valueLength: 40, unitLength: 20 });

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const ROW_FIELDS = Object.freeze([
  { field: 'model', icon: 'agent' },
  { field: 'effort', icon: 'speed' },
  { field: 'mode', icon: 'settings' },
]);
const DEFAULT_UNIT = 'credits';
const TIP_GAP = 8;
const TIP_EDGE = 12;
const numberFormat = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const resetFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

function boundedValue(value, longest) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().slice(0, longest).trim();
  return trimmed === '' ? undefined : trimmed;
}

function parseResetTime(value) {
  const milliseconds = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

/**
 * The `usage` event as Studio keeps it: `used` (held between 0 and `limit`), `remaining` (limit minus used), `limit`, `unit`
 * ("credits" when missing) and `resetsAt` in milliseconds when it parses. Without a finite `used` and a finite `limit` above zero
 * it is { type: 'usage' } with nothing in it, and the card ignores it: the ring stays as it was.
 */
export function parseAgentUsage(event) {
  const { used, limit } = event;
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
    return { type: 'usage' };
  }
  const held = Math.min(Math.max(used, 0), limit);
  const parsed = {
    type: 'usage',
    used: held,
    remaining: limit - held,
    limit,
    unit: boundedValue(event.unit, AGENT_STATUS_LIMITS.unitLength) ?? DEFAULT_UNIT,
  };
  const resetsAt = parseResetTime(event.resetsAt);
  if (resetsAt !== undefined) {
    parsed.resetsAt = resetsAt;
  }
  return parsed;
}

/**
 * The `status` event as Studio keeps it: the model, effort and mode as trimmed text (up to 40 characters), each only when it is
 * valid. A value that is not valid is left out, never made up, and the event is not an error.
 */
export function parseAgentStatus(event) {
  const status = { type: 'status' };
  for (const { field } of ROW_FIELDS) {
    const value = boundedValue(event[field], AGENT_STATUS_LIMITS.valueLength);
    if (value !== undefined) {
      status[field] = value;
    }
  }
  return status;
}

/** By the share used: plenty under 50%, half from 50% to under 80%, low from 80% to under 100%, empty at 100%. */
export function agentUsageLevel({ used, limit }) {
  if (used >= limit) {
    return 'empty';
  }
  if (used * 10 >= limit * 8) {
    return 'low';
  }
  return used * 2 >= limit ? 'half' : 'plenty';
}

/** "12 of 50 credits left" and, when the host gave a time, "Resets 1 Dec"; `name` is both as one sentence pair. */
export function describeAgentUsage(usage) {
  const left = `${numberFormat.format(usage.remaining)} of ${numberFormat.format(usage.limit)} ${usage.unit} left`;
  const reset = usage.resetsAt === undefined ? '' : `Resets ${resetFormat.format(usage.resetsAt)}`;
  return { left, reset, name: reset ? `${left}. ${reset}` : left };
}

function createSvgElement(documentReference, tagName, className) {
  const element = documentReference.createElementNS(SVG_NAMESPACE, tagName);
  element.setAttribute('class', className);
  return element;
}

function createRing(documentReference) {
  const ring = createSvgElement(documentReference, 'svg', 'crucible-studio-agent-ring');
  ring.setAttribute('aria-hidden', 'true');
  const track = createSvgElement(documentReference, 'circle', 'crucible-studio-agent-ring-track');
  const arc = createSvgElement(documentReference, 'circle', 'crucible-studio-agent-ring-arc');
  arc.setAttribute('pathLength', '100');
  const mark = createSvgElement(documentReference, 'circle', 'crucible-studio-agent-ring-mark');
  ring.append(track, arc, mark);
  return { ring, arc };
}

/**
 * The row and the ring of the Agent card. `row` goes under the field, `button` between the field and Send, `popover` anywhere in the
 * card (it opens in the top layer). `sync(status, usage)` shows what they hold and hides what they do not.
 */
export function createAgentStatusBar({ documentReference, createElement, createIcon }) {
  const row = createElement(documentReference, 'div', { className: 'crucible-studio-agent-status', hidden: true });
  const { ring, arc } = createRing(documentReference);
  const percentText = createElement(documentReference, 'span');
  const percent = createElement(documentReference, 'span', { className: 'crucible-studio-agent-usage-percent', attributes: { 'aria-hidden': 'true' } }, createIcon(documentReference, 'creditToken'), percentText);
  const button = createElement(documentReference, 'button', { type: 'button', className: 'crucible-studio-agent-usage', hidden: true }, ring);
  const leftText = createElement(documentReference, 'span');
  const leftLine = createElement(documentReference, 'span', { className: 'crucible-studio-agent-usage-line' }, createIcon(documentReference, 'creditToken'), leftText);
  const resetLine = createElement(documentReference, 'span');
  const popover = createElement(documentReference, 'div', {
    className: 'crucible-studio-popover crucible-studio-agent-usage-tip',
    id: 'crucible-studio-agent-usage-tip',
    attributes: { popover: 'manual', role: 'tooltip' },
  }, leftLine, resetLine);

  let tipOpen = false;
  let hovered = false;
  let focused = false;
  let dismissed = false;

  function placeTip() {
    const view = documentReference.defaultView;
    const anchor = button.getBoundingClientRect();
    const tip = popover.getBoundingClientRect();
    const opensUpward = anchor.top - tip.height - TIP_GAP >= TIP_EDGE;
    const rightAligned = anchor.right - tip.width;
    const left = Math.min(Math.max(rightAligned, TIP_EDGE), Math.max(view.innerWidth - tip.width - TIP_EDGE, TIP_EDGE));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(opensUpward ? anchor.top - tip.height - TIP_GAP : anchor.bottom + TIP_GAP)}px`;
    const opening = popoverOpeningStyle({ opensUpward, opensLeftward: true });
    popover.style.setProperty('--studio-popover-origin', opening.origin);
    popover.style.setProperty('--studio-popover-shift', opening.shift);
  }

  function closeOnEscape(event) {
    if (event.key !== 'Escape') {
      return;
    }
    event.stopPropagation();
    dismissed = true;
    updateTip();
  }

  function updateTip() {
    const shouldOpen = !button.hidden && !dismissed && (hovered || focused);
    if (shouldOpen === tipOpen) {
      return;
    }
    tipOpen = shouldOpen;
    button.setAttribute('aria-expanded', String(shouldOpen));
    if (shouldOpen) {
      popover.style.left = '0px';
      popover.style.top = '0px';
      popover.showPopover();
      placeTip();
      documentReference.addEventListener('keydown', closeOnEscape, true);
    } else {
      popover.hidePopover();
      documentReference.removeEventListener('keydown', closeOnEscape, true);
    }
  }

  function setEngaged(nextHovered, nextFocused) {
    hovered = nextHovered;
    focused = nextFocused;
    if (!hovered && !focused) {
      dismissed = false;
    }
    updateTip();
  }

  button.addEventListener('pointerenter', () => setEngaged(true, focused));
  button.addEventListener('pointerleave', () => setEngaged(false, focused));
  button.addEventListener('focusin', () => setEngaged(hovered, true));
  button.addEventListener('focusout', () => setEngaged(hovered, false));

  function syncRow(status) {
    const items = ROW_FIELDS.filter(({ field }) => status[field]).map(({ field, icon }) => createElement(
      documentReference,
      'span',
      { className: 'crucible-studio-agent-status-item', dataset: { field } },
      createIcon(documentReference, icon),
      createElement(documentReference, 'span', { className: 'crucible-studio-agent-status-text', textContent: status[field] }),
    ));
    row.replaceChildren(...items);
    row.hidden = items.length === 0;
  }

  function syncUsage(usage) {
    button.hidden = !usage;
    if (!usage) {
      setEngaged(false, false);
      return;
    }
    const level = agentUsageLevel(usage);
    const description = describeAgentUsage(usage);
    const share = usage.remaining / usage.limit;
    button.dataset.level = level;
    button.setAttribute('aria-label', description.name);
    arc.style.setProperty('--studio-agent-ring-fill', String(Math.round(share * 1000) / 10));
    leftText.textContent = description.left;
    resetLine.textContent = description.reset;
    resetLine.hidden = description.reset === '';
    percentText.textContent = `${Math.round(share * 100)}%`;
    button.replaceChildren(ring, ...(level === 'plenty' ? [] : [percent]));
  }

  return {
    row,
    button,
    popover,
    sync(status, usage) {
      syncRow(status ?? {});
      syncUsage(usage ?? undefined);
    },
  };
}

/** The row, the ring and its popover. Size and stroke of the ring are custom properties of the card, so a look can override them. */
export const AGENT_STATUS_CSS = `
.crucible-studio-agent {
  --studio-agent-ring-size: 20px;
  --studio-agent-ring-stroke: 2.5px;
}
.crucible-studio-agent-bar {
  flex: none;
  display: grid;
  gap: var(--studio-space-8);
  padding: var(--studio-space-8) var(--studio-space-12);
}
.crucible-studio-agent-status {
  display: flex;
  flex-wrap: wrap;
  gap: var(--studio-space-4) var(--studio-space-12);
  min-inline-size: 0;
  color: color-mix(in srgb, var(--studio-text) 76%, var(--studio-panel));
  font-size: 12px;
}
.crucible-studio-agent-status[hidden] { display: none; }
.crucible-studio-agent-status-item {
  display: inline-flex;
  align-items: center;
  gap: var(--studio-space-4);
  min-inline-size: 0;
  max-inline-size: 100%;
}
.crucible-studio-agent-status-item .crucible-studio-icon { inline-size: 14px; block-size: 14px; }
.crucible-studio-agent-status-text { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The ring's hit area is as tall as the field and Send beside it; the ring sits in the middle of it. */
.crucible-studio-agent button.crucible-studio-agent-usage {
  flex: none;
  gap: var(--studio-space-4);
  min-block-size: 36px;
  padding: 0 var(--studio-space-8);
  --studio-agent-ring-color: var(--studio-icon);
}
.crucible-studio-agent button.crucible-studio-agent-usage[hidden] { display: none; }
.crucible-studio-agent-usage[data-level="half"] { --studio-agent-ring-color: var(--studio-accent); }
.crucible-studio-agent-usage[data-level="low"],
.crucible-studio-agent-usage[data-level="empty"] { --studio-agent-ring-color: var(--studio-warning); }
@media (hover: hover) {
  .crucible-studio-agent button.crucible-studio-agent-usage:hover { background: color-mix(in srgb, var(--studio-text) 7%, transparent); }
}
.crucible-studio-agent-ring {
  flex: none;
  inline-size: var(--studio-agent-ring-size);
  block-size: var(--studio-agent-ring-size);
  overflow: visible;
  fill: none;
}
/* The geometry is in CSS so the size and the stroke can change without a new drawing. */
.crucible-studio-agent-ring circle {
  cx: calc(var(--studio-agent-ring-size) / 2);
  cy: calc(var(--studio-agent-ring-size) / 2);
  r: calc((var(--studio-agent-ring-size) - var(--studio-agent-ring-stroke)) / 2);
  stroke-width: var(--studio-agent-ring-stroke);
}
.crucible-studio-agent-ring-track { stroke: color-mix(in srgb, var(--studio-text) 22%, transparent); }
.crucible-studio-agent-ring-arc {
  stroke: var(--studio-agent-ring-color);
  stroke-linecap: round;
  stroke-dasharray: var(--studio-agent-ring-fill, 0) 100;
  transform: rotate(-90deg);
  transform-box: fill-box;
  transform-origin: center;
}
/* Plenty, half and low differ by the length of the arc and the colour; empty draws nothing over the track and puts a dot in the middle. */
.crucible-studio-agent-usage[data-level="empty"] .crucible-studio-agent-ring-arc { stroke-opacity: 0; }
.crucible-studio-agent-ring circle.crucible-studio-agent-ring-mark {
  display: none;
  fill: var(--studio-agent-ring-color);
  stroke: none;
  r: calc(var(--studio-agent-ring-size) * 0.12);
}
.crucible-studio-agent-usage[data-level="empty"] .crucible-studio-agent-ring-mark { display: inline; }
@media (prefers-reduced-motion: no-preference) {
  .crucible-studio-agent-ring-arc {
    transition: stroke-dasharray var(--studio-motion-base) var(--studio-ease-out), stroke var(--studio-motion-base) var(--studio-ease-out);
  }
}
/* The share as a number beside the ring, only at low and empty. It is off until a look turns it on with this property. */
.crucible-studio-agent-usage-percent {
  display: var(--studio-agent-ring-percent-display, none);
  align-items: center;
  gap: var(--studio-space-4);
  color: color-mix(in srgb, var(--studio-text) 76%, var(--studio-panel));
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.crucible-studio-agent-usage-tip {
  gap: var(--studio-space-4);
  min-inline-size: 0;
  max-inline-size: 240px;
  padding: var(--studio-space-12);
  font-size: 12px;
  white-space: nowrap;
}
.crucible-studio-agent-usage-tip span[hidden] { display: none; }
.crucible-studio-agent-usage-line { display: inline-flex; align-items: center; gap: var(--studio-space-4); }
.crucible-studio-agent-usage-line .crucible-studio-icon,
.crucible-studio-agent-usage-percent .crucible-studio-icon { inline-size: 14px; block-size: 14px; }
`;
