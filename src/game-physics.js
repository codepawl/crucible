// Live physics for a game scene. The recipe's physics section names the bodies (the same section the film bake reads, with
// the same limits); the game steps them with Jolt in the fixed update of the runtime and moves their nodes with set-node.
// This file loads only for a recipe whose game has physics true, so other games do not carry the engine.
import { liveAgentPhysicsDefinition } from './agent-physics.js';
import { gamePhysicsProblem } from './game-needs.js';
import { loadJoltEngine, joltAdapter } from './physics-jolt.js';
import { createPhysicsSystem } from './physics-runtime.js';
import { wholeGeometryOfParts } from './mesh-material-slots.js';

export const GAME_PHYSICS_STEP_SECONDS = 1 / 60;

// The page gives a URL to the engine files it ships. Only the page's own origin is loaded, so a recipe cannot pull code from elsewhere.
function sameOriginModuleUrl(physicsUrl) {
  if (physicsUrl === undefined) return undefined;
  const base = globalThis.location?.href ?? import.meta.url;
  const url = new URL(physicsUrl, base);
  const origin = globalThis.location?.origin;
  if (origin && url.origin !== origin) throw new Error(`physicsUrl must be on the page's own origin (${origin}), got ${url.origin}. Ship the physics files next to the page.`);
  return url.href;
}

/** The geometry of each recipe geometry as its node draws it; a node with material slots is several parts, whose triangles are put back together. */
export function bodyGeometriesOf(recipe, parts) {
  const partsByNode = new Map();
  for (const part of parts) partsByNode.set(part.name, [...(partsByNode.get(part.name) ?? []), part]);
  const geometries = new Map();
  for (const node of recipe.nodes) {
    if (node.geometry !== undefined && partsByNode.has(node.id)) geometries.set(node.geometry, wholeGeometryOfParts(partsByNode.get(node.id)));
  }
  return geometries;
}

/**
 * Build the physics of a game. `scene` is the agent scene (its parts give each body's geometry), `playerNode` and
 * `playerFootOffset` name the node the controller moves (a kinematic body when it is in the physics section) and
 * `physicsUrl` is where the page keeps jolt-physics.wasm.js. Returns `{ system, bodies, poseOperations, dispose }`.
 */
export async function createGamePhysics({ recipe, scene, playerNode, physicsUrl }) {
  const problem = gamePhysicsProblem(recipe);
  if (problem) throw new Error(problem);
  const geometries = bodyGeometriesOf(recipe, scene.parts);
  const definition = liveAgentPhysicsDefinition(recipe.physics, recipe, geometries);
  await loadJoltEngine({ moduleUrl: sameOriginModuleUrl(physicsUrl) });
  const createSystem = () => createPhysicsSystem(definition, { adapter: joltAdapter, timestep: GAME_PHYSICS_STEP_SECONDS });
  // The world is null while restart() rebuilds it; the steps in between do nothing.
  let system = await createSystem();
  let rebuilding = Promise.resolve();
  let disposed = false;
  let failure = null;
  const bodies = new Map(recipe.physics.bodies.map(body => [body.node, body]));
  const sentPoses = new Map();

  return {
    get system() {
      return system;
    },
    /** The error of the last restart that could not rebuild the world, or null while the world runs. */
    get failure() {
      return failure;
    },
    bodies,
    playerIsBody: bodies.get(playerNode)?.type === 'kinematic',
    /** Drive the kinematic player body to the controller position, then step the world once. */
    fixedUpdate(stepSeconds, context, playerPosition, playerYaw) {
      if (failure) throw new Error(`The physics world could not be rebuilt on restart, so the game has no physics: ${failure.message}. Fix the physics section and call restart() again.`);
      if (!system) return;
      if (playerPosition) {
        system.setKinematicPose(playerNode, {
          translation: playerPosition,
          rotation: [0, Math.sin(playerYaw / 2), 0, Math.cos(playerYaw / 2)],
        });
      }
      system.fixedUpdate(stepSeconds, context);
    },
    /** Position of a dynamic body, for the rules; undefined for any other node. */
    positionOf(nodeId) {
      return system && bodies.get(nodeId)?.type === 'dynamic' ? system.getPose(nodeId).translation : undefined;
    },
    /** set-node operations for the dynamic bodies that moved since the last call. */
    poseOperations() {
      const operations = [];
      if (!system) return operations;
      for (const [nodeId, body] of bodies) {
        if (body.type !== 'dynamic') continue;
        const { translation, rotation } = system.getPose(nodeId);
        const last = sentPoses.get(nodeId);
        if (last && last.every((value, index) => value === (index < 3 ? translation[index] : rotation[index - 3]))) continue;
        sentPoses.set(nodeId, [...translation, ...rotation]);
        operations.push({ type: 'set-node', id: nodeId, translation, rotation });
      }
      return operations;
    },
    /** Put every body back where the recipe placed it by building the world again. Resolves once the new world runs. */
    restart() {
      const previous = system;
      system = null;
      previous?.dispose();
      sentPoses.clear();
      // A failed rebuild must not block the next restart, so each one starts after the earlier one settles, whichever way.
      rebuilding = rebuilding.catch(() => {}).then(async () => {
        const next = await createSystem().catch(error => {
          failure = error;
          console.error(`The physics world could not be rebuilt on restart: ${error.message}`);
          throw error;
        });
        if (disposed) next.dispose();
        else {
          // A second restart may have queued behind the first, which already installed a world.
          system?.dispose();
          system = next;
          failure = null;
        }
      });
      return rebuilding;
    },
    dispose() {
      disposed = true;
      system?.dispose();
      system = null;
    },
  };
}
