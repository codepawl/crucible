// Checks and captures for the home page (site/index.html), the pour story. Run it against a served build:
//   npm run build && npx vite preview --port 4173
//   node scripts/check-landing.mjs check [--url http://127.0.0.1:4173/] [--out artifacts/landing]
//   node scripts/check-landing.mjs shots     hero, pour and install on a desktop and a phone, as PNG files
//   node scripts/check-landing.mjs video     a scroll-through clip of the story on a desktop and a phone
// `check` scrolls through the story at 20 positions on a desktop, a laptop and a phone and measures every visible line of text
// against the drawn parts of the scene, against the other lines and against the screen edge, how close the stream leaves the spout,
// then repeats the page with reduced motion and with the scene chunk blocked, where the five stills must take the scene's place.
// It exits 1 when text touches a drawn part or another line, a line leaves the screen, or the console is not clean.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argumentsGiven = process.argv.slice(2);
const mode = argumentsGiven.find((argument) => !argument.startsWith('--')) ?? 'check';
const option = (name, fallback) => {
  const index = argumentsGiven.indexOf(`--${name}`);
  return index === -1 ? fallback : argumentsGiven[index + 1];
};
const pageAddress = option('url', 'http://127.0.0.1:4173/');
const outputFolder = resolve(option('out', 'artifacts/landing'));
mkdirSync(outputFolder, { recursive: true });

const SIZES = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'laptop', width: 1024, height: 768 }, { name: 'phone', width: 390, height: 844 }];
const STORY_POSITIONS = 14;
const SECTION_POSITIONS = 6;
const MAXIMUM_SPOUT_DISTANCE_PIXELS = 3;
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-audio-output'] });

async function openPage(options) {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    reducedMotion: options.reduced ? 'reduce' : 'no-preference',
    ...(options.video ? { recordVideo: { dir: options.video, size: { width: options.width, height: options.height } } } : {}),
  });
  const page = await context.newPage();
  const problems = [];
  if (options.blocked) await page.route('**/*landing-scene*', (route) => route.abort());
  page.on('console', (message) => {
    const text = message.text().slice(0, 240);
    const expected = options.blocked && (text.includes('The pour scene could not load') || text.includes('ERR_FAILED') || text.includes('Failed to load resource'));
    if (message.type() === 'error' && !expected) problems.push(text);
  });
  page.on('pageerror', (error) => problems.push(error.message.slice(0, 240)));
  await page.goto(pageAddress);
  await page.waitForFunction('window.pageReady === true', null, { timeout: 45000 }).catch(() => problems.push('page never became ready'));
  await page.evaluate(() => document.fonts.ready);
  return { context, page, problems };
}

// Scroll offsets: evenly through the story, then evenly through the sections below it.
const scrollPlan = (page) => page.evaluate(([storyCount, sectionCount]) => {
  const story = document.getElementById('story');
  const storyTravel = Math.max(0, story.offsetHeight - window.innerHeight);
  const end = document.documentElement.scrollHeight - window.innerHeight;
  const offsets = [];
  for (let index = 0; index < storyCount; index++) offsets.push(story.offsetTop + (storyTravel * index) / (storyCount - 1));
  for (let index = 1; index <= sectionCount; index++) offsets.push(story.offsetTop + storyTravel + ((end - story.offsetTop - storyTravel) * index) / sectionCount);
  return offsets.map((offset) => Math.round(Math.min(end, offset)));
}, [STORY_POSITIONS, SECTION_POSITIONS]);

async function settle(page, offset) {
  await page.evaluate((top) => window.scrollTo(0, top), offset);
  await page.waitForFunction('window.foundryPage.settled()', null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(420);
}

// Runs in the page: every visible line of text against the canvas, the drawn parts and every other line of text.
const measureOverlaps = () => {
  const touching = (first, second, slack) => Math.min(first.right, second.right) - Math.max(first.left, second.left) > slack && Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > slack;
  const lines = [];
  const coveredByChrome = [];
  const walker = document.createTreeWalker(document.getElementById('page'), NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    const owner = node.parentElement;
    if (owner.closest('script, style') || !owner.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })) continue;
    range.selectNodeContents(node);
    for (const box of range.getClientRects()) {
      if (box.width < 2 || box.height < 2 || box.bottom < 0 || box.top > window.innerHeight) continue;
      const hit = document.elementFromPoint(Math.min(window.innerWidth - 1, Math.max(0, box.left + box.width / 2)), Math.min(window.innerHeight - 1, Math.max(0, box.top + box.height / 2)));
      // The notes inside the scene let clicks through, so a hit test cannot see them; nothing is ever drawn over them.
      const covered = !owner.closest('.callouts') && (!hit || !(owner.contains(hit) || hit.contains(owner)));
      if (covered && hit && hit.closest('.ladder, .cue, .hud') && !owner.closest('.ladder, .cue, .hud')) coveredByChrome.push(`${owner.textContent.trim().slice(0, 30)} / ${hit.closest('.ladder, .cue, .hud').className}`);
      if (covered) continue;
      lines.push({ node, text: node.textContent.trim().slice(0, 30), left: box.left, right: box.right, top: box.top, bottom: box.bottom });
    }
  }
  // The sticky nav is opaque, so the part of the canvas that has scrolled under it is not on screen.
  const navBottom = document.querySelector('.nav').getBoundingClientRect().bottom;
  const whole = document.getElementById('foundry').getBoundingClientRect();
  const frame = { left: whole.left, right: whole.right, top: Math.max(whole.top, navBottom), bottom: whole.bottom, width: whole.width };
  const canvasShown = frame.width > 0 && frame.bottom > frame.top && frame.top < window.innerHeight;
  const engine = window.foundryPage.engine;
  const boxes = (engine && canvasShown ? engine.subjectBoxes() : []).filter((box) => box.bottom > navBottom).map((box) => ({ ...box, top: Math.max(box.top, navBottom) }));
  const found = { lines: lines.length, onSubject: [], onText: [...coveredByChrome], pastEdge: [], notes: 0 };
  lines.forEach((line, index) => {
    if (line.node.parentElement.closest('.callouts')) found.notes += 1;
    for (const box of boxes) if (touching(line, box, 1)) found.onSubject.push(`${line.text} / ${box.name}`);
    for (let other = index + 1; other < lines.length; other++) {
      if (lines[other].node !== line.node && touching(line, lines[other], 3)) found.onText.push(`${line.text} / ${lines[other].text}`);
    }
    if (line.right > window.innerWidth + 1 || line.left < -1) found.pastEdge.push(line.text);
  });
  const probe = engine && canvasShown ? engine.probe() : null;
  found.spout = probe && probe.attached ? { distance: probe.distance, leaveAngle: probe.leaveAngle } : null;
  found.overflow = document.documentElement.scrollWidth - window.innerWidth;
  return found;
};

// Reads the frame back right after a draw, to prove the projected stream point really is molten metal on screen.
const streamPixel = () => {
  window.foundryPage.seek(0.2);
  const source = document.getElementById('foundry');
  const probe = window.foundryPage.engine.probe();
  const copy = document.createElement('canvas');
  copy.width = source.width;
  copy.height = source.height;
  const context = copy.getContext('2d');
  context.drawImage(source, 0, 0);
  const scale = source.width / source.clientWidth;
  const read = (point) => [...context.getImageData(Math.round(point[0] * scale), Math.round(point[1] * scale), 1, 1).data.slice(0, 3)];
  return { attached: probe.attached, streamMid: read(probe.streamMid), besideStream: read([probe.streamMid[0] + 40, probe.streamMid[1]]) };
};

async function measureScrollPasses(failures) {
  const report = { passes: {} };
  for (const size of SIZES) {
    const { context, page, problems } = await openPage(size);
    const totals = { positions: 0, lines: 0, onSubject: 0, onText: 0, pastEdge: 0, overflow: 0, notePositions: 0, spoutSamples: 0, spoutDistance: 0, leaveAngle: 0, examples: [] };
    for (const offset of await scrollPlan(page)) {
      await settle(page, offset);
      const found = await page.evaluate(measureOverlaps);
      totals.positions += 1;
      totals.lines += found.lines;
      totals.notePositions += found.notes > 0 ? 1 : 0;
      for (const kind of ['onSubject', 'onText', 'pastEdge']) {
        totals[kind] += found[kind].length;
        if (found[kind].length && totals.examples.length < 6) totals.examples.push(`${kind} at ${offset}: ${found[kind][0]}`);
      }
      totals.overflow = Math.max(totals.overflow, found.overflow);
      if (found.spout) {
        totals.spoutSamples += 1;
        totals.spoutDistance = Math.max(totals.spoutDistance, found.spout.distance);
        totals.leaveAngle = Math.max(totals.leaveAngle, found.spout.leaveAngle);
      }
    }
    if (size.name === 'desktop') totals.streamPixel = await page.evaluate(streamPixel).catch((error) => error.message.slice(0, 120));
    totals.console = problems;
    report.passes[size.name] = totals;
    if (totals.onSubject + totals.onText + totals.pastEdge + totals.overflow > 0 || problems.length || totals.spoutDistance > MAXIMUM_SPOUT_DISTANCE_PIXELS) failures.push(`${size.name} pass`);
    await context.close();
  }
  return report;
}

async function measureFallbackPasses(report, failures) {
  for (const pass of [{ name: 'reduced', reduced: true }, { name: 'blocked', blocked: true }]) {
    const { context, page, problems } = await openPage({ width: 1440, height: 900, ...pass });
    const totals = { onText: 0, pastEdge: 0, overflow: 0, console: problems };
    totals.staticStory = await page.evaluate(() => document.getElementById('story').classList.contains('is-static'));
    await page.evaluate(() => document.querySelectorAll('.still').forEach((image) => { image.loading = 'eager'; }));
    await page.waitForTimeout(600);
    totals.stillsLoaded = await page.evaluate(() => [...document.querySelectorAll('.still')].filter((image) => image.complete && image.naturalWidth > 0).length);
    const end = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    for (let index = 0; index < 8; index++) {
      await page.evaluate((top) => window.scrollTo(0, top), Math.round((end * index) / 7));
      await page.waitForTimeout(200);
      const found = await page.evaluate(measureOverlaps);
      totals.onText += found.onText.length;
      totals.pastEdge += found.pastEdge.length;
      totals.overflow = Math.max(totals.overflow, found.overflow);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${outputFolder}/fallback-${pass.name}.png` });
    report.passes[pass.name] = totals;
    if (!totals.staticStory || totals.stillsLoaded !== 5 || totals.onText + totals.pastEdge + totals.overflow > 0 || problems.length) failures.push(`${pass.name} pass`);
    await context.close();
  }
}

async function check() {
  const failures = [];
  const report = await measureScrollPasses(failures);
  await measureFallbackPasses(report, failures);
  writeFileSync(`${outputFolder}/check.json`, JSON.stringify(report, null, 1));
  for (const [name, totals] of Object.entries(report.passes)) {
    const spout = totals.spoutSamples ? ` spout ${totals.spoutDistance.toFixed(3)}px over ${totals.spoutSamples}, leave angle ${totals.leaveAngle.toFixed(2)}deg` : '';
    const stills = totals.staticStory === undefined ? '' : ` static ${totals.staticStory} stills ${totals.stillsLoaded}/5`;
    const notes = totals.notePositions === undefined ? '' : ` notes at ${totals.notePositions} positions`;
    const pixel = totals.streamPixel ? ` pixel ${JSON.stringify(totals.streamPixel)}` : '';
    console.log(name, `positions ${totals.positions ?? 8}`, `subject ${totals.onSubject ?? '-'}`, `text ${totals.onText}`, `edge ${totals.pastEdge}`, `overflow ${totals.overflow}`, `console ${totals.console.length ? totals.console.join(' | ') : 'clean'}${notes}${spout}${stills}${pixel}`, (totals.examples ?? []).join(' ; '));
  }
  console.log(failures.length ? `check failed: ${failures.join(', ')}` : 'check passed');
  return failures.length === 0;
}

// Hero, the pour and the install section, on a desktop and a phone.
async function shots() {
  for (const size of [SIZES[0], SIZES[2]]) {
    const { context, page } = await openPage(size);
    const story = await page.evaluate(() => ({ top: document.getElementById('story').offsetTop, travel: document.getElementById('story').offsetHeight - window.innerHeight }));
    const installTop = await page.evaluate(() => document.getElementById('install').offsetTop - document.querySelector('.nav').offsetHeight);
    const views = [['hero', story.top + story.travel * 0.0], ['pour', story.top + story.travel * 0.3], ['fill', story.top + story.travel * 0.5], ['install', installTop]];
    for (const [name, offset] of views) {
      await settle(page, Math.round(offset));
      await page.screenshot({ path: `${outputFolder}/${name}-${size.name}.png` });
    }
    await context.close();
  }
  console.log('shots written to', outputFolder);
}

async function video() {
  for (const take of [{ name: 'scroll', width: 1280, height: 720 }, { name: 'scroll-phone', width: 390, height: 844 }]) {
    const raw = `${outputFolder}/raw-${take.name}`;
    rmSync(raw, { recursive: true, force: true });
    mkdirSync(raw, { recursive: true });
    const { context, page } = await openPage({ ...take, video: raw });
    const end = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    await page.waitForTimeout(800);
    const steps = 400;
    for (let step = 0; step <= steps; step++) {
      await page.evaluate((top) => window.scrollTo(0, top), Math.round((end * step) / steps));
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(600);
    await context.close();
    const recorded = `${raw}/${readdirSync(raw).find((name) => name.endsWith('.webm'))}`;
    const target = `${outputFolder}/${take.name}.mp4`;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', recorded, '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-an', `${target}.part.mp4`]);
    renameSync(`${target}.part.mp4`, target);
    rmSync(raw, { recursive: true, force: true });
    console.log(take.name, 'video written');
  }
}

const jobs = { check, shots, video };
if (!jobs[mode]) throw new Error(`Unknown mode "${mode}". Use check, shots or video.`);
const passed = await jobs[mode]();
await browser.close();
process.exit(passed === false ? 1 : 0);
