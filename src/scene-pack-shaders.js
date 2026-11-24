// The shader code a packed scene can need at run time. The renderer draws a feature only after its shader module has been
// imported, which agent-scene does when it compiles a recipe (src/agent-scene-modules.js). A pack lists the module names
// its scene needs and the runtime imports exactly those, so the page never loads the recipe compiler. The names are the
// keys of agent-scene-modules.js; each module here only registers GLSL and imports no agent-scene code.

export const PACK_SHADER_MODULES = Object.freeze({
  layerShaders: () => import('./material-layer-shaders.js'),
  emissionMask: () => import('./emission-mask.js'),
  liquidShader: () => import('./liquid-shader.js'),
  subsurfaceShader: () => import('./subsurface-shader.js'),
  fogShader: () => import('./fog-shader.js'),
  retroShader: () => import('./retro-shader.js'),
  worldMaterials: () => import('./world-material-shader.js'),
  // The probe code of the object reflections a metal part carries; the traced probe data itself travels in the pack.
  reflections: () => import('./reflection-probes.js'),
  viewTransform: () => import('./view-transform-shader.js'),
  postSteps: () => import('./post-steps.js'),
  volumeGrid: () => import('./local-volume-grid.js'),
  volumeRamp: () => import('./local-volume-ramp.js'),
});

// Recipe features that need more than shader code at run time. A pack refuses them until a later slice of #2178 carries them.
export const PACK_UNSUPPORTED_MODULES = Object.freeze({
  cascades: 'cascaded shadows, sun angular radius, ies profiles or area lights',
  lineArt: 'line art or toon shading',
  userPass: 'postPasses',
  materialSnippet: 'material snippets',
  textPanel: 'text panels (material.text)',
  textBillboard: 'billboards',
});

/** Imports the shader modules a pack names. Throws for a name this runtime does not know, which means the pack is newer. */
export function loadPackShaderModules(names) {
  return Promise.all(names.map(name => {
    const load = PACK_SHADER_MODULES[name];
    if (!load) throw new Error(`The pack needs the shader module "${name}", which this runtime does not have; update crucible or repack the scene.`);
    return load();
  }));
}
