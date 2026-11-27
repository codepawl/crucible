// Merges the lcov files of the test shards, prints and summarises line, branch and function coverage, and fails when
// any figure falls more than the allowed margin below the committed baseline (config/coverage-baseline.json).
// Raising the baseline is a manual edit of that file. The function figure counts each function once per source line,
// so the baseline was re-measured (93.4 to 92.28 on the same commit) when unnamed functions stopped being counted per shard.
// The branch figure counts each branch once per source line and position on that line, for the same reason (see branchKey).
// With --expect-shards <count> it first checks that the lcov files are exactly shard-1.info to shard-<count>.info, each with source files in it, and
// refuses to merge otherwise: a partial rerun of failed jobs leaves some shards out or stale, and the merged total would be wrong (#1320).
// Usage: node scripts/coverage-gate.mjs <lcov file or folder>... [--baseline config/coverage-baseline.json] [--merged-out merged.lcov] [--expect-shards <count>]
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Branch totals move by up to about 0.8 points between runs of the same commit (merged V8 block ranges across shards),
// so branches get more room than lines and functions, which stay within a few hundredths.
const ALLOWED_DROP_POINTS = Object.freeze({ lines: 0.5, branches: 1.5, functions: 0.5 });
const METRICS = ['lines', 'branches', 'functions'];

function collectLcovPaths(inputs) {
  const paths = [];
  for (const input of inputs) {
    let stats;
    try {
      stats = statSync(input);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Coverage file or folder not found: ${input}`);
      throw error;
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(input, { recursive: true })) {
        const name = String(entry);
        if (name.endsWith('.info') || name.endsWith('.lcov')) paths.push(join(input, name));
      }
    } else {
      paths.push(input);
    }
  }
  return paths;
}

const SHARD_FILE_NAME = /^shard-(\d+)\.info$/;
const RERUN_ADVICE = 'Merged coverage of a partial set is wrong, so nothing was merged. Rerun all jobs of the Test workflow ("Re-run all jobs"), not only the failed ones.';

// Returns the list of problems with the shard files (an empty list when the set is complete). Each text is the content of the file at the same index in paths.
export function checkShardSet(paths, texts, expectedCount) {
  const problems = [];
  const pathsByShard = new Map();
  paths.forEach((path, index) => {
    const match = SHARD_FILE_NAME.exec(basename(path));
    if (!match) {
      problems.push(`${path} is not named shard-<number>.info, so it does not belong to a shard run of ${expectedCount} shards`);
      return;
    }
    const shard = Number(match[1]);
    if (shard < 1 || shard > expectedCount) {
      problems.push(`${basename(path)} is shard ${shard}, outside 1 to ${expectedCount}: it is left over from a run with a different shard count`);
      return;
    }
    if (!pathsByShard.has(shard)) pathsByShard.set(shard, []);
    pathsByShard.get(shard).push(index);
  });
  const missing = [];
  for (let shard = 1; shard <= expectedCount; shard++) {
    const indexes = pathsByShard.get(shard) ?? [];
    if (indexes.length === 0) missing.push(shard);
    else if (indexes.length > 1) problems.push(`shard ${shard} appears ${indexes.length} times (${indexes.map(index => paths[index]).join(', ')})`);
    else if (!/^SF:/m.test(texts[indexes[0]])) problems.push(`shard-${shard}.info has no source files in it: the shard did not finish writing its coverage`);
  }
  if (missing.length > 0) problems.push(`missing shard${missing.length > 1 ? 's' : ''} ${missing.join(', ')}: found ${expectedCount - missing.length} of ${expectedCount}`);
  return problems;
}

function fileRecord(files, path) {
  if (!files.has(path)) files.set(path, { lines: new Map(), branches: new Map(), functions: new Map() });
  return files.get(path);
}

function addHits(map, key, hits) {
  map.set(key, (map.get(key) ?? 0) + hits);
}

// V8 numbers the unnamed functions of a file per process (`anonymous_7`), so the same name points at different
// functions in different shards. A function is therefore identified by its line, plus its name when it has one.
const ANONYMOUS_FUNCTION_NAME = /^anonymous_\d+$/;

function functionKey(line, name) {
  return ANONYMOUS_FUNCTION_NAME.test(name) ? `${line},anonymous` : `${line},${name}`;
}

function functionEntry(record, key, line, name) {
  if (!record.functions.has(key)) {
    const mergedName = ANONYMOUS_FUNCTION_NAME.test(name) ? `anonymous_at_line_${line}` : name;
    record.functions.set(key, { line, name: mergedName, hits: 0 });
  }
  return record.functions.get(key);
}

// V8 numbers the blocks of a file per process, in the order it reports them, and a shard that never runs a function reports
// that function as one range instead of its nested blocks. The same block id therefore points at different branches in
// different shards, and keying by it counted one branch once per shard layout (more shards, lower figure). A branch is
// identified by its line and by its position among the branches reported for that line, which every shard agrees on
// for the branches it reports. A shard that reports fewer branches on a line only adds hits to the first ones.
function branchKey(line, branch, positionByLine) {
  const lineAndBranch = `${line},${branch}`;
  const position = positionByLine.get(lineAndBranch) ?? 0;
  positionByLine.set(lineAndBranch, position + 1);
  return `${line},${position},${branch}`;
}

export function mergeLcov(texts) {
  const files = new Map();
  for (const text of texts) {
    let record = null;
    let keyByName = new Map();
    let branchPositionByLine = new Map();
    for (const row of text.split(/\r?\n/)) {
      const separator = row.indexOf(':');
      const tag = separator < 0 ? row : row.slice(0, separator);
      const value = separator < 0 ? '' : row.slice(separator + 1);
      if (tag === 'SF') {
        record = fileRecord(files, value);
        keyByName = new Map();
        branchPositionByLine = new Map();
      } else if (!record) {
        continue;
      } else if (tag === 'DA') {
        const [line, hits] = value.split(',');
        addHits(record.lines, line, Number(hits));
      } else if (tag === 'BRDA') {
        const [line, , branch, hits] = value.split(',');
        addHits(record.branches, branchKey(line, branch, branchPositionByLine), hits === '-' ? 0 : Number(hits));
      } else if (tag === 'FN') {
        const [line, name] = value.split(',');
        const key = functionKey(line, name);
        keyByName.set(name, key);
        functionEntry(record, key, line, name);
      } else if (tag === 'FNDA') {
        const [hits, name] = value.split(',');
        const key = keyByName.get(name) ?? functionKey('0', name);
        const entry = functionEntry(record, key, key.split(',')[0], name);
        entry.hits += Number(hits);
      }
    }
  }
  return files;
}

export function totalsOf(files) {
  const totals = { lines: [0, 0], branches: [0, 0], functions: [0, 0] };
  for (const record of files.values()) {
    for (const hits of record.lines.values()) {
      totals.lines[1]++;
      if (hits > 0) totals.lines[0]++;
    }
    for (const hits of record.branches.values()) {
      totals.branches[1]++;
      if (hits > 0) totals.branches[0]++;
    }
    for (const entry of record.functions.values()) {
      totals.functions[1]++;
      if (entry.hits > 0) totals.functions[0]++;
    }
  }
  const percentages = {};
  for (const metric of METRICS) {
    const [covered, found] = totals[metric];
    percentages[metric] = found === 0 ? 100 : Math.round((covered / found) * 10000) / 100;
  }
  return { totals, percentages };
}

// The metrics the lcov files hold no records of. totalsOf reads those as 100%, which would hide a drop to nothing.
export function unmeasuredMetrics(totals) {
  return METRICS.filter(metric => totals[metric][1] === 0);
}

export function compareWithBaseline(percentages, baseline) {
  return METRICS.map(metric => ({
    metric,
    actual: percentages[metric],
    baseline: baseline[metric],
    ok: percentages[metric] >= baseline[metric] - ALLOWED_DROP_POINTS[metric],
  }));
}

function toLcov(files) {
  const rows = [];
  for (const [path, record] of files) {
    rows.push('TN:', `SF:${path}`);
    for (const entry of record.functions.values()) rows.push(`FN:${entry.line},${entry.name}`);
    for (const entry of record.functions.values()) rows.push(`FNDA:${entry.hits},${entry.name}`);
    for (const [key, hits] of record.branches) rows.push(`BRDA:${key},${hits}`);
    for (const [line, hits] of record.lines) rows.push(`DA:${line},${hits}`);
    rows.push('end_of_record');
  }
  return rows.join('\n') + '\n';
}

function parseExpectedShards(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) throw new Error(`--expect-shards needs a whole number of shards, 1 or more, got "${value}". Pass the shard count of the unit matrix.`);
  return count;
}

function main() {
  const args = process.argv.slice(2);
  const inputs = [];
  let baselinePath = 'config/coverage-baseline.json';
  let mergedOut = null;
  let expectedShards = null;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--baseline') {
      if (args[index + 1] === undefined) throw new Error('Pass a baseline file path after --baseline.');
      baselinePath = args[++index];
    } else if (args[index] === '--merged-out') {
      if (args[index + 1] === undefined) throw new Error('Pass an output path after --merged-out.');
      mergedOut = args[++index];
    } else if (args[index] === '--expect-shards') {
      expectedShards = parseExpectedShards(args[++index]);
    } else {
      inputs.push(args[index]);
    }
  }
  const paths = collectLcovPaths(inputs);
  if (paths.length === 0) throw new Error('No lcov files found.');
  const texts = paths.map(path => readFileSync(path, 'utf8'));
  if (expectedShards !== null) {
    const problems = checkShardSet(paths, texts, expectedShards);
    if (problems.length > 0) {
      const listed = problems.map(problem => `- ${problem}`).join('\n');
      console.error(`The coverage shards are incomplete or mixed:\n${listed}\n${RERUN_ADVICE}`);
      process.exit(1);
    }
  }
  const files = mergeLcov(texts);
  if (files.size === 0) {
    console.error(`The ${paths.length} lcov file(s) hold no source files, so there is nothing to measure and every figure would read 100%. A test run that crashed leaves an empty file like this: rerun it and pass the lcov it writes.`);
    process.exit(1);
  }
  if (mergedOut) writeFileSync(mergedOut, toLcov(files));
  const { totals, percentages } = totalsOf(files);
  const unmeasured = unmeasuredMetrics(totals);
  if (unmeasured.length > 0) {
    console.error(`The lcov files hold no ${unmeasured.join(' or ')} records, so that figure would read 100%. Rerun the tests with the same coverage reporters and pass the lcov they write.`);
    process.exit(1);
  }
  let baselineText;
  try {
    baselineText = readFileSync(baselinePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Coverage baseline file not found: ${baselinePath}`);
    throw error;
  }
  const baseline = JSON.parse(baselineText);
  const results = compareWithBaseline(percentages, baseline);

  const table = [
    `Coverage from ${paths.length} lcov file(s), ${files.size} source files. A drop below the baseline of more than ${ALLOWED_DROP_POINTS.lines} points (lines, functions) or ${ALLOWED_DROP_POINTS.branches} points (branches) fails.`,
    '',
    '| Metric | Covered | Total | Actual % | Baseline % | Result |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...results.map(
      result => `| ${result.metric} | ${totals[result.metric][0]} | ${totals[result.metric][1]} | ${result.actual} | ${result.baseline} | ${result.ok ? 'pass' : 'FAIL'} |`,
    ),
    '',
  ].join('\n');
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Coverage\n\n${table}\n`);
  if (results.some(result => !result.ok)) {
    console.error('Coverage fell below the baseline. Add tests, or lower config/coverage-baseline.json on purpose.');
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`coverage-gate: ${error.message}`);
    process.exit(1);
  }
}
