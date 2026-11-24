import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { STUDIO_CSS } from '../src/studio-styles.js';

// Studio colours come from the tokens of src/site-tokens.css. These tests read the CSS text, resolve the tokens for one theme
// and compute the WCAG contrast ratio, so a mark that drops under 3:1 (the bar for non-text marks) fails here.
const SITE_TOKENS_CSS = readFileSync(new URL('../src/site-tokens.css', import.meta.url), 'utf8');
const NON_TEXT_CONTRAST = 3;

function blockBody(css, selectorText) {
  const start = css.indexOf(`${selectorText} {`);
  assert.notEqual(start, -1, `No rule "${selectorText}" found.`);
  return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
}

function declarationsOf(body) {
  const declarations = {};
  for (const match of body.matchAll(/(--?[\w-]+)\s*:\s*([^;]+);/gu)) declarations[match[1]] = match[2].trim();
  return declarations;
}

function themeTokens(theme) {
  const rootDeclarations = declarationsOf(blockBody(SITE_TOKENS_CSS, ':root'));
  if (theme === 'light') return { ...rootDeclarations, ...declarationsOf(blockBody(SITE_TOKENS_CSS, '[data-theme="light"]')) };
  return { ...rootDeclarations, ...declarationsOf(blockBody(SITE_TOKENS_CSS, '[data-theme="dark"]')) };
}

function parseHexColour(text) {
  const hex = text.trim().replace('#', '');
  const channels = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { channels, alpha };
}

function compositeOver(top, bottom) {
  return { channels: top.channels.map((channel, index) => channel * top.alpha + bottom.channels[index] * (1 - top.alpha)), alpha: 1 };
}

function luminance({ channels }) {
  const [red, green, blue] = channels.map(channel => {
    const unit = channel / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first, second) {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

// The --studio-* tokens on .crucible-studio, resolved to hex for one theme.
function studioColours(theme) {
  const site = themeTokens(theme);
  const studio = declarationsOf(blockBody(STUDIO_CSS, '.crucible-studio'));
  const colours = {};
  const resolve = name => {
    const value = studio[name];
    const reference = value.match(/^var\((--[\w-]+)(?:,\s*([^)]+))?\)$/u);
    if (!reference) return value;
    return site[reference[1]] ?? reference[2];
  };
  for (const name of ['--studio-panel', '--studio-text', '--studio-muted', '--studio-accent', '--studio-ok', '--studio-trace', '--studio-trace-edge']) {
    colours[name] = parseHexColour(resolve(name));
  }
  return colours;
}

function tokenInDeclaration(css, selectorText, property) {
  const declaration = blockBody(css, selectorText).replace(/\/\*[^]*?\*\//gu, '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${property}:`)).map(part => part.match(/var\((--studio-[\w-]+)\)/u)).find(Boolean);
  assert.ok(declaration, `"${selectorText}" must set ${property} from a --studio-* token.`);
  return declaration[1];
}

for (const theme of ['light', 'dark']) {
  test(`${theme} theme: the spot light direction line is drawn in a colour that holds against the dark viewport`, () => {
    const token = tokenInDeclaration(STUDIO_CSS, '.crucible-studio-scene-mark-ray', 'stroke');
    assert.notEqual(token, '--studio-text', 'The line sits over the viewport, which stays dark in both themes: a theme text token turns it dark on dark in the light theme.');
    const colours = studioColours(theme);
    const darkViewport = parseHexColour('#17161a');
    assert.ok(contrastRatio(colours[token], darkViewport) >= NON_TEXT_CONTRAST, `${token} against the dark viewport in the ${theme} theme.`);
  });

  test(`${theme} theme: the icon of a selected or active Scene row has 3:1 against the tinted row it sits on`, () => {
    const token = tokenInDeclaration(STUDIO_CSS, '.crucible-studio-tree-row[data-selected="true"] .crucible-studio-tree-select .crucible-studio-icon', 'color');
    const colours = studioColours(theme);
    for (const state of ['selected', 'active']) {
      const tintShare = Number(blockBody(STUDIO_CSS, `.crucible-studio-tree-row[data-${state}="true"]`).match(/var\(--studio-accent\) (\d+)%/u)?.[1]);
      assert.ok(tintShare > 0, `The ${state} row is tinted in the accent.`);
      const rowBackground = compositeOver({ channels: colours['--studio-accent'].channels, alpha: tintShare / 100 }, colours['--studio-panel']);
      assert.ok(contrastRatio(colours[token], rowBackground) >= NON_TEXT_CONTRAST, `${token} against the ${state} row (${tintShare}% tint) in the ${theme} theme.`);
    }
  });

  test(`${theme} theme: the colour swatch edge and the watch dot edge have 3:1 against their background`, () => {
    const colours = studioColours(theme);
    const fieldTint = { channels: colours['--studio-text'].channels, alpha: 0.07 };
    const fieldBackground = compositeOver(fieldTint, colours['--studio-panel']);
    const swatchEdgeToken = tokenInDeclaration(STUDIO_CSS, '.crucible-studio-prop > input[type="color"]::-webkit-color-swatch', 'border');
    assert.ok(contrastRatio(colours[swatchEdgeToken], fieldBackground) >= NON_TEXT_CONTRAST, `${swatchEdgeToken} against the colour field in the ${theme} theme.`);
    const watchEdgeToken = tokenInDeclaration(STUDIO_CSS, '.crucible-studio-watch-pill', 'box-shadow');
    assert.ok(contrastRatio(colours[watchEdgeToken], colours['--studio-panel']) >= NON_TEXT_CONTRAST, `${watchEdgeToken} against the panel in the ${theme} theme.`);
  });
}

test('the accent reads at 3:1 against the light panel, as the issue asked to confirm', () => {
  const colours = studioColours('light');
  assert.ok(contrastRatio(colours['--studio-accent'], colours['--studio-panel']) >= NON_TEXT_CONTRAST);
});
