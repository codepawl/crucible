import '../../src/brand-fonts.css';
import { loadAllAgentSceneModules } from '../../src/agent-scene.js';
import { createStudio } from '../../src/studio.js';
import { reportStudioLoadingProgress, reportStudioModulesLoaded, revealStudio, showStudioLoadingFailure, STUDIO_LOADING_MILESTONES } from '../../src/studio-boot.js';
import { createCatalogHooks } from './catalog-hooks.js';

// ?catalog=<folder> names a same-origin folder that holds a scene's catalog files by the id the recipe uses:
// <id>.glb, <id>.hdr, <id>.cube and <id>.png, .jpg or .webp. ?catalogStore=1 adds the Import command, which posts the file to that
// folder. ?scene=<file> opens a scene.json from the same origin.
// The bundled HDRIs and looks load from assets/looks with no folder.
const SCENE_FILE_PATTERN = /^\/[\w\-./]+\.json$/;
const SCENE_SEGMENT_PATTERN = /^[\w.-]+$/;

// The address bar chooses these files, so the page reads them only from its own origin, by path alone (no query, no
// credentials sent), and a link to this page cannot make it call anything else.
function sameOriginUrl(value) {
  const requested = new URL(value, window.location.href);
  if (requested.origin !== window.location.origin) {
    throw new Error(`This page only reads files from ${window.location.origin}, not ${requested.origin}.`);
  }
  return new URL(requested.pathname, window.location.origin);
}

function sceneFilePath(value) {
  const url = sameOriginUrl(value);
  const segments = url.pathname.split('/').filter(Boolean);
  if (!SCENE_FILE_PATTERN.test(url.pathname) || segments.length === 0 || segments.some(segment => segment === '.' || segment === '..' || !SCENE_SEGMENT_PATTERN.test(segment))) {
    throw new Error('?scene= takes the path of a .json scene file on this origin.');
  }
  return `/${segments.map(encodeURIComponent).join('/')}`;
}

function catalogHooksFor(folderParameter, storeParameter) {
  const folder = folderParameter ? sameOriginUrl(folderParameter.endsWith('/') ? folderParameter : `${folderParameter}/`) : null;
  return createCatalogHooks(folder, undefined, { catalogStore: storeParameter === '1' });
}

function reportProgress(milestone) {
  reportStudioLoadingProgress(document, STUDIO_LOADING_MILESTONES[milestone]);
}

async function mountStudioPage() {
  const root = document.querySelector('#studio-root');
  if (!root) {
    return;
  }
  reportProgress('modulesLoaded');
  const parameters = new URLSearchParams(window.location.search);
  await loadAllAgentSceneModules({ onModuleLoaded: (loaded, total) => reportStudioModulesLoaded(document, loaded, total) });
  reportProgress('sceneModulesLoaded');
  const studio = createStudio(root, { catalog: catalogHooksFor(parameters.get('catalog'), parameters.get('catalogStore')) });
  reportProgress('studioCreated');
  studio.selectNode('cube');
  window.__studioPage = studio;
  const sceneParameter = parameters.get('scene');
  if (sceneParameter) {
    const scenePath = sceneFilePath(sceneParameter);
    const response = await fetch(scenePath, { credentials: 'omit' });
    if (!response.ok) {
      throw new Error(`${scenePath} did not load (HTTP ${response.status}).`);
    }
    await studio.loadExternalTextFile(await response.text(), { fileName: scenePath.split('/').pop(), recordUndo: false, agent: false });
    reportProgress('sceneFileLoaded');
  }
  await revealStudio({ studio, setupParameter: parameters.get('setup'), documentReference: document, requestFrame: requestAnimationFrame });
}

mountStudioPage().catch(error => {
  window.__studioPageError = error.message;
  showStudioLoadingFailure(document, error);
  console.error(error);
});
