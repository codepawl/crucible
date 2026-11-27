// Pure view model for /tiers.html: formats per-scene comparisons, cross-scene summary ranges, and methodology details.

const METRICS = [
  { id: 'time', name: 'Time', lowerWord: 'faster', higherWord: 'slower' },
  { id: 'memory', name: 'Card memory', lowerWord: 'less memory', higherWord: 'more memory' },
  { id: 'flip', name: 'Error against Cycles, 4,096 samples', lowerWord: 'lower error', higherWord: 'higher error' },
];

export const TIER_GUIDE = {
  draft: {
    title: 'draft',
    purpose: 'Quick look while editing',
    runsOn: 'Glaze, 0.5x render scale, 1 sample, light shading, 8-bit target, coarse LOD',
    tradeOff: 'Aliased edges, quarter pixel count scaled up, no environment lookup',
    apiQuality: 'draft',
  },
  realtime: {
    title: 'realtime',
    purpose: 'Interactive scenes and viewports',
    runsOn: 'Glaze defaults (HDR target, 4x MSAA, 1.0x pixel ratio, full shading)',
    tradeOff: 'Direct and baked light without path-traced multi-bounce global illumination',
    apiQuality: 'realtime',
  },
  'realtime-high': {
    title: 'realtime-high',
    purpose: 'Higher quality live frames',
    runsOn: 'Planned: WebGPU backend, GI cache, temporal upscaling',
    tradeOff: 'Targets hardware GPUs; tracking work in issues #901 and #902',
    apiQuality: 'realtime-high',
  },
  final: {
    title: 'final',
    purpose: 'Path-traced stills at 256 samples',
    runsOn: 'Cook native (Vulkan ray queries) with Cook WebGPU WGSL fallback',
    tradeOff: 'Uses optional @codepawlhq/cook; metal, glass, and outdoor-hdri show higher bias floor',
    apiQuality: 'final',
  },
};

const SCENE_LABELS = {
  'lit-interior': 'Lit interior',
  'spot-area': 'Spot and area',
  'light-linking': 'Light linking',
  metal: 'Metal',
  glass: 'Glass',
  'outdoor-hdri': 'Outdoor HDRI',
};

export function formatSceneName(sceneId) {
  return SCENE_LABELS[sceneId] ?? sceneId;
}

function grouped(value, digits) {
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// Times keep three significant figures at most: 0.68 ms, 57.4 ms, 363 ms, 1.32 s.
function digitsFor(figure, metricId) {
  if (metricId !== 'time') return figure.digits;
  if (figure.median >= 100) return 0;
  return figure.median >= 10 ? 1 : 2;
}

function formatSpread(figure, unit, digits) {
  const middle = `${grouped(figure.median, digits)}${unit}`;
  if (figure.runs < 2 || figure.low === figure.high) return { value: middle, range: null };
  return { value: middle, range: `${grouped(figure.low, digits)} to ${grouped(figure.high, digits)}` };
}

function metricFigure(part, metricId) {
  if (metricId === 'time') return { figure: part.time, unit: ` ${part.time.unit}`, note: part.time.means };
  if (metricId === 'memory') return { figure: part.memoryMebibytes, unit: ' MiB', note: 'added on the card' };
  return { figure: part.flip, unit: '', note: 'FLIP, lower is better' };
}

function formatMultiplier(ratio) {
  if (ratio >= 10) return `${Math.round(ratio)}x`;
  return `${ratio.toFixed(1)}x`;
}

function describeComparison(crucibleValue, blenderValue, metric) {
  if (!(crucibleValue > 0) || !(blenderValue > 0)) return '';
  const ratio = blenderValue / crucibleValue;
  if (ratio >= 1.15) return `${formatMultiplier(ratio)} ${metric.lowerWord}`;
  const inverse = crucibleValue / blenderValue;
  if (inverse >= 1.15) return `${formatMultiplier(inverse)} ${metric.higherWord}`;
  return 'About even';
}

function describePart(part, metricId, largest) {
  const { figure, unit, note } = metricFigure(part, metricId);
  return { label: part.label, ...formatSpread(figure, unit, digitsFor(figure, metricId)), note, share: largest > 0 ? figure.median / largest : 0 };
}

function resolveTiersForScene(data, sceneId) {
  if (sceneId && data.scenes && data.scenes[sceneId]) return data.scenes[sceneId].tiers;
  return data.tiers;
}

function buildTierDescription(tiers, data, tierId) {
  const tier = tiers.find(candidate => candidate.id === tierId);
  if (!tier) throw new Error(`Unknown tier "${tierId}"; pass one of ${tiers.map(candidate => candidate.id).join(', ')}`);
  if (tier.status === 'planned') return { id: tier.id, status: 'planned', issues: tier.issues, rows: [] };
  const rows = METRICS.map(metric => {
    const { crucible, blender } = tier;
    const crucibleValue = metricFigure(crucible, metric.id).figure.median;
    const blenderValue = metricFigure(blender, metric.id).figure.median;
    const largest = Math.max(crucibleValue, blenderValue);
    return {
      id: metric.id,
      name: metric.name,
      delta: describeComparison(crucibleValue, blenderValue, metric),
      crucible: describePart(crucible, metric.id, largest),
      blender: describePart(blender, metric.id, largest),
    };
  });
  return { id: tier.id, status: 'measured', rows };
}

export function describeTier(data, tierId) {
  return buildTierDescription(data.tiers, data, tierId);
}

export function describeTierForScene(data, tierId, sceneId = data.scene) {
  return buildTierDescription(resolveTiersForScene(data, sceneId), data, tierId);
}

function formatCrossSceneRange(values, unit, digits) {
  const low = Math.min(...values);
  const high = Math.max(...values);
  return `${grouped(low, digits)} to ${grouped(high, digits)}${unit}`;
}

function scientific(value) {
  if (value === null || value === undefined) return 'n/a';
  return value.toExponential(2);
}

function buildSceneDetails(tier) {
  if (!tier || tier.status === 'planned') return [];
  const items = [];
  if (tier.id === 'draft' || tier.id === 'realtime') {
    const { crucible, blender } = tier;
    const timeSpread = formatSpread(crucible.time, ' ms', digitsFor(crucible.time, 'time'));
    items.push({ label: 'Frame with pixel read', value: timeSpread.value, note: timeSpread.range ? `${timeSpread.range} over ${crucible.runs} runs` : crucible.time.means });
    if (crucible.throughputMilliseconds) {
      const queued = formatSpread(crucible.throughputMilliseconds, ' ms', digitsFor(crucible.throughputMilliseconds, 'time'));
      items.push({ label: 'Queued back to back', value: queued.value, note: queued.range ? `${queued.range} on GPU queue without pixel read` : 'GPU queue without pixel read' });
    }
    if (crucible.firstFrameMilliseconds) {
      const first = formatSpread(crucible.firstFrameMilliseconds, ' ms', digitsFor(crucible.firstFrameMilliseconds, 'time'));
      items.push({ label: 'First frame cold start', value: first.value, note: first.range ? `${first.range} over ${crucible.runs} runs` : 'Includes pipeline warmup' });
    }
    const eeveeSpread = formatSpread(blender.time, ' ms', digitsFor(blender.time, 'time'));
    items.push({ label: blender.label, value: eeveeSpread.value, note: 'One full render call (scene sync, ray tracing off, no GI)' });
    return items;
  }
  const { crucible, blender, webgpu, equalError } = tier;
  if (crucible.perSampleMilliseconds && blender.perSampleMilliseconds) {
    const nativeSample = crucible.perSampleMilliseconds.median;
    const cyclesSample = blender.perSampleMilliseconds.median;
    items.push({
      label: 'Per-sample render speed',
      value: `${grouped(nativeSample, 2)} ms`,
      note: `${formatMultiplier(cyclesSample / nativeSample)} faster than Cycles (${grouped(cyclesSample, 2)} ms/sample)`,
    });
  }
  if (webgpu) {
    const webgpuTime = formatSpread(webgpu.time, ' s', digitsFor(webgpu.time, 'time'));
    const perSample = webgpu.perSampleMilliseconds ? `${grouped(webgpu.perSampleMilliseconds.median, 2)} ms/sample` : '';
    const slowdown = webgpu.slowdownVsNative ? `, ${webgpu.slowdownVsNative}x slower than native` : '';
    const parity = webgpu.flipVsNative === undefined ? '' : `, FLIP ${webgpu.flipVsNative} vs native`;
    items.push({
      label: 'Cook WebGPU (WGSL fallback)',
      value: webgpuTime.value,
      note: `${perSample}${slowdown}${parity}`.replace(/^, /, ''),
    });
  }
  if (equalError) {
    if (equalError.outcome === 'noise') {
      items.push({
        label: 'Time to Cycles 256-sample noise',
        value: `${equalError.timeRatioSampling.toFixed(2)}x sampling`,
        note: `Needs ${equalError.sampleRatio}x Cycles samples (${equalError.timeRatioTotal.toFixed(2)}x total with setup); error scales as 1/N`,
      });
    } else if (equalError.outcome === 'target-floor') {
      items.push({
        label: 'Equal-error floor',
        value: 'Bias-limited',
        note: `Both engines flatten before matching Cycles 1024-sample floor (Cook ${scientific(equalError.cookRelMse1024)}, Cycles ${scientific(equalError.cyclesRelMse1024)})`,
      });
    } else {
      items.push({
        label: 'Equal-error bias floor',
        value: 'Not reached by 1,024 spp',
        note: `Cook error drops slower than 1/N (${scientific(equalError.cookRelMse256)} at 256 spp to ${scientific(equalError.cookRelMse1024)} at 1,024 spp vs Cycles ${scientific(equalError.cyclesRelMse256)})`,
      });
    }
  }
  return items;
}

export function describeTierOverview(data, tierId, sceneId = data.scene) {
  const guide = TIER_GUIDE[tierId];
  if (!guide) throw new Error(`Unknown tier "${tierId}"`);
  const activeTier = resolveTiersForScene(data, sceneId).find(candidate => candidate.id === tierId);
  if (!activeTier || activeTier.status === 'planned') {
    return {
      ...guide,
      status: 'planned',
      issues: activeTier?.issues ?? [901, 902],
      summaryStats: [],
      details: [],
    };
  }
  const sceneIds = data.sceneOrder ?? Object.keys(data.scenes ?? {});
  const allTiers = sceneIds.map(name => resolveTiersForScene(data, name).find(candidate => candidate.id === tierId)).filter(Boolean);
  const summaryStats = [];
  if (allTiers.length > 0) {
    const unit = ` ${allTiers[0].crucible.time.unit}`;
    summaryStats.push({
      label: `Range across ${allTiers.length} scenes`,
      value: formatCrossSceneRange(allTiers.map(entry => entry.crucible.time.median), unit, 2),
    });
    summaryStats.push({
      label: 'Card memory range',
      value: formatCrossSceneRange(allTiers.map(entry => entry.crucible.memoryMebibytes.median), ' MiB', 0),
    });
    summaryStats.push({
      label: 'FLIP error range',
      value: formatCrossSceneRange(allTiers.map(entry => entry.crucible.flip.median), '', 3),
    });
  }
  return {
    ...guide,
    status: 'measured',
    issues: [],
    summaryStats,
    details: buildSceneDetails(activeTier),
  };
}

export function describeSceneBreakdown(data, tierId) {
  const sceneIds = data.sceneOrder ?? (data.scenes ? Object.keys(data.scenes) : [data.scene]);
  return sceneIds.map(sceneId => {
    const tier = resolveTiersForScene(data, sceneId).find(candidate => candidate.id === tierId);
    if (!tier || tier.status === 'planned') return null;
    const { crucible, blender } = tier;
    const crucibleTime = formatSpread(crucible.time, ` ${crucible.time.unit}`, digitsFor(crucible.time, 'time')).value;
    const blenderTime = formatSpread(blender.time, ` ${blender.time.unit}`, digitsFor(blender.time, 'time')).value;
    const crucibleMemory = formatSpread(crucible.memoryMebibytes, ' MiB', 0).value;
    const blenderMemory = formatSpread(blender.memoryMebibytes, ' MiB', 0).value;
    const crucibleFlip = formatSpread(crucible.flip, '', 3).value;
    const blenderFlip = formatSpread(blender.flip, '', 3).value;
    let extra = '';
    if (crucible.throughputMilliseconds) {
      extra = `Queued ${grouped(crucible.throughputMilliseconds.median, 2)} ms, cold ${grouped(crucible.firstFrameMilliseconds.median, 1)} ms`;
    } else if (tier.equalError?.outcome === 'noise') {
      extra = `${tier.equalError.timeRatioSampling.toFixed(2)}x Cycles time to same noise`;
    } else if (tier.equalError) {
      extra = 'Bias floor at 1,024 spp';
    }
    return {
      scene: sceneId,
      sceneLabel: formatSceneName(sceneId),
      crucibleTime,
      blenderTime,
      speedRatio: describeComparison(crucible.time.median, blender.time.median, METRICS[0]),
      crucibleMemory,
      blenderMemory,
      crucibleFlip,
      blenderFlip,
      extra,
    };
  }).filter(Boolean);
}

export function describeConditions(data) {
  const { card, blender, node, platform, date } = data.conditions;
  return {
    hardware: card,
    software: `${blender}, Node ${node.replace(/^v/, '')}, ${platform}`,
    size: `${data.width} by ${data.height}`,
    date,
    scene: data.scene,
  };
}
