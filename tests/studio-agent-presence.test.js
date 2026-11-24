import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { AGENT_COLORS, agentColor, assertAgentName, createAgentPresence, describeAgentEdit, diffRecipeNodes } from '../src/studio-agent-presence.js';

function makeFakeDocument({ travelToken = '360ms', easingToken = 'cubic-bezier(0.2, 0, 0, 1)', reducedMotion } = {}) {
  const fakeElement = () => {
    const element = {
      dataset: {},
      style: { setProperty(name, value) { this[name] = value; } },
      children: [],
      glides: [],
      glideTransform: 'none',
      setAttribute() {},
      append() {},
      set textContent(value) {},
      animate(keyframes, options) {
        const glide = {
          keyframes,
          options,
          cancelled: false,
          cancel() { this.cancelled = true; this.oncancel?.(); },
          finish() { this.onfinish?.(); },
        };
        element.glides.push(glide);
        return glide;
      },
    };
    return element;
  };
  const values = { '--studio-motion-travel': travelToken, '--studio-ease-out': easingToken };
  return {
    createElement: fakeElement,
    createElementNS: fakeElement,
    defaultView: { ...(reducedMotion === undefined ? {} : { matchMedia: query => ({ matches: reducedMotion && query.includes('reduce') }) }), getComputedStyle: element => ({ getPropertyValue: name => values[name] ?? '', transform: element.glideTransform }) },
  };
}

function makePresence(positions, options) {
  const controller = {
    viewportWidth: 800,
    viewportHeight: 600,
    nodeOutline: nodeId => {
      const [x, y] = positions[nodeId];
      return [[x, y], [x + 10, y], [x, y + 10]];
    },
  };
  return createAgentPresence(makeFakeDocument(options), { controller, requestDraw() {} });
}

function makeRecipe() {
  return {
    format: 'crucible.scene',
    geometries: [{ id: 'cube', type: 'box' }, { id: 'ball', type: 'sphere', segments: 16 }],
    materials: [{ id: 'paint', color: [1, 0, 0] }, { id: 'stone', color: [0.5, 0.5, 0.5] }],
    nodes: [
      { id: 'ground', geometry: 'cube', material: 'stone' },
      { id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 1, 0] },
      { id: 'orb', geometry: 'ball', material: 'stone' },
    ],
    environment: { setup: 'studio' },
  };
}

test('diffRecipeNodes lists moved, added and removed nodes', () => {
  const after = makeRecipe();
  after.nodes[1].translation = [2, 1, 0];
  after.nodes.push({ id: 'lamp', geometry: 'ball', material: 'paint' });
  after.nodes.shift();
  assert.deepEqual(diffRecipeNodes(makeRecipe(), after), { nodeIds: ['hero', 'lamp'], removedNodeIds: ['ground'], otherChange: false });
});

test('diffRecipeNodes points at every node that uses a changed material or geometry', () => {
  const recoloured = makeRecipe();
  recoloured.materials[1].color = [0, 0, 1];
  assert.deepEqual(diffRecipeNodes(makeRecipe(), recoloured).nodeIds, ['ground', 'orb']);
  const reshaped = makeRecipe();
  reshaped.geometries[1].segments = 32;
  assert.deepEqual(diffRecipeNodes(makeRecipe(), reshaped).nodeIds, ['orb']);
});

test('diffRecipeNodes reports a look change apart from the nodes, and nothing for the same recipe', () => {
  const relit = makeRecipe();
  relit.environment.setup = 'sunset';
  assert.deepEqual(diffRecipeNodes(makeRecipe(), relit), { nodeIds: [], removedNodeIds: [], otherChange: true });
  assert.deepEqual(diffRecipeNodes(makeRecipe(), makeRecipe()), { nodeIds: [], removedNodeIds: [], otherChange: false });
  assert.deepEqual(diffRecipeNodes({}, {}), { nodeIds: [], removedNodeIds: [], otherChange: false });
});

test('describeAgentEdit names up to two objects and counts the rest', () => {
  const none = { nodeIds: [], removedNodeIds: [], otherChange: false };
  assert.equal(describeAgentEdit('Claude', { ...none, nodeIds: ['hero'] }), 'Claude edited hero');
  assert.equal(describeAgentEdit('Claude', { ...none, nodeIds: ['hero', 'orb', 'lamp', 'ground'] }), 'Claude edited hero, orb and 2 more');
  assert.equal(describeAgentEdit('Claude', { ...none, removedNodeIds: ['orb'] }), 'Claude removed orb');
  assert.equal(describeAgentEdit('Claude', { ...none, otherChange: true }), 'Claude changed the scene look');
  assert.equal(describeAgentEdit('Claude', none), 'Claude saved without changes');
});

test('assertAgentName trims a name and rejects an empty, long or non-string one', () => {
  assert.equal(assertAgentName('  Claude '), 'Claude');
  for (const bad of ['', '   ', 'x'.repeat(41), 7, null]) {
    assert.throws(() => assertAgentName(bad), /agent name must be a string of 1 to 40 characters/);
  }
});

test('agentColor keeps one palette colour per name and spreads names over the palette', () => {
  assert.equal(agentColor('Claude'), agentColor(' Claude '));
  const names = ['Claude', 'Builder', 'Agent', 'Lighting', 'Layout', 'Rigger', 'Painter', 'Modeler'];
  const used = new Set(names.map(agentColor));
  for (const color of used) assert.ok(AGENT_COLORS.includes(color));
  assert.ok(used.size >= 3, `eight names share only ${used.size} colours`);
  assert.throws(() => agentColor(''), /agent name must be a string/);
});

test('the pointer asks for outlines only until it has its stops, and visits the same nodes as before (#2842)', () => {
  const documentReference = makeFakeDocument();
  const nodeIds = Array.from({ length: 120 }, (_, index) => `node-${index}`);
  const asked = [];
  const controller = {
    viewportWidth: 800,
    viewportHeight: 600,
    nodeOutline(nodeId) {
      asked.push(nodeId);
      const index = Number(nodeId.split('-')[1]);
      return index % 2 === 0 ? [[0, 0], [10, 0], [0, 10]] : null;
    },
  };
  const presence = createAgentPresence(documentReference, { controller, requestDraw() {} });
  const stopCount = presence.show({ name: 'Claude', nodeIds });
  assert.equal(stopCount, 8);
  assert.equal(presence.activeNodeId, 'node-0');
  assert.deepEqual(asked.slice(0, 15), nodeIds.slice(0, 15), 'outlines were asked in list order');
  assert.ok(!asked.some(nodeId => Number(nodeId.split('-')[1]) > 14), 'the search ended at the eighth visible node, not at the end of the list');
  presence.dispose();
});

function withFakeTimers(body) {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    body();
  } finally {
    mock.timers.reset();
  }
}

test('a new target glues the pointer there in pixels and starts a glide from where it stood (#3223)', () => withFakeTimers(() => {
  const presence = makePresence({ hero: [100, 200], orb: [400, 300] });
  presence.show({ name: 'Claude', nodeIds: ['hero', 'orb'] });
  const pointer = presence.element;
  assert.equal(pointer.dataset.travelling, undefined, 'the first appearance snaps in place');
  assert.equal(pointer.glides.length, 0);
  assert.equal(pointer.style['--studio-agent-x'], '103.3px');
  assert.equal(pointer.style['--studio-agent-y'], '203.3px');
  mock.timers.tick(1100);
  assert.equal(presence.activeNodeId, 'orb');
  assert.equal(pointer.dataset.travelling, 'true');
  assert.equal(pointer.style['--studio-agent-x'], '403.3px', 'the glued position is already the new target');
  assert.equal(pointer.glides.length, 1);
  assert.deepEqual(pointer.glides[0].keyframes, [{ transform: 'translate(-300.0px, -100.0px)' }, { transform: 'translate(0px, 0px)' }], 'the glide starts at the old place and ends at zero offset');
  assert.deepEqual(pointer.glides[0].options, { duration: 360, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  pointer.glides[0].finish();
  assert.equal(pointer.dataset.travelling, undefined, 'the glide ending ends the travel');
  presence.dispose();
}));

test('camera updates during a glide keep it running and keep the pointer glued under it (#3223)', () => withFakeTimers(() => {
  const positions = { hero: [100, 200], orb: [400, 300] };
  const presence = makePresence(positions);
  presence.show({ name: 'Claude', nodeIds: ['hero', 'orb'] });
  const pointer = presence.element;
  presence.place();
  assert.equal(pointer.dataset.travelling, undefined, 'a frame with the camera still starts no travel');
  mock.timers.tick(1100);
  for (const [index, x] of [410, 420, 430, 440].entries()) {
    positions.orb = [x, 300 + index * 5];
    presence.place();
    assert.equal(pointer.dataset.travelling, 'true', `camera frame ${index} must not cut the glide`);
    assert.equal(pointer.style['--studio-agent-x'], `${(x + 3.3).toFixed(1)}px`);
  }
  assert.equal(pointer.glides.length, 1, 'the camera starts no second glide');
  assert.equal(pointer.glides[0].cancelled, false);
  pointer.glides[0].finish();
  positions.orb = [500, 400];
  presence.place();
  assert.equal(pointer.dataset.travelling, undefined);
  assert.equal(pointer.style['--studio-agent-x'], '503.3px', 'after the glide the pointer follows the camera');
  presence.dispose();
}));

test('a second target mid-glide starts the next glide from the visible position (#3223)', () => withFakeTimers(() => {
  const presence = makePresence({ hero: [100, 200], orb: [400, 300], lamp: [600, 100] });
  presence.show({ name: 'Claude', nodeIds: ['hero', 'orb', 'lamp'] });
  const pointer = presence.element;
  mock.timers.tick(1100);
  const firstGlide = pointer.glides[0];
  pointer.glideTransform = 'matrix(1, 0, 0, 1, -120, -40)';
  mock.timers.tick(200);
  assert.equal(pointer.dataset.travelling, 'true');
  mock.timers.tick(900);
  assert.equal(presence.activeNodeId, 'lamp');
  assert.equal(firstGlide.cancelled, true, 'the old glide is replaced');
  assert.equal(pointer.glides.length, 2);
  assert.equal(pointer.dataset.travelling, 'true', 'the next target keeps the travel state');
  assert.equal(pointer.style['--studio-agent-x'], '603.3px');
  assert.deepEqual(pointer.glides[1].keyframes[0], { transform: 'translate(-320.0px, 160.0px)' }, 'from the old place (403.3, 303.3) plus what was left of the glide (-120, -40), minus the new target');
  presence.show({ name: 'Claude', nodeIds: ['hero'] });
  assert.equal(pointer.hidden, false, 'a new walk does not hide the pointer first');
  assert.equal(pointer.glides.length, 3, 'it glides from where it stands');
  presence.hide();
  assert.equal(pointer.dataset.travelling, undefined);
  assert.equal(pointer.glides[2].cancelled, true, 'hiding the pointer stops the glide');
  presence.dispose();
}));

test('the glide takes its duration and easing from the tokens and the fallback timer follows the duration (#3223)', () => {
  for (const [token, expectedDuration] of [['200ms', 200], ['0.5s', 500], ['360ms', 360]]) {
    withFakeTimers(() => {
      const positions = { hero: [100, 200], orb: [400, 300] };
      const presence = makePresence(positions, { travelToken: token, easingToken: ' ease-in-out ' });
      presence.show({ name: 'Claude', nodeIds: ['hero', 'orb'] });
      mock.timers.tick(1100);
      const pointer = presence.element;
      assert.deepEqual(pointer.glides[0].options, { duration: expectedDuration, easing: 'ease-in-out' });
      mock.timers.tick(expectedDuration + 39 - 5);
      positions.orb = [410, 300];
      presence.place();
      assert.equal(pointer.dataset.travelling, 'true', `${token}: still travelling just before the fallback`);
      mock.timers.tick(10);
      assert.equal(pointer.dataset.travelling, undefined, `${token}: the fallback ends a travel ${expectedDuration + 40} ms after it started, camera updates or not`);
      assert.equal(pointer.glides[0].cancelled, true);
      presence.dispose();
    });
  }
});

test('a zero travel token, as reduced motion sets it, makes the pointer snap with no glide (#3223)', () => withFakeTimers(() => {
  const presence = makePresence({ hero: [100, 200], orb: [400, 300] }, { travelToken: '0ms' });
  presence.show({ name: 'Claude', nodeIds: ['hero', 'orb'] });
  mock.timers.tick(1100);
  assert.equal(presence.activeNodeId, 'orb');
  assert.equal(presence.element.dataset.travelling, undefined);
  assert.equal(presence.element.glides.length, 0);
  assert.equal(presence.element.style['--studio-agent-x'], '403.3px');
  presence.dispose();
}));

test('a stop on the object the pointer is already on starts no travel (#3223)', () => withFakeTimers(() => {
  const presence = makePresence({ hero: [100, 200], orb: [400, 300] });
  presence.show({ name: 'Claude', nodeIds: ['hero', 'hero', 'orb'] });
  mock.timers.tick(1100);
  assert.equal(presence.element.dataset.travelling, undefined, 'the second stop is the same object');
  mock.timers.tick(1100);
  assert.equal(presence.element.dataset.travelling, 'true', 'the third stop is another object');
  presence.element.glides[0].finish();
  presence.show({ name: 'Claude', nodeIds: ['orb'] });
  assert.equal(presence.element.dataset.travelling, undefined, 'a new walk that starts on the same object does not travel');
  presence.dispose();
}));

test('a target that goes off screen under a running glide ends it, and the pointer shown again appears in place (#3223)', () => withFakeTimers(() => {
  const positions = { hero: [100, 200], orb: [400, 300], lamp: [600, 100] };
  const controller = {
    viewportWidth: 800,
    viewportHeight: 600,
    lampOffScreen: false,
    nodeOutline(nodeId) {
      const [x, y] = positions[nodeId];
      return this.lampOffScreen && nodeId === 'lamp' ? null : [[x, y], [x + 10, y], [x, y + 10]];
    },
  };
  const presence = createAgentPresence(makeFakeDocument({ travelToken: '2s' }), { controller, requestDraw() {} });
  presence.show({ name: 'Claude', nodeIds: ['hero', 'orb', 'lamp'] });
  const pointer = presence.element;
  mock.timers.tick(1100);
  assert.equal(pointer.glides.length, 1);
  assert.equal(pointer.glides[0].cancelled, false, 'a two second glide is still in flight at the next stop');
  controller.lampOffScreen = true;
  mock.timers.tick(1100);
  assert.equal(presence.activeNodeId, 'lamp');
  assert.equal(pointer.hidden, true);
  assert.equal(pointer.glides[0].cancelled, true, 'the glide in flight is cancelled');
  assert.equal(pointer.dataset.travelling, undefined);
  mock.timers.tick(2000);
  controller.lampOffScreen = false;
  presence.show({ name: 'Claude', nodeIds: ['orb'] });
  assert.equal(pointer.hidden, false);
  assert.equal(pointer.glides.length, 1, 'shown again, it appears in place with no new animation');
  presence.dispose();
}));

test('a glide whose target is off screen when it starts hides the pointer and leaves no animation (#3223)', () => withFakeTimers(() => {
  let orbVisible = true;
  const controller = {
    viewportWidth: 800,
    viewportHeight: 600,
    nodeOutline: nodeId => (nodeId === 'orb' && !orbVisible ? null : [[100, 200], [110, 200], [100, 210]]),
  };
  const presence = createAgentPresence(makeFakeDocument(), { controller, requestDraw() {} });
  presence.show({ name: 'Claude', nodeIds: ['hero', 'orb'] });
  orbVisible = false;
  mock.timers.tick(1100);
  assert.equal(presence.element.hidden, true);
  assert.equal(presence.element.dataset.travelling, undefined);
  assert.equal(presence.element.glides.filter(glide => !glide.cancelled).length, 0);
  presence.dispose();
}));

test('a pointer under reduced motion snaps even when the token cannot be read (#3223)', () => {
  for (const options of [{ reducedMotion: true }, { reducedMotion: true, travelToken: '' }, { reducedMotion: true, travelToken: 'soon' }]) {
    withFakeTimers(() => {
      const presence = makePresence({ hero: [100, 200], orb: [400, 300] }, options);
      presence.show({ name: 'Claude', nodeIds: ['hero', 'orb'] });
      mock.timers.tick(1100);
      assert.equal(presence.element.glides.length, 0, JSON.stringify(options));
      assert.equal(presence.element.style['--studio-agent-x'], '403.3px');
      presence.dispose();
    });
  }
});

test('an unreadable token still glides for someone who has not asked for reduced motion, and no matchMedia is fine (#3223)', () => {
  for (const options of [{ reducedMotion: false, travelToken: '' }, { travelToken: 'soon' }]) {
    withFakeTimers(() => {
      const presence = makePresence({ hero: [100, 200], orb: [400, 300] }, options);
      presence.show({ name: 'Claude', nodeIds: ['hero', 'orb'] });
      mock.timers.tick(1100);
      assert.equal(presence.element.glides.length, 1);
      assert.equal(presence.element.glides[0].options.duration, 360);
      presence.dispose();
    });
  }
});
