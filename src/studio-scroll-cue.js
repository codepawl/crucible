// The cue for a Studio card body that scrolls: which edges have content hidden past them. The stylesheet fades those edges
// (data-fade-top, data-fade-bottom), and the thin scrollbar of .crucible-studio-scroll shows that the body scrolls at all.

const EDGE_TOLERANCE_PIXELS = 1;

export function scrollFadeEdges({ scrollTop, clientHeight, scrollHeight }) {
  const hiddenBelow = scrollHeight - clientHeight - scrollTop;
  const scrolls = scrollHeight - clientHeight > EDGE_TOLERANCE_PIXELS;
  return {
    top: scrolls && scrollTop > EDGE_TOLERANCE_PIXELS,
    bottom: scrolls && hiddenBelow > EDGE_TOLERANCE_PIXELS,
  };
}

export function applyScrollFade(element) {
  const edges = scrollFadeEdges(element);
  setMarker(element, 'fadeTop', edges.top);
  setMarker(element, 'fadeBottom', edges.bottom);
  return edges;
}

function setMarker(element, name, present) {
  if (present) {
    element.dataset[name] = 'true';
  } else {
    delete element.dataset[name];
  }
}

// Keeps the markers of `element` current while it scrolls, resizes or changes its rows. Returns the function that refreshes them now.
export function watchScrollFade(element) {
  const view = element.ownerDocument?.defaultView ?? globalThis;
  const refresh = () => applyScrollFade(element);
  element.addEventListener('scroll', refresh, { passive: true });
  if (typeof view.ResizeObserver === 'function') new view.ResizeObserver(refresh).observe(element);
  if (typeof view.MutationObserver === 'function') {
    new view.MutationObserver(refresh).observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style', 'class'] });
  }
  refresh();
  return refresh;
}
