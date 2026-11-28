import { createShowcaseViewer } from '@codepawlhq/crucible/addons/showcase';
import { createFieldSynthAssembly } from './demo-assembly.js';

const assembly = createFieldSynthAssembly();
const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');

const viewer = await createShowcaseViewer({
  container: document.querySelector('#app'),
  title: 'Field synthesizer',
  parts: assembly.parts,
  theme: 'prototype',
  actions: [
    {
      id: 'pull-out',
      type: 'toggle',
      label: 'Pull-out tray',
      active: false,
      onChange: active => {
        assembly.setTargets({ pullOut: active ? 1 : 0 });
      },
    },
    {
      id: 'explode',
      type: 'range',
      label: 'Explode',
      value: 0,
      min: 0,
      max: 1,
      step: 0.01,
      onChange: value => {
        assembly.setTargets({ explode: value });
      },
    },
  ],
  onFrame: (deltaSeconds, { viewer: activeViewer }) => {
    const { changed, active } = assembly.step(deltaSeconds, reducedMotion?.matches ?? false);
    if (changed) activeViewer.updateParts(assembly.parts);
    return active;
  },
});

window.__showcaseApp = viewer;
