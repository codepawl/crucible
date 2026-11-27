import './site-chrome.js';
import './site.css';
import './tiers.css';
import data from '../bench/tiers/results/tier-page-lit-interior.json';
import {
  describeConditions,
  describeSceneBreakdown,
  describeTierForScene,
  describeTierOverview,
  formatSceneName,
} from './tiers-model.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const TIER_ICONS = {
  draft: 'M13 3 5 13.5h6L10 21l8-10.5h-6z',
  realtime: 'M8 5.5v13l11-6.5z',
  'realtime-high': 'M8 5.5v13l11-6.5z',
  final: 'M12 3.5l2.4 5.6 6.1.5-4.6 4 1.4 6-5.3-3.2-5.3 3.2 1.4-6-4.6-4 6.1-.5z',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(pathData, className) {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  const path = document.createElementNS(SVG_NAMESPACE, 'path');
  path.setAttribute('d', pathData);
  svg.append(path);
  return svg;
}

function createBarSlot(kind) {
  const row = element('div', `tiers-bar is-${kind}`);
  const header = element('span', 'tiers-bar-label');
  const titleGroup = element('span', 'tiers-bar-title');
  const label = element('span');
  const delta = kind === 'crucible' ? element('span', 'tiers-bar-delta') : null;
  if (delta) titleGroup.append(label, delta);
  else titleGroup.append(label);
  const value = element('strong');
  header.append(titleGroup, value);
  const track = element('span', 'tiers-track');
  const fill = element('span', 'tiers-fill');
  track.append(fill);
  const note = element('span', 'tiers-bar-note');
  row.append(header, track, note);
  return { row, label, delta, value, fill, note };
}

function updateBarSlot(slot, part, deltaText) {
  slot.label.textContent = part.label;
  if (slot.delta) {
    slot.delta.textContent = deltaText || '';
    slot.delta.hidden = !deltaText;
  }
  slot.value.textContent = part.value;
  slot.fill.style.setProperty('--share', `${Math.max(part.share * 100, 1.5)}%`);
  slot.note.textContent = part.range ? `${part.range} over runs` : part.note;
}

function createPanelController(panel, onSelectScene) {
  const overviewCard = element('section', 'tiers-overview');
  const overviewMain = element('div', 'tiers-overview-main');
  const overviewPurpose = element('h2', 'tiers-overview-title');
  const overviewMeta = element('p', 'tiers-overview-meta');
  const overviewTradeOff = element('p', 'tiers-overview-tradeoff');
  overviewMain.append(overviewPurpose, overviewMeta, overviewTradeOff);
  const overviewStats = element('div', 'tiers-overview-stats');
  overviewCard.append(overviewMain, overviewStats);

  const sceneIds = data.sceneOrder ?? Object.keys(data.scenes ?? {});
  const sceneSection = element('section', 'tiers-scene-section');
  const sceneHeader = element('div', 'tiers-section-head');
  const sceneHeading = element('h2', '', 'Selected scene breakdown');
  const sceneSubtitle = element('span', 'tiers-section-note');
  sceneHeader.append(sceneHeading, sceneSubtitle);
  const sceneBar = element('div', 'tiers-scene-bar');
  sceneBar.setAttribute('role', 'group');
  sceneBar.setAttribute('aria-label', 'Benchmark scene');
  const sceneButtons = new Map();
  for (const sceneId of sceneIds) {
    const button = element('button', 'tiers-scene-chip', formatSceneName(sceneId));
    button.type = 'button';
    button.dataset.scene = sceneId;
    button.addEventListener('click', () => onSelectScene(sceneId));
    sceneBar.append(button);
    sceneButtons.set(sceneId, button);
  }
  sceneSection.append(sceneHeader, sceneBar);

  const metricsGrid = element('div', 'tiers-metrics');
  const metricSlots = [0, 1, 2].map(() => {
    const block = element('section', 'tiers-metric');
    const heading = element('h3');
    const crucibleSlot = createBarSlot('crucible');
    const blenderSlot = createBarSlot('blender');
    block.append(heading, crucibleSlot.row, blenderSlot.row);
    metricsGrid.append(block);
    return { heading, crucibleSlot, blenderSlot };
  });

  const detailsGrid = element('div', 'tiers-details');

  const allScenesSection = element('section', 'tiers-scenes-section');
  const allScenesHeading = element('h2', '', 'All six measured scenes');
  const scenesTable = element('ol', 'tiers-scenes-table');
  const scenesHead = element('li', 'tiers-scene-row tiers-scene-row-head');
  scenesHead.setAttribute('aria-hidden', 'true');
  for (const columnLabel of ['Scene', 'Crucible time', 'Reference time', 'Card memory', 'Error (FLIP)', 'Extra notes']) {
    scenesHead.append(element('span', '', columnLabel));
  }
  scenesTable.append(scenesHead);
  const sceneRows = new Map();
  for (const sceneId of sceneIds) {
    const row = element('li', 'tiers-scene-row');
    row.dataset.scene = sceneId;
    const button = element('button', 'tiers-scene-row-trigger');
    button.type = 'button';
    button.addEventListener('click', () => onSelectScene(sceneId));
    const sceneCell = element('span', 'tiers-scene-name', formatSceneName(sceneId));
    const crucibleCell = element('span', 'tiers-scene-cell');
    const crucibleValue = element('b');
    const crucibleBadge = element('small');
    crucibleCell.append(crucibleValue, crucibleBadge);
    const refCell = element('span', 'tiers-scene-cell');
    const refValue = element('b');
    refCell.append(refValue);
    const memoryCell = element('span', 'tiers-scene-cell');
    const memoryValue = element('b');
    const memoryRef = element('small');
    memoryCell.append(memoryValue, memoryRef);
    const flipCell = element('span', 'tiers-scene-cell');
    const flipValue = element('b');
    const flipRef = element('small');
    flipCell.append(flipValue, flipRef);
    const noteCell = element('span', 'tiers-scene-extra');
    button.append(sceneCell, crucibleCell, refCell, memoryCell, flipCell, noteCell);
    row.append(button);
    scenesTable.append(row);
    sceneRows.set(sceneId, { row, button, crucibleValue, crucibleBadge, refValue, memoryValue, memoryRef, flipValue, flipRef, noteCell });
  }
  allScenesSection.append(allScenesHeading, scenesTable);

  const measuredView = element('div', 'tiers-measured-view');
  measuredView.append(overviewCard, sceneSection, metricsGrid, detailsGrid, allScenesSection);

  const plannedView = element('div', 'tiers-planned');
  const plannedIcon = icon('M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z', 'tiers-planned-icon');
  const plannedTextWrap = element('div', 'tiers-planned-copy');
  const plannedTitle = element('strong', '', 'Planned tier, not measured yet');
  const plannedNote = element('p');
  plannedTextWrap.append(plannedTitle, plannedNote);
  plannedView.append(plannedIcon, plannedTextWrap);
  plannedView.hidden = true;

  panel.replaceChildren(measuredView, plannedView);

  return {
    update(tierId, sceneId) {
      const overview = describeTierOverview(data, tierId, sceneId);
      const isPlanned = overview.status === 'planned';
      measuredView.hidden = isPlanned;
      plannedView.hidden = !isPlanned;

      if (isPlanned) {
        const issueLinks = overview.issues.map(number => `#${number}`).join(', ');
        plannedNote.textContent = `${overview.runsOn}. ${overview.tradeOff}. Tracking issues: ${issueLinks}.`;
        return;
      }

      overviewPurpose.textContent = `${overview.title} (${overview.purpose})`;
      overviewMeta.textContent = `${overview.runsOn} (API settings.quality: "${overview.apiQuality}")`;
      overviewTradeOff.textContent = `Trade-off: ${overview.tradeOff}`;

      overviewStats.replaceChildren(
        ...overview.summaryStats.map(stat => {
          const item = element('div', 'tiers-stat');
          item.append(element('span', '', stat.label), element('strong', '', stat.value));
          return item;
        }),
      );

      for (const [id, button] of sceneButtons) {
        button.setAttribute('aria-pressed', String(id === sceneId));
      }
      sceneSubtitle.textContent = `Showing ${formatSceneName(sceneId)} (${data.width}x${data.height})`;

      const description = describeTierForScene(data, tierId, sceneId);
      description.rows.forEach((row, index) => {
        const slot = metricSlots[index];
        slot.heading.textContent = row.name;
        updateBarSlot(slot.crucibleSlot, row.crucible, row.delta);
        updateBarSlot(slot.blenderSlot, row.blender, '');
      });

      detailsGrid.replaceChildren(
        ...overview.details.map(detail => {
          const card = element('div', 'tiers-detail-card');
          card.append(
            element('span', 'tiers-detail-label', detail.label),
            element('strong', 'tiers-detail-value', detail.value),
            element('span', 'tiers-detail-note', detail.note),
          );
          return card;
        }),
      );

      const breakdown = describeSceneBreakdown(data, tierId);
      for (const entry of breakdown) {
        const slot = sceneRows.get(entry.scene);
        if (!slot) continue;
        const active = entry.scene === sceneId;
        slot.row.classList.toggle('is-active', active);
        slot.button.setAttribute('aria-pressed', String(active));
        slot.crucibleValue.textContent = entry.crucibleTime;
        slot.crucibleBadge.textContent = entry.speedRatio;
        slot.refValue.textContent = entry.blenderTime;
        slot.memoryValue.textContent = entry.crucibleMemory;
        slot.memoryRef.textContent = `vs ${entry.blenderMemory}`;
        slot.flipValue.textContent = entry.crucibleFlip;
        slot.flipRef.textContent = `vs ${entry.blenderFlip}`;
        slot.noteCell.textContent = entry.extra;
      }
    },
  };
}

function renderConditions(container) {
  const conditions = describeConditions(data);
  container.replaceChildren(
    element('span', '', conditions.hardware),
    element('span', '', conditions.software),
    element('span', '', `${conditions.size} px, ${data.sceneOrder?.length ?? 6} scenes`),
    element('span', '', `measured ${conditions.date}`),
  );
}

function renderMethodology(container) {
  const heading = element('h2', '', 'Methodology and definitions');
  const summary = element(
    'p',
    'tiers-method-copy',
    `Each measurement takes the median across up to three non-contended runs with engines interleaved on an idle GPU (${data.idleGate?.contendedCount ?? 0} of ${data.idleGate?.totalRuns ?? 162} runs contended). Glaze primary times include pixel readback; queued times measure back-to-back GPU work without readback. EEVEE timings cover a whole render call with scene sync, ray tracing off, and no GI. Quality error uses FLIP and relative MSE against ${data.referenceSamples ?? 4096}-sample Cycles renders.`,
  );
  const links = element('nav', 'tiers-method-links');
  links.setAttribute('aria-label', 'Benchmark references');
  const linkItems = [
    ['Raw six-scene matrix (Markdown)', 'https://github.com/codepawl/crucible/blob/main/bench/tiers/results/matrix-960.table.md'],
    ['Benchmark runner and scoring rules', 'https://github.com/codepawl/crucible/blob/main/bench/tiers/README.md'],
    ['Performance and memory guide', '/docs.html#performance-and-memory'],
  ];
  for (const [label, href] of linkItems) {
    const anchor = element('a', '', label);
    anchor.href = href;
    links.append(anchor);
  }
  container.replaceChildren(heading, summary, links);
}

const panel = document.getElementById('tiers-panel');
renderConditions(document.getElementById('tiers-conditions'));
renderMethodology(document.getElementById('tiers-method'));

let activeTierId = null;
let activeSceneId = data.scene;
const controller = createPanelController(panel, nextSceneId => {
  if (nextSceneId === activeSceneId) return;
  activeSceneId = nextSceneId;
  controller.update(activeTierId, activeSceneId);
});

const switchContainer = document.getElementById('tiers-switch');
const tierButtons = data.tiers.map(tier => {
  const button = element('button', `tiers-tab${tier.status === 'planned' ? ' is-planned' : ''}`);
  button.type = 'button';
  button.dataset.tier = tier.id;
  button.append(icon(TIER_ICONS[tier.id], 'tiers-tab-icon'), element('span', '', tier.id));
  button.addEventListener('click', () => selectTier(tier.id));
  return button;
});
switchContainer.replaceChildren(...tierButtons);

function selectTier(tierId) {
  if (tierId === activeTierId) return;
  activeTierId = tierId;
  for (const button of tierButtons) button.setAttribute('aria-pressed', String(button.dataset.tier === tierId));
  controller.update(activeTierId, activeSceneId);
}

const initialHash = location.hash.slice(1);
selectTier(data.tiers.some(tier => tier.id === initialHash) ? initialHash : data.tiers[0].id);

window.addEventListener('hashchange', () => {
  const requested = location.hash.slice(1);
  if (data.tiers.some(tier => tier.id === requested)) selectTier(requested);
});
