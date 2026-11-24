// Colour map as an image sequence: frames are catalog images, the frame follows the scene's motion time. Kept outside
// agent-scene-capabilities.js so the scene entry does not carry text only an agent reads; the MCP runtime adds it to
// scene_capabilities.

export const TEXTURE_SEQUENCE_LIMITS = Object.freeze({
  // maxFrames bounds the list in a recipe. A sequence of at most wholeSequenceFrames frames is decoded whole; a longer one streams,
  // and only the frame of the current time and the one before it stay decoded. maxDecodedBytes bounds the decoded bytes a scene
  // keeps at once, and one frame is at most maxSide x maxSide x 4 = 16 MiB.
  maxFrames: 4096, wholeSequenceFrames: 64, maxFps: 60, maxSide: 2048, maxDecodedBytes: 64 * 1024 * 1024,
});

export const TEXTURE_SEQUENCE_CAPABILITIES = Object.freeze({
  field: 'material.map = { sequence: { frames: [catalog image asset IDs], fps, loop } }',
  covers: 'color map (map) of surface-tag materials; needs UVs (grid, box and similar); not combined with pattern',
  frame: 'floor(motionTime * fps), wrapped when loop is true (default) and held on the last frame when false; frame 0 before any motion time',
  clock: 'motionTime, also in render jobs (settings.motion.start + elapsed)',
  streaming: 'a sequence of more than wholeSequenceFrames frames loads on demand: the host reads and decodes the frame of each requested time and keeps the one before it, so a video job decodes each frame once, in frame order, and the limits are per frame (maxSide) and for the decoded frames kept at once (maxDecodedBytes), not for the whole list. Streaming covers scene_look with a time and the raster still and video jobs; scene_review (all shots in one call) and path traced or native jobs (settings.renderer, which refuses a streamed sequence) need a sequence of at most wholeSequenceFrames frames. Shorter sequences load whole.',
  images: 'PNG, JPEG or WebP files in the --assets folder, listed by scene_asset_catalog with kind image; one size for all frames; the image alpha applies with alphaMode blend or mask',
  catalog: 'a folder of more than 256 consecutively numbered images is listed by scene_asset_catalog under sequences, not per frame; write map.sequence = { catalog: the sequence name such as "frame_####.png", fps, loop } instead of frames. The server swaps in the frame IDs (hashed on first use, not at startup)',
  ...TEXTURE_SEQUENCE_LIMITS,
});

export const FACE_IMAGE_CAPABILITIES = Object.freeze({
  field: 'node.faceImages = [{ face, colorMap | map, tile, offset, rotation, color, opacity, alphaMode, alphaCutoff }], up to 6 on a node whose geometry is a box; null removes them',
  face: '+x, -x, +y, -y, +z or -z: the face of the part that carries the image, upright seen from outside (+z and -z upright by the part axes, +y has the top of the image toward -z)',
  image: 'colorMap: one catalog image asset ID, PNG, JPEG or WebP, up to 2048 pixels a side; map: { sequence: { frames, fps, loop } } is a per-frame list of 2 to 4096 local catalog images, picked by floor(time * fps) with no blending (fps = the scene fps for one image per frame; loop false holds the last one). A numbered folder works as map.sequence.catalog. Alpha of the image is used: alphaMode defaults to blend here, mask with alphaCutoff makes a hard cutout',
  tile: '[u, v] metres one tile covers along the face, 0.001 to 100000, so the tiling stays constant when the part is resized (Roblox Texture StudsPerTile, 1 stud = 0.28 m); left out, one image stretches over the whole face (Roblox Decal). offset [u, v] in tiles and rotation in degrees move the tiles',
  result: 'each entry becomes a child quad node "<node>.face-<n>" with its own material "<node>.face-<n>", a hair (0.5 mm) outside the face, decal true, depthLayer stacking on one face (at most 5 per face); it follows the part. Edit it with set-node and set-material on those IDs, or set faceImages again to replace them all',
  alsoOn: 'worldScale takes [u, v] on any material with colorMap or a map sequence, so a quad or a mesh can tile by metres without faceImages; uvOffset and uvRotation work with a map sequence too',
  network: 'local catalog images only, no URLs',
});
