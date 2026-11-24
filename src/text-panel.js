// Text drawn to a texture on the CPU (#3237): a sign on one face of a part, or a name tag on a camera-facing quad.
// The glyphs are the DejaVu Sans outlines the 3D text already bundles, filled by a scanline rasterizer with exact horizontal
// coverage, so the bytes are the same on every machine and in every backend (no canvas, no system font, no new dependency).
import { invalidField } from './field-error.js';
import { DEFAULT_FONT_DATA } from './font-default.js';
import { flattenContour } from './text-geometry.js';
import { createImage } from './material-texture-kit.js';

export const TEXT_PANEL_LIMITS = Object.freeze({
  maxCharacters: 512,
  maxLines: 32,
  maxTextureSide: 1024,
  minTextureSide: 8,
  resolution: Object.freeze([16, 2048]),
  size: Object.freeze([0.01, 100]),
  fonts: Object.freeze(['sans']),
  aligns: Object.freeze(['left', 'center', 'right']),
  verticalAligns: Object.freeze(['top', 'middle', 'bottom']),
});

const PANEL_FIELDS = ['content', 'font', 'width', 'height', 'fontSize', 'color', 'background', 'align', 'verticalAlign', 'wrap', 'padding', 'resolution'];
const LINE_HEIGHT_EMS = 1.2;
const SUBSCANLINES = 4;
const CURVE_SEGMENTS = 6;
const FALLBACK_CHARACTER = '?';
const DEFAULT_RESOLUTION = 256;

function checkedNumber(path, value, [minimum, maximum], example) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidField(path, value, `a number from ${minimum} to ${maximum}, such as ${example}`, TypeError);
  }
  return value;
}

function checkedColor(path, value) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(component => typeof component !== 'number' || !Number.isFinite(component) || component < 0 || component > 1)) {
    throw invalidField(path, value, 'three numbers from 0 to 1, such as [1, 0.9, 0.6]', TypeError);
  }
  return [...value];
}

function checkedChoice(path, value, choices) {
  if (!choices.includes(value)) throw invalidField(path, value, `one of ${choices.join(', ')}`);
  return value;
}

/**
 * Validates the `text` field of a material and returns the plain record the scene keeps. `width` and `height` are the metres
 * the panel covers (the face it is drawn for); `fontSize` is the metres from one baseline to the next divided by 1.2.
 * A missing `background` leaves the panel transparent. Characters the font does not hold draw as "?".
 */
export function normalizeTextPanel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField('text', value, 'an object such as { "content": "OPEN", "width": 2, "height": 0.6, "color": [1, 0.9, 0.6] }', TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!PANEL_FIELDS.includes(key)) throw invalidField(`text.${key}`, value[key], `one of the text fields: ${PANEL_FIELDS.join(', ')}`, TypeError);
  }
  if (typeof value.content !== 'string' || value.content.length === 0 || [...value.content].length > TEXT_PANEL_LIMITS.maxCharacters) {
    throw invalidField('text.content', value.content, `a string of 1 to ${TEXT_PANEL_LIMITS.maxCharacters} characters, such as "OPEN"; split longer text over several panels`, TypeError);
  }
  if (value.content.split('\n').length > TEXT_PANEL_LIMITS.maxLines) {
    throw invalidField('text.content', value.content.slice(0, 20), `at most ${TEXT_PANEL_LIMITS.maxLines} lines`);
  }
  const width = checkedNumber('text.width', value.width, TEXT_PANEL_LIMITS.size, 2);
  const height = checkedNumber('text.height', value.height, TEXT_PANEL_LIMITS.size, 0.6);
  const panel = {
    content: value.content,
    font: checkedChoice('text.font', value.font ?? 'sans', TEXT_PANEL_LIMITS.fonts),
    width,
    height,
    fontSize: checkedNumber('text.fontSize', value.fontSize ?? height * 0.5, TEXT_PANEL_LIMITS.size, 0.3),
    color: checkedColor('text.color', value.color ?? [1, 1, 1]),
    align: checkedChoice('text.align', value.align ?? 'center', TEXT_PANEL_LIMITS.aligns),
    verticalAlign: checkedChoice('text.verticalAlign', value.verticalAlign ?? 'middle', TEXT_PANEL_LIMITS.verticalAligns),
    wrap: value.wrap ?? true,
    padding: checkedNumber('text.padding', value.padding ?? Math.min(width, height) * 0.05, [0, Math.min(width, height) / 2], 0.05),
    resolution: checkedNumber('text.resolution', value.resolution ?? DEFAULT_RESOLUTION, TEXT_PANEL_LIMITS.resolution, 256),
  };
  if (typeof panel.wrap !== 'boolean') throw invalidField('text.wrap', value.wrap, 'true or false', TypeError);
  if (value.background !== undefined && value.background !== null) panel.background = checkedColor('text.background', value.background);
  return panel;
}

function glyphOf(character) {
  return DEFAULT_FONT_DATA.glyphs[character] ?? DEFAULT_FONT_DATA.glyphs[FALLBACK_CHARACTER];
}

/** The pixel size of the texture: `resolution` pixels per metre, both sides kept at or under the texture limit. */
export function textPanelTextureSize(panel) {
  const fit = Math.min(1, TEXT_PANEL_LIMITS.maxTextureSide / Math.max(panel.width, panel.height) / panel.resolution);
  const side = metres => Math.max(TEXT_PANEL_LIMITS.minTextureSide, Math.round(metres * panel.resolution * fit));
  return { width: side(panel.width), height: side(panel.height) };
}

function advanceOf(word, factor) {
  let total = 0;
  for (const character of word) total += glyphOf(character)[0] * factor;
  return total;
}

// Greedy wrap: words fill a line until the next one would pass `available`; a word wider than a line breaks between characters.
function wrapLine(line, factor, available) {
  const lines = [];
  let current = '';
  for (const word of line.split(' ')) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (advanceOf(candidate, factor) <= available) {
      current = candidate;
      continue;
    }
    if (current !== '') lines.push(current);
    current = '';
    let rest = word;
    while (advanceOf(rest, factor) > available && [...rest].length > 1) {
      let take = [...rest].length - 1;
      while (take > 1 && advanceOf([...rest].slice(0, take).join(''), factor) > available) take--;
      lines.push([...rest].slice(0, take).join(''));
      rest = [...rest].slice(take).join('');
    }
    current = rest;
  }
  lines.push(current);
  return lines;
}

/** The lines the panel draws, after "\n" and wrapping, with each width in texture pixels: `{ lines: [{ text, width }], size, factor }`. */
export function layoutTextPanel(panel) {
  const size = textPanelTextureSize(panel);
  const pixelsPerMetre = size.width / panel.width;
  const emPixels = panel.fontSize * pixelsPerMetre;
  const factor = emPixels / DEFAULT_FONT_DATA.unitsPerEm;
  const available = size.width - 2 * panel.padding * pixelsPerMetre;
  const lines = panel.content.split('\n').flatMap(line => (panel.wrap ? wrapLine(line, factor, available) : [line]));
  return { size, emPixels, factor, available, lines: lines.map(text => ({ text, width: advanceOf(text, factor) })) };
}

// Crossings of every glyph edge with every sub-scanline: [x, winding] pairs, one list per sub-scanline.
function collectCrossings(layout, panel, rows) {
  const crossings = Array.from({ length: rows * SUBSCANLINES }, () => []);
  const { factor, emPixels, size } = layout;
  const pixelsPerMetre = size.width / panel.width;
  const padding = panel.padding * pixelsPerMetre;
  const blockHeight = layout.lines.length * LINE_HEIGHT_EMS * emPixels;
  const free = size.height - blockHeight;
  const top = panel.verticalAlign === 'top' ? padding : panel.verticalAlign === 'bottom' ? free - padding : free / 2;
  const baselineOffset = emPixels * (LINE_HEIGHT_EMS / 2 + (DEFAULT_FONT_DATA.ascender + DEFAULT_FONT_DATA.descender) / (2 * DEFAULT_FONT_DATA.unitsPerEm));
  layout.lines.forEach((line, index) => {
    const baseline = top + index * LINE_HEIGHT_EMS * emPixels + baselineOffset;
    let cursor = panel.align === 'left' ? padding : panel.align === 'right' ? size.width - padding - line.width : (size.width - line.width) / 2;
    for (const character of line.text) {
      const glyph = glyphOf(character);
      for (const contour of glyph.slice(1)) {
        const polygon = flattenContour(contour, CURVE_SEGMENTS).map(([x, y]) => [cursor + x * factor, baseline - y * factor]);
        addEdges(crossings, polygon);
      }
      cursor += glyph[0] * factor;
    }
  });
  return crossings;
}

function addEdges(crossings, polygon) {
  for (let index = 0; index < polygon.length; index++) {
    const [startX, startY] = polygon[index];
    const [endX, endY] = polygon[(index + 1) % polygon.length];
    if (startY === endY) continue;
    const winding = endY > startY ? 1 : -1;
    const low = Math.min(startY, endY);
    const high = Math.max(startY, endY);
    const first = Math.max(0, Math.ceil(low * SUBSCANLINES - 0.5));
    const last = Math.min(crossings.length - 1, Math.ceil(high * SUBSCANLINES - 0.5) - 1);
    for (let sub = first; sub <= last; sub++) {
      const y = (sub + 0.5) / SUBSCANLINES;
      crossings[sub].push([startX + (endX - startX) * (y - startY) / (endY - startY), winding]);
    }
  }
}

// Adds the covered share of each pixel the span [from, to) touches, one sub-scanline's worth.
function addSpan(coverage, from, to) {
  const first = Math.max(0, Math.floor(from));
  const last = Math.min(coverage.length - 1, Math.ceil(to) - 1);
  for (let column = first; column <= last; column++) {
    coverage[column] += (Math.min(to, column + 1) - Math.max(from, column)) / SUBSCANLINES;
  }
}

function rowCoverage(crossings, row, width) {
  const coverage = new Float64Array(width);
  for (let sub = 0; sub < SUBSCANLINES; sub++) {
    const hits = crossings[row * SUBSCANLINES + sub].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    let winding = 0;
    for (let index = 0; index < hits.length - 1; index++) {
      winding += hits[index][1];
      if (winding !== 0) addSpan(coverage, hits[index][0], hits[index + 1][0]);
    }
  }
  return coverage;
}

/**
 * Draws a normalized panel to RGBA bytes: `{ width, height, data, lines }`. Row 0 is the top of the panel. With a background
 * every pixel is opaque; without one the colour is the text colour everywhere and the alpha is the glyph coverage, so a
 * filtered edge never darkens. The same panel gives the same bytes.
 */
export function rasterizeTextPanel(panel) {
  const layout = layoutTextPanel(panel);
  const { width, height } = layout.size;
  const crossings = collectCrossings(layout, panel, height);
  const data = new Uint8ClampedArray(width * height * 4);
  const text = panel.color.map(component => component * 255);
  const background = panel.background?.map(component => component * 255);
  for (let row = 0; row < height; row++) {
    const coverage = rowCoverage(crossings, row, width);
    for (let column = 0; column < width; column++) {
      const share = Math.min(1, coverage[column]);
      const offset = (row * width + column) * 4;
      for (let channel = 0; channel < 3; channel++) {
        data[offset + channel] = Math.round(background ? background[channel] + (text[channel] - background[channel]) * share : text[channel]);
      }
      data[offset + 3] = background ? 255 : Math.round(share * 255);
    }
  }
  return { width, height, data, lines: layout.lines.map(line => line.text) };
}

/** The texture descriptors of a material with a `text` panel: the colour map, drawn once on first read. */
export function createTextPanelTextures(panel) {
  const frame = rasterizeTextPanel(panel);
  return { map: { image: createImage(frame.data, frame.width, frame.height), colorSpace: 'srgb' } };
}
