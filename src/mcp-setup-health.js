// Structured MCP setup diagnostics so agents surface misconfiguration instead of silently building degraded scenes.

const EIGHT_GIBIBYTES = 8 * 1024 * 1024 * 1024;
const RECOMMENDED_MINIMUM_MEMORY_MIB = 256;

/**
 * Assess launch and runtime prerequisites and return `{ status: 'ok' | 'degraded', warnings }`.
 * Each warning carries `{ code, severity, impact, fix }`.
 */
export function assessMcpSetupHealth({
  backend = 'gpu',
  memory = 256,
  totalMemoryBytes = EIGHT_GIBIBYTES,
  assetsConfigured = true,
  jobsConfigured = true,
  packsConfigured = false,
  nativeCookAvailable = null,
  softwareWebGl = false,
  skillSyncMismatch = null,
} = {}) {
  const warnings = [];
  if (backend === 'cpu') {
    warnings.push({
      code: 'CPU_BACKEND',
      severity: 'warn',
      impact: 'MCP preview and jobs run on SwiftShader CPU emulation instead of hardware GPU, which is slow and skips native path tracing.',
      fix: 'Restart crucible-mcp with --backend gpu (default) or verify Chrome GPU support with `npx crucible doctor`.',
    });
  } else if (softwareWebGl) {
    warnings.push({
      code: 'SOFTWARE_WEBGL_FALLBACK',
      severity: 'warn',
      impact: 'Hardware GPU was requested, but Chrome selected software WebGL (SwiftShader/llvmpipe). Renders will be slower.',
      fix: 'Pass `--browser <chrome-path>` or check your GPU driver setup with `npx crucible doctor`.',
    });
  }
  if (totalMemoryBytes >= EIGHT_GIBIBYTES && Number.isFinite(memory) && memory < RECOMMENDED_MINIMUM_MEMORY_MIB) {
    warnings.push({
      code: 'LOW_MEMORY',
      severity: 'warn',
      impact: `Memory budget is ${memory} MiB on an 8+ GiB machine, which shrinks render targets and limits textures.`,
      fix: 'Restart crucible-mcp with `--memory 256` (or `--memory 512`), or run `npx crucible doctor --fix`.',
    });
  }
  if (!assetsConfigured) {
    warnings.push({
      code: 'ASSETS_UNCONFIGURED',
      severity: 'info',
      impact: 'No `--assets` directory is configured, so `scene_asset_catalog` cannot serve external GLB, HDRI, or texture assets.',
      fix: 'Pass `--assets <absolute-folder>` when launching crucible-mcp if this task uses external GLB/HDRI files.',
    });
  }
  if (!jobsConfigured) {
    warnings.push({
      code: 'JOBS_UNCONFIGURED',
      severity: 'info',
      impact: 'No `--jobs` directory is configured, so `scene_render_submit`, `scene_export_glb`, and `scene_export_web` are unavailable.',
      fix: 'Pass `--jobs <absolute-folder>` (or run `npx crucible doctor --fix`) to enable renders and exports.',
    });
  }
  if (nativeCookAvailable === false && backend === 'gpu') {
    warnings.push({
      code: 'NATIVE_COOK_UNAVAILABLE',
      severity: 'info',
      impact: 'Optional `@codepawlhq/cook` native path tracer is unavailable; final renders use GPU/WebGPU or CPU fallback.',
      fix: 'Install `@codepawlhq/cook` in the MCP environment if native Vulkan path tracing is needed (optional when `--packs` or WebGPU suffices).',
    });
  }
  if (typeof skillSyncMismatch === 'string' && skillSyncMismatch.length > 0) {
    warnings.push({
      code: 'SKILLS_OUT_OF_SYNC',
      severity: 'warn',
      impact: `Installed Crucible skills differ from the server version (${skillSyncMismatch}).`,
      fix: 'Update Crucible skills to match this package version (`npx crucible doctor`).',
    });
  }
  if (packsConfigured === false && warnings.length > 0) {
    // Only record status; missing packs alone does not degrade setup health when using procedural recipes.
  }
  return {
    status: warnings.length > 0 ? 'degraded' : 'ok',
    warnings,
  };
}

/** Short instruction notice appended to MCP `instructions` only when setup has warnings. */
export function setupHealthNoticeText(health) {
  if (!health || health.warnings.length === 0) return '';
  const codes = health.warnings.map(warning => warning.code).join(', ');
  return ` Setup health is degraded (${codes}). Report the exact warnings and fixes from scene_capabilities topic setupHealth (or first setupWarnings) to the user instead of falling back to blind raw-code 3D.`;
}
