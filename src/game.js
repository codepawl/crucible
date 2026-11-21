import { CrucibleRenderer } from './renderer.js';
import { createAgentScene, loadAgentSceneModules } from './agent-scene.js';
import { agentGroundPlacement, createAgentGround, FLOOR_COLOR } from './agent-ground.js';
import { agentEnvironmentMap } from './agent-look.js';
import { groundBounceEnvironment } from './ground-bounce.js';
import { createRuntime } from './runtime.js';
import { createInput, gamepadSource, keyboardSource } from './input.js';
import { replaySource, touchSource } from './input-sources.js';
import { createTouchStickOverlay } from './touch-stick-overlay.js';
import { createCharacterController, createChaseCamera, createController, createCameraRigOfKind, createFirstPersonCamera, createFollowCamera, createTopDownCamera, createVehicleController } from './player.js';
import { createGameRules } from './game-rules.js';
import { hasTexturedMaterial, parentTranslation } from './game-needs.js';

// Plays the `game` section of a scene recipe in a page: the scene, the input preset, the character controller, the camera rig
// and the game rules, all run by the live runtime. scene_export_web writes a folder whose index.html calls startGame.

const KEYBOARD_ACTIONS = { jump: ['keyboard/Space'], run: ['keyboard/ShiftLeft'] };
const KEYBOARD_AXES = {
  moveX: ['keyboard/KeyD', { control: 'keyboard/KeyA', scale: -1 }],
  moveForward: ['keyboard/KeyW', { control: 'keyboard/KeyS', scale: -1 }],
  lookX: ['keyboard/ArrowRight', { control: 'keyboard/ArrowLeft', scale: -1 }],
  lookY: ['keyboard/ArrowUp', { control: 'keyboard/ArrowDown', scale: -1 }],
};
const MOVE_STICK = { name: 'move', area: { x: 0, y: 0, width: 0.5, height: 1 }, radius: 60 };

export function inputDefinition(preset) {
  const actions = { jump: [...KEYBOARD_ACTIONS.jump], run: [...KEYBOARD_ACTIONS.run] };
  const axes = Object.fromEntries(Object.entries(KEYBOARD_AXES).map(([name, bindings]) => [name, [...bindings]]));
  if (preset === 'gamepad') {
    actions.jump.push('gamepad/0.button0');
    axes.moveX.push('gamepad/0.axis0');
    axes.moveForward.push({ control: 'gamepad/0.axis1', scale: -1 });
    axes.lookX.push('gamepad/0.axis2');
    axes.lookY.push({ control: 'gamepad/0.axis3', scale: -1 });
  }
  if (preset === 'touch') {
    actions.jump.push('touch/tap');
    axes.moveX.push('touch/moveX');
    axes.moveForward.push({ control: 'touch/moveY', scale: -1 });
  }
  return { actions, axes };
}

function inputSources(preset, touch) {
  const sources = [keyboardSource()];
  if (preset === 'gamepad') sources.push(gamepadSource());
  if (touch) sources.push(touch);
  return sources;
}

function requireTouchControls(value) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`startGame option touchControls must be true or false, got ${value === null ? 'null' : typeof value}. Pass true to draw the touch stick on a game with input "touch".`);
  }
  return value;
}

function cameraRigFor(kind, controller, input) {
  const rigOptions = { subject: controller.state, input };
  if (kind === 'first-person') return createFirstPersonCamera(rigOptions);
  if (kind === 'top-down') return createTopDownCamera(rigOptions);
  if (kind === 'chase') return createChaseCamera(rigOptions);
  if (kind !== 'follow') return createCameraRigOfKind(kind, rigOptions);
  return createFollowCamera(rigOptions);
}

// A node's world position, from the translations along its parents. The player starts there.
function nodeTranslation(nodes, id) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const position = [0, 0, 0];
  for (let node = byId.get(id); node; node = byId.get(node.parent)) {
    for (let axis = 0; axis < 3; axis++) position[axis] += node.translation?.[axis] ?? 0;
  }
  return position;
}

// The node a controller or follower moves: its feet position and the heading about the vertical axis.
// A placed glTF character faces +Z, while yaw 0 faces -Z, so its node is turned half a circle.
const GLTF_FACING_YAW = Math.PI;

function characterOperation(id, position, yaw, footOffset, modelYaw = 0, parentOffset = [0, 0, 0]) {
  yaw += modelYaw;
  const translation = [position[0] - parentOffset[0], position[1] + footOffset - parentOffset[1], position[2] - parentOffset[2]];
  return { type: 'set-node', id, translation, rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] };
}

// Copies the controller's state into the graph parameters that the animation's `drive` names.
function parameterSystem(animation, controllerState) {
  return {
    name: 'animation-parameters',
    fixedUpdate() {
      for (const [parameter, source] of Object.entries(animation.drive)) animation.graph.set(parameter, controllerState[source]);
    },
  };
}

function litEnvironment(scene, hasAutomaticGround) {
  const environment = scene.environment;
  return groundBounceEnvironment(scene.parts, { ...environment, map: agentEnvironmentMap(environment) }, { automaticAlbedo: hasAutomaticGround ? FLOOR_COLOR : null });
}

function createStatusLine(canvas) {
  const element = document.createElement('div');
  element.style.cssText = 'position:fixed;left:12px;top:12px;padding:6px 10px;border-radius:6px;background:rgba(0,0,0,.55);color:#fff;font:14px system-ui,sans-serif;pointer-events:none;user-select:none';
  canvas.parentNode.appendChild(element);
  return element;
}

function withoutPhysics(recipe) {
  const { physics, ...rest } = recipe;
  return rest;
}

function modelYawOf(animation) {
  return animation?.assetNode ? GLTF_FACING_YAW : 0;
}

// The hint names the way the page can restart: a replay has none, a phone has no R key, so it takes a tap.
function restartHintFor(inputPreset, replay) {
  if (replay) return '';
  return inputPreset === 'touch' ? '   (tap to restart)' : '   (R to restart)';
}

function describeState(state, restartHint) {
  const variables = Object.entries(state.variables).map(([name, value]) => `${name} ${value}`).join('   ');
  const verdict = state.status === 'won' ? `   YOU WIN${restartHint}` : state.status === 'lost' ? `   GAME OVER${restartHint}` : '';
  return `${variables}${verdict}`;
}

// A rules part that does not say `visible` starts as hidden as the scene node it is named after,
// so a hidden pickup stays hidden until a rule shows it.
function rulesWithNodeVisibility(rulesDocument, nodes) {
  if (rulesDocument.parts === undefined) return rulesDocument;
  const hiddenNodeIds = new Set(nodes.filter(node => node.visible === false).map(node => node.id));
  const parts = rulesDocument.parts.map(part => partWithNodeVisibility(part, hiddenNodeIds));
  return { ...rulesDocument, parts };
}

function partWithNodeVisibility(part, hiddenNodeIds) {
  const followsHiddenNode = part.visible === undefined && hiddenNodeIds.has(part.id);
  if (!followsHiddenNode) return part;
  return { ...part, visible: false };
}

async function loadAnimationRuntime() {
  const [{ createGameAnimation }, { createPathFollower }] = await Promise.all([import('./game-animation.js'), import('./npc-follower.js')]);
  return { createGameAnimation, createPathFollower };
}

/**
 * Start the game a recipe describes on a canvas and return its parts: `scene`, `runtime`, `rules`, `input`, `controller`, `renderer`,
 * `restart()` (puts the player, camera, NPCs, animation graphs, physics bodies and rules back at the start; returns a promise that settles once the physics world is rebuilt) and `dispose()`. Options: `replay` (a recording from recordInput; the keyboard is not attached) `showStatus` (default true) `touchControls` (default false; true draws a virtual stick under the finger on a game with `input: "touch"`) `assets` (decoded catalog assets by assetCopyKey) or `assetUrls` (asset id to GLB URL, which startGame fetches and decodes), `images` (decoded catalog images the materials read, by asset id) or `imageUrls` (image id to URL, fetched and decoded the same way), `physicsUrl` (where the page keeps jolt-physics.wasm.js, on its own origin; a recipe with game.physics true needs it unless the jolt-physics package resolves) and `createRenderer` (tests pass a stand-in for the WebGL renderer).
 */
export async function startGame(canvas, recipe, options = {}) {
  const cleanups = [];
  try {
    const game = await buildGame(canvas, recipe, options, cleanups);
    let disposed = false;
    // Copy the property descriptors, not the values, so `physics` keeps following the world that restart() rebuilds.
    return Object.defineProperties({}, {
      ...Object.getOwnPropertyDescriptors(game),
      dispose: {
        enumerable: true,
        value() {
          if (disposed) return;
          disposed = true;
          runCleanups(cleanups);
        },
      },
    });
  } catch (error) {
    runCleanups(cleanups);
    throw error;
  }
}

// Each resource registers its cleanup as it is created; they run newest first.
function runCleanups(cleanups) {
  while (cleanups.length > 0) cleanups.pop()();
}

function operationKey(operation) {
  return `${operation.type}:${operation.id}:${Object.keys(operation).join(',')}`;
}

/**
 * Two operations of one frame that write the same fields of the same node leave only the later one standing, so the earlier one is
 * dropped before a frame is compared with the last one sent: otherwise the earlier write would be compared with what the later one sent.
 */
export function lastOperationPerKey(operations) {
  const byKey = new Map();
  for (const operation of operations) byKey.set(operationKey(operation), operation);
  return [...byKey.values()];
}

function operationTarget(operation) {
  return `${operation.type}:${operation.id}`;
}

/**
 * The operations a frame must send. When any operation for a node changed, every operation for that node is sent again, in frame order:
 * two operations that write overlapping fields with different field sets resolve by order, so sending only one of them could let an
 * older write win over a newer one.
 */
export function operationsToSend(operations, lastSentOperations) {
  const candidates = lastOperationPerKey(operations);
  const changedTargets = new Set();
  for (const operation of candidates) {
    if (lastSentOperations.get(operationKey(operation)) !== JSON.stringify(operation)) changedTargets.add(operationTarget(operation));
  }
  return candidates.filter(operation => changedTargets.has(operationTarget(operation)));
}

async function buildGame(canvas, recipe, { replay, showStatus = true, touchControls = false, assets: providedAssets, assetUrls, images: providedImages, imageUrls, physicsUrl, createRenderer = (...rendererArguments) => new CrucibleRenderer(...rendererArguments) }, cleanups) {
  const setup = recipe.game;
  if (!setup) throw new Error('startGame needs a recipe with a game section. Add one with the set-game operation.');
  // Live physics replaces the recorded bake of the same section, so the scene is built without it.
  const sceneRecipe = setup.physics ? withoutPhysics(recipe) : recipe;
  await loadAgentSceneModules(sceneRecipe);
  if (hasTexturedMaterial(recipe)) await import('./replace-textured-parts.js');
  // The exported page gives URLs; the assets load only for a recipe that places or retargets a catalog asset.
  const assets = providedAssets ?? (assetUrls ? await (await import('./game-assets.js')).loadGameAssets(recipe, assetUrls) : undefined);
  const sequenceFrames = providedImages ?? (imageUrls ? await (await import('./game-assets.js')).loadGameImages(recipe, imageUrls) : undefined);
  const scene = createAgentScene(sceneRecipe, {}, { assets, sequenceFrames });
  const { game } = scene.exportRecipe();
  const placement = agentGroundPlacement(scene.parts, scene.environment);
  const environment = litEnvironment(scene, Boolean(placement));
  const renderer = createRenderer(canvas, scene.parts, {
    ground: placement ? createAgentGround(placement) : false,
    hdr: true,
    depth: true,
    world: scene.environment.world,
    environment,
    pixelRatio: Math.min(globalThis.devicePixelRatio ?? 1, 2),
  });
  cleanups.push(() => renderer.dispose());

  const { actions, axes } = inputDefinition(game.input);
  const drawTouchStick = requireTouchControls(touchControls) && game.input === 'touch' && !replay;
  const touch = game.input === 'touch' && !replay ? touchSource({ target: canvas, sticks: [MOVE_STICK] }) : null;
  const input = createInput({ sources: replay ? [replaySource(replay)] : inputSources(game.input, touch), actions, axes });
  if (drawTouchStick) {
    const stickOverlay = createTouchStickOverlay({ parent: canvas.parentNode, source: touch });
    cleanups.push(() => stickOverlay.dispose());
  }
  const footOffset = game.player.footOffset;
  const start = nodeTranslation(recipe.nodes, game.player.node);
  const playerParentOffset = parentTranslation(recipe.nodes, game.player.node, 'game.player.node');
  const body = { position: [0, 0, 0], rotationY: 0 };
  let rig = null;
  // The animation graph runtime loads only for a recipe that declares an animation or an NPC, so other games do not carry it.
  const hasAnimation = Boolean(game.player.animation) || (game.npcs?.length ?? 0) > 0;
  const { createGameAnimation, createPathFollower } = hasAnimation ? await loadAnimationRuntime() : {};
  const playerAnimation = game.player.animation ? createGameAnimation(game.player.animation, recipe.nodes, game.player.node, { assets }) : null;
  const startPosition = [start[0], start[1] - footOffset, start[2]];
  // Any other name is a kind a host registered with registerController, such as one from an allowlisted addon.
  const customKind = !['character', 'vehicle'].includes(game.player.controller);
  const controller = customKind
    ? createController(game.player.controller, { input, position: startPosition, ground: game.ground, node: body })
    : game.player.controller === 'vehicle'
    ? createVehicleController({ input, position: startPosition, ground: game.ground, maximumSpeed: game.player.maximumSpeed, node: body })
    : createCharacterController({
      input,
      position: startPosition,
      ground: game.ground,
      walkSpeed: game.player.walkSpeed,
      runSpeed: game.player.runSpeed,
      jumpSpeed: game.player.jumpSpeed,
      faceCamera: game.camera === 'first-person',
      cameraYaw: () => rig?.yaw ?? 0,
      node: body,
      ...(playerAnimation?.hasRootMotion ? { rootMotion: () => playerAnimation.graph.rootMotion.delta } : {}),
    });
  rig = cameraRigFor(game.camera, controller, input);

  const physics = game.physics ? await (await import('./game-physics.js')).createGamePhysics({ recipe, scene, playerNode: game.player.node, physicsUrl }) : null;
  if (physics) cleanups.push(() => physics.dispose());
  const physicsSystem = physics && {
    name: 'game-physics',
    fixedUpdate: (stepSeconds, context) => physics.fixedUpdate(stepSeconds, context, physics.playerIsBody ? [controller.state.position[0], controller.state.position[1] + footOffset, controller.state.position[2]] : null, body.rotationY),
  };
  const nodeIds = new Set(recipe.nodes.map(node => node.id));
  const rules = game.rules ? createGameRules(rulesWithNodeVisibility(game.rules, recipe.nodes), { input, onRestart: restartHost, getPartPosition: id => (id === game.player.node ? [...controller.state.position] : physics?.positionOf(id)) }) : null;
  const shownNodes = new Map();
  const animatedCharacters = [];
  const animationSystems = [];
  if (playerAnimation) {
    animatedCharacters.push(playerAnimation);
    animationSystems.push(parameterSystem(playerAnimation, controller.state), playerAnimation.graph.system());
  }
  const npcs = (game.npcs ?? []).map(npc => {
    const animation = createGameAnimation(npc.animation, recipe.nodes, npc.node, { assets });
    const start = nodeTranslation(recipe.nodes, npc.node);
    const parentOffset = parentTranslation(recipe.nodes, npc.node, 'game.npcs[].node');
    const follower = createPathFollower({ graph: animation.graph, position: [start[0], start[1] - npc.footOffset, start[2]], yaw: npc.yaw, cruiseSpeed: npc.cruiseSpeed });
    follower.follow(npc.path);
    animatedCharacters.push(animation);
    animationSystems.push(follower.system(), animation.graph.system());
    return { node: npc.node, footOffset: npc.footOffset, follower, graph: animation.graph, modelYaw: modelYawOf(animation), parentOffset, startPosition: [...follower.state.position], startYaw: follower.state.yaw, path: npc.path };
  });
  const hasPosedAssets = animatedCharacters.some(animation => animation.assetNode);
  let drawnTopology = scene.topologyRevision;
  const status = showStatus && rules ? createStatusLine(canvas) : null;
  if (status) cleanups.push(() => status.remove());

  // A frame that sends the same pose as the last one changes nothing, so it skips scene.apply, which costs time in proportion
  // to the scene. Anything else that edited the scene since (a restart, a script) bumps the revision and sends every pose again.
  const lastSentOperations = new Map();
  let lastAppliedRevision = -1;
  function operationsChangedSinceLastFrame(operations) {
    if (scene.revision !== lastAppliedRevision) lastSentOperations.clear();
    return operationsToSend(operations, lastSentOperations);
  }

  const sceneSystem = {
    name: 'scene',
    update(deltaSeconds, context) {
      const position = controller.positionAt(context.alpha);
      const operations = [characterOperation(game.player.node, position, body.rotationY, footOffset, modelYawOf(playerAnimation), playerParentOffset)];
      for (const npc of npcs) operations.push(characterOperation(npc.node, npc.follower.state.position, npc.follower.state.yaw, npc.footOffset, npc.modelYaw, npc.parentOffset));
      for (const animation of animatedCharacters) operations.push(...animation.operations());
      if (physics) operations.push(...physics.poseOperations());
      for (const part of rules?.state.parts ?? []) {
        if (!nodeIds.has(part.id) || part.id === game.player.node || shownNodes.get(part.id) === part.visible) continue;
        shownNodes.set(part.id, part.visible);
        operations.push({ type: 'set-node', id: part.id, visible: part.visible });
      }
      const changedOperations = operationsChangedSinceLastFrame(operations);
      if (changedOperations.length > 0) {
        scene.apply(changedOperations, { expectedRevision: scene.revision });
        lastAppliedRevision = scene.revision;
        for (const operation of changedOperations) lastSentOperations.set(operationKey(operation), JSON.stringify(operation));
      }
      if (hasPosedAssets) {
        for (const animation of animatedCharacters) if (animation.assetNode) scene.setAssetPose(animation.assetNode, animation.assetPose());
        scene.sampleMotion(context.elapsedSeconds % 3600);
      }
      if (scene.topologyRevision === drawnTopology) {
        renderer.updateParts(scene.parts);
      } else {
        renderer.replaceParts(scene.parts);
        drawnTopology = scene.topologyRevision;
      }
      if (status) status.textContent = describeState(rules.state, restartHintFor(game.input, replay));
    },
  };

  // Puts everything the game moves back at its start. The rules have already reset themselves when this runs.
  const startYaw = controller.state.yaw;
  const startRig = { yaw: rig.yaw, pitch: rig.pitch };
  let physicsRestart = Promise.resolve();
  function restartHost() {
    controller.teleport?.(startPosition, startYaw);
    Object.assign(rig, startRig);
    rig.init?.();
    playerAnimation?.graph.reset();
    for (const npc of npcs) {
      Object.assign(npc.follower.state, { position: [...npc.startPosition], yaw: npc.startYaw, speed: 0, lastMove: 0 });
      npc.graph.reset();
      npc.follower.follow(npc.path);
    }
    if (physics) {
      physicsRestart = physics.restart();
      physicsRestart.catch(() => {});
    }
  }
  function restart() {
    if (rules) rules.restart();
    else restartHost();
    return physicsRestart;
  }

  const baseCamera = scene.camera;
  const runtime = createRuntime(renderer, {
    fixedRate: 60,
    systems: [input, controller, ...animationSystems, rig, ...(physicsSystem ? [physicsSystem] : []), ...(rules ? [rules] : []), sceneSystem],
    frame: context => ({ ...baseCamera, ...rig.pose(context), environment, time: context.elapsedSeconds }),
  });
  cleanups.push(() => runtime.dispose());
  const resize = () => renderer.resize();
  globalThis.addEventListener?.('resize', resize);
  cleanups.push(() => globalThis.removeEventListener?.('resize', resize));
  resize();
  // After a win or a loss, R (or a tap on a touch game) starts the game again. A replay drives the input itself, so it has neither.
  const restartOnKey = event => {
    if (event.code === 'KeyR' && !event.repeat && rules && rules.state.status !== 'playing') restart();
  };
  const restartOnTap = () => {
    if (rules && rules.state.status !== 'playing') restart();
  };
  if (!replay) {
    globalThis.addEventListener?.('keydown', restartOnKey);
    cleanups.push(() => globalThis.removeEventListener?.('keydown', restartOnKey));
    if (game.input === 'touch') {
      canvas.addEventListener?.('pointerdown', restartOnTap);
      cleanups.push(() => canvas.removeEventListener?.('pointerdown', restartOnTap));
    }
  }
  runtime.start();

  return {
    scene,
    runtime,
    rules,
    input,
    controller,
    renderer,
    get physics() {
      return physics?.system ?? null;
    },
    /** The error of a restart that could not rebuild the physics world, or null. */
    get physicsError() {
      return physics?.failure ?? null;
    },
    animation: playerAnimation?.graph ?? null,
    npcs,
    restart,
  };
}
