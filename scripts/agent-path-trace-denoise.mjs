import * as builtinOidn from '../src/denoise-oidn.js';

async function loadOidnPackage() {
  return builtinOidn.findOidnBinary() ? builtinOidn : null;
}

/**
 * What a job's `settings.renderer.denoise` becomes. `true` (the default) and "oidn" mean OIDN with the albedo and normal
 * guides, which needs the built-in `denoise-oidn` addon binary. Without it `note` says so and a filter runs instead, so the
 * job result never claims a denoiser that did not run: the CPU wavelet filter, or on the native backend (`native`) the GPU
 * a-trous filter ("atrous", biased: it smooths). `keepWavelet` makes a missing OIDN fall back to the wavelet filter on
 * native too; the `final` quality tier sets it, because it always ran the wavelet filter before it used OIDN. An explicit
 * "wavelet", "none" or false keeps its meaning everywhere, and OIDN is not loaded for them. The samples a job asked for are
 * never changed here: only an explicit "oidn" without `samples` gets OIDN_DEFAULT_SAMPLES, in agent-render-jobs.mjs.
 */
export async function chooseDenoiser(requested, { native = false, keepWavelet = false, loadOidn = loadOidnPackage } = {}) {
  const isDefault = requested === true;
  if (requested !== 'oidn' && !isDefault) return { denoise: requested };
  const denoiser = await loadOidn();
  if (denoiser) {
    return { denoise: 'oidn', denoiser };
  }
  const reason = 'needs the OIDN binary: run `npx crucible-oidn-fetch` or set OIDN_DENOISE_PATH';
  const lead = isDefault ? 'denoise true uses OIDN, which' : 'denoise "oidn"';
  if (native && !keepWavelet) return { denoise: 'atrous', note: `${lead} ${reason}: the GPU a-trous filter ran instead (it smooths, so it is biased; denoise "wavelet" picks the CPU filter).` };
  return { denoise: 'wavelet', note: `${lead} ${reason}: the wavelet filter ran instead.` };
}

function floatsFromBase64(base64) {
  const bytes = Buffer.from(base64, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/**
 * Filters the features a page returned for denoise "oidn" and gives the result back to the page to draw. If the tool fails,
 * the page filters the same pixels with the wavelet filter and the report says so. Returns the PNG as base64 and the report.
 */
export async function finishWithOidn({ traced, denoiser, drawLinear }) {
  const { width, height } = traced.report;
  const features = Object.fromEntries(['color', 'albedo', 'normal'].map(name => [name, floatsFromBase64(traced.features[name])]));
  const started = performance.now();
  let linear;
  let failure;
  try {
    linear = await denoiser.denoiseWithOidn({ width, height, ...features });
  } catch (error) {
    failure = error.message;
  }
  const denoiseSeconds = (performance.now() - started) / 1000;
  const drawn = await drawLinear({ width, height, ...(linear ? { linear: Buffer.from(linear.buffer, linear.byteOffset, linear.byteLength).toString('base64') } : {}) });
  const report = { ...traced.report, denoised: true, denoiser: linear ? 'oidn' : 'wavelet', denoiseSeconds, ...(linear ? { oidnVersion: denoiser.OIDN_VERSION } : { denoiserNote: `OIDN failed (${failure}): the wavelet filter ran instead.` }) };
  return { data: drawn.data, report };
}
