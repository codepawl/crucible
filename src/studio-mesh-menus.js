// Edit-mode menus of Studio: Delete (X), Merge (M), Separate (P), Symmetrize and the Mesh tools context menu
// (right-click in the edit-mode viewport or the rail button). Kept separate so studio.js stays focused on layout.

const SYMMETRIZE_DIRECTIONS = Object.freeze([
  Object.freeze({ axis: 'x', keep: 'positive', label: '+X to -X' }),
  Object.freeze({ axis: 'x', keep: 'negative', label: '-X to +X' }),
  Object.freeze({ axis: 'y', keep: 'positive', label: '+Y to -Y' }),
  Object.freeze({ axis: 'y', keep: 'negative', label: '-Y to +Y' }),
  Object.freeze({ axis: 'z', keep: 'positive', label: '+Z to -Z' }),
  Object.freeze({ axis: 'z', keep: 'negative', label: '-Z to +Z' }),
]);

/** Builds the edit-mode popovers and returns them with `openMeshMenu`, `openToolsAt` and `isOpen`. */
export function createMeshMenus({
  createMenuPopover,
  createMenuItem,
  controller,
  getCanvas,
  openPopoverAt,
  getMeshEditor,
  separateMeshSelection,
  onStartTool = () => {},
  onTopologyApplied,
}) {
  let lastMenuPoint = null;

  const applyEdit = action => {
    const editor = getMeshEditor();
    if (!editor) {
      return;
    }
    action(editor);
    onTopologyApplied();
  };

  const separatePopover = createMenuPopover(
    'crucible-studio-pop-separate',
    createMenuItem('Selection', 'mesh.separate', () => separateMeshSelection(), 'duplicate'),
  );
  const meshDeletePopover = createMenuPopover(
    'crucible-studio-pop-mesh-delete',
    createMenuItem('Dissolve Vertices', '', () => applyEdit(editor => editor.dissolve('vertices')), 'meshVertex'),
    createMenuItem('Dissolve Edges', '', () => applyEdit(editor => editor.dissolve('edges')), 'meshEdge'),
    createMenuItem('Dissolve Faces', '', () => applyEdit(editor => editor.dissolve('faces')), 'meshFace'),
  );
  const meshMergeCenterItem = createMenuItem('At Center', '', () => applyEdit(editor => editor.merge('center')), 'meshVertex');
  const meshMergeFirstItem = createMenuItem('At First', '', () => applyEdit(editor => editor.merge('first')), 'meshVertex');
  const meshMergeLastItem = createMenuItem('At Last', '', () => applyEdit(editor => editor.merge('last')), 'meshVertex');
  const meshMergeCollapseItem = createMenuItem('Collapse', '', () => applyEdit(editor => editor.merge('collapse')), 'meshVertex');
  const meshMergePopover = createMenuPopover(
    'crucible-studio-pop-mesh-merge',
    meshMergeCenterItem,
    meshMergeFirstItem,
    meshMergeLastItem,
    meshMergeCollapseItem,
  );
  const meshSymmetrizePopover = createMenuPopover(
    'crucible-studio-pop-mesh-symmetrize',
    ...SYMMETRIZE_DIRECTIONS.map(({ axis, keep, label }) => createMenuItem(
      label,
      '',
      () => applyEdit(editor => editor.symmetrize({ axis, keep })),
      'seeThrough',
    )),
  );

  function syncMergeItems() {
    const editor = getMeshEditor();
    const isAtFirstOrLastAvailable = editor?.mode === 'vertex';
    for (const item of [meshMergeFirstItem, meshMergeLastItem]) {
      item.setAttribute('aria-disabled', isAtFirstOrLastAvailable ? 'false' : 'true');
    }
  }

  function openMeshMenu(popover) {
    const editor = getMeshEditor();
    const bounds = getCanvas().getBoundingClientRect();
    const centre = editor?.selectionCentre;
    const pixel = centre ? controller.projectWorldPoint(centre) : null;
    syncMergeItems();
    const pointX = bounds.left + (pixel?.x ?? bounds.width / 2);
    const pointY = bounds.top + (pixel?.y ?? bounds.height / 2);
    lastMenuPoint = [pointX, pointY];
    openPopoverAt(popover, pointX, pointY);
  }

  function openSubmenu(popover) {
    syncMergeItems();
    if (lastMenuPoint) {
      openPopoverAt(popover, ...lastMenuPoint);
      return;
    }
    const toolsBox = meshToolsPopover.getBoundingClientRect?.();
    if (toolsBox && toolsBox.width > 0) {
      openPopoverAt(popover, toolsBox.left, toolsBox.top);
      return;
    }
    openMeshMenu(popover);
  }

  function openToolsAt(clientX, clientY) {
    lastMenuPoint = [clientX, clientY];
    openPopoverAt(meshToolsPopover, clientX, clientY);
  }

  const mergeRow = createMenuItem('Merge…', 'mesh.mergeMenu', () => openSubmenu(meshMergePopover), 'meshVertex');
  mergeRow.dataset.groupStart = 'true';

  const meshToolsPopover = createMenuPopover(
    'crucible-studio-pop-mesh-tools',
    createMenuItem('Bevel', 'mesh.bevel', () => onStartTool('bevel'), 'angle'),
    createMenuItem('Loop cut', 'mesh.loopCut', () => onStartTool('loopCut'), 'meshEdge'),
    createMenuItem('Make face / edge', 'mesh.makeFace', () => applyEdit(editor => editor.makeFace()), 'meshFace'),
    createMenuItem('Fill', '', () => applyEdit(editor => editor.fill()), 'meshFace'),
    createMenuItem('Grid fill', '', () => applyEdit(editor => editor.gridFill()), 'grid'),
    createMenuItem('Bridge edge loops', '', () => applyEdit(editor => editor.bridge()), 'link'),
    createMenuItem('Subdivide', '', () => applyEdit(editor => editor.subdivide()), 'tierBalanced'),
    createMenuItem('Symmetrize…', '', () => openSubmenu(meshSymmetrizePopover), 'seeThrough'),
    mergeRow,
    createMenuItem('Separate…', 'mesh.separate', () => openSubmenu(separatePopover), 'duplicate'),
    createMenuItem('Dissolve…', 'mesh.deleteMenu', () => openSubmenu(meshDeletePopover), 'remove'),
  );
  meshToolsPopover.addEventListener('beforetoggle', event => {
    if (event.newState === 'closed') {
      lastMenuPoint = null;
    }
  });

  const popovers = [separatePopover, meshDeletePopover, meshMergePopover, meshSymmetrizePopover, meshToolsPopover];
  const isOpen = () => popovers.some(popover => {
    try {
      return popover.matches(':popover-open');
    } catch {
      return false;
    }
  });

  return {
    separatePopover,
    meshDeletePopover,
    meshMergePopover,
    meshSymmetrizePopover,
    meshToolsPopover,
    popovers,
    openMeshMenu,
    openToolsAt,
    isOpen,
  };
}
