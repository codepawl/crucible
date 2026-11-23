// Loading the preview page (goto, then waiting for window.__agentPreview) takes longer on a busy machine than any later page call,
// so it gets its own bounded limit instead of the 15 s default of the other page calls.
export const PAGE_LOAD_TIMEOUT_MS = 60000;

export function pageLoadTimeoutMessage(timeoutMs) {
  const seconds = Math.round(timeoutMs / 1000);
  return `The preview page did not load in ${seconds} s, most likely because the machine is busy. Retry the call, or lower the number of parallel render jobs and scenes.`;
}

export async function loadPreviewPage(page, origin, timeoutMs = PAGE_LOAD_TIMEOUT_MS) {
  try {
    await page.goto(origin, { timeout: timeoutMs });
    await page.waitForFunction(() => Boolean(window.__agentPreview), undefined, { timeout: timeoutMs });
  } catch (error) {
    if (!/Timeout \d+ms exceeded/i.test(String(error?.message))) throw error;
    const timeoutError = new Error(pageLoadTimeoutMessage(timeoutMs), { cause: error });
    timeoutError.pageLoadTimeout = true;
    throw timeoutError;
  }
}
