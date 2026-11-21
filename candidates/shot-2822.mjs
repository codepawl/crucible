import { chromium } from 'playwright';

const [, , baseUrl, outputDirectory, ...names] = process.argv;
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  for (const name of names) {
    for (const [label, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on('pageerror', error => { errors.push(error.message); console.log('PAGEERROR', error.message); });
      page.on('requestfailed', request => console.log('REQFAIL', request.url()));
      page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); console.log('CONSOLE', message.text().slice(0, 300)); }; });
      await page.goto(`${baseUrl}/modeling.html?scene=${name}`);
      await page.waitForFunction(() => window.__scene?.renderer || window.__modelingError, null, { timeout: 120000 });
      const problem = await page.evaluate(() => window.__modelingError);
      if (problem) console.log(name, label, 'ERROR', problem);
      await page.evaluate(() => { window.__scene.pause(); window.__scene.renderAt(2.5); });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${outputDirectory}/${name}-${label}.png` });
      console.log(name, label, await page.locator('#modeling-stat').textContent(), errors.slice(0, 3));
      await page.close();
    }
  }
} finally {
  await browser.close();
}
