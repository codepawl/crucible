// The pictures on the New scene cards: one rendered still of each starting scene, made by scripts/render-template-thumbnails.mjs
// with Crucible itself. This module loads only when the chooser opens, and each picture is fetched when its card shows.
export const TEMPLATE_THUMBNAIL_URLS = Object.freeze({
  empty: new URL('../assets/studio-templates/empty.webp', import.meta.url).href,
  blockout: new URL('../assets/studio-templates/blockout.webp', import.meta.url).href,
  showcase: new URL('../assets/studio-templates/showcase.webp', import.meta.url).href,
  pedestal: new URL('../assets/studio-templates/pedestal.webp', import.meta.url).href,
  courtyard: new URL('../assets/studio-templates/courtyard.webp', import.meta.url).href,
});
