# Rain weather portrait benchmark

Renders a `1080x1920` portrait street scene with dry vs rainy weather (`@codepawlhq/crucible/addons/rain` streaks, ground splashes, and paired wetness), verifies frame-seek determinism (`RMSE === 0`), and reports wall/GPU frame times:

```sh
node bench/rain/bench.mjs
```
