// Remembers which coplanar-overlap findings an edit answer already carried, so the next answer repeats a finding only when
// one of its parts changed or it is new (#2207). A scene keeps one tracker; scene_inspect and scene_look never use it and
// always list every finding.

export const REMEMBERED_FINDINGS_LIMIT = 128;

const REPEAT_TRACKED_KIND = 'coplanar-overlap';

function hashNumbers(hash, numbers) {
  let value = hash;
  for (let index = 0; index < numbers.length; index++) {
    value = Math.imul(value ^ Math.round(numbers[index] * 1e6), 16777619) >>> 0;
  }
  return value;
}

/** A short text that changes when the part's transform or its geometry changes; empty for an unknown part. */
export function partFingerprint(part) {
  if (!part) return '';
  const withMatrix = hashNumbers(2166136261, part.matrix ?? []);
  const positions = part.geometry?.positions ?? [];
  return `${hashNumbers(withMatrix, positions).toString(36)}:${positions.length}`;
}

function findingKey(finding, fingerprintOf) {
  const names = finding.nodes ?? [];
  return `${finding.kind}|${names.join(',')}|${finding.reason ?? ''}|${finding.nodes ? '' : finding.message}|${names.map(fingerprintOf).join(',')}`;
}

export function createRepeatTracker(limit = REMEMBERED_FINDINGS_LIMIT) {
  let reported = new Set();
  return {
    /**
     * Splits the findings into those to show and a count of coplanar ones already reported with unchanged parts.
     * The tracker keeps only the findings of the latest answer (capped), so a finding that went away and comes back is shown again.
     */
    filter(findings, fingerprintOf) {
      const shown = [];
      const current = new Set();
      let unchanged = 0;
      for (const finding of findings) {
        if (finding.kind !== REPEAT_TRACKED_KIND) {
          shown.push(finding);
          continue;
        }
        const key = findingKey(finding, fingerprintOf);
        if (reported.has(key)) {
          unchanged++;
        } else {
          shown.push(finding);
        }
        if (current.size < limit) current.add(key);
      }
      reported = current;
      return { shown, unchanged };
    },
  };
}

export function unchangedFindingsLine(count) {
  return `${count} coplanar overlap${count === 1 ? '' : 's'} reported earlier ${count === 1 ? 'is' : 'are'} unchanged; scene_inspect lists them all.`;
}
