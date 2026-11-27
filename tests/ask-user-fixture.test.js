import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadAskUserFixture, describeAskUserFixture, ASK_USER_FIXTURE_VARIABLE, ASK_USER_FIXTURE_LIMITS } from '../scripts/ask-user-fixture.mjs';
import { ACCEPTED_CLI_OPTIONS } from '../scripts/mcp-server.mjs';
import { askUserEnvironment } from '../bench/agent-modeling/ask-user-environment.mjs';
import { BENCH_TASKS } from '../bench/agent-modeling/suite.mjs';
import { taskById } from '../bench/agent-modeling/tasks.mjs';
import { previewHarness } from './support/preview-harness.mjs';

const serverScript = new URL('../scripts/mcp-server.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const benchFixture = join(import.meta.dirname, '..', 'bench', 'agent-modeling', 'ask-user-pin.json');

async function fixtureFile(context, name, text) {
  const directory = await mkdtemp(join(tmpdir(), 'ask-user-fixture-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, name);
  await writeFile(filePath, typeof text === 'string' ? text : JSON.stringify(text));
  return filePath;
}

const loadFrom = filePath => loadAskUserFixture({ [ASK_USER_FIXTURE_VARIABLE]: filePath });
const oneMark = { marks: [{ pixel: [384, 256], note: 'make this red' }] };

test('without the variable, or with an empty one, no fixture is loaded', () => {
  assert.equal(loadAskUserFixture({}), undefined);
  assert.equal(loadAskUserFixture({ [ASK_USER_FIXTURE_VARIABLE]: '' }), undefined);
});

test('a valid fixture loads as the { x, y, note } marks the annotate page sends, and drops motionTime', async context => {
  const filePath = await fixtureFile(context, 'pin.json', { marks: [{ pixel: [384, 256], note: 'make this red', motionTime: 1.5 }, { pixel: [1, 2] }] });
  assert.deepEqual(loadFrom(filePath), { name: 'pin.json', marks: [{ x: 384, y: 256, note: 'make this red' }, { x: 1, y: 2, note: '' }] });
});

test('the loader refuses a relative path, another extension, a missing or oversized file and bad JSON, naming the variable', async context => {
  assert.throws(() => loadFrom('pin.json'), /CRUCIBLE_ASK_USER_FIXTURE must be an absolute path/);
  const wrongExtension = await fixtureFile(context, 'pin.txt', oneMark);
  assert.throws(() => loadFrom(wrongExtension), /CRUCIBLE_ASK_USER_FIXTURE must point to a \.json file, got "pin\.txt"/);
  const missing = join(await mkdtemp(join(tmpdir(), 'ask-user-fixture-')), 'none.json');
  assert.throws(() => loadFrom(missing), /CRUCIBLE_ASK_USER_FIXTURE cannot read none\.json/);
  const padded = await fixtureFile(context, 'big.json', JSON.stringify({ ...oneMark, padding: 'x'.repeat(ASK_USER_FIXTURE_LIMITS.maxBytes) }));
  assert.throws(() => loadFrom(padded), /big\.json is \d+ bytes, over the 65536 byte limit/);
  const notJson = await fixtureFile(context, 'bad.json', '{"marks": [');
  assert.throws(() => loadFrom(notJson), /CRUCIBLE_ASK_USER_FIXTURE file bad\.json is not valid JSON/);
});

test('the loader checks the marks against the limits of real marks', async context => {
  const cases = [
    [[], /must be an object like/],
    [{ marks: [] }, /needs 1 to 16 marks/],
    [{ marks: Array.from({ length: 17 }, () => ({ pixel: [1, 1] })) }, /needs 1 to 16 marks, got 17/],
    [{ marks: ['pin'] }, /mark 1 must be an object/],
    [{ marks: [{ note: 'no pixel' }] }, /mark 1 pixel must be \[x, y\]/],
    [{ marks: [{ pixel: [1] }] }, /mark 1 pixel must be \[x, y\]/],
    [{ marks: [{ pixel: [-1, 5] }] }, /mark 1 pixel must be \[x, y\]/],
    [{ marks: [{ pixel: [1025, 5] }] }, /mark 1 pixel must be \[x, y\]/],
    [{ marks: [{ pixel: ['1', 5] }] }, /mark 1 pixel must be \[x, y\]/],
    [{ marks: [{ pixel: [1, 1], note: 'x'.repeat(281) }] }, /mark 1 note must be text of at most 280 characters/],
    [{ marks: [{ pixel: [1, 1], note: 4 }] }, /mark 1 note must be text/],
    [{ marks: [{ pixel: [1, 1], motionTime: -1 }] }, /mark 1 motionTime must be a number of seconds/],
    [{ marks: [{ pixel: [1, 1], motionTime: 'soon' }] }, /mark 1 motionTime must be a number of seconds/],
  ];
  for (const [content, message] of cases) {
    const filePath = await fixtureFile(context, 'case.json', content);
    assert.throws(() => loadFrom(filePath), message, JSON.stringify(content).slice(0, 80));
  }
});

test('a fixture mark may carry a lasso instead of a pixel, and the loader checks its points and count (#922)', async context => {
  const outline = [[10, 10], [100, 10], [100, 80]];
  const filePath = await fixtureFile(context, 'lasso.json', { marks: [{ lasso: outline, note: 'make these blue' }, { pixel: [1, 2] }] });
  assert.deepEqual(loadFrom(filePath), { name: 'lasso.json', marks: [{ kind: 'lasso', points: outline, note: 'make these blue' }, { x: 1, y: 2, note: '' }] });
  const tooMany = Array.from({ length: 65 }, (unused, index) => [index, 5]);
  const cases = [
    [{ marks: [{ lasso: [[1, 1], [2, 2]] }] }, /mark 1 lasso must be an array of 3 to 64 \[x, y\] points/],
    [{ marks: [{ lasso: tooMany }] }, /mark 1 lasso must be an array of 3 to 64 \[x, y\] points/],
    [{ marks: [{ lasso: 'around the statue' }] }, /mark 1 lasso must be an array of 3 to 64/],
    [{ marks: [{ lasso: [[1, 1], [2, 2], [3]] }] }, /mark 1 lasso point 3 must be \[x, y\], two numbers from 0 to 1024/],
    [{ marks: [{ lasso: [[1, 1], [2, 2], [3, 1025]] }] }, /mark 1 lasso point 3 must be \[x, y\]/],
    [{ marks: [{ lasso: [[1, 1], [2, 2], [-3, 1]] }] }, /mark 1 lasso point 3 must be \[x, y\]/],
    [{ marks: [{ lasso: outline, pixel: [1, 1] }] }, /mark 1 has both pixel and lasso/],
    [{ marks: [{ lasso: outline, note: 'x'.repeat(281) }] }, /mark 1 note must be text of at most 280 characters/],
  ];
  for (const [content, message] of cases) {
    const caseFile = await fixtureFile(context, 'case.json', content);
    assert.throws(() => loadFrom(caseFile), message, JSON.stringify(content).slice(0, 80));
  }
  const atLimit = await fixtureFile(context, 'limit.json', { marks: [{ lasso: tooMany.slice(0, 64).map(([x]) => [x * 10, 500 + x]) }] });
  assert.equal(loadFrom(atLimit).marks[0].points.length, 64);
});

test('the bench lasso outlines the statue and the plinth, not the floor, at the stage camera (#922)', async () => {
  const task = taskById('ask-user-lasso');
  assert.ok(BENCH_TASKS.find(candidate => candidate.id === 'ask-user-lasso').topics.includes('askUser'));
  const lassoFixture = join(import.meta.dirname, '..', 'bench', 'agent-modeling', 'ask-user-lasso.json');
  assert.deepEqual(askUserEnvironment(task), { [ASK_USER_FIXTURE_VARIABLE]: resolve(lassoFixture) });

  const fixture = loadFrom(lassoFixture);
  const { preview } = previewHarness();
  preview.create({ recipe: structuredClone(task.startRecipe), sessionId: 'lasso', backend: 'cpu', memoryBudgetMiB: 64 });
  const frame = preview.annotateFrame({ sessionId: 'lasso' });
  const picked = await preview.pickMarks({ sessionId: 'lasso', camera: frame.camera, width: frame.width, height: frame.height, marks: fixture.marks });
  const [mark] = picked.marks;
  assert.equal(mark.kind, 'lasso');
  assert.equal(mark.note, 'make these blue');
  const covered = Object.fromEntries(mark.parts.map(part => [part.partId, part.coverage]));
  assert.ok(covered.statue > 0.25 && covered.plinth > 0.25, JSON.stringify(covered));
  assert.ok((covered.floor ?? 0) < 0.15, `the floor stays a sliver: ${JSON.stringify(covered)}`);
  const byId = Object.fromEntries(mark.parts.map(part => [part.partId, part]));
  assert.deepEqual(byId.plinth.materialSharedWith, ['floor'], 'the plinth shares stone with the unmarked floor');
  assert.equal('materialSharedWith' in byId.statue, false);
  assert.equal(byId.floor.edge, true);
  assert.equal('edge' in byId.plinth, false);
});

function startServer(environmentOverrides) {
  const child = spawn(process.execPath, [serverScript], { env: { ...process.env, ...environmentOverrides }, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const exited = new Promise(resolve => child.on('close', code => resolve(code)));
  const waitFor = (pattern, timeoutMs = 20000) => new Promise(resolve => {
    const finish = () => { clearTimeout(timer); clearInterval(poll); resolve(errors); };
    const timer = setTimeout(finish, timeoutMs);
    const poll = setInterval(() => { if (pattern.test(errors)) finish(); }, 25);
    exited.then(finish);
  });
  return { child, exited, waitFor };
}

test('the server logs one line at start naming the fixture file, and refuses a bad fixture before serving', async context => {
  const filePath = await fixtureFile(context, 'pin.json', oneMark);
  const started = startServer({ [ASK_USER_FIXTURE_VARIABLE]: filePath });
  context.after(() => started.child.kill());
  const errors = await started.waitFor(/scene_ask_user answers come from the fixture/);
  const fixtureLines = errors.split('\n').filter(line => line.includes('fixture')).map(line => line.trim());
  assert.deepEqual(fixtureLines, ['Crucible: scene_ask_user answers come from the fixture pin.json']);
  assert.equal(describeAskUserFixture({ name: 'pin.json' }), fixtureLines[0]);
  started.child.kill();

  const badPath = await fixtureFile(context, 'bad.json', { marks: [] });
  const refused = startServer({ [ASK_USER_FIXTURE_VARIABLE]: badPath });
  context.after(() => refused.child.kill());
  assert.match(await refused.waitFor(/CRUCIBLE_ASK_USER_FIXTURE/), /CRUCIBLE_ASK_USER_FIXTURE file bad\.json needs 1 to 16 marks/);
  assert.notEqual(await refused.exited, 0);

  const quiet = startServer({ [ASK_USER_FIXTURE_VARIABLE]: '' });
  context.after(() => quiet.child.kill());
  assert.doesNotMatch(await quiet.waitFor(/never-matches/, 1500), /fixture/);
});

test('the variable is in no flag list and no tool schema', async () => {
  assert.ok(!ACCEPTED_CLI_OPTIONS.some(name => /fixture/i.test(name)));
  const source = await readFile(serverScript, 'utf8');
  const mentions = source.split('\n').filter(line => /CRUCIBLE_ASK_USER_FIXTURE|askUserFixture/.test(line));
  assert.ok(mentions.every(line => !/register\(|z\.|describe\(/.test(line)), mentions.join('\n'));
});

test('the bench pin on the plinth lands on it at the stage camera and warns that the floor shares its stone (#1972)', async () => {
  const task = taskById('ask-user-pin-shared');
  assert.ok(BENCH_TASKS.find(candidate => candidate.id === 'ask-user-pin-shared').topics.includes('askUser'));
  const sharedFixture = join(import.meta.dirname, '..', 'bench', 'agent-modeling', 'ask-user-pin-shared.json');
  assert.deepEqual(askUserEnvironment(task), { [ASK_USER_FIXTURE_VARIABLE]: resolve(sharedFixture) });
  const fixture = loadFrom(sharedFixture);
  const { preview } = previewHarness();
  preview.create({ recipe: structuredClone(task.startRecipe), sessionId: 'pin-shared', backend: 'cpu', memoryBudgetMiB: 64 });
  const frame = preview.annotateFrame({ sessionId: 'pin-shared' });
  const picked = await preview.pickMarks({ sessionId: 'pin-shared', camera: frame.camera, width: frame.width, height: frame.height, marks: fixture.marks });
  const [mark] = picked.marks;
  assert.equal(mark.partId, 'plinth');
  assert.equal(mark.note, 'make this red');
  assert.deepEqual(mark.materialSharedWith, ['floor']);
  const statuePick = await preview.pickMarks({ sessionId: 'pin-shared', camera: frame.camera, width: frame.width, height: frame.height, marks: loadFrom(benchFixture).marks });
  assert.equal('materialSharedWith' in statuePick.marks[0], false, 'the statue has a material of its own');
});

test('a fixture mark may carry color or view marks and rejects invalid bounds (#922)', async context => {
  const validPath = await fixtureFile(context, 'color-view.json', {
    marks: [
      { pixel: [384, 256], color: '#FF0000', note: 'red statue' },
      { pixel: [100, 120], color: [0, 0.5, 1], note: 'blue accent' },
      { view: { eye: [2, 3, 5], target: [0, 1, 0], fov: 40 }, note: 'closer' },
    ],
  });
  const loaded = loadFrom(validPath);
  assert.deepEqual(loaded.marks[0], { kind: 'color', x: 384, y: 256, color: [1, 0, 0], hex: '#ff0000', note: 'red statue' });
  assert.equal(loaded.marks[1].kind, 'color');
  assert.deepEqual(loaded.marks[1].color, [0, 0.5, 1]);
  assert.deepEqual(loaded.marks[2], { kind: 'view', camera: { eye: [2, 3, 5], target: [0, 1, 0], fov: 40 }, note: 'closer' });

  const invalidCases = [
    [{ marks: [{ pixel: [10, 10], color: [1.2, 0, 0] }] }, /mark 1 color/],
    [{ marks: [{ pixel: [10, 10], hex: 'not-hex' }] }, /mark 1 hex/],
    [{ marks: [{ lasso: [[1, 1], [10, 1], [10, 10]], color: '#ff0000' }] }, /cannot combine lasso with color/],
    [{ marks: [{ view: { eye: [1, 2, 3], target: [0, 0, 0], fov: 4 }, pixel: [1, 1] }] }, /cannot combine view/],
    [{ marks: [{ view: { eye: [1, 2, 3], target: [0, 0, 0], fov: 121 } }] }, /mark 1 camera\.fov/],
  ];
  for (const [content, message] of invalidCases) {
    const filePath = await fixtureFile(context, 'bad-color-view.json', content);
    assert.throws(() => loadFrom(filePath), message);
  }
});

test('only a bench task tagged askUser gets the fixture, and its pin lands on the statue at the bench camera', async () => {
  const task = taskById('ask-user-pin');
  assert.ok(BENCH_TASKS.find(candidate => candidate.id === 'ask-user-pin').topics.includes('askUser'));
  assert.deepEqual(askUserEnvironment(task), { [ASK_USER_FIXTURE_VARIABLE]: resolve(benchFixture) });
  assert.equal(askUserEnvironment(taskById('look-metal')), undefined);

  const fixture = loadFrom(benchFixture);
  const { preview } = previewHarness();
  preview.create({ recipe: structuredClone(task.startRecipe), sessionId: 'pin', backend: 'cpu', memoryBudgetMiB: 64 });
  const frame = preview.annotateFrame({ sessionId: 'pin' });
  const picked = await preview.pickMarks({ sessionId: 'pin', camera: frame.camera, width: frame.width, height: frame.height, marks: fixture.marks });
  assert.equal(picked.marks.length, 1);
  assert.equal(picked.marks[0].partId, 'statue');
  assert.equal(picked.marks[0].note, 'make this red');
  assert.equal(picked.marks[0].material, 'bronze');
});
