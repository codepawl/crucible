import assert from 'node:assert/strict';
import test from 'node:test';
import { AXIS_COLORS, GRID_PART_PREFIX, axisWidgetEnds, buildGridParts, cameraVisibleHeight, describeBounds, describeCamera, describeGridStep, gridLayout, placeGridParts, viewportClipPlanes, viewportFloorPart, viewportGridLayout } from '../src/studio-viewport-aids.js';

test('buildGridParts makes textured quads whose cells tile a one-texel line, and two axis strips', () => {
  const parts = buildGridParts();
  assert.equal(parts.length, 20, 'three sheets of six line textures each, and two axes');
  assert.ok(parts.every(part => part.name.startsWith(GRID_PART_PREFIX)), 'so exports leave the grid out');
  assert.ok(parts.every(part => part.castShadow === false && part.receiveShadow === false && part.depthLayer >= 1));
  assert.ok(parts.every(part => part.material.alphaMode === 'blend' && part.material.tag === 'unlit'));
  const named = name => parts.find(part => part.name === `${GRID_PART_PREFIX}${name}`);
  const smallest = named('sheet0-32');
  const image = smallest.material.map.image;
  assert.equal(image.width, 32);
  assert.equal(image.data.length, 32 * 32 * 4);
  const alphaAt = (picture, column, row) => picture.data[(row * picture.width + column) * 4 + 3];
  assert.equal(alphaAt(image, 0, 9), 255, 'the first column is a line');
  assert.equal(alphaAt(image, 9, 0), 255, 'the first row is a line');
  assert.equal(alphaAt(image, 9, 9), 0, 'the inside of a cell is clear');
  assert.deepEqual([...image.data.slice((9 * 32 + 9) * 4, (9 * 32 + 9) * 4 + 3)], [255, 255, 255], 'clear texels are white, so a blurred line has no dark fringe');
  const geometry = smallest.geometry;
  const corners = [0, 1, 2, 3].map(corner => [geometry.positions[corner * 3], geometry.positions[corner * 3 + 2]]);
  assert.deepEqual([...geometry.uvs], corners.flat(), 'one cell of texture per unit of the quad');
  assert.ok(parts.filter(part => part.name.includes('sheet')).every(part => part.geometry === geometry), 'the sheets share one geometry');
  assert.equal(named('sheet2-32').material.map.image, image, 'and each texture');

  const axisX = named('axis-x');
  const axisZ = named('axis-z');
  assert.ok(axisX.material.color[0] > axisX.material.color[2], 'the X axis is red');
  assert.ok(axisZ.material.color[2] > axisZ.material.color[0], 'the Z axis is blue');
  const axisImage = axisX.material.map.image;
  assert.equal(alphaAt(axisImage, 9, 0), 255, 'an axis texture has its one line');
  assert.equal(alphaAt(axisImage, 0, 9), 0, 'and nothing across it');
  const acrossOf = (part, axis) => [0, 1, 2, 3].map(corner => [part.geometry.positions[corner * 3 + axis], part.geometry.uvs[corner * 2 + 1]]);
  assert.ok(acrossOf(axisX, 2).every(([position, coordinate]) => position === coordinate), 'the line of the X strip lies where z is 0');
  assert.ok(acrossOf(axisZ, 0).every(([position, coordinate]) => position === coordinate), 'the line of the Z strip lies where x is 0');

  const asked = [];
  buildGridParts((size, rowsOnly) => { asked.push([size, rowsOnly]); return { width: size, height: size }; });
  assert.deepEqual(asked, [[32, false], [64, false], [128, false], [256, false], [512, false], [1024, false], [256, true]]);
});

test('gridLayout grows its step tenfold as the view widens, keeps lines about a pixel wide and follows the target', () => {
  const view = (visibleHeight, target = [0, 0, 0]) => ({ visibleHeight, viewportHeight: 720, target });
  const near = gridLayout(view(4));
  const far = gridLayout(view(300));
  assert.equal(near.step, 1);
  assert.equal(far.step, 10);
  assert.equal(gridLayout(view(0.5)).step, 0.1);
  const shown = (layout, sheetIndex) => layout.sheets.filter(sheet => sheet.id.startsWith(`${GRID_PART_PREFIX}sheet${sheetIndex}-`) && sheet.translation[1] > 0);
  for (const visibleHeight of [0.7, 4, 9, 39, 300, 2500]) {
    const layout = gridLayout(view(visibleHeight));
    assert.equal(layout.sheets.length, 18);
    for (const sheetIndex of [0, 1]) {
      const sheets = shown(layout, sheetIndex);
      assert.equal(sheets.length, 1, 'one quad of each sheet is shown and the others are put away');
      const textureSize = Number(sheets[0].id.split('-').pop());
      const linePixels = sheets[0].scale[0] / textureSize / (visibleHeight / 720);
      assert.ok(linePixels > 0.5 && linePixels <= 1.8, `a line is about a pixel wide (${linePixels.toFixed(2)} px at ${visibleHeight} m)`);
    }
    assert.equal(shown(layout, 1)[0].scale[0], shown(layout, 0)[0].scale[0] * 10, 'the middle cells are ten fine cells wide');
    assert.equal(shown(layout, 2)[0].scale[0], shown(layout, 0)[0].scale[0] * 100, 'and the coarse cells a hundred');
  }
  const textureOf = layout => Number(shown(layout, 0)[0].id.split('-').pop());
  const fromAbove = gridLayout({ ...view(4), eye: [0, 5, 0] });
  const lowOverTheFloor = gridLayout({ ...view(4), eye: [5, 0.2, 0] });
  assert.equal(textureOf(fromAbove), textureOf(near), 'seen from above, lines are sized for the target');
  assert.ok(textureOf(lowOverTheFloor) > textureOf(near), 'a camera low over the floor gets thinner lines, so the ones at its feet are not bands');
  assert.ok(lowOverTheFloor.lines[0].scale[2] < fromAbove.lines[0].scale[2], 'and thinner axes');
  // What a line adds up to where sheets share it: a coarser sheet is drawn over the finer ones.
  const strengths = layout => {
    const [fine, middle, coarse] = [0, 1, 2].map(sheetIndex => shown(layout, sheetIndex)[0].opacity);
    return [fine, 1 - (1 - fine) * (1 - middle), 1 - (1 - fine) * (1 - middle) * (1 - coarse)];
  };
  const close = (value, wanted) => Math.abs(value - wanted) < 0.001;
  const justSwitched = strengths(gridLayout(view(4.0001)));
  const aboutToSwitch = strengths(gridLayout(view(39.999)));
  assert.ok(justSwitched[0] > 0.1 && justSwitched[0] < justSwitched[1], 'every tenth line is stronger than the lines between');
  assert.ok(close(aboutToSwitch[0], 0), 'the finest lines fade out before the step grows');
  assert.ok(close(aboutToSwitch[1], justSwitched[0]), 'the lines that become the finest ones keep their strength over the change');
  assert.ok(close(aboutToSwitch[2], justSwitched[1]), 'and so do the ones that become every tenth line');
  assert.ok(close(justSwitched[2], justSwitched[1]), 'which is as strong as a line gets');
  assert.ok(gridLayout(view(12)).sheets.every(sheet => sheet.opacity >= 0 && sheet.opacity < 1));
  assert.ok(shown(far, 0)[0].translation[1] > shown(near, 0)[0].translation[1], 'the grid lifts off the floor as the view widens');
  const moved = gridLayout(view(4, [37.4, 0, -12.2]));
  assert.deepEqual(shown(moved, 0)[0].translation.filter((unused, axis) => axis !== 1), [37, -12], 'the fine sheet follows the target in whole cells');
  assert.deepEqual(shown(moved, 1)[0].translation.filter((unused, axis) => axis !== 1), [40, -10], 'and the middle sheet in whole cells of its own');
  const axis = name => moved.lines.find(line => line.id === `${GRID_PART_PREFIX}${name}`);
  assert.equal(axis('axis-z').translation[0], 0, 'the Z axis stays on the world origin');
  assert.equal(axis('axis-x').translation[2], 0, 'and so does the X axis');
  assert.ok(axis('axis-x').scale[0] > 1000 && axis('axis-x').scale[2] < 10, 'the X strip is long along X and narrow across');
  assert.ok(axis('axis-x').translation[1] > shown(moved, 2)[0].translation[1], 'the axes lie above the sheets');
  assert.equal(describeGridStep(0.1), '10 cm');
  assert.equal(describeGridStep(1), '1 m');
  assert.equal(describeGridStep(100), '100 m');
  assert.equal(describeGridStep(1000), '1 km');
  assert.equal(describeGridStep(0.001), '1 mm');
  assert.equal(cameraVisibleHeight({ projection: 'orthographic', orthoScale: 8 }), 8);
  assert.ok(Math.abs(cameraVisibleHeight({ eye: [0, 0, 10], target: [0, 0, 0], fov: 90 }) - 20) < 1e-9);
  assert.ok(Math.abs(cameraVisibleHeight({ eye: [0, 0, 10], target: [0, 0, 0], focalLength: 24 }) - 10) < 1e-9);
});

test('a view straight along X or Z stands the grid up behind the target, facing the camera, with the floor axis across it', () => {
  const matrixOf = entry => {
    const matrix = new Float32Array(16);
    placeGridParts(new Map([[entry.id, { matrix, material: {} }]]), { sheets: [entry], lines: [] });
    return matrix;
  };
  const shownSheet = layout => layout.sheets.find(sheet => sheet.opacity > 0);
  const front = viewportGridLayout({ eye: [0.4, 1, 6], target: [0.4, 1, 0], fov: 45 }, 720);
  const frontSheet = matrixOf(shownSheet(front));
  assert.ok(Math.abs(frontSheet[14] + 6) < 1e-9, 'the front grid stands one view distance behind the target');
  assert.equal(frontSheet[6], 1, 'and faces along Z');
  assert.ok(frontSheet[0] > 0 && frontSheet[9] > 0, 'its cells run along X and up Y');
  const frontAxes = front.lines.filter(line => line.translation[1] !== -1e5);
  assert.deepEqual(frontAxes.map(line => line.id), [`${GRID_PART_PREFIX}axis-x`], 'the red X axis runs across the front view');
  assert.ok(frontAxes[0].translation[1] > 0.019 && frontAxes[0].translation[1] < 0.05, 'just above the floor');
  assert.ok(frontAxes[0].translation[2] > -6, 'in front of the sheets');
  const right = viewportGridLayout({ eye: [8, 0.5, 0], target: [0, 0.5, 0], projection: 'orthographic', orthoScale: 4 }, 720);
  const rightSheet = matrixOf(shownSheet(right));
  assert.ok(Math.abs(rightSheet[12] + 8) < 1e-9, 'the right view stands it behind the target on X');
  assert.equal(right.step, viewportGridLayout({ eye: [0, 5, 0.01], target: [0, 0, 0], projection: 'orthographic', orthoScale: 4 }, 720).step, 'orthographic steps match the floor');
  assert.deepEqual(right.lines.filter(line => line.translation[1] !== -1e5).map(line => line.id), [`${GRID_PART_PREFIX}axis-z`], 'the blue Z axis runs across the right view');
  const tilted = viewportGridLayout({ eye: [0, 3, 6], target: [0, 0, 0], fov: 45 }, 720);
  assert.ok(tilted.sheets.every(sheet => sheet.basis === undefined), 'a tilted view keeps the grid on the floor');
  assert.deepEqual(tilted, gridLayout({ visibleHeight: cameraVisibleHeight({ eye: [0, 3, 6], target: [0, 0, 0], fov: 45 }), viewportHeight: 720, target: [0, 0, 0], eye: [0, 3, 6] }));
});

test('the viewport planes follow the camera out, and its floor reaches past them', () => {
  const close = viewportClipPlanes({ eye: [4, 3, 5], target: [0, 0, 0], near: 0.1, far: 120 });
  assert.deepEqual(close, { near: 0.1, far: Math.hypot(4, 3, 5) * 80 });
  const distant = viewportClipPlanes({ eye: [0, 0, 400], target: [0, 0, 0], near: 0.1, far: 120 });
  assert.equal(distant.near, 4);
  assert.equal(distant.far, 32000);
  assert.deepEqual(viewportClipPlanes({ eye: [0, 0, 1], target: [0, 0, 0] }), { near: 0.1, far: 100 });
  const floor = viewportFloorPart(0.019);
  assert.equal(floor.material.tag, 'floor');
  assert.ok(Math.max(...floor.geometry.positions) > distant.far, 'the edge of the floor is never in view');
  assert.ok([1, 4, 7, 10].every(index => Math.abs(floor.geometry.positions[index] - 0.019) < 1e-6));
});

test('placeGridParts writes each sheet and line into its part: the matrix, and for a sheet the opacity', () => {
  const layout = gridLayout();
  const sheet = layout.sheets.find(candidate => candidate.opacity > 0);
  const sheetPart = { matrix: new Float32Array(16), material: { opacity: 0 } };
  const linePart = { matrix: new Float32Array(16), material: { emission: 0.9 } };
  placeGridParts(new Map([[sheet.id, sheetPart], [layout.lines[0].id, linePart]]), layout);
  assert.equal(sheetPart.matrix[15], 1);
  assert.equal(sheetPart.matrix[0], sheet.scale[0]);
  assert.ok(Math.abs(sheetPart.matrix[13] - sheet.translation[1]) < 1e-6);
  assert.equal(sheetPart.material.opacity, sheet.opacity);
  assert.ok(Math.abs(linePart.matrix[0] - layout.lines[0].scale[0]) < 1e-3);
  assert.deepEqual(linePart.material, { emission: 0.9 }, 'a line keeps its material');
});

test('axisWidgetEnds places the axes as the camera sees them, far ends first', () => {
  const front = axisWidgetEnds({ eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0] });
  const find = (ends, axis, positive) => ends.find(end => end.axis === axis && end.positive === positive);
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
  near(find(front, 'x', true).x, 1);
  near(find(front, 'y', true).y, -1);
  near(find(front, 'z', true).depth, 1);
  near(find(front, 'z', false).depth, -1);
  assert.deepEqual(front.map(end => end.depth), [...front.map(end => end.depth)].sort((first, second) => first - second));
  assert.equal(front.at(-1).view, 'front');
  assert.deepEqual(front.map(end => end.view).filter(Boolean).sort(), ['back', 'front', 'left', 'right', 'top']);
  const right = axisWidgetEnds({ eye: [5, 0, 0], target: [0, 0, 0] });
  near(find(right, 'x', true).depth, 1);
  near(find(right, 'z', true).x, -1);
});

test('describeCamera and describeBounds write the readout lines', () => {
  assert.equal(describeCamera({ projection: 'orthographic', fov: 40 }), 'Orthographic');
  assert.equal(describeCamera({ focalLength: 49.6 }), 'Perspective · 50 mm');
  assert.equal(describeCamera({ fov: 41.6 }), 'Perspective · 42°');
  assert.equal(describeCamera({}), 'Perspective · 45°');
  assert.equal(describeBounds({ size: [0.42, 0.9, 0.42] }), '0.42 × 0.90 × 0.42 m');
  assert.equal(describeBounds({ size: [120.4, 3, 0.005] }), '120 × 3.00 × 0.01 m');
});
