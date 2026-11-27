// The equal-error assessment of Cook native against Cycles: how many samples Cook needs to reach Cycles' 256 sample error, and what that costs in time.
// Shared by make-table.mjs (the tables). The caller says how to read one engine's measured points
// ({ samples, relMse, samplingSeconds, totalSeconds }) so each keeps its own rule for contended runs.
import { median } from './idle-gate.mjs';

// Cook's relMSE is read as noise-limited only when it falls roughly as 1 over N between the two measured counts. A 1024 sample error above
// this share of the 256 sample error (1/N would give 0.25) means the error is held up by something that more samples do not remove: a bias.
export const BIAS_LIMIT_RATIO = 0.4;
export const REFERENCE_SAMPLES = 256;
export const LONGER_SAMPLES = 1024;

// How one engine's relMSE moves between 256 and 1024 samples. 1/N gives a ratio of 0.25.
function errorTrend(points) {
  const short = points.find(point => point.samples === REFERENCE_SAMPLES);
  const long = points.find(point => point.samples === LONGER_SAMPLES);
  if (!short || !long || !(short.relMse > 1e-9)) return null;
  const ratio = long.relMse / short.relMse;
  return { short: short.relMse, long: long.relMse, ratio, biasLimited: ratio > BIAS_LIMIT_RATIO };
}

// Samples at which an error that falls as 1 over N from the longer measured count reaches the target.
function samplesForError(longPoint, targetError) {
  return (longPoint.samples * longPoint.relMse) / targetError;
}

// The equal-error assessment of Cook native against Cycles on one scene. Three outcomes:
//   noise: both errors fall roughly as 1/N between 256 and 1024 samples, so the ratio is extrapolated from 1024 samples and printed.
//   native-bias: Cook native's error falls slower than 1/N, so no ratio is given.
//   target-floor: the Cycles 256 sample error itself falls slower than 1/N (a floor, not a noise level), so no ratio is given.
export function equalErrorAssessment(scene, countedPoints) {
  const cycles = countedPoints(scene, 'cycles');
  const native = countedPoints(scene, 'cook-native');
  const cyclesTrend = errorTrend(cycles);
  const nativeTrend = errorTrend(native);
  if (!cyclesTrend || !nativeTrend) return null;
  const reference = cycles.find(point => point.samples === REFERENCE_SAMPLES);
  const longNative = native.find(point => point.samples === LONGER_SAMPLES);
  const assessment = { scene, cyclesTrend, nativeTrend, targetRelMse: reference.relMse, outcome: 'noise' };
  if (nativeTrend.biasLimited) return { ...assessment, outcome: 'native-bias' };
  if (cyclesTrend.biasLimited) return { ...assessment, outcome: 'target-floor' };
  const needed = samplesForError(longNative, reference.relMse);
  const perSampleNative = median(native.map(point => point.samplingSeconds / point.samples));
  const setupNative = median(native.map(point => point.totalSeconds - point.samplingSeconds));
  const perSampleCycles = reference.samplingSeconds / reference.samples;
  const samplingTime = needed * perSampleNative;
  const totalTime = samplingTime + setupNative;
  return {
    ...assessment, samplesNeeded: needed, sampleRatio: needed / reference.samples, perSampleSpeedup: perSampleCycles / perSampleNative,
    samplingSeconds: samplingTime, totalSeconds: totalTime, cyclesSamplingSeconds: reference.samplingSeconds,
    timeRatioSampling: samplingTime / reference.samplingSeconds, timeRatioTotal: totalTime / reference.totalSeconds,
  };
}
