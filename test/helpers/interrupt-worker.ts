/**
 * Interrupt worker (test-only): pre-constructs its own Geos context, then —
 * on request — schedules `interruptRequest()` on ITS OWN event loop.
 *
 * The schedule must live on this thread: a synchronous FFI call blocks the
 * PARENT thread's event loop, so a parent-side setTimeout can never fire
 * mid-op (that discovery is exactly the D19 same-thread limitation).
 */
import { parentPort } from "node:worker_threads";
import { Geos } from "../../src/index.ts";

const geos = new Geos();
parentPort!.on("message", (msg: { abortAfterMs?: number }) => {
  if (msg.abortAfterMs !== undefined) {
    setTimeout(() => {
      geos.interruptRequest(); // atomic global in the shim — visible cross-thread
      parentPort!.postMessage("flipped");
    }, msg.abortAfterMs);
  }
});
parentPort!.postMessage("ready");
