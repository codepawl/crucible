# @codepawlhq/crucible-roblox-import

Companion package that imports Roblox-style scenes exported from Roblox Studio (the XML `.rbxlx` place and `.rbxmx` model files) as a Crucible scene recipe: block, wedge, cylinder and ball parts with size, CFrame, colour, material and transparency, point, spot and surface lights, and the camera. 1 stud is 0.28 m, Y is up, the field of view is vertical. It imports no dependency and never fetches a URL; meshes and textures named by asset id come from a local folder with an `asset-map.json`. It is a library, not an addon, so the MCP server does not load it with `--allow-addon`. Install it with `npm install @codepawlhq/crucible-roblox-import`.

```js
import { importRoblox } from '@codepawlhq/crucible-roblox-import';
import { importRobloxFile } from '@codepawlhq/crucible-roblox-import/node';

const { recipe, warnings } = importRoblox(xmlText);
const withAssets = await importRobloxFile('place.rbxlx', { assetFolder: './assets' });
```

An unsupported class stops the import with its class, name and what to pass. The guide with the mapping table, limits and options is [docs/roblox-import.md](../../docs/roblox-import.md).
