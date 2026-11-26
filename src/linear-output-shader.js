import { registerShaderFeatureCode } from './shader-registry.js';

// Linear output (#1749), a step of the post pass: the frame writes the linear scene radiance as it stands after every pass that adds light,
// with no view transform, look, display-space finishing or clamp. Only a renderer that draws a frame with linearOutput needs this module;
// post.js leaves every other post program as it was. `post(body)` splices the early exit into the post main, and `step` checks the frame.
const ANCHOR = '  if (POST_VOLUME) color = volumeFog(color);\n';
const EXIT = `  if (hdrEnabled > 0.5) {
    float linearAlpha = POST_TRANSPARENT ? coverage : 1.0;
    outputColor = vec4(color * linearAlpha, linearAlpha);
    return;
  }
`;

registerShaderFeatureCode('linearOutput', {
  post(mainBody) {
    if (!mainBody.includes(ANCHOR)) throw new Error('The post shader no longer holds the line that linear output is written after.');
    return mainBody.replace(ANCHOR, ANCHOR + EXIT);
  },
  // Checks the frame and returns the name of the post step.
  postStep(renderer, frame) {
    if (!frame.linearOutput) return null;
    if (!renderer.hdr || !frame.outputFramebuffer) throw new Error('linearOutput needs hdr: true and an outputFramebuffer from createFloatOutput; pass both or drop linearOutput.');
    return 'linearOutput';
  },
});
