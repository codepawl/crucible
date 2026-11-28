// The Animate timeline's keys in one piece: the markers on the scrub bar, a row per animated property with its key editor,
// and the key buttons on the Object panel's rows. studio.js builds it once and syncs it with the playhead.
import { createKeyMarkers } from './studio-timeline-keys.js';
import { createTimelineRows } from './studio-timeline-rows.js';
import { createPropertyKeyButtons } from './studio-property-key-buttons.js';

export function createTimelinePanel({ documentReference, createElement, createIcon, createIconButton, controller, announce, isDeleteKey, keysElement, trackElement, fallbackFocus, propertyRows }) {
  const keyMarkers = createKeyMarkers({ documentReference, controller, keysElement, trackElement, announce, isDeleteKey, fallbackFocus });
  const rows = createTimelineRows({ documentReference, createElement, createIcon, createIconButton, controller, announce, isDeleteKey });
  const buttons = createPropertyKeyButtons({ controller, rows: propertyRows, createIconButton, announce });
  return {
    rowsElement: rows.rowsElement,
    editorElement: rows.editorElement,
    sync(duration) {
      keyMarkers.sync(duration);
      rows.sync(duration);
      buttons.sync();
    },
  };
}
