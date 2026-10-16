/**
 * Cooperative cancellation (D19): the shim's interrupt flag is an ATOMIC
 * GLOBAL read by the per-context `GEOSContextInterruptCallback` at GEOS's
 * own interruption points. `withSignal` is the plumbing every cancellable
 * op uses:
 *
 * 1. pre-check — an already-aborted signal throws before any C call;
 * 2. listener — an abort flips the shim flag (`geos_shim_interrupt_request`);
 * 3. finally — the flag is reset and the listener removed;
 * 4. failure + `signal.aborted` → `GeosError("aborted")` with
 *    `cause = signal.reason` (io.md §7 error table).
 *
 * HONEST LIMITATION (concurrency.md §3): a synchronous FFI call blocks the
 * JS thread, so an AbortSignal listener on the CALLING thread cannot fire
 * mid-call. Mid-flight cancellation of a main-thread op only works when the
 * flag is flipped from another thread (`geos.interruptRequest()` from a
 * Worker, or a listener on a signal aborted from another thread). The
 * same-thread `signal` still always gives the pre-check and after-the-fact
 * abort reporting; the real ergonomic story is Phase 3 `parallel.*`, where
 * the op runs on a Worker and the main thread's listener can reach it.
 */
import { GeosError } from "./errors.ts";
import type { Geos } from "./geos.ts";

/** Options every cancellable op accepts (api-surface §Conventions). */
export interface OpOptions {
  signal?: AbortSignal;
}

export function abortError(signal: AbortSignal, cause?: unknown): GeosError {
  return new GeosError("aborted", "operation aborted via AbortSignal", undefined, {
    cause: cause ?? signal.reason,
  });
}

/**
 * Run `fn` under the given signal. The ops modules stay signal-free; the
 * `Geos` method wrappers close over the caller's options and wrap the call.
 *
 * Cross-context note (D19): the flag is process-global, so two ops running
 * concurrently on DIFFERENT threads can erase each other's interrupt
 * requests (one thread's `finally` reset clears a request meant for the
 * other). Within one thread ops are sequential and this cannot happen;
 * cross-Worker setups must ensure only one signal-taking op is in flight
 * per flag (Phase 3's worker pool will partition by design).
 */
export function withSignal<T>(geos: Geos, signal: AbortSignal | undefined, fn: () => T): T {
  if (signal === undefined) return fn();
  if (signal.aborted) throw abortError(signal);
  const shim = geos.native.shim;
  const request = (): void => {
    shim.geos_shim_interrupt_request();
  };
  signal.addEventListener("abort", request, { once: true });
  try {
    return fn();
  } catch (err) {
    // The underlying GeosError (with its GEOS message) is always preserved
    // as `cause` — never discarded.
    if (signal.aborted && err instanceof GeosError) throw abortError(signal, err);
    // Cross-thread pattern (D19): the flag was flipped by ANOTHER thread in
    // response to this signal while this thread was blocked in the C call —
    // GEOS surfaces it as InterruptedException. Re-shape it as the aborted
    // error (op "aborted", cause = the underlying failure) so callers can
    // handle both paths uniformly.
    if (
      err instanceof GeosError &&
      err.geosMessage !== undefined &&
      err.geosMessage.includes("Interrupted!")
    ) {
      throw abortError(signal, err);
    }
    throw err;
  } finally {
    // Reset even on success: a listener that fired late (racing completion)
    // must not poison the NEXT op with a stale interrupt.
    shim.geos_shim_interrupt_reset();
    signal.removeEventListener("abort", request);
  }
}
