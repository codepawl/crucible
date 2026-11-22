// Splits 3D text into a node per letter or word, from the same layout `text` uses.
import { DEFAULT_FONT_NAME, checkedTextInput, layoutGlyphs } from './text-geometry.js';

const SPLIT_UNITS = ['letters', 'words'];
const MAX_SPLIT_PIECES = 128;

function splitPieces(placements, split) {
  const pieces = [];
  let word = null;
  for (const placement of placements) {
    if (/\s/.test(placement.character)) {
      word = null;
    } else if (split === 'letters') {
      pieces.push({ text: placement.character, x: placement.x, y: placement.y, line: placement.lineIndex });
    } else if (word?.line === placement.lineIndex) {
      word.text += placement.character;
    } else {
      word = { text: placement.character, x: placement.x, y: placement.y, line: placement.lineIndex };
      pieces.push(word);
    }
  }
  return pieces;
}

/**
 * Splits text into one node per letter or per word, as plain recipe data: `{ geometries, nodes, pieces }`. Each piece is an
 * ordinary left-aligned `text` geometry and a node whose translation is where `text(content, options)` puts that piece, so the
 * nodes drawn together look the same as the unsplit text. A piece turns and scales about the left end of its baseline.
 * Spaces and line breaks make no piece. Letters that repeat share one geometry. Node ids are `<id>-<index>` in reading order.
 */
export function splitText(content, { id = 'text', split = 'letters', size = 1, depth = 0.2, font: fontName = DEFAULT_FONT_NAME, align = 'left', curveSegments = 4, material, parent, translation = [0, 0, 0] } = {}) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,100}$/.test(id)) throw new TypeError('id must be 1 to 101 letters, digits, spaces, dots, dashes or underscores, such as "title".');
  if (!SPLIT_UNITS.includes(split)) throw new RangeError(`split must be one of ${SPLIT_UNITS.join(', ')}, such as "letters".`);
  if (!Array.isArray(translation) || translation.length !== 3 || !translation.every(Number.isFinite)) throw new TypeError('translation must be three finite numbers, such as [0, 0, 0].');
  const { font, lines, factor } = checkedTextInput(content, { size, depth, fontName, align, curveSegments });
  const pieces = splitPieces(layoutGlyphs(lines, font, fontName, factor, align, size), split);
  if (pieces.length === 0) throw new RangeError('text has no visible characters to split.');
  if (pieces.length > MAX_SPLIT_PIECES) throw new RangeError(`splitText makes at most ${MAX_SPLIT_PIECES} pieces and this text has ${pieces.length}: split into "words", or shorten the text.`);
  const geometryByText = new Map();
  const geometries = [];
  const nodes = pieces.map((piece, index) => {
    if (!geometryByText.has(piece.text)) {
      const geometryId = `${id}-glyphs-${geometries.length}`;
      geometryByText.set(piece.text, geometryId);
      const geometry = { id: geometryId, type: 'text', text: piece.text, size, depth, align: 'left', curveSegments };
      if (fontName !== DEFAULT_FONT_NAME) geometry.font = fontName;
      geometries.push(geometry);
    }
    const node = { id: `${id}-${index}`, geometry: geometryByText.get(piece.text), translation: [translation[0] + piece.x, translation[1] + piece.y, translation[2]] };
    if (material !== undefined) node.material = material;
    if (parent !== undefined) node.parent = parent;
    return node;
  });
  return { geometries, nodes, pieces: pieces.map((piece, index) => ({ id: nodes[index].id, text: piece.text, line: piece.line })) };
}
