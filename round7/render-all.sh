#!/usr/bin/env bash
# Renders the six stills with the round-6 shader (before), the mask-debug shader (slope-1 only) and the final shader (after).
# Run on the PC from artifacts/2874 once the gpu-lock queue is free; each pass goes through gpu-lock. Restores the final shader at the end.
set -e
root=C:/Users/nxan2/Documents/crucible
worktree=$root/.claude/worktrees/w-2874
out=$root/artifacts/2874
pipeline=$out/r7/pipeline
mkdir -p $out/r7/pc/before $out/r7/pc/debug $out/r7/pc/after
pass() { # shader variants folder
  cp $pipeline/$1 $worktree/src/wetness-shader.js
  (cd $out && bash ~/.agents/tools/gpu-lock.sh node engine.mjs $2)
  cp $out/slope-*.png $out/road-*.png $out/slope-*.json $out/road-*.json $out/r7/pc/$3/ 2>/dev/null || true
}
pass before-shader.js v-six.mjs before
pass debug-shader.js r7/v-slope1.mjs debug
pass final-shader.js v-six.mjs after
