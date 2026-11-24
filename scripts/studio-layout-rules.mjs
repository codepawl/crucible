// The rules of the Studio layout audit, on plain measurements, so they run and are tested without a browser.
// `studio-layout-audit.mjs` measures the real DOM in Chrome and hands the records to `findSpacingProblems`.
//
// A record is what the page reports for one element:
//   { selector, gaps: { row, column } | null, padding: { top, right, bottom, left },
//     insets: { top, right, bottom, left } | null, visibleEdge: boolean, uniformPadding: boolean, childGap: number }
// `gaps` is null unless the element is a flex or grid container with two or more children. `insets` is the distance from
// the box of its real children to its own edges, null unless the element has padding and element children. `visibleEdge`
// is true when it has a border or a fill, `uniformPadding` when its four paddings are equal. `childGap` is the largest gap
// among its element children.

// The one spacing scale of Studio, in CSS pixels. The tokens in studio-styles.js are named after these steps.
export const SPACING_SCALE = Object.freeze([0, 4, 8, 12, 16, 24]);

// 2 px is also allowed, for a gap or padding between touching controls of one group (the buttons of a tool row, the step
// buttons of a dialog), where 4 px would read as a break between two buttons that belong together. 6 px, 10 px, 14 px and
// 18 px are not: each use found is really a 4, 8, 12 or 16.
export const TIGHT_STEP = 2;

export const INSET_TOLERANCE = 2;

export const KINDS = Object.freeze({
  uneven: 'uneven-inset',
  offScale: 'off-scale',
  groupGap: 'group-gap',
});

const SIDES = Object.freeze(['top', 'right', 'bottom', 'left']);

export function isOnScale(value, scale = SPACING_SCALE) {
  return scale.some(step => Math.abs(step - value) < 0.01) || Math.abs(value - TIGHT_STEP) < 0.01;
}

function nearestStep(value, scale = SPACING_SCALE) {
  return scale.reduce((best, step) => (Math.abs(step - value) < Math.abs(best - value) ? step : best), scale[0]);
}

function rounded(value) {
  return Math.round(value * 10) / 10;
}

export function insetSpread(insets) {
  const values = SIDES.map(side => insets[side]);
  return Math.max(...values) - Math.min(...values);
}

function allowedBy(allowlist, problem) {
  return allowlist.find(entry => entry.kind === problem.kind
    && problem.selector.includes(entry.selector)
    && (entry.detail === undefined || entry.detail === problem.detail));
}

// Only a container whose edge can be seen (a border or a fill) shows its insets, so only those are held to them. A box with
// the same padding on four sides must show the same inset on four sides; any other padded box keeps each pair of opposite
// sides level, top with bottom and left with right.
function unevenSpread(record) {
  const { insets } = record;
  if (record.uniformPadding) return insetSpread(insets);
  return Math.max(Math.abs(insets.top - insets.bottom), Math.abs(insets.left - insets.right));
}

function checkInsets(record, tolerance) {
  if (!record.insets || !record.visibleEdge) return [];
  const spread = unevenSpread(record);
  if (spread <= tolerance) return [];
  const numbers = SIDES.map(side => `${side} ${rounded(record.insets[side])}`).join(', ');
  return [{
    kind: KINDS.uneven,
    selector: record.selector,
    detail: 'insets',
    message: `${record.selector}: the content sits at unequal insets from the edges (${numbers} px; spread ${rounded(spread)} px, at most ${tolerance} allowed). `
      + 'Give the container one padding on all four sides from the tokens (--studio-space-*), and take the slack out of the larger side: '
      + 'a stretched grid row or a flex-grow child leaves it (use align-content: start or align-self: start), and a centred child needs equal room on both sides.',
  }];
}

function checkScale(record, scale) {
  const findings = [];
  const check = (what, value) => {
    if (isOnScale(value, scale)) return;
    const step = nearestStep(value, scale);
    findings.push({
      kind: KINDS.offScale,
      selector: record.selector,
      detail: what,
      message: `${record.selector}: ${what} is ${rounded(value)} px, which is not on the spacing scale (${scale.join(', ')}, and 2 between touching controls). `
        + `Use var(--studio-space-${step}) (${step} px), the nearest step.`,
    });
  };
  if (record.gaps) {
    check('row-gap', record.gaps.row);
    check('column-gap', record.gaps.column);
  }
  for (const side of SIDES) check(`padding-${side}`, record.padding[side]);
  return findings;
}

function checkGroupGap(record) {
  if (!record.gaps) return [];
  const outer = Math.max(record.gaps.row, record.gaps.column);
  // A container with no gap keeps its parts apart with padding or margins, or they are one surface (a panel's head and body).
  if (outer === 0 || record.childGap <= outer) return [];
  return [{
    kind: KINDS.groupGap,
    selector: record.selector,
    detail: 'gap',
    message: `${record.selector}: the gap between its groups is ${rounded(outer)} px but a group inside has a gap of ${rounded(record.childGap)} px, so the groups read as one run. `
      + `The gap between groups must be at least the gap inside them: raise this gap to var(--studio-space-${nearestStep(record.childGap + 4)}) or tighten the inner one.`,
  }];
}

/**
 * @param {object[]} records measurements from the page
 * @param {{ scale?: number[], tolerance?: number, allowlist?: { kind: string, selector: string, detail?: string, reason: string }[] }} options
 * @returns {{ findings: object[], allowed: object[] }}
 */
export function findSpacingProblems(records, { scale = SPACING_SCALE, tolerance = INSET_TOLERANCE, allowlist = [] } = {}) {
  const findings = [];
  const allowed = [];
  for (const record of records) {
    for (const problem of [...checkInsets(record, tolerance), ...checkScale(record, scale), ...checkGroupGap(record)]) {
      const entry = allowedBy(allowlist, problem);
      if (entry) allowed.push({ ...problem, reason: entry.reason });
      else findings.push(problem);
    }
  }
  return { findings, allowed };
}
