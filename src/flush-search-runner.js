// Runs a flush search that is written as a generator (issue #2905). Each `yield` in the steps is a checkpoint: the runner
// stops at the first checkpoint past its time slice and goes on in the next turn of the event loop, so a search of a few
// hundred thousand triangles never holds the page for more than about one slice. `drainSteps` runs the same steps to the end
// at once, which is how the synchronous entry points get exactly the same result.

/** Runs `steps` (a generator) to its end without stopping and returns what it returned. */
export function drainSteps(steps) {
  let step = steps.next();
  while (!step.done) {
    step = steps.next();
  }
  return step.value;
}

/**
 * Starts `steps` in slices of `sliceMilliseconds`, the first on the next turn of the event loop. `onDone(result)` runs once,
 * in the slice that finishes the steps. `drain()` finishes them now, synchronously, and `cancel()` drops them: the steps change
 * nothing outside themselves until their last checkpoint, so a cancelled search leaves no trace. When a slice throws,
 * `onFailure(error)` runs and the error is thrown on, from the timer or from `drain()`.
 */
export function createFlushSearchRunner({
  steps,
  sliceMilliseconds = 8,
  now = () => performance.now(),
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  onDone,
  onFailure,
}) {
  let timer = null;
  let finished = false;

  function complete(result) {
    finished = true;
    onDone?.(result);
  }

  function fail(error) {
    finished = true;
    onFailure?.(error);
    throw error;
  }

  function runSlice() {
    timer = null;
    if (finished) return;
    const sliceEnd = now() + sliceMilliseconds;
    let step;
    try {
      do {
        step = steps.next();
      } while (!step.done && now() < sliceEnd);
    } catch (error) {
      fail(error);
    }
    if (step.done) {
      complete(step.value);
    } else {
      timer = schedule(runSlice, 0);
    }
  }

  timer = schedule(runSlice, 0);
  return {
    drain() {
      if (finished) return;
      cancelSchedule(timer);
      timer = null;
      let result;
      try {
        result = drainSteps(steps);
      } catch (error) {
        fail(error);
      }
      complete(result);
    },
    cancel() {
      if (finished) return;
      finished = true;
      cancelSchedule(timer);
      timer = null;
      steps.return();
    },
  };
}
