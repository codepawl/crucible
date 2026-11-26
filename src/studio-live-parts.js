import { isLiveGeometry, isReindexedGeometry } from './live-geometry.js';
import { updatePartVertices } from './update-part-vertices.js';

/** Upload in-place vertex edits (live seas, cloth) on parts the renderer already holds. */
export function syncLiveGeometryParts(renderer, parts) {
  if (!renderer?.partLocations) {
    return 0;
  }
  let updated = 0;
  let reindexed = false;
  for (const part of parts) {
    if (!isLiveGeometry(part.geometry) || !renderer.partLocations.has(part)) {
      continue;
    }
    const { positions, normals, skyVisibility, indices, surfaceMasks } = part.geometry;
    const partReindexed = isReindexedGeometry(part.geometry);
    updatePartVertices(renderer, part, positions, normals, {
      ...(skyVisibility && !surfaceMasks ? { skyVisibility } : {}),
      ...(partReindexed && { indices }),
    });
    updated++;
    if (partReindexed) {
      reindexed = true;
    }
  }
  if (reindexed) {
    renderer.shadowCascades?.forgetFits?.();
  }
  return updated;
}

/** Tracks the scene, topology and revision/time key already uploaded to Studio's renderer. */
export function createPartSyncTracker(initialScene = null) {
  let renderedScene = initialScene;
  let renderedTopology = initialScene?.topologyRevision ?? null;
  let renderedRevisionKey = null;
  return {
    reset(scene = null, topology = null) {
      renderedScene = scene;
      renderedTopology = topology;
      renderedRevisionKey = null;
    },
    needsReplace(scene, topology) {
      return renderedScene !== scene || renderedTopology !== topology;
    },
    replace(renderer, scene, topology, revisionKey, parts) {
      renderer.replaceParts(parts);
      renderedScene = scene;
      renderedTopology = topology;
      renderedRevisionKey = revisionKey;
    },
    update(renderer, revisionKey, parts) {
      renderer.updateParts(parts);
      if (renderedRevisionKey !== revisionKey) {
        syncLiveGeometryParts(renderer, parts);
        renderedRevisionKey = revisionKey;
      }
    },
  };
}
