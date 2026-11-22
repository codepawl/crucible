// The picture half of scene_review `checks: "realism"`: reads each shot of the review grid and warns about a texture
// that repeats in a grid. The material checks need no picture and live in src/realism-checks.js.
import { decodePng } from './agent-icon-png.mjs';
import { cellPlane, detectTiling } from './review-tiling.mjs';
import { FIX_BY_CHECK as MATERIAL_FIXES, albedoDiagnostics, finding, metallicOnDielectricDiagnostics } from '../src/realism-checks.js';
import { REVIEW_LIMITS } from './agent-review.mjs';

const REALISM_CHECK_ORDER = ['albedo-out-of-range', 'metallic-on-dielectric', 'visible-tiling'];
const FIX_BY_CHECK = Object.freeze({
  ...MATERIAL_FIXES,
  'visible-tiling': 'Break the repeat: scale the texture so one tile covers more of the surface, add a second pattern at another scale, or vary the colour with a noise mask.',
});

/** A tiling warning for one shot, in the same shape. `tiling` is the result of detectTiling. */
export function tilingDiagnostic(shotLabel, tiling) {
  return finding('visible-tiling', shotLabel,
    `The picture of ${shotLabel} repeats every ${tiling.periodX} by ${tiling.periodY} pixels (autocorrelation ${tiling.strength.toFixed(2)}), which reads as a texture tiled in a grid.`,
    FIX_BY_CHECK['visible-tiling']);
}

/**
 * The pass or fail list of scene_review `checks: "realism"`. `tilingFindings` are the warnings the shots produced; the
 * tiling check only ever warns, so it reads "warn" and never "fail". Every check is listed, with its fix.
 */
export function realismReport(recipe, tilingFindings = []) {
  const findingsByCheck = {
    'albedo-out-of-range': albedoDiagnostics(recipe),
    'metallic-on-dielectric': metallicOnDielectricDiagnostics(recipe),
    'visible-tiling': tilingFindings,
  };
  const checks = REALISM_CHECK_ORDER.map(check => {
    const findings = findingsByCheck[check];
    const status = findings.length === 0 ? 'pass' : check === 'visible-tiling' ? 'warn' : 'fail';
    return { check, status, fix: FIX_BY_CHECK[check], ...(findings.length ? { findings: findings.map(({ target, message }) => ({ target, message })) } : {}) };
  });
  return { passed: checks.every(entry => entry.status !== 'fail'), checks };
}

/** One tiling warning per shot of the review grid (base64 PNG) whose picture repeats. Never throws: an unreadable grid gives none. */
export function reviewTilingFindings(gridBase64, settings) {
  let grid;
  try { grid = decodePng(Buffer.from(gridBase64, 'base64')); }
  catch { return []; }
  const findings = [];
  for (const [index, shot] of settings.shots.entries()) {
    const cell = { x: (index % settings.columns) * settings.width, y: Math.floor(index / settings.columns) * (settings.height + REVIEW_LIMITS.labelHeight) + REVIEW_LIMITS.labelHeight, cellWidth: settings.width, cellHeight: settings.height };
    if (cell.x + cell.cellWidth > grid.width || cell.y + cell.cellHeight > grid.height) continue;
    const tiling = detectTiling(cellPlane(grid, cell));
    if (tiling) findings.push(tilingDiagnostic(shot.label, tiling));
  }
  return findings;
}
