# Kinetic text

A title that rises, grows or appears one letter or word at a time. `splitText` turns a text into one node per letter or word, and `staggerNodeTracks` copies one animation across them, each starting a little after the one before. Both return plain recipe data (geometries, nodes and motion tracks), so the result goes straight into `scene_create` or a recipe file.

```js
import { splitText, staggerNodeTracks } from '@codepawlhq/crucible/addons/kinetic-text';

const title = splitText('CRUCIBLE', { id: 'title', split: 'letters', align: 'center', material: 'gold' });
const rise = staggerNodeTracks(title.nodes, {
  property: 'translation', offset: 0.09, order: 'forward',
  keyframes: [{ time: 0, value: [0, -1.4, 0], easing: 'easeOutBack' }, { time: 0.7, value: [0, 0, 0] }],
});
const recipe = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: title.geometries,
  materials: [{ id: 'gold', color: [0.9, 0.65, 0.2], metallic: 0.9, roughness: 0.3 }],
  nodes: title.nodes,
  motion: { duration: rise.duration, tracks: rise.tracks },
};
```

`scripts/render-title-reveal.mjs` builds this scene with a drop and a scale track and renders it through the MCP render job.

## splitText

`splitText(content, options)` returns `{ geometries, nodes, pieces }`.

- `split` is `letters` (the default) or `words`. Spaces and line breaks make no piece, and a word never crosses a line break.
- Each piece is an ordinary left-aligned `text` geometry and a node. The node translation is where `text(content, options)` puts that piece, so the nodes drawn together look the same as the unsplit text, for any `align` and any number of lines.
- Letters that repeat share one geometry. Node ids are `<id>-<index>` in reading order, geometry ids `<id>-glyphs-<n>`.
- Options: `id`, `size`, `depth`, `font`, `align`, `curveSegments` (as for a `text` geometry), `material`, `parent`, and `translation` (the position of the whole text, default `[0, 0, 0]`).
- A piece turns and scales about the left end of its baseline, because that is its node origin.
- At most 128 pieces, the track limit of one motion. Split a longer text into words.

## staggerNodeTracks

`staggerNodeTracks(nodes, { property, keyframes, offset, order, seed, easing })` returns `{ tracks, duration, delays }`: one `node` track per node, `motion.tracks`-ready, and the shortest `motion.duration` that holds them all.

- `nodes` are `{ id, translation? }`, such as `splitText(...).nodes`.
- `property` is `translation`, `rotation`, `scale`, `visible` or `opacity` (0 to 1, a fade; the node draws blended while it has the track). Translation keyframes are offsets from each node's own translation, so one rise track works for every letter. The other properties are the values themselves.
- `offset` is the delay in seconds between one node's start and the next one's.
- `order` is `forward`, `reverse`, `center` (the middle starts first; the two middle nodes of an even count start together) or `random` (a seeded shuffle: the same `seed` gives the same order).
- `easing` spreads the start times between the first and the last node. `linear` (the default) starts each node exactly `offset` after the one before; another curve from the [keyframe easings](https://crucible.codepawl.com/animation-curves.md) bunches the starts. A curve that overshoots (`easeOutBack`) is clamped at 0. Easings on individual keyframes pass through to the tracks.
- Before its start a node holds its first keyframe: a track that starts late gets a keyframe at time 0 with that value.
- The limits of a motion apply: 128 tracks, 2048 keyframes in all and a duration of at most 30 seconds. An error names the limit and what to lower.

A per-letter fade is `property: 'opacity'` with keyframes from 0 to 1: `node scripts/render-title-reveal.mjs --effect fade` renders CRUCIBLE fading in letter by letter.

The MCP tools take no new fields apart from the node `opacity` track property. An agent builds the recipe through these functions, or writes the same geometries, nodes and tracks by hand.
