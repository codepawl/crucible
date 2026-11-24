# Contributing to Crucible

This file covers setup, how to send a change, the checks it must pass, the code style and the release flow.
Coding agents can start with [AGENTS.md](AGENTS.md), the short version. Everyone follows the [code of conduct](.github/CODE_OF_CONDUCT.md).
To ask a question or report a bug, see [SUPPORT.md](.github/SUPPORT.md). Questions, ideas and finished work go in [Discussions](https://github.com/codepawl/crucible/discussions); a bug or a planned change goes in an issue.
A maintainer gives a first answer to every issue and pull request within about 7 days.
Coding agents are welcome to open pull requests. There is no disclosure box: the person who opens the pull request answers for it.

## Set up

1. Install Node.js 20.19 or later (the `Test` workflow uses 24) and Google Chrome.
2. Clone the repository and run `npm ci`.
3. Run `npm run dev`. Vite prints the local URL of the showcase.
4. For the Cook tests and native renders, run `npm run cook:fetch` to get the prebuilt addon of the pinned Cook (or `npm run cook:build` with Rust). `npm run cook:check` says whether the installed Cook is the one `package-lock.json` pins. When it is not, the Cook tests skip and `tests/cook-install.test.js` fails with what to run. Set `COOK_ALLOW_UNPINNED=1` only when you link a Cook checkout on purpose.

The library source is in `src/` and the Node tools and smoke scripts are in `scripts/`.
The tests are in `tests/` and the guides are in `docs/`.
`public/` holds the site assets: previews, CC0 textures and the HDRI.

## Make a change

1. Pick an issue. Issues labelled `good first issue` or `help wanted` are good places to start. For a large feature with no issue, open one with the feature form first. We then agree on the design before you write it.
2. Comment on the issue that you take it, so that two people do not build the same thing.
3. Fork the repository (`gh repo fork codepawl/crucible --clone`) and create a branch from `main` named `<issue>-<short-slug>`, such as `412-mesh-bevel`.
4. Write the change and its tests in the same commit, and update the guide in `docs/` that describes the feature.
5. Add a change note (see [Change notes](#change-notes)). Do not edit `CHANGELOG.md`: two pull requests that edit it conflict on GitHub.
6. Run `npm run preflight`, then open the pull request with `node scripts/open-pr.mjs` (see [Open the pull request](#open-the-pull-request)). The template asks what changed and how you checked it.

Name the pull request `<imperative sentence> (#<issue>)`, such as `Add mesh bevel to mesh_edit (#412)`. Keep one change in each pull request.

A bug you find on the way can ride along in the same pull request when it sits in a file you already change, the fix is small (about 20 lines) and changes no look, and you add a test that fails without it. Put it in its own commit and name it in the description under **Also fixed**. Any other bug gets its own issue or its own pull request.

### Your first pull request

Start with an issue labelled [`good first issue`](https://github.com/codepawl/crucible/labels/good%20first%20issue). Each one names the files to change and has a `Done when` list. None of them needs a GPU, Rust or Blender.

1. Comment on the issue that you take it. A maintainer adds `status:in-progress`, so that nobody else starts it.
2. Make the change and one test that fails without it.
3. Run `node --test tests/<area>.test.js` for the area you changed, then `npm run preflight -- --skip-tests`.
4. Open the pull request with `node scripts/open-pr.mjs`. Copy the `Done when` list of the issue into it and tick what you did.

After you open it, a bot leaves one comment about the format. It is a hint, not a review. A maintainer reviews the diff, answers within about 7 days and merges it when the checks pass. If you are stuck, ask on the issue. The release notes thank every outside contributor by name.

### Open the pull request
One command opens a pull request that passes the `PR metadata` check on its first run. Write the description to a file first (what changed, `Closes #N`, `## How I checked it`, `## Evidence`):

```sh
node scripts/open-pr.mjs --title "Add mesh bevel to mesh_edit (#412)" --body-file artifacts/pr-body.md --labels enhancement,goal:capable --milestone "0 Measure" --evidence artifacts/before.png artifacts/after.png
```

It runs the metadata checks locally on the description and the files changed against `origin/main` (pictures passed with `--evidence` count as evidence) and stops with every finding and its fix. It refuses an empty description or `-`. Then it pushes the branch if needed, runs one `gh pr create`, pushes the evidence with `push-evidence.mjs`, adds the pictures under `## Evidence` and reads the stored description back to check it. `--base <branch>` changes the base, and `--dry-run` prints the commands and the final description without writing anything on GitHub.

While you still expect review rounds, pass `--draft`. CI runs no job on a draft, so the pushes of each round take no runner time. Run `gh pr ready <number>` when the work is done: that starts the full `Test` run, and a maintainer merges only a ready pull request.

### Link the issue

Write `Closes #123` in the description when the pull request finishes the issue. Write `Part of #123` when it is one step of a larger issue. Issues are for work to do, so there is no tracking issue to link.

### Change notes

Every change under `src/`, `bin/`, `packages/` or `skills/` adds `changes/<issue>.md` with one changelog bullet. When one issue gets several pull requests, add a slug: `changes/<issue>-<slug>.md`. A size note is `changes/<issue>.size.md` or `changes/<issue>-<slug>.size.md`. CI, docs-only and test-only pull requests need no note. [changes/README.md](changes/README.md) has the format.

The `Test` workflow runs this check on every pull request, so `git push --no-verify` does not skip it.

### Describe how you checked it

Under **How I checked it** (or **Ran**, **Checks**, **Checked**, **Tests**, **Verification**), paste the commands you ran and what they printed. A line such as `npm run preflight: 14 checks ok` is enough. This applies to agents too: show the commands and their results.

### Show the evidence

Under **Evidence**, show what changed from old to new. This applies to every pull request that changes shipped code, from maintainers, outside contributors and agents alike.

- For a change people can see, add a before and an after picture or a short clip rendered by Crucible.
- For a change that can be measured, give the numbers before and after: frame time, load time, bundle bytes, memory, a quality score or the bench table.
- If nothing can be seen or measured, write one line that says so, such as "Nothing to see or measure: an internal rename."

Drag pictures and clips into the description box on GitHub. A coding agent that cannot upload pushes them to a branch named `evidence-pr-<number>` and links the raw file URLs. One command does it without touching your working tree, index or branch, and prints the Markdown image lines to paste:

```sh
node scripts/push-evidence.mjs 1234 artifacts/before.png artifacts/after.png
```

Files land at `pr-1234/<name>` on `evidence-pr-1234`; files already there stay. Pictures and clips (png, jpg, gif, webp, mp4, webm) up to 20 MB, from inside the repository or the temp folder. Add `--dry-run` to see the links first. Put the same picture or clip in the change note when the change is visible.

For a look or feature change, one command renders the scene on the branch (and on `origin/main` with `--base`), writes labelled side-by-side stills and a clip with a JSON sidecar per file under `artifacts/<issue>/`, measures every frame and prints a PASS or FAIL checklist (also in `checks.json`): subject fully in frame with a margin, no blown highlights or crushed shadows, and no single-frame jump over 5 levels in luma or saturation over every frame of a clip (a smaller step above 3 times the median is printed as a note, not a failure). Paste the checklist into the pull request and push the pictures with the command above:

```sh
node scripts/evidence.mjs --issue 1234 --recipe scene.json --cameras cameras.json --subject -1,0,-1,1,2,1 --clip 0-29 --base origin/main
node scripts/evidence.mjs --issue 1234 --builtin bar        # a small built-in recipe to try it
node scripts/evidence.mjs --issue 1234 --analyze <folder-of-frames>   # check frames you already have
```

`cameras.json` maps a name to `{ "eye": [x, y, z], "target": [x, y, z] }`; `--subject` is the subject box swept over the clip (min x, y, z then max x, y, z). The recipe is a scene file for `scripts/render-media.mjs`, and its `frame.fov` is the lens. The checks live in `scripts/evidence-checks.mjs`.

### Keep private data out

Issues and pull requests are public. Leave out local paths (a Windows user folder, or a home folder under `/home` or `/Users`), tokens and personal data. Use a path inside the repository instead.

## Checks

Run `npm run preflight` before you open a pull request. It runs every check below that applies to the files you changed, plus the size, tool cost and coverage gates, keeps going after a failure and ends with one line per check and how to fix it. Logs go to `artifacts/preflight/`. `--skip-tests` skips the slow test pass while you iterate but still runs the unit tests recorded under half a second (`scripts/fast-tests.mjs`, listed in `config/fast-tests.json`, made by `npm run record:fast-tests`).

`npm ci` points git at `.githooks/`, whose pre-push hook runs `npm run preflight -- --skip-tests` and stops the push when a gate fails. Pushing only tags or branch deletions skips it. To skip it once, run `SKIP_PREFLIGHT=1 git push` in Bash or `$env:SKIP_PREFLIGHT=1; git push` in PowerShell. `git push --no-verify` skips it too. The hook runs only the sub-second unit tests (about 13 s), because the full pass takes minutes; run the full preflight before you open the pull request.

Between one test file and the full pass there are four commands made for coding agents. Their output is short (one `FAIL file :: test :: first message` line per failure, at most ten, then a count) and the full TAP goes to `artifacts/test-logs/`:

- `npm run test:affected -- <files...>` runs every test file that mentions one of the files, or a module that re-exports it; with no files it uses the files your branch changed.
- `npm run test:fast` runs a deterministic 10 percent of the test files, seeded by the branch name (`-- --seed <text> --percent <n>` changes it). It does not replace `npm test`.
- `npm run test:mutation-check -- tests/<name>.test.js` reverts your changes under `src/`, `bin/`, `packages/` and `scripts/`, runs the tests, prints the ones that fail and restores the tree. It exits 1 when none fail, because then the test does not pin your change. Stage unstaged edits outside those folders first and `git add -N` new files under them.
- `npm test -- --test-reporter=./scripts/test-compact-reporter.mjs` gives the full pass the same short output.

The checks it runs, if you want one alone:

1. Run `npm test`. All Node tests must pass.
2. Run `npm run check:links` if you changed a Markdown or HTML file. It finds links that point at no file.
3. Run `npm run build`. It builds the site and the viewers into `dist/`.
4. Run `npm run smoke:package` if you changed exports, `package.json` or the build. It installs the packed archive into a clean project.

A renderer or shader change also needs a look at real pixels.
Run `npm run smoke` or the `smoke:*` script for the area that you changed, and look at the screenshots that it saves under `artifacts/`.
A change to skinning, glTF loading, poses or IK also needs `npm run smoke:character`, which takes a real character through the MCP server. Run `npm run prepare:release` first.
Screenshots and other output go to `artifacts/`, which Git ignores.

Every pull request runs `npm audit`, `npm run size`, `npm run tool-cost`, `npm test` (with coverage, twelve shards; Node runs each file in its own process), `prepare:release`, `smoke:package` and `smoke:mcp-package` in the `Test` workflow. `smoke:mcp-package` draws through the MCP server on SwiftShader in Chrome. `npm run size` compares every bundle with `origin/main`. If a bundle grows past its allowance (64 bytes gzip for core and the scenes, 2% for the npm archive), add `changes/<issue>.size.md` with the line `- entry:core: <why it is worth the bytes>` and say why in the pull request. Never edit `bench/size/budgets.json` or `baseline.json` in a pull request. `bench/size/README.md` has the details.

`npm run tool-cost` does the same for what the MCP tools cost an agent. If a tool schema grows by more than 64 bytes, a typical result by more than 128 bytes, or the schema total by more than 128 bytes, first move rare detail into `scene_capabilities` or a shared schema. If the growth is worth it, add a line to `changes/<issue>.size.md`, such as `- tool:scene_create: <why it is worth the bytes>`, `- tool-total: <why>` or `- result:scene_capabilities: <why>`. Never edit `bench/tool-cost-budgets.json` in a pull request. `bench/tool-cost-ceilings.json` holds fixed absolute ceilings (the schema total, each tool and the default `scene_capabilities` answer) that fail the check whatever the growth. Put field detail in a `scene_capabilities` topic and keep only the common fields in the tool schema. `bench/tool-cost/README.md` has the details.

Branch protection on `main` requires the `test` check to pass before a merge. `GitGuardian Security Checks` is an external check that must also pass.

Main is tested after every push to it, so a branch does not need the newest `main` to merge. Merge `main` into your branch only when `git merge-tree` reports a conflict, or when `main` changed a file your branch also changes:

```sh
git fetch origin
git merge-tree --write-tree origin/main HEAD >/dev/null || echo "conflict: merge origin/main"
comm -12 <(git diff --name-only HEAD...origin/main | sort) <(git diff --name-only origin/main...HEAD | sort)   # files both sides changed
```

`merge-tree` exits 1 on a conflict, and the last command prints nothing when the two sets of files are apart. If either shows something, run `git merge origin/main`, fix it and push. Otherwise push without merging.

These checks need a GPU or a person's eyes, so they do not run on a pull request. The author runs each one that applies:

| Check | Run it when you change |
| --- | --- |
| `Cook addon` workflow | Native code: it runs on a pull request only when `package.json`, the lock file or a file the addon tests import changes (`node scripts/addon-job-paths.mjs` lists them), and nightly on `main` |
| `npm run smoke:mcp` | MCP tools or the preview, on a GPU |
| `npm run smoke:character` | Skinning, glTF loading, poses or IK |
| `npm run smoke:line-art-nodes` | Outlines or `environment.lines.nodes`, on a GPU |
| `npm run reference` | Shaders, lighting or materials |
| `npm run benchmark:runtime` | The renderer's frame path |
| `scripts/blender-golden.py` | A case in `tests/fixtures/blender/cases.json`, or the Blender version |
| `scripts/blender-easing-golden.py` | An easing curve, or the Blender version |

### Tool schema and skill changes

A change to an MCP tool, its schema or a skill under `skills/` also needs the agent bench. A longer schema can lower how often an agent succeeds. Run Haiku alone, because it reacts first, and compare it with the baseline:

```sh
node bench/agent-modeling/bench.mjs --models haiku --runs 3 --label <branch> --backend cpu
node bench/agent-modeling/compare-bench.mjs bench/agent-modeling/results/bench-baseline.json bench/agent-modeling/results/bench-<branch>.json
```

Paste the table into the pull request. The bench runs through a Claude Code login. Without one, write "I have no Claude Code login; a maintainer runs the bench." in the pull request and a maintainer runs it. If the tool schemas did not change, write "The tool schemas are unchanged." Only `skills/` and `scripts/mcp-server.mjs` trigger this check. [bench/agent-modeling/README.md](bench/agent-modeling/README.md) has the details.

**Bench what changed, not everything again and again.** A change to one topic (relations, particles, an explosion, the terrain) runs only the tasks that exercise it, by kind or by topic, and compares on those tasks alone:

```sh
node bench/agent-modeling/bench.mjs --suggest origin/main     # prints the command for this branch's diff
node bench/agent-modeling/bench.mjs --kinds light --topics relations --models haiku --runs 3 --label <branch> --backend cpu
```

Name the task ids you ran in the pull request (`--dry-run` lists them). Skipped baseline tasks are listed by `compare-bench.mjs` and never count as failures. The full bench runs for a change every task reads (the tool schemas and server instructions in `scripts/mcp-server.mjs`, or `skills/build-crucible-scene/SKILL.md`), and once before each release cut.

**A skill change is benched in skill mode `references`.** By default the bench agent sees no skill, so an edit to a skill file could not change a result. Under `skills/build-crucible-scene/`, run with `--skill-mode references`: the agent's system prompt then holds `SKILL.md` plus the reference files its task kind points to (`KIND_REFERENCES` in `bench/agent-modeling/suite.mjs`: light tasks get `light.md`, look tasks `look.md`, and so on), and `--suggest` adds the flag and picks the kinds that load the reference you changed. The stored `bench-baseline.json` has no skill, so compare base and head instead: run the same command on `origin/main` (label `base`) and on your branch, then `compare-bench.mjs bench-base.json bench-<branch>.json`. `compare-bench.mjs` refuses two files made in different skill modes.

### Look changes

A change to shaders, lighting, materials, the default render or a post step changes how every scene looks. Add a before and an after picture to the pull request. Run every picture and clip through `node scripts/check-preview.mjs <file> [--reference <Cook or Cycles still>]` before you send it for review, and fix what it fails ([docs/check-preview.md](docs/check-preview.md)). A bot adds the label `hold:look-approval`. Only the owner removes it, and nothing with that label merges. Once the owner removes it, the check counts the look as approved and stops asking for pictures. A file named like a look file that only gains a thrown message or an input check (every changed line is a throw, its guard, a comment or a plain `const`) is not counted as a look change. A maintainer (owner, member or collaborator) whose change touches a look file without changing a pixel, such as a compile fix, a refactor or a test, writes "The look is unchanged." in the description, and the bot adds no hold and asks for no picture. Outside pull requests keep the hold.

### Who runs the GPU and person checks

You run the checks in the table above that apply, when you can. When you cannot (for example, you have no GPU), say so in the pull request. A maintainer runs them and adds the label `status:needs-gpu-check`. The merge waits for them only for look and renderer changes.

Do not weaken a test to make it pass. If a test is flaky, find the cause and fix the test or the code.

## Labels and milestones

The maintainer sets labels and the milestone, so you do not need to. Every issue has one goal and one priority:

- `goal:capable`, `goal:light` or `goal:ai` say which part of the [goal](docs/goal.md) the work serves.
- `priority:must`, `priority:should` or `priority:could` say how soon. [Triage](#triage) says how a bug gets one.
- `bug`, `enhancement` or `documentation` say what kind of work it is. `regression` marks a bug that the last published version did not have.

The milestones are `0 Measure`, `1 Lighter`, `2 Modeling`, `3 Look`, `4 Motion and simulation`, `5 Agent surface` and `6 Games`. [docs/goal.md](docs/goal.md) explains each one. A pull request that misses a label or the milestone gets `needs-triage` until the maintainer sets them.

A bot (`.github/workflows/sync-pr-metadata.yml`) assigns the maintainer on every new pull request and issue, and copies the milestone and the `priority:*` and `goal:*` labels of the issue a pull request names. It only adds, so name the issue in the description and leave these fields to it.

## Triage

### How urgent a bug is

A bug's priority comes from what a user meets, not from how easy the fix is:

- `priority:must`: fixed before the next release. A normal library call, recipe, MCP tool or render job crashes, hangs,
  runs out of memory, or gives a wrong picture or wrong data without an error. Something the docs describe that does
  not work as written counts too, and so does a regression.
- `priority:should`: real files or agents reach it, but only with unusual input: a glTF or HDR file from another tool,
  parts that share a name, an edge case in the hierarchy. An error that names the wrong field for a common mistake is
  `should` too.
- `priority:could`: only input that makes no sense reaches it (NaN, negative or huge counts, an unknown name), through a
  direct library call that the recipe and MCP layers already refuse, or the fix only rewords a message.

When two levels both seem to fit, run the smallest case through a recipe or an MCP tool. If it shows there, pick the
higher level.

### How big an issue is

One issue is one piece of work that one person or agent can finish in one pull request:

- Symptoms with one cause are one issue. Small findings in the same module are one issue with a checkbox per case:
  four missing input checks in `src/mesh-uv.js` make one issue, not four.
- Split an issue when its parts touch areas that can be worked on at the same time, or when they have different
  priorities.
- Each issue names the file area, gives the smallest case that shows the problem, and ends with a `## Done when` list
  that a test can check.
- `good first issue` marks work in one file with a named test file and no look change. `help wanted` marks scoped,
  self-contained work that is open to outside contributors.

## Review and merge

Only the maintainer merges. There is no required review and no auto-merge. A pull request merges when the `test` check passes, `GitGuardian Security Checks` passes, and the maintainer has looked at it. [CODEOWNERS](.github/CODEOWNERS) lists the maintainer.

## The pull request check

The `PR metadata` workflow checks each pull request against this guide. It posts one friendly comment that lists what is missing, with a link to the section that explains each item. The checks are:

- The description links an issue and says how you checked.
- Shipped code has a change note.
- Shipped code shows its evidence: pictures, numbers before and after, or a line that there is nothing to show.
- Tool and skill changes have a bench table.
- Look changes have a picture.
- The description holds no local path.

Docs-only, CI-only and test-only pull requests skip everything except the local path check.

- The comment updates itself when you fix an item. One reminder follows when 24 hours are left.
- A maintainer gives a first answer within about 7 days. That reply time is separate from the bot clock, which counts only items on your side. If an item is still open 72 hours after the first comment (the end of that UTC day, weekends included), the bot closes the pull request. It invites you to reopen it once the item is fixed, and reopening starts the time again.
- Pull requests from the owner, members, collaborators and bots never close by themselves. Drafts and pull requests labelled `needs-owner-decision` do not close either; the clock of a draft restarts once it passes the reminder time, so marking it ready later still gets the reminder first.
- Labels and the milestone never count against you. The bot adds `needs-triage` when they are missing and `status:needs-author` while something of yours is missing.

For maintainers: the workflow is `.github/workflows/pr-metadata.yml`, and the rules are the pure modules `scripts/pr-metadata-check.mjs` (what is missing) and `scripts/pr-metadata-flow.mjs` (the clock and the wording). The workflow runs on `pull_request_target`, so it never checks out or runs the code of the pull request. It reads the description and the file list through the API only. Do not change that. It is not a required check.

To test a change to the rules, run `node --test tests/pr-metadata-check.test.js`. To see what the bot would do on the real repository without changing anything, run the workflow by hand: `gh workflow run pr-metadata.yml -f dry_run=true`, then read the log. A run with `dry_run=false` sweeps every open pull request.

## Code style

- Use descriptive full names. Write `positionCount`, not `n` or `cnt`. Short names are fine for small loop indices.
- Write one statement on each line. Keep functions small.
- Add a comment only where the reason is not clear from the code.
- Keep the core renderer free of new runtime dependencies. Put optional features in an addon under `src/` and export it as `crucible/addons/<name>`.
- Make every scene builder deterministic for the same seed. Tests compare geometry byte for byte.
- Validate input at the public boundary and throw an error that says what failed and what to pass instead.
- Measure a performance claim on matching scenes before you write it in the docs.

## Assets

Use only assets that you can share under CC0 or a license that allows redistribution.
Record the source, the author and the license of each asset in `public/textures/CREDITS.md`.
Keep site assets out of the npm package: the `files` list in `package.json` decides what ships.

`scripts/build-leaf-cards.py` rebuilds the leaf cards in `public/textures/leaves` from the ambientCG atlases. Its header gives the command.

## Release

Maintainers make releases. `package.json` holds the version, and the publish workflow runs when it changes on `main`. A bump must carry its `## <version>` section in `CHANGELOG.md` and no unfolded `changes/*.md` notes: the pull request gate (`check-change-note`) checks that, and `npm run check:release-changelog` checks it again before `publish` (skipped when npm already serves the version, so a non-bump change to `package.json` stays green), so npm is never published from a commit whose release page cannot be built.

A minor release ships about once a week, give or take one to three days. A maintainer picks the issues that must be in it,
waits a few days at most for the issues that should be in it, and moves the rest to the next release. A look change still
waiting for the owner's approval does not hold a release back. A serious bug ships alone as a patch release, without
waiting for the week.

1. List the bugs that must be fixed first: `gh issue list --label bug --label priority:must --state open`. The list is
   empty, or the maintainer moves each issue on it to the next release with a reason written in the issue.
1. Update the version in `package.json` and in `src/version.js`, run `npm run plugin:sync` to copy it into `.claude-plugin/marketplace.json`, then run `npm run changes:fold`. It writes the files in `changes/` into `CHANGELOG.md` as that version's section and deletes them. Read `npm run changes` first to see what it will fold. It also deletes the `changes/*.size.md` notes.
2. Run `npm run size:release` and `npm run tool-cost:release`. They reset the size budgets, the baseline and the tool cost ceilings to the release numbers. Read the diffs of `bench/size/budgets.json` and `bench/tool-cost-budgets.json`. Run `node scripts/guide-fields.mjs snapshot` to record the fields this release accepts in `bench/guide-fields/released.json`, then remove the `{since X.Y.Z}` tags of this version from `docs/game.md` and `docs/mcp.md`.
3. Run `npm test`, `npm run build` and `npm run smoke:package`.
4. Commit and push to `main`.
5. Wait for the `Publish Crucible` workflow. It tests the package and publishes the new version through the npm trusted publisher.
6. Run `npm run deploy`. It checks that the tree is clean and pushed, builds the site and verifies the live `/release.json`.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
