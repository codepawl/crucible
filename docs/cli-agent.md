# Built-in headless AI CLI

The `crucible` command includes a built-in headless AI agent and account authentication.
You can build and edit 3D scenes directly from your terminal without setting up a separate MCP client.
Every scene edit writes an updated recipe JSON file to disk.

## Sign in

1. Run `npx crucible auth login` to open your browser and sign in for 250 free credits, with no card needed.
2. Run `npx crucible auth login --no-browser` on a headless machine to print the sign-in URL instead of opening a browser.
3. Run `npx crucible auth status` to print your remaining credits and account URL (`https://accounts.codepawl.com/account`).
4. Run `npx crucible auth logout` to remove the saved local session.

The CLI stores your session in `auth.json` inside `CRUCIBLE_CONFIG_DIR`, `%APPDATA%\crucible` on Windows, or `$XDG_CONFIG_HOME/crucible` on Linux and macOS.
On POSIX systems, the directory uses mode `0700` and the file uses mode `0600`.
For headless CI, set `CRUCIBLE_AGENT_TOKEN` instead of signing in with a browser.
To connect your own external agent without signing in, use [crucible-mcp](mcp.md).

## Run the agent

Pass a prompt in quotes to create a new scene and save `scene.json`.

```sh
npx crucible agent "Create a studio-lit ceramic mug" --out mug.json
```

Pass `--scene` to open an existing recipe before the first turn.

```sh
npx crucible agent "Add warm rim lighting" --scene mug.json --out mug-lit.json
```

## Options

| Flag | What it does |
| --- | --- |
| `--scene <in.json>` | Load an existing scene recipe before the first turn. |
| `--out <out.json>` | Write updated recipes here. Defaults to `--scene`, or `scene.json`. |
| `--model <name>` | Use `haiku`, `sonnet`, `opus`, or an explicit model ID. Defaults to `haiku`. |
| `--max-turns <1..60>` | Stop after this many model turns. Defaults to `30`. |
| `--backend cpu|gpu` | Select the renderer backend for `crucible-mcp`. Defaults to `gpu`. |
| `--jobs <dir>` | Pass a render job folder to `crucible-mcp`. |
| `--json` | Print one JSON summary object to stdout. |
| `--quiet` | Suppress progress lines on stderr. |

## Environment variables

| Variable | What it does |
| --- | --- |
| `CRUCIBLE_AGENT_TOKEN` | Bearer token for headless CI runs. |
| `CRUCIBLE_CONFIG_DIR` | Directory that stores `auth.json`. |
| `CRUCIBLE_ACCOUNTS_ISSUER` | Custom OAuth issuer URL. |
| `CRUCIBLE_AGENT_PROXY` | Custom agent proxy base URL. |
| `CRUCIBLE_NO_PROMO` | Set to `1` to hide promotional credit notices. |

## How scene files update

The CLI spawns `crucible-mcp` over stdio with the core scene authoring tools.
After each mutating tool succeeds, the CLI exports the recipe and writes it atomically to `--out`.
Your scene file stays valid JSON even if a later turn fails or hits `--max-turns`.

## Setup diagnostics (`crucible doctor`)

Run `npx crucible doctor` to audit Node.js, browser availability, MCP client configs, `--assets` / `--jobs` directories, `--memory`, optional packages, and Crucible skills, or `npx crucible doctor --fix` to create missing directories and repair MCP configs safely with a `.bak` backup (see [mcp.md](mcp.md)).
