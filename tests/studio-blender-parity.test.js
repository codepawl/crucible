import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STUDIO_TOOLS } from '../src/studio-templates.js';

const PARITY_PAGE_URL = new URL('../docs/studio-blender-parity.md', import.meta.url);
const FORMS = Object.freeze(['tool', 'toggle', 'mode', 'operator', 'modifier', 'setting', 'panel']);
const NO_STUDIO_FORM = 'missing';
const NO_BLENDER_FORM = 'unconfirmed';
const FIX_HINT = 'Add the row to docs/studio-blender-parity.md with the form Blender uses; if Studio differs, write the reason in the row.';

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim());
}

/** Every table of the page that has "Blender form" and "Studio form" columns, as rows keyed by the column names. */
function readParityRows(pageText) {
  const lines = pageText.split(/\r?\n/);
  const rows = [];
  let columns = null;
  for (const line of lines) {
    if (!line.trim().startsWith('|')) {
      columns = null;
      continue;
    }
    const cells = splitTableRow(line);
    if (cells.includes('Blender form') && cells.includes('Studio form')) {
      columns = cells;
      continue;
    }
    if (!columns || cells.every(cell => /^-+$/.test(cell))) {
      continue;
    }
    const row = { line };
    columns.forEach((name, index) => {
      row[name] = cells[index] ?? '';
    });
    row.cellCount = cells.length;
    row.columnCount = columns.length;
    rows.push(row);
  }
  return rows;
}

function readForms(cell) {
  return cell.split(' + ').map(word => word.trim());
}

function describeRow(row) {
  return `"${row['Blender feature (default key)'].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').slice(0, 60)}"`;
}

/** Returns one sentence per problem found in the page for the tools of the Studio rail. */
export function checkParityPage(pageText, railTools) {
  const rows = readParityRows(pageText);
  const problems = [];

  for (const row of rows) {
    const name = describeRow(row);
    const blenderCell = row['Blender form'];
    const studioCell = row['Studio form'];
    if (row.cellCount !== row.columnCount) {
      problems.push(`Row ${name} has ${row.cellCount} cells; its table has ${row.columnCount} columns.`);
      continue;
    }
    const blenderForms = readForms(blenderCell);
    const studioForms = readForms(studioCell);
    const unknownBlender = blenderForms.filter(word => word !== NO_BLENDER_FORM && !FORMS.includes(word));
    const unknownStudio = studioForms.filter(word => word !== NO_STUDIO_FORM && !FORMS.includes(word));
    if (unknownBlender.length > 0 || unknownStudio.length > 0) {
      problems.push(`Row ${name} uses "${[...unknownBlender, ...unknownStudio].join('", "')}", which is not a form. Use ${FORMS.join(', ')}, ${NO_STUDIO_FORM} (Studio) or ${NO_BLENDER_FORM} (Blender).`);
      continue;
    }
    const comparable = !studioForms.includes(NO_STUDIO_FORM) && !blenderForms.includes(NO_BLENDER_FORM);
    const differs = comparable && studioForms.some(form => !blenderForms.includes(form));
    const note = row.Note ?? '';
    if (differs && !note.includes('Reason:') && !note.includes('To fix:')) {
      problems.push(`Row ${name} gives Studio the form "${studioCell}" and Blender "${blenderCell}". Start its Note with "Reason:" and say why, or with "To fix:" if it is a mistake.`);
    }
  }

  for (const tool of railTools) {
    const row = rows.find(candidate => candidate['Studio today']?.includes(`\`tool:${tool}\``));
    if (!row) {
      problems.push(`The rail tool "${tool}" has no parity row. Put \`tool:${tool}\` at the start of its Studio today cell.`);
      continue;
    }
    const sameForm = readForms(row['Studio form']).includes('tool') && readForms(row['Blender form']).includes('tool');
    if (!sameForm && !(row.Note ?? '').includes('Reason:')) {
      problems.push(`The rail tool "${tool}" is a "${row['Studio form']}" row in Blender form "${row['Blender form']}". A rail tool must be a tool in both, or its Note must start with "Reason:".`);
    }
  }
  return problems;
}

function failureMessage(problems) {
  return `${problems.join('\n')}\n${FIX_HINT}`;
}

const REAL_PAGE = readFileSync(PARITY_PAGE_URL, 'utf8');
const HEADER = '| Blender feature (default key) | Blender form | Studio form | Studio today | Note |\n| --- | --- | --- | --- | --- |\n';

test('every tool on the Studio rail has a parity row in the form Blender uses', () => {
  assert.ok(STUDIO_TOOLS.length > 0);
  const problems = checkParityPage(REAL_PAGE, STUDIO_TOOLS);
  assert.deepEqual(problems, [], failureMessage(problems));
});

test('the page has the rows the audit promised and no form outside the list', () => {
  const rows = readParityRows(REAL_PAGE);
  assert.ok(rows.length >= 80, `Only ${rows.length} rows read; the tables may have lost a column header.`);
  for (const row of rows) {
    assert.equal(row.cellCount, row.columnCount, row.line);
  }
});

test('a rail tool without a row is reported by name', () => {
  const withoutSnapRow = REAL_PAGE.split('\n').filter(line => !line.includes('`tool:snap`')).join('\n');
  const problems = checkParityPage(withoutSnapRow, STUDIO_TOOLS);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"snap" has no parity row/);
});

test('a rail tool that is a toggle in Blender needs a Reason', () => {
  const page = `${HEADER}| Snapping | toggle | tool | \`tool:snap\` Different. | Hold Shift. |\n`;
  assert.match(checkParityPage(page, ['snap'])[0], /Start its Note with "Reason:"|must be a tool in both/);
  const reasoned = `${HEADER}| Snapping | toggle | tool | \`tool:snap\` Different. | Reason: being replaced in #3342. |\n`;
  assert.deepEqual(checkParityPage(reasoned, ['snap']), []);
});

test('a word outside the list of forms is refused', () => {
  const page = `${HEADER}| Pivot | setting | dropdown | Has. | |\n`;
  assert.match(checkParityPage(page, [])[0], /"dropdown", which is not a form/);
});

test('a form that differs from Blender needs a Reason or a To fix', () => {
  const page = `${HEADER}| Measure | tool | panel | Has. | A readout. |\n`;
  assert.match(checkParityPage(page, [])[0], /Start its Note with "Reason:"/);
  assert.deepEqual(checkParityPage(`${HEADER}| Measure | tool | panel | Has. | To fix: a ruler. |\n`, []), []);
  assert.deepEqual(checkParityPage(`${HEADER}| Extrude | tool + operator | operator | Has. | |\n`, []), []);
});

test('a missing or unconfirmed form never counts as a mismatch', () => {
  const page = `${HEADER}| Annotate | tool | missing | Missing. | |\n| Rename | unconfirmed | panel | Has. | |\n`;
  assert.deepEqual(checkParityPage(page, []), []);
});
