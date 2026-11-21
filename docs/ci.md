# CI

`test.yml` runs on every pull request and is called by `publish.yml`, so a release runs the same checks as the pull request that produced it.

## Jobs

All jobs start at once.

| Job | What it runs |
| --- | --- |
| `audit` | `npm audit --audit-level=high` |
| `size` | `npm run size` and `npm run tool-cost` against the pull request base (pull requests only; a release has no base) |
| `unit` (12 shards balanced by measured time, `scripts/shard-test-files.mjs` and `config/test-timings.json`) | `npm run build:lib`, then `npm run test:coverage` on one twelfth of the test files; uploads its lcov and per-file timings |
| `coverage` | merges the shard lcov files, writes the summary, compares with `config/coverage-baseline.json`, uploads `lcov` |
| `package` | `prepare:release`, `check:links:package`, `check:published-site`, `smoke:package`, `smoke:mcp-package` |
| `addon-python` | `python -m pytest packages/blender-addon/tests` (numpy and pytest, no Blender; `conftest.py` leaves out the script that needs `bpy`). The steps run only when a pull request changes a file under `packages/blender-addon/`, or on a release run |
| `bun` | `smoke:mcp-package` with `MCP_SERVER_RUNTIME=bun`: the packed MCP server runs under bun, the way `bunx crucible-mcp` starts it |
| `test` | waits for every job above and fails unless each one succeeded. Branch protection on `main` requires this name. |

`node --test` runs each file in its own process (the Node 24 default, `--test-isolation=process`), so the unit pass is also the isolation check. `npm run test:isolated` stays as a local tool: it runs the same files four at a time and reruns a failure alone.

## A test that hangs

`npm test`, `npm run test:coverage`, `npm run test:isolated` and the Cook jobs (`unit-without-cook`, `cook-addon.yml`) start every test file with `--test-timeout=300000`, so a test without its own `timeout` option fails after 300 seconds with `test timed out after ...` and its name, instead of waiting for the 15 minute job limit. `node --test` alone does not end the file: the process stays alive while a Chrome or a dev server it started keeps a handle open. So each file also loads `scripts/test-hang-guard.mjs`, which:

- stops the file `CRUCIBLE_TEST_GRACE_AFTER_TIMEOUT_MS` (default 10000) after node:test reports a test timeout, so a hang ends about 310 seconds after it starts (a test that sets its own longer `timeout` ends that much after its own limit, up to 610 seconds for the tests that set 600000);
- also stops the file after `CRUCIBLE_TEST_FILE_LIMIT_MS` (default 660000) for a hang that never trips a test timeout;
- a stop kills every child process the file started together with its descendants (`taskkill /T` on Windows, a walk over `ps` on Linux and macOS), prints `TEST FILE HUNG: <file>` and exits 1;
- kills a child a file left running when it exits normally (a child started with `detached: true` is left alone there);
- gives the file its own temp folder (`TMPDIR`, `TEMP` and `TMP` point at `<temp>/crucible-test-temp-<pid>-<time>`, children inherit them) and removes it when the file exits, pass or fail, so a test that calls `mkdtemp(join(tmpdir(), ...))` or starts a Chrome with a user-data folder leaves nothing behind (#2848). `CRUCIBLE_KEEP_TEST_TEMP=1` keeps the folder and prints its path. A file killed from outside (not through its own exit) can still leave its folder, which carries its process id in the name.

Smoke and bench scripts run outside the test runner, so they use `createScratchDirectory(prefix)` from `scripts/scratch-directory.mjs`, which removes the folder when the script exits (`CRUCIBLE_KEEP_TEMP=1` keeps it). `tests/script-temp-folder-hygiene.test.js` fails when a script under `scripts/` or `bench/` calls `mkdtemp` and never removes the folder; a script whose folder is its output carries a `// keeps-temp: <reason>` comment.

A stop ends the whole file, so tests after the hung one in that file do not run; the run is already failed.

Limit: the guard lives on the file's own event loop. A test that blocks it, such as a `spawnSync`, `execFileSync` or `execSync` without a `timeout` option, is not stopped until the call returns (measured: a 15 second block passed with limits of 2 and 4 seconds). Give every synchronous child call in a test a `timeout`; nothing enforces this yet.

Why 300 seconds: the slowest tests in the 6 latest green `Test` runs (`gh run list --workflow test.yml --status success`, per-test times from the spec reporter, slowest and fastest of the 6 runs) were:

| Test | Slowest | Fastest |
| --- | --- | --- |
| diffuse + glossy + emission match the beauty frame (`lighting-passes`) | 129.9 s | 51.9 s |
| a native job without the native tracer runs the cpu backend | 117.9 s | 73.9 s |
| a preset on a 56 part room shrinks to the path work budget | 82.8 s | 38.9 s |
| a render job draws the grid frame its motion time selects | 80.6 s | 32.9 s |
| ambient occlusion leaves a flat wall seen at a slant within one display level | 67.3 s | 36.1 s |
| explicit settings far above the preset budget run when they fit the hard limit | 61.4 s | 26.8 s |
| a 64 by 64 flag with dihedral bending and creases folds softly | 60.4 s | 34.9 s |

No other test took 60 s or more. 300 s is 2.3 times the slowest, and a hang still fails about 310 seconds in, well before the 15 minute job limit.

`tests/test-hang-guard.test.js` proves it on `tests/fixtures/hanging-test-file.js`, a file that hangs on purpose with a child and a grandchild: with a 2 second test timeout and a 2 second grace it stops in about 5 seconds, names the test and leaves neither process running; a second case covers the file limit and a third covers the exit cleanup with `tests/fixtures/leftover-child-test-file.js`. A test that needs longer than 300 seconds sets `{ timeout: <ms> }` on itself, and one above 650 seconds also needs a higher file limit.

## Coverage

Coverage comes from Node's built-in `--experimental-test-coverage`. The `coverage` job fails when line or function coverage falls more than 0.5 points, or branch coverage more than 1.5 points, below `config/coverage-baseline.json` (branch totals move by up to about 0.8 points between runs of the same commit). Raise the baseline by editing that file; lower it only on purpose and say why in the pull request. In CI the gate runs with `--expect-shards 12` and refuses to merge unless the files are exactly `shard-1.info` to `shard-12.info`, each with source files in it. The gate also fails when the files hold no line, branch or function records at all, since that figure would read 100 %. A shard that is missing, left over from another shard count, doubled or empty fails with the problems listed and "Re-run all jobs". This is what a `gh run rerun --failed` after a hung shard used to turn into a wrong total of 91.66 % (#1320); rerun all jobs instead. To reproduce locally: `npm run test:coverage -- --test-reporter=lcov --test-reporter-destination=coverage/lcov.info`, then `npm run coverage:gate -- coverage`.

## Add a job or a smoke

1. Add the job to `test.yml`: `actions/checkout`, then `./.github/actions/setup`, then your command. Pin any new action by full SHA.
2. Add its id to `needs` of the `test` job. A job left out of `needs` does not gate `main`.
3. A smoke that needs the packed archive goes in the `package` job after `prepare:release`.
