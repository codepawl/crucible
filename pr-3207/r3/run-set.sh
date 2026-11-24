WT=${WT:-C:/Users/nxan2/Documents/crucible/.claude/worktrees/w-3148}
TAG=${TAG:-after}
G="bash $HOME/.agents/tools/gpu-lock.sh node"
run() { $G "$@" 2>&1 | grep -i "wrote\|error" | cut -c1-120; }
EYE_SCALE=8 EYE_CAMERA='{"eye":[2.2,0.9,3.2],"target":[0,0,0.8],"fov":30}' run render-eye.mjs $WT $TAG-eye-tq raster
EYE_SCALE=8 EYE_CAMERA='{"eye":[0,0,5.5],"target":[0,0,0.8],"fov":30}' run render-eye.mjs $WT $TAG-eye-front raster
STRIPE_Z=-1.2 run render.mjs $WT $TAG-sphere-near raster 2.0 0.05
STRIPE_Z=-4 run render.mjs $WT $TAG-sphere-far raster 2.0 0.05
