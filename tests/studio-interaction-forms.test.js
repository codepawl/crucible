import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STUDIO_TOOLS } from '../src/studio-templates.js';

const FORMS_PAGE_URL = new URL('../docs/studio-interaction-forms.md', import.meta.url);
const FORMS = Object.freeze(['tool', 'toggle', 'mode', 'operator', 'modifier', 'setting', 'panel']);
const FIX_HINT = 'Add the row to docs/studio-interaction-forms.md with the feature, its form, where it lives and the reason the form fits.';
const HEADER = '| Studio feature | Form | Where | Reason |\n| --- | --- | --- | --- |\n';

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim());
}

/** Every table of the page that has the columns "Studio feature" and "Form", as rows keyed by the column names. */
function readFormRows(pageText) {
  const rows = [];
  let columns = null;
  for (const line of pageText.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) {
      columns = null;
      continue;
    }
    const cells = splitTableRow(line);
    if (cells.includes('Studio feature') && cells.includes('Form')) {
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

/** Returns one sentence per problem found in the page: bad forms, empty reasons and rail tools without a row. */
export function checkFormsPage(pageText, railTools) {
  const rows = readFormRows(pageText);
  const problems = [];

  for (const row of rows) {
    const name = `"${row['Studio feature'].slice(0, 60)}"`;
    if (row.cellCount !== row.columnCount) {
      problems.push(`Row ${name} has ${row.cellCount} cells; its table has ${row.columnCount} columns.`);
      continue;
    }
    const unknown = readForms(row.Form).filter(word => !FORMS.includes(word));
    if (unknown.length > 0) {
      problems.push(`Row ${name} uses "${unknown.join('", "')}", which is not a form. Use ${FORMS.join(', ')}.`);
    }
    if (row.Reason.trim() === '') {
      problems.push(`Row ${name} has no Reason. Say in plain words why the form fits.`);
    }
  }

  for (const tool of railTools) {
    const row = rows.find(candidate => candidate.Where?.includes(`\`tool:${tool}\``));
    if (!row) {
      problems.push(`The rail tool "${tool}" has no row. Put \`tool:${tool}\` in the Where cell of its row.`);
      continue;
    }
    if (!readForms(row.Form).includes('tool')) {
      problems.push(`The rail tool "${tool}" has the form "${row.Form}". A rail tool owns the pointer, so its form must include tool.`);
    }
  }
  return problems;
}

function failureMessage(problems) {
  return `${problems.join('\n')}\n${FIX_HINT}`;
}

const REAL_PAGE = readFileSync(FORMS_PAGE_URL, 'utf8');

test('every tool on the Studio rail has a row with the form tool and a reason', () => {
  assert.ok(STUDIO_TOOLS.length > 0);
  const problems = checkFormsPage(REAL_PAGE, STUDIO_TOOLS);
  assert.deepEqual(problems, [], failureMessage(problems));
});

test('the page keeps its rows, each with every column', () => {
  const rows = readFormRows(REAL_PAGE);
  assert.ok(rows.length >= 35, `Only ${rows.length} rows read; the tables may have lost a column header.`);
  for (const row of rows) {
    assert.equal(row.cellCount, row.columnCount, row.line);
  }
});

test('a rail tool without a row is reported by name', () => {
  const withoutSnapRow = REAL_PAGE.split('\n').filter(line => !line.includes('`tool:snap`')).join('\n');
  const problems = checkFormsPage(withoutSnapRow, STUDIO_TOOLS);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"snap" has no row/);
});

test('a rail tool whose form is not a tool is reported', () => {
  const page = `${HEADER}| Snapping | toggle | \`tool:snap\` | A state every tool obeys. |\n`;
  assert.match(checkFormsPage(page, ['snap'])[0], /"snap" has the form "toggle"/);
  const fixed = `${HEADER}| Snapping | tool + operator | \`tool:snap\` | The tool owns the pointer. |\n`;
  assert.deepEqual(checkFormsPage(fixed, ['snap']), []);
});

test('a word outside the list of forms is refused', () => {
  const page = `${HEADER}| Pivot | dropdown | here | A stored choice. |\n`;
  assert.match(checkFormsPage(page, [])[0], /"dropdown", which is not a form/);
});

test('an empty reason is refused', () => {
  const page = `${HEADER}| Measure | panel | here | |\n`;
  assert.match(checkFormsPage(page, [])[0], /has no Reason/);
  assert.deepEqual(checkFormsPage(`${HEADER}| Measure | panel | here | A value to read. |\n`, []), []);
});
