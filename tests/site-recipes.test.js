import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { parseRadianceHdr } from '../src/hdri.js';
import { BUNDLED_ENVIRONMENT_NAMES, registerCatalogEnvironment } from '../src/look-catalog.js';
import { RECIPES, recipeForFrame, recipeSource } from '../scripts/recipe-catalog.mjs';
import { escapeHtml, pageFileName, renderRecipePages } from '../scripts/make-recipe-pages.mjs';

for (const name of BUNDLED_ENVIRONMENT_NAMES) registerCatalogEnvironment(name, parseRadianceHdr(readFileSync(new URL(`../assets/looks/${name}.hdr`, import.meta.url))));

const read = relativePath => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('every committed recipe page is what the generator writes, so the code shown is the code in the file', () => {
  for (const [fileName, html] of Object.entries(renderRecipePages())) {
    assert.equal(read(`site/${fileName}`), html, `site/${fileName} is stale: run node scripts/make-recipe-pages.mjs`);
  }
  for (const recipe of RECIPES) {
    const page = read(`site/${pageFileName(recipe.slug)}`);
    assert.ok(page.includes(`<code id="scene-code">${escapeHtml(recipeSource(recipe.slug))}</code>`), `${recipe.slug} page must hold its recipe file text`);
  }
});

test('each recipe file builds a scene, has its pictures, and its before frame differs only in the environment', () => {
  for (const recipe of RECIPES) {
    const after = recipeForFrame(recipe.slug, 'after');
    assert.doesNotThrow(() => createAgentScene(after), recipe.slug);
    for (const frame of recipe.frames) {
      const stillPath = frame.image ?? `/recipes/${recipe.slug}-${frame.id}.webp`;
      assert.ok(existsSync(new URL(`../public${stillPath}`, import.meta.url)), stillPath);
    }
    if (recipe.frames.length > 1) {
      const before = recipeForFrame(recipe.slug, 'before');
      assert.doesNotThrow(() => createAgentScene(before), recipe.slug);
      assert.deepEqual({ ...before, environment: null }, { ...after, environment: null });
    }
    if (recipe.clip) assert.ok(existsSync(new URL(`../public/recipes/${recipe.slug}.mp4`, import.meta.url)));
  }
  assert.notDeepEqual(recipeForFrame('hdri-lighting', 'before').environment, recipeForFrame('hdri-lighting', 'after').environment);
  assert.equal(recipeForFrame('view-transform', 'before').environment.viewTransform, 'aces');
  assert.equal(recipeForFrame('view-transform', 'after').environment.viewTransform, 'agx');
});

test('the dolly zoom keeps the figure the same size from FOV 75 to FOV 20', () => {
  const scene = createAgentScene(recipeForFrame('dolly-zoom', 'after'));
  const frameHeights = [];
  for (let time = 0; time <= 4.8001; time += 0.1) {
    scene.sampleMotion(time);
    const distance = scene.camera.eye[2] - scene.camera.target[2];
    frameHeights.push(2 * distance * Math.tan(scene.camera.fov * Math.PI / 360));
  }
  scene.sampleMotion(0);
  assert.ok(Math.abs(scene.camera.fov - 75) < 1e-6);
  scene.sampleMotion(4.8);
  assert.ok(Math.abs(scene.camera.fov - 20) < 1e-6);
  for (const height of frameHeights) assert.ok(Math.abs(height - 2.7) < 0.05, `frame height ${height} at the figure drifted from 2.7 m`);
});

test('the site navigation and the build list the recipe pages', () => {
  for (const page of ['docs', 'changelog', 'marketplace', 'showcase', 'tiers']) assert.match(read(`site/${page}.html`), /<a (class="wide" )?href="\/recipes.html"/, `${page} nav`);
  assert.ok(read('site/index.html').includes('href="/recipes.html"'), 'index nav');
  const viteConfig = read('vite.config.js');
  for (const fileName of Object.keys(renderRecipePages())) assert.ok(viteConfig.includes(`site/${fileName}`), `${fileName} missing from vite.config.js input`);
});
