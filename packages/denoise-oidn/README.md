# @codepawlhq/crucible-denoise-oidn

OIDN denoising is now built into `@codepawlhq/crucible/addons/denoise-oidn`. Install `@codepawlhq/crucible` and run `npx crucible-oidn-fetch` to download the [Intel Open Image Denoise](https://github.com/RenderKit/oidn) (Apache-2.0) 2.5.1 release for your platform after a SHA-256 check; this package folder remains as a compatibility wrapper.

```sh
npx crucible-oidn-fetch   # downloads the official OIDN release into ./vendor after a SHA-256 check
```

Then ask a render job for it: `settings.renderer: { type: "pathTracer", denoise: "oidn" }`. Samples default to 16 for `oidn`. If the binary is missing, the job uses the wavelet filter (the GPU a-trous filter of the native tracer on `backend: "native"`) and says so in `metrics.pathTracer.denoiserNote`. `OIDN_DENOISE_PATH` points at an `oidnDenoise` you installed yourself.

A render job on `backend: "native"` keeps one OIDN device and filter alive in the Cook addon, so the second and later frames skip the process start, the device creation, the weights load and the PFM files. It needs the shared library from the same release (`findOidnLibrary()` looks next to the tool, in `OIDN_LIBRARY_PATH` and in ./vendor) and a built addon; without either, the job runs the `oidnDenoise` tool as before and `metrics.pathTracer.denoiserNote` says why. The report's `oidnMode` is `"in-process"` or `"cli"`.

```js
import { createNativeOidnDenoiser } from '@codepawlhq/cook';
import { createOidnDenoiser } from '@codepawlhq/crucible/addons/denoise-oidn';

const denoiser = createOidnDenoiser({ createNative: createNativeOidnDenoiser, device: 'cuda' }); // throws, with what to install, when the library or addon is missing
const filtered = await denoiser.denoise({ width, height, color, albedo, normal }); // the first call commits the filter; a changed size recommits
denoiser.lastTimings; // { recommitted, commitSeconds, writeSeconds, executeSeconds, readSeconds } of the last call
denoiser.close();
```

`denoiseWithOidn({ width, height, color, albedo, normal })` takes row-major `Float32Array`s with three floats per pixel and returns the filtered colour. It runs on the CPU by default, so the GPU stays free and the result does not depend on a graphics driver. On one machine the same input gave the same bytes twice (measured).
