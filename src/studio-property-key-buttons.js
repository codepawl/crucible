// The key button on the Position, Rotation and Scale rows of the Object panel: filled when the selected object has a key
// on that property at the playhead, and a click puts one there or takes it away.
import { propertyKeyAt } from './studio-property-keys.js';

const PROPERTY_LABELS = Object.freeze({ translation: 'position', rotation: 'rotation', scale: 'scale' });

/** `rows` maps a pose property to its vector row; each row's head gets one button. Returns `sync()` for the panel's refresh. */
export function createPropertyKeyButtons({ controller, rows, createIconButton, announce }) {
  const buttons = Object.entries(rows).map(([property, row]) => {
    const label = `Key ${PROPERTY_LABELS[property]}`;
    const button = createIconButton('keyframe', label, {
      className: 'crucible-studio-mini-btn crucible-studio-key-toggle',
      dataset: { property },
      attributes: { 'aria-pressed': 'false' },
    });
    button.addEventListener('click', () => {
      const nodeId = controller.selectedNodeId;
      if (!nodeId) {
        return;
      }
      try {
        const added = controller.togglePropertyKeyframe(nodeId, property);
        announce(`${added ? 'Keyed' : 'Removed the key of'} ${PROPERTY_LABELS[property]} at ${controller.motionTime.toFixed(2)} s`);
      } catch (error) {
        announce(error);
      }
    });
    row.container.querySelector('.crucible-studio-field-head').append(button);
    return { property, button };
  });

  function sync() {
    const nodeId = controller.selectedNodeId;
    const tracks = controller.exportRecipe().motion?.tracks ?? [];
    for (const { property, button } of buttons) {
      const keyed = Boolean(nodeId && propertyKeyAt(tracks, nodeId, property, controller.motionTime));
      button.setAttribute('aria-pressed', keyed ? 'true' : 'false');
      button.disabled = !nodeId;
    }
  }

  return { sync };
}
