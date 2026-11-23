/**
 * Wording for the agent errors that recorded runs hit most. The session errors alone were a third of all tool errors
 * (21 of 68): an agent used an ID it invented, or one from a scene that was disposed or never created.
 *
 * `openSessionIds` lists the open scenes from least to most recently used; `evictedSessionIds` lists scenes the server
 * closed to stay under its scene cap.
 */
export function sessionProblem(requestedSessionId, activeSessionId, { openSessionIds = [], evictedSessionIds = [], evictionReasons = {} } = {}) {
  if (evictedSessionIds.includes(requestedSessionId)) {
    const open = openSessionIds.length ? ` Open scenes: ${openSessionIds.join(', ')}.` : '';
    const reason = evictionReasons[requestedSessionId] ?? 'the server keeps a limited number of open scenes and closes the least recently used one when a new scene is created';
    return `sessionId ${requestedSessionId} was evicted: ${reason}.${open} Pass the sessionId of an open scene, or call scene_create again (scene_export_recipe saves a scene before it is evicted).`;
  }
  if (!activeSessionId) {
    return 'No scene is active: it was never created, was disposed, or scene_create failed. Call scene_create or scene_create_asset first, then pass the sessionId it returns.';
  }
  if (openSessionIds.length > 1) {
    return `Unknown scene session ${requestedSessionId}. Open scenes: ${openSessionIds.join(', ')}; the last used is ${activeSessionId}. Pass one of them as sessionId, leave sessionId out for the last used scene, or call scene_create for a new scene.`;
  }
  return `Unknown scene session ${requestedSessionId}. The active session is ${activeSessionId}; leave sessionId out or pass that one, or call scene_dispose and then scene_create for a new scene.`;
}

/** How many scenes one server keeps open, and the resident geometry bytes they may hold together. */
export const SCENE_STORE_LIMITS = Object.freeze({ maxOpenScenes: 4, maxOpenSceneBytes: 96 * 1024 * 1024 });

function mebibytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Which open scenes a new scene closes, and why. `openScenes` lists `{ sessionId, bytes }` from least to most recently used and
 * `incomingBytes` is the new scene's resident geometry. Scenes close oldest first until both caps hold, so a scene is only closed
 * for a cap that is really exceeded: the scene count, or the resident geometry the open scenes hold together with the new one.
 * The reason names that cap and the numbers, because "up to 4 scenes" is easy to read as a promise a few large scenes cannot keep.
 * A byte figure that is not a finite number is an accounting bug: it throws and names the scene, because a NaN compares as
 * neither over nor under a cap and would silently switch the cap off or close every older scene.
 */
export function planSceneEviction(openScenes, incomingBytes, limits = SCENE_STORE_LIMITS) {
  const figures = [{ subject: 'the new scene', bytes: incomingBytes }, ...openScenes.map(scene => ({ subject: `scene ${scene.sessionId}`, bytes: scene.bytes }))];
  for (const { subject, bytes } of figures) {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new TypeError(`Internal error: the resident geometry bytes of ${subject} is ${bytes}, not a finite count, so the open-scene cap cannot be applied. Report this with the recipe that built the scene.`);
    }
  }
  let remainingCount = openScenes.length;
  let remainingBytes = incomingBytes + openScenes.reduce((total, scene) => total + scene.bytes, 0);
  const startingBytes = remainingBytes;
  const sessionIds = [];
  let closedForCount = false;
  let closedForBytes = false;
  for (const scene of openScenes) {
    const overCount = remainingCount + 1 > limits.maxOpenScenes;
    const overBytes = remainingBytes > limits.maxOpenSceneBytes;
    if (!overCount && !overBytes) break;
    closedForCount ||= overCount;
    closedForBytes ||= overBytes;
    remainingCount -= 1;
    remainingBytes -= scene.bytes;
    sessionIds.push(scene.sessionId);
  }
  if (!sessionIds.length) return { sessionIds, reason: null };
  const reasons = [];
  if (closedForCount) reasons.push(`the server keeps at most ${limits.maxOpenScenes} open scenes`);
  if (closedForBytes) {
    reasons.push(`the open scenes and the new one held ${mebibytes(startingBytes)} of resident geometry, over the ${mebibytes(limits.maxOpenSceneBytes)} cap (the new scene alone is ${mebibytes(incomingBytes)})`);
  }
  return { sessionIds, reason: `closed the least recently used scene${sessionIds.length > 1 ? 's' : ''} because ${reasons.join(' and ')}` };
}

/** A request made against an old revision: names both revisions, so the caller retries with the current one instead of guessing. */
export function staleRevisionMessage(subject, expectedRevision, currentRevision) {
  return `Stale revision for ${subject}: expectedRevision ${expectedRevision} is not the current revision ${currentRevision}. Pass expectedRevision ${currentRevision}; a failed scene_apply leaves the revision unchanged, and scene_inspect returns the current one.`;
}
