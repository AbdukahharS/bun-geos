/**
 * geos.parallel — the worker-pool batch helper (ROADMAP Phase 3; D23).
 *
 * Design (decisions.md D23, closing concurrency.md §4's open item):
 * - Lazily-spawned pool; each Worker owns exactly one Geos context (D3).
 *   Workers spawn on FIRST USE, after the main thread has loaded the native
 *   libraries — the D11 preload rule holds by construction.
 * - Transfer currency is WKB (geometries never cross, D11): chunks go out
 *   as one WKB buffer + byte offsets via postMessage transfer lists;
 *   geometry results come back the same way and are re-read with one
 *   `fromWKBMany` crossing. Masks/measures cross as typed arrays.
 * - Chunking by CUMULATIVE VERTEX COUNT (concurrency.md §4): weights from
 *   one `geos_shim_num_points_many` crossing, chunks cut in input order,
 *   results reassembled in input order (documented determinism).
 * - Interrupt partition (the D19 known limit, fixed by design): the op runs
 *   on workers, so the main thread stays FREE — its abort listener flips
 *   the shim's atomic global flag directly, GEOS sees it inside the
 *   workers' C loops, and the pool resets the flag in `finally`. Rule that
 *   makes the process-global flag safe: at most ONE signal-taking parallel
 *   op in flight per pool; further ones queue behind it (ops WITHOUT a
 *   signal bypass the gate — they never WRITE the flag, matching the
 *   main-thread `withSignal` behavior; note their workers still READ the
 *   global flag, so a concurrent abort can fail their in-flight chunks
 *   (documented honest bound — D23.4).
 * - All-or-nothing (D18/D22): any chunk failure rejects the whole op with
 *   a `GeosParallelError` carrying per-chunk string diagnostics (D21).
 * - Small batches run on the calling thread: below `minChunkGeoms × 2`
 *   items the pool overhead (WKB both ways + messages) dominates and the
 *   main-thread batch op wins.
 */
import { Worker } from "node:worker_threads";
import { GeosError } from "../errors.ts";
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import { abortError, type OpOptions } from "../interrupt.ts";
import { wkbManyBytes } from "../io/wkb.ts";
import { type BatchInput, withBatchInputsAsync } from "../ops/batch.ts";
import type { BufferOptions } from "../ops/buffer.ts";
import { geomPtrArray } from "../ptrs.ts";
import type { FromWorker, ParallelOp, RunMessage, ToWorker } from "./protocol.ts";

export interface ParallelOptions extends OpOptions {
  /** Pool size override. Default: clamp(hardwareConcurrency − 1, 1, 8). */
  concurrency?: number;
  /** Chunks per worker (load-balance oversubscription). Default 2. */
  chunkFactor?: number;
  /** Chunk floor in geometries (amortizes WKB serialization). Default 64. */
  minChunkGeoms?: number;
  /**
   * Watchdog for a dispatched chunk (ms). A worker that neither returns a
   * result nor trips `error`/`exit` (measured Bun 1.4.3 engine flake: worker
   * child processes can die pre-handshake under a large parent heap, with no
   * parent-side signal) is terminated and the job fails loudly — the pool
   * never hangs. Default 120_000.
   */
  jobTimeoutMs?: number;
}

/** All-or-nothing parallel failure with per-chunk string diagnostics. */
export class GeosParallelError extends GeosError {
  readonly chunkErrors: Array<{ chunk: number; message: string }>;

  constructor(op: string, chunkErrors: Array<{ chunk: number; message: string }>) {
    const first = chunkErrors[0]!;
    super(op, `parallel ${op} failed in chunk ${first.chunk}: ${first.message}`);
    this.chunkErrors = chunkErrors;
  }
}

interface ChunkJob {
  msg: RunMessage;
  resolve: (r: FromWorker & { kind: "result" }) => void;
  reject: (e: Error) => void;
  /** Watchdog: a dispatched job must complete or the worker is reaped. */
  timer: ReturnType<typeof setTimeout> | null;
}

interface PoolWorker {
  worker: Worker;
  busy: ChunkJob | null;
  ready: boolean;
  jobs: ChunkJob[];
  /** Watchdog for workers that never become ready (spawn flake). */
  startupTimer: ReturnType<typeof setTimeout> | null;
  /** Watchdog window for jobs drained from this worker. */
  jobTimeoutMs: number;
}

const DEFAULT_MIN_CHUNK = 64;
const DEFAULT_CHUNK_FACTOR = 2;
const DEFAULT_JOB_TIMEOUT_MS = 120_000;

export class Parallel implements Disposable {
  readonly geos: Geos;
  #workers: PoolWorker[] = [];
  #desired: number;
  #nextId = 1;
  /** Tail of the single-flight chain for signal-taking ops (D23.4). */
  #signalChain: Promise<unknown> = Promise.resolve();
  #disposed = false;

  /** @internal — create via `geos.parallel`. */
  constructor(geos: Geos, size?: number) {
    this.geos = geos;
    const hw = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
    this.#desired = size ?? Math.max(1, Math.min(hw - 1, 8));
  }

  /** Current worker count (grows lazily on dispatch). */
  get size(): number {
    return this.#workers.length;
  }

  /** @internal — stall/crash diagnostics for tests and the bench harness. */
  debugState(): Array<{ ready: boolean; busy: boolean; queued: number }> {
    return this.#workers.map((w) => ({
      ready: w.ready,
      busy: w.busy !== null,
      queued: w.jobs.length,
    }));
  }

  #assertOpen(what: string): void {
    if (this.#disposed) {
      throw new TypeError(`bun-geos: parallel pool used after dispose (in ${what})`);
    }
    this.geos.assertOpen(what);
  }

  #spawn(): PoolWorker {
    const worker = new Worker(new URL("./worker.ts", import.meta.url));
    const pw: PoolWorker = {
      worker,
      busy: null,
      ready: false,
      jobs: [],
      startupTimer: null,
      jobTimeoutMs: DEFAULT_JOB_TIMEOUT_MS,
    };
    // Workers stay REF'D: an unref'd worker's message port is not guaranteed
    // to be polled on an otherwise-idle main loop (measured stall). Exit
    // hygiene comes from the dispose path — terminate() releases the
    // handles. CAVEAT (documented in the class docs): an UNDISPOSED pool
    // keeps the process alive — always dispose your Geos/pool, or run pool
    // work in a dedicated process (as bench/parallel.ts does).
    worker.on("message", (msg: FromWorker) => {
      if (msg.kind === "ready") {
        pw.ready = true;
        if (pw.startupTimer !== null) {
          clearTimeout(pw.startupTimer);
          pw.startupTimer = null;
        }
        this.#drain(pw, pw.jobTimeoutMs);
        return;
      }
      if (msg.kind === "bye") return;
      const job = pw.busy;
      pw.busy = null;
      this.#clearJobTimer(job);
      if (job !== null) {
        if (msg.kind === "result") job.resolve(msg);
        else job.reject(new Error(msg.geosMessage ?? msg.message));
      }
      this.#drain(pw, pw.jobTimeoutMs);
    });
    worker.on("error", (err: Error) => {
      this.#reapWorker(pw, `worker crashed: ${err.message}`);
    });
    // A worker can EXIT without an 'error' event (crash with a nonzero code,
    // engine-level IPC loss) — its busy/queued jobs would otherwise pend
    // forever. 'exit' is the authoritative liveness signal: reap the worker
    // and reject everything it holds.
    worker.on("exit", (code: number) => {
      this.#reapWorker(pw, `worker exited unexpectedly (code ${code})`);
    });
    // Startup watchdog (Bun 1.4.3 engine flake, D23: a spawned worker child
    // can die pre-handshake with no parent-side signal). If it never becomes
    // ready, reap it — #dispatch respawns on demand.
    pw.startupTimer = setTimeout(() => {
      this.#reapWorker(pw, "worker startup timed out (no ready signal)");
    }, DEFAULT_JOB_TIMEOUT_MS);
    this.#workers.push(pw);
    return pw;
  }

  #clearJobTimer(job: ChunkJob | null): void {
    if (job !== null && job.timer !== null) {
      clearTimeout(job.timer);
      job.timer = null;
    }
  }

  /** Reject everything a dead worker holds and drop it from rotation. */
  #reapWorker(pw: PoolWorker, reason: string): void {
    if (pw.startupTimer !== null) {
      clearTimeout(pw.startupTimer);
      pw.startupTimer = null;
    }
    const job = pw.busy;
    this.#clearJobTimer(job);
    pw.busy = null;
    const queued = [...pw.jobs];
    pw.jobs.length = 0;
    pw.ready = false;
    const i = this.#workers.indexOf(pw);
    if (i >= 0) this.#workers.splice(i, 1);
    try {
      void pw.worker.terminate();
    } catch {
      // already gone
    }
    const err = new GeosError("parallel", reason);
    if (job !== null) job.reject(err);
    for (const j of queued) j.reject(err);
  }

  /** Hand queued jobs to a worker (FIFO per worker), arming the watchdog. */
  #drain(pw: PoolWorker, jobTimeoutMs: number): void {
    while (pw.busy === null && pw.jobs.length > 0 && pw.ready) {
      const job = pw.jobs.shift()!;
      pw.busy = job;
      job.timer = setTimeout(() => {
        this.#reapWorker(
          pw,
          `worker job timed out after ${jobTimeoutMs}ms (op ${job.msg.op} id ${job.msg.id})`,
        );
      }, jobTimeoutMs);
      pw.worker.postMessage(job.msg, transferListOf(job.msg));
    }
  }

  #dispatch(msg: RunMessage, jobTimeoutMs: number): Promise<FromWorker & { kind: "result" }> {
    return new Promise((resolve, reject) => {
      const job: ChunkJob = { msg, resolve, reject, timer: null };
      let pw = this.#workers.find((w) => w.ready && w.busy === null);
      if (pw === undefined && this.#workers.length < this.#desired) pw = this.#spawn();
      if (pw === undefined) {
        // all workers busy: queue on the least-loaded one
        pw = this.#workers.reduce((a, b) => (a.jobs.length <= b.jobs.length ? a : b));
      }
      pw.jobTimeoutMs = jobTimeoutMs;
      pw.jobs.push(job);
      this.#drain(pw, jobTimeoutMs);
    });
  }

  /**
   * Dispose the pool: request shutdown, await every worker's ack (a
   * terminated worker skips its Geos disposal and leaks the C session —
   * the interrupt-worker lesson, promoted to the protocol), then terminate.
   * Idempotent. In-flight ops reject (their jobs die with the workers).
   */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const workers = this.#workers;
    this.#workers = [];
    for (const pw of workers) {
      if (pw.startupTimer !== null) {
        clearTimeout(pw.startupTimer);
        pw.startupTimer = null;
      }
      this.#clearJobTimer(pw.busy);
      for (const j of pw.jobs) this.#clearJobTimer(j);
    }
    // Shutdown-ack with a bounded wait (audited Risk 3): a worker that never
    // acks (engine flake) must not hang dispose — terminate unconditionally
    // after the grace period. The ack is the leak-safe path (the worker
    // disposes its own Geos first); the timeout trades that for liveness.
    const ACK_GRACE_MS = 5_000;
    const acks = workers.map((pw) =>
      Promise.race([
        new Promise<void>((resolve) => {
          const onMsg = (msg: FromWorker): void => {
            if (msg.kind === "bye") {
              pw.worker.removeListener("message", onMsg);
              resolve();
            }
          };
          pw.worker.on("message", onMsg);
          pw.worker.postMessage({ kind: "shutdown" } satisfies ToWorker);
        }),
        new Promise<void>((resolve) => setTimeout(resolve, ACK_GRACE_MS)),
      ]),
    );
    Promise.all(acks)
      .then(() => {
        for (const pw of workers) void pw.worker.terminate();
      })
      .catch(() => {
        // acks never arrived (worker crash) — terminate anyway
        for (const pw of workers) void pw.worker.terminate();
      });
  }

  dispose(): void {
    this[Symbol.dispose]();
  }

  // ------------------------------------------------------------ public API

  intersectionAll(a: Geometry, bs: BatchInput, opts?: ParallelOptions): Promise<Geometry[]> {
    return this.#runOverlay("intersectionAll", a, bs, opts);
  }
  differenceAll(a: Geometry, bs: BatchInput, opts?: ParallelOptions): Promise<Geometry[]> {
    return this.#runOverlay("differenceAll", a, bs, opts);
  }
  symDifferenceAll(a: Geometry, bs: BatchInput, opts?: ParallelOptions): Promise<Geometry[]> {
    return this.#runOverlay("symDifferenceAll", a, bs, opts);
  }

  intersectsAll(a: Geometry, bs: BatchInput, opts?: ParallelOptions): Promise<Uint8Array> {
    return this.#runMask("intersects", a, bs, opts);
  }
  containsAll(a: Geometry, bs: BatchInput, opts?: ParallelOptions): Promise<Uint8Array> {
    return this.#runMask("contains", a, bs, opts);
  }
  coveredByAll(a: Geometry, bs: BatchInput, opts?: ParallelOptions): Promise<Uint8Array> {
    return this.#runMask("coveredBy", a, bs, opts);
  }
  coversAll(a: Geometry, bs: BatchInput, opts?: ParallelOptions): Promise<Uint8Array> {
    return this.#runMask("covers", a, bs, opts);
  }
  crossesAll(a: Geometry, bs: BatchInput, opts?: ParallelOptions): Promise<Uint8Array> {
    return this.#runMask("crosses", a, bs, opts);
  }
  disjointAll(a: Geometry, bs: BatchInput, opts?: ParallelOptions): Promise<Uint8Array> {
    return this.#runMask("disjoint", a, bs, opts);
  }
  overlapsAll(a: Geometry, bs: BatchInput, opts?: ParallelOptions): Promise<Uint8Array> {
    return this.#runMask("overlaps", a, bs, opts);
  }
  touchesAll(a: Geometry, bs: BatchInput, opts?: ParallelOptions): Promise<Uint8Array> {
    return this.#runMask("touches", a, bs, opts);
  }
  withinAll(a: Geometry, bs: BatchInput, opts?: ParallelOptions): Promise<Uint8Array> {
    return this.#runMask("within", a, bs, opts);
  }

  areaAll(gs: BatchInput, opts?: ParallelOptions): Promise<Float64Array> {
    return this.#runMeasure("areaAll", null, gs, opts);
  }
  lengthAll(gs: BatchInput, opts?: ParallelOptions): Promise<Float64Array> {
    return this.#runMeasure("lengthAll", null, gs, opts);
  }
  distanceAll(a: Geometry, bs: BatchInput, opts?: ParallelOptions): Promise<Float64Array> {
    return this.#runMeasure("distanceAll", a, bs, opts);
  }
  hausdorffAll(a: Geometry, bs: BatchInput, opts?: ParallelOptions): Promise<Float64Array> {
    return this.#runMeasure("hausdorffAll", a, bs, opts);
  }
  frechetAll(a: Geometry, bs: BatchInput, opts?: ParallelOptions): Promise<Float64Array> {
    return this.#runMeasure("frechetAll", a, bs, opts);
  }

  bufferAll(
    gs: BatchInput,
    distance: number,
    opts?: ParallelOptions & BufferOptions,
  ): Promise<Geometry[]> {
    return this.#runGeometryOp(
      "bufferAll",
      null,
      gs,
      {
        distance,
        quadSegs: opts?.quadSegs,
        join: opts?.join,
        mitreLimit: opts?.mitreLimit,
        singleSided: opts?.singleSided,
      },
      opts,
    );
  }

  makeValid(gs: BatchInput, opts?: ParallelOptions): Promise<Geometry[]> {
    return this.#runGeometryOp("makeValid", null, gs, {}, opts);
  }

  /**
   * Parallel union: per-chunk `unionAll(strategy)` in the workers, then ONE
   * final `unionAll(disjointSubset)` over the chunk results on the calling
   * thread (correct for any input). A valid union — but for chunks > 1
   * bitwise identity with the main-thread `geos.unionAll` is NOT guaranteed
   * (union is order-sensitive at float level; D23.6).
   */
  unionAll(
    gs: BatchInput,
    opts?: ParallelOptions & { strategy?: "auto" | "coverage" | "disjointSubset" | "unary" },
  ): Promise<Geometry> {
    this.#assertOpen("unionAll");
    if (Array.isArray(gs) && gs.length === 0) {
      throw new RangeError("unionAll: needs at least one geometry");
    }
    const mergedP = this.#enqueueWithSignal(opts?.signal, () =>
      this.#runChunks<Geometry[]>(
        "unionAll",
        null,
        gs,
        { strategy: opts?.strategy },
        opts,
        async (parts) => {
          // each chunk's union arrives as a one-element fromWKBMany result;
          // the final reduce is ONE main-thread unionAll crossing (D23.6)
          const unions = parts.map((p) => p[0]!);
          try {
            const merged = this.geos.unionAll(unions, { strategy: "disjointSubset" });
            return [merged];
          } finally {
            // the intermediates die even if the reduce throws (audited Risk 6)
            for (const p of unions) p.dispose();
          }
        },
      ),
    );
    return mergedP.then((arr) => arr[0]!);
  }

  // ------------------------------------------------------------- internals

  #runOverlay(
    op: "intersectionAll" | "differenceAll" | "symDifferenceAll",
    a: Geometry,
    bs: BatchInput,
    opts?: ParallelOptions,
  ): Promise<Geometry[]> {
    this.#assertOpen(op);
    a.requireSame(this.geos);
    return this.#enqueueWithSignal(opts?.signal, () =>
      this.#runChunks<Geometry[]>(op, a, bs, {}, opts, async (parts) => parts.flat()),
    );
  }

  #runMask(pred: string, a: Geometry, bs: BatchInput, opts?: ParallelOptions): Promise<Uint8Array> {
    const op = `pred:${pred}` as ParallelOp;
    this.#assertOpen(op);
    a.requireSame(this.geos);
    return this.#enqueueWithSignal(opts?.signal, () =>
      this.#runChunks<Uint8Array>(op, a, bs, {}, opts, async (masks) => {
        const out = new Uint8Array(masks.reduce((n, m) => n + m.length, 0));
        let off = 0;
        for (const m of masks) {
          out.set(m, off);
          off += m.length;
        }
        return out;
      }),
    );
  }

  #runMeasure(
    op: "areaAll" | "lengthAll" | "distanceAll" | "hausdorffAll" | "frechetAll",
    a: Geometry | null,
    bs: BatchInput,
    opts?: ParallelOptions,
  ): Promise<Float64Array> {
    this.#assertOpen(op);
    if (a !== null) a.requireSame(this.geos);
    return this.#enqueueWithSignal(opts?.signal, () =>
      this.#runChunks<Float64Array>(op, a, bs, {}, opts, async (values) => {
        const out = new Float64Array(values.reduce((n, v) => n + v.length, 0));
        let off = 0;
        for (const v of values) {
          out.set(v, off);
          off += v.length;
        }
        return out;
      }),
    );
  }

  #runGeometryOp(
    op: "bufferAll" | "makeValid",
    a: Geometry | null,
    bs: BatchInput,
    params: Record<string, unknown>,
    opts?: ParallelOptions,
  ): Promise<Geometry[]> {
    this.#assertOpen(op);
    if (a !== null) a.requireSame(this.geos);
    return this.#enqueueWithSignal(opts?.signal, () =>
      this.#runChunks<Geometry[]>(op, a, bs, params, opts, async (parts) => parts.flat()),
    );
  }

  /**
   * Single-flight gate + abort plumbing (D23.4): pre-check, listener that
   * flips the global flag from the FREE main thread, uniform aborted shape,
   * flag reset in finally. At most one signal-taking op runs at a time;
   * the rest queue on `#signalChain`.
   */
  #enqueueWithSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    if (signal === undefined) return fn();
    if (signal.aborted) throw abortError(signal);
    const prev = this.#signalChain;
    let release: () => void = () => {};
    this.#signalChain = new Promise<void>((r) => {
      release = r;
    });
    return prev.then(async () => {
      const request = (): void => {
        this.geos.native.shim.geos_shim_interrupt_request();
      };
      signal.addEventListener("abort", request, { once: true });
      try {
        return await fn();
      } catch (err) {
        // Uniform aborted shape (D19): the underlying GeosError (with its
        // GEOS message — typically "interrupted by request" surfaced from
        // the worker) is preserved as `cause`.
        if (signal.aborted && err instanceof GeosError) throw abortError(signal, err);
        throw err;
      } finally {
        // Hygiene (D19): reset even on success — a stale flip must not
        // poison the next op. Safe: no other signal-taking op is running.
        this.geos.native.shim.geos_shim_interrupt_reset();
        signal.removeEventListener("abort", request);
        release();
      }
    });
  }

  /**
   * Normalize inputs (Arrow input builds here, transiently), then either
   * run on this thread (small batches) or chunk + dispatch + reassemble.
   *
   * The arena handoff (audited C1): the callback runs INSIDE the transient
   * normalization arena, so the only things it may do with `gs` are
   * consume-and-serialize (launch) or run the small-batch op with outputs
   * explicitly registered into `outArena` (the caller's arena, captured
   * before the transient one opened). Result MATERIALIZATION — reading the
   * workers' WKB back into geometries — happens in `#collectResults`, after
   * this method's arena closed, so outputs default to the caller's context
   * and can never be freed by the transient teardown.
   */
  #runChunks<T>(
    op: ParallelOp,
    a: Geometry | null,
    bs: BatchInput,
    params: Record<string, unknown>,
    opts: ParallelOptions | undefined,
    merge: (parts: T[]) => Promise<T>,
  ): Promise<T> {
    return withBatchInputsAsync(this.geos, bs, `parallel.${op}`, async (gs) => {
      this.#validateChunking(opts);
      const minChunkGeoms = opts?.minChunkGeoms ?? DEFAULT_MIN_CHUNK;
      if (gs.length < minChunkGeoms * 2) {
        // Small-batch fast path: the pool overhead (WKB both ways plus
        // message traffic) dominates — delegate to the verified synchronous
        // main-thread API with the RAW input. Safe to re-enter here because
        // the pool's input arena is UNPUSHED (withBatchInputsAsync): nested
        // currentArena() captures resolve to the caller's context, never to
        // the pool's transient arena (audited C1).
        return { local: true as const, result: this.#runLocal<T>(op, a, bs, params, gs) };
      }
      const { pending } = await this.#launchChunks(op, a, gs, params, opts);
      return { local: false as const, pending };
    }).then((launched) => {
      if (launched.local) return launched.result;
      return this.#collectResults<T>(op, launched.pending, merge);
    });
  }

  /** Chunking tunables are user-facing — reject nonsense up front. */
  #validateChunking(opts: ParallelOptions | undefined): void {
    const min = opts?.minChunkGeoms;
    const factor = opts?.chunkFactor;
    if (min !== undefined && (!Number.isInteger(min) || min < 1)) {
      throw new RangeError(`bun-geos: minChunkGeoms must be a positive integer, got ${min}`);
    }
    if (factor !== undefined && (!Number.isFinite(factor) || factor < 1)) {
      throw new RangeError(`bun-geos: chunkFactor must be ≥ 1, got ${factor}`);
    }
  }

  /** Calling-thread execution for small batches (same op table, main API). */
  #runLocal<T>(
    op: ParallelOp,
    a: Geometry | null,
    bs: BatchInput,
    params: Record<string, unknown>,
    gs?: readonly Geometry[],
  ): T {
    const g = this.geos;
    switch (op) {
      case "intersectionAll":
        return g.intersectionAll(a!, bs) as T;
      case "differenceAll":
        return g.differenceAll(a!, bs) as T;
      case "symDifferenceAll":
        return g.symDifferenceAll(a!, bs) as T;
      case "unionAll": {
        // T at this call site is Geometry[] (per-chunk shape) even on the
        // local path — wrap the single union so unionAll's tail (arr[0])
        // resolves (audited N2: the bare Geometry read as undefined)
        const u = g.unionAll(gs ?? (bs as readonly Geometry[]), {
          strategy: params.strategy as UnionStrategyOpt,
        }) as Geometry;
        return [u] as T;
      }
      case "bufferAll": {
        const p = params as unknown as { distance: number } & BufferOptions;
        return g.bufferAll(bs, p.distance, p) as T;
      }
      case "makeValid": {
        // per-item repair — needs the item array (normalized for Arrow input
        // via the callback's `gs`; `bs` already carries it for Geometry[])
        const items = gs ?? (bs as readonly Geometry[]);
        return items.map((x) => g.makeValid(x)) as T;
      }
      case "areaAll":
        return g.areaAll(bs) as T;
      case "lengthAll":
        return g.lengthAll(bs) as T;
      case "distanceAll":
        return g.distanceAll(a!, bs) as T;
      case "hausdorffAll":
        return g.hausdorffAll(a!, bs) as T;
      case "frechetAll":
        return g.frechetAll(a!, bs) as T;
      default: {
        if (!op.startsWith("pred:")) throw new Error(`unknown parallel op ${op}`);
        return g.predicateAll(op.slice(5) as Parameters<Geos["predicateAll"]>[0], a!, bs) as T;
      }
    }
  }

  /**
   * Pipelined launch (D23): serialize chunk-by-chunk, yielding between
   * chunks so workers compute while the main thread serializes the next
   * one. Serializing everything upfront idles the pool for the whole
   * serialization window (~360ms at 10⁵ geoms — measured as the cap that
   * kept the ≥5× parallel axis at ~4×). Resolves once EVERY chunk's WKB is
   * built and dispatched — i.e. `gs` is fully consumed and the caller's
   * transient input arena may close.
   */
  async #launchChunks(
    op: ParallelOp,
    a: Geometry | null,
    gs: readonly Geometry[],
    params: Record<string, unknown>,
    opts: ParallelOptions | undefined,
  ): Promise<{ pending: Array<Promise<FromWorker & { kind: "result" }>> }> {
    this.#assertOpen(op);
    const chunks = this.#chunkByVertices(
      gs,
      opts?.chunkFactor ?? DEFAULT_CHUNK_FACTOR,
      opts?.minChunkGeoms ?? DEFAULT_MIN_CHUNK,
    );
    const aWkb = a !== null ? bufferOf(this.geos.toWKB(a)) : undefined;

    const pending: Array<Promise<FromWorker & { kind: "result" }>> = [];
    const yields: Array<Promise<void>> = [];
    for (const range of chunks) {
      const slice = gs.slice(range[0], range[1]);
      // ONE writer per chunk (wkbManyBytes) — per-geom writer create/destroy
      // was the serialization floor of the ≥5× axis (D23 note)
      const { buf, offsets } = wkbManyBytes(this.geos, slice);
      const msg: RunMessage = {
        kind: "run",
        id: this.#nextId++,
        op,
        wkb: buf.buffer as ArrayBuffer,
        offsets,
        params,
      };
      if (aWkb !== undefined) msg.aWkb = aWkb.slice(0);
      pending.push(this.#dispatch(msg, opts?.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS));
      // yield: let ready workers receive the just-posted job and start
      // computing before the next synchronous serialization stretch
      yields.push(new Promise<void>((resolve) => setImmediate(resolve)));
    }
    for (const y of yields) await y;
    return { pending };
  }

  /**
   * Materialize results AFTER the transient input arena closed (audited C1):
   * `fromWKBMany` and the final reduce register into the caller's context —
   * never into an arena that is already gone. All-or-nothing with per-chunk
   * diagnostics (D23.5): every failure is collected, the whole op rejects
   * with one GeosParallelError.
   */
  async #collectResults<T>(
    op: ParallelOp,
    pending: Array<Promise<FromWorker & { kind: "result" }>>,
    merge: (parts: T[]) => Promise<T>,
  ): Promise<T> {
    const settled = await Promise.allSettled(
      pending.map(async (p): Promise<T> => {
        const r = await p;
        if (r.wkb !== undefined && r.offsets !== undefined) {
          return this.geos.fromWKBMany(new Uint8Array(r.wkb), r.offsets) as T;
        }
        if (r.mask !== undefined) return r.mask as T;
        if (r.values !== undefined) return r.values as T;
        throw new GeosError(`parallel.${op}`, "worker returned no payload");
      }),
    );
    // All-or-nothing with per-chunk diagnostics (D23.5): every failure is
    // collected, the whole op rejects with one GeosParallelError.
    const results: T[] = new Array(pending.length);
    const failures: Array<{ chunk: number; message: string }> = [];
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i]!;
      if (s.status === "fulfilled") {
        results[i] = s.value;
      } else {
        const reason = s.reason;
        failures.push({
          chunk: i,
          message: reason instanceof Error ? reason.message : String(reason),
        });
      }
    }
    if (failures.length > 0) throw new GeosParallelError(`parallel.${op}`, failures);
    return merge(results);
  }

  /**
   * Chunk boundaries by cumulative vertex count (concurrency.md §4): one
   * `num_points_many` crossing for the weights, cuts in input order,
   * ~`chunkFactor × workers` chunks, never below `minChunkGeoms` items.
   */
  #chunkByVertices(
    gs: readonly Geometry[],
    chunkFactor: number,
    minChunkGeoms: number,
  ): Array<[number, number]> {
    const n = gs.length;
    const ptrs = geomPtrArray(this.geos, gs, "parallel chunking");
    const weights = new Uint32Array(n);
    const r = this.geos.native.shim.geos_shim_num_points_many(this.geos.shim, ptrs, n, weights);
    if (r !== 0) throw this.geos.fail("geos_shim_num_points_many");
    const desired = Math.max(1, Math.round(this.#desired * chunkFactor));
    const totalVerts = weights.reduce((a, b) => a + b, 0);
    const targetVerts = Math.max(1, Math.ceil(totalVerts / desired));
    const ranges: Array<[number, number]> = [];
    let start = 0;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += weights[i]!;
      const bigEnough = i - start + 1 >= minChunkGeoms;
      const tail = n - i <= minChunkGeoms; // don't leave a sliver tail
      if (acc >= targetVerts && (bigEnough || tail)) {
        ranges.push([start, i + 1]);
        start = i + 1;
        acc = 0;
      }
    }
    if (start < n) ranges.push([start, n]);
    return ranges;
  }
}

type UnionStrategyOpt = "auto" | "coverage" | "disjointSubset" | "unary";

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function transferListOf(msg: RunMessage): ArrayBuffer[] {
  const transfer: ArrayBuffer[] = [msg.wkb];
  if (msg.aWkb !== undefined) transfer.push(msg.aWkb);
  return transfer;
}
