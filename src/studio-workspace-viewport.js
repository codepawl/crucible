// What the Studio viewport draws in each workspace. It is display only: the recipe is never touched, so a switch is not
// saved and not undoable. Build shapes objects, so it shows them plainly: studio lighting that reads form, no cast shadows,
// no fog, no post steps or post passes. Look, Animate and Export draw the scene's own look, and a still always does.
import { agentEnvironmentMap } from './agent-look.js';
import { EFFECT_PRESETS } from './effects.js';
import { lightingSetupFields } from './lighting-setups.js';

const PLAIN_WORKSPACES = Object.freeze(new Set(['build']));

// Soft light: the studio setup at full strength washes pale materials out, so Build lights it down until form reads.
const PLAIN_ENVIRONMENT_INTENSITY = 0.35;
const PLAIN_KEY_INTENSITY = 0.3;

// A stand-in for the scene's passes: the planner sees no pass, so none is applied while the view is plain.
const SCENE_WITHOUT_POST_PASSES = Object.freeze({ postPasses: Object.freeze([]), revision: 0 });

/** True when a workspace draws objects plainly instead of with the scene's full look. */
export function workspaceDrawsPlainly(workspaceId) {
  return PLAIN_WORKSPACES.has(workspaceId);
}

function plainEnvironmentOf(environment) {
  const plain = {
    ...environment,
    ...lightingSetupFields('studio'),
    setup: 'studio',
    hdri: undefined,
    sky: undefined,
    skybox: undefined,
    reflectionHdri: undefined,
    environmentIntensity: PLAIN_ENVIRONMENT_INTENSITY,
    keyIntensity: PLAIN_KEY_INTENSITY,
    environmentRotation: 0,
    fogDensity: 0,
    volumeFog: undefined,
    localVolumes: undefined,
    lines: undefined,
  };
  return { ...plain, map: agentEnvironmentMap(plain) };
}

/**
 * Chooses what one viewport frame draws. The scene hands out a fresh environment object on every read, so the plain
 * environment is rebuilt from it each frame; its lighting map is cached by setup, so a switch of tab stays instant.
 */
export function chooseViewportLook({ workspaceId, drawingTheShot, environment, effects, scene }) {
  if (drawingTheShot || !workspaceDrawsPlainly(workspaceId)) {
    return { environment, effects, passScene: scene, shadowsVisible: true };
  }
  return { environment: plainEnvironmentOf(environment), effects: EFFECT_PRESETS.neutral, passScene: SCENE_WITHOUT_POST_PASSES, shadowsVisible: false };
}
