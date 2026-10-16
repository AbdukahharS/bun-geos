/**
 * geos.parallel worker entry (D23). One Worker = one JS thread = one Geos
 * context (D3). The native library was already dlopened on the main thread
 * before this Worker spawned (D11 preload rule — the pool is created lazily
 * on first use), so this import's dlopen is a refcount no-op.
 *
 * A chunk arrives as WKB + byte offsets; the worker rebuilds, runs the
 * batch op in one shim crossing (or the per-item op inside its own thread),
 * and ships results back — geometry results as WKB (transferred), masks and
 * measure values as typed arrays. All failures are STRING messages (D21:
 * no C resources inside errors).
 */
import { parentPort } from "node:worker_threads";
import { Geos } from "../index.ts";
import { wkbManyBytes } from "../io/wkb.ts";
import type {
  BufferParams,
  FromWorker,
  ResultMessage,
  RunMessage,
  ToWorker,
  UnionParams,
} from "./protocol.ts";

if (parentPort === null) {
  // Never spawn this file as the main module.
  throw new Error("bun-geos: parallel worker started outside a Worker");
}

const port = parentPort;
const geos = new Geos();

function serializeGeoms(gs: import("../index.ts").Geometry[]): {
  wkb: ArrayBuffer;
  offsets: Uint32Array;
} {
  // ONE writer for the whole result batch (wkbManyBytes, Phase 3)
  const bytes = wkbManyBytes(geos, gs);
  return { wkb: bytes.buf.buffer as ArrayBuffer, offsets: bytes.offsets };
}

function runChunk(msg: RunMessage): ResultMessage {
  using _arena = geos.arena(); // chunk inputs + intermediates freed on exit
  const gs = geos.fromWKBMany(new Uint8Array(msg.wkb), msg.offsets);
  const result: ResultMessage = { kind: "result", id: msg.id };
  switch (msg.op) {
    case "intersectionAll":
    case "differenceAll":
    case "symDifferenceAll": {
      if (msg.aWkb === undefined) throw new Error(`${msg.op} needs a reference geometry`);
      using a = geos.fromWKB(new Uint8Array(msg.aWkb));
      const outs =
        msg.op === "intersectionAll"
          ? geos.intersectionAll(a, gs)
          : msg.op === "differenceAll"
            ? geos.differenceAll(a, gs)
            : geos.symDifferenceAll(a, gs);
      const ser = serializeGeoms(outs);
      result.wkb = ser.wkb;
      result.offsets = ser.offsets;
      break;
    }
    case "unionAll": {
      const params = (msg.params ?? {}) as UnionParams;
      const u = params.strategy
        ? geos.unionAll(gs, { strategy: params.strategy })
        : geos.unionAll(gs);
      const ser = serializeGeoms([u]);
      result.wkb = ser.wkb;
      result.offsets = ser.offsets;
      break;
    }
    case "bufferAll": {
      const p = (msg.params ?? {}) as unknown as BufferParams;
      const opts: import("../index.ts").BufferAllOptions = {};
      if (p.quadSegs !== undefined) opts.quadSegs = p.quadSegs;
      if (p.join !== undefined) opts.join = p.join;
      if (p.mitreLimit !== undefined) opts.mitreLimit = p.mitreLimit;
      if (p.singleSided !== undefined) opts.singleSided = p.singleSided;
      const outs = geos.bufferAll(gs, p.distance, opts);
      const ser = serializeGeoms(outs);
      result.wkb = ser.wkb;
      result.offsets = ser.offsets;
      break;
    }
    case "makeValid": {
      // per-item repair — the loop lives in this worker thread, which is
      // the point of the pool: the WORK parallelizes, not the crossing.
      const outs = gs.map((g) => geos.makeValid(g));
      const ser = serializeGeoms(outs);
      result.wkb = ser.wkb;
      result.offsets = ser.offsets;
      break;
    }
    case "areaAll":
      result.values = geos.areaAll(gs);
      break;
    case "lengthAll":
      result.values = geos.lengthAll(gs);
      break;
    case "distanceAll":
    case "hausdorffAll":
    case "frechetAll": {
      if (msg.aWkb === undefined) throw new Error(`${msg.op} needs a reference geometry`);
      using a = geos.fromWKB(new Uint8Array(msg.aWkb));
      if (msg.op === "distanceAll") result.values = geos.distanceAll(a, gs);
      else if (msg.op === "hausdorffAll") result.values = geos.hausdorffAll(a, gs);
      else result.values = geos.frechetAll(a, gs);
      break;
    }
    default: {
      if (!msg.op.startsWith("pred:")) throw new Error(`unknown parallel op ${msg.op}`);
      const pred = msg.op.slice(5) as Parameters<Geos["predicateAll"]>[0];
      if (msg.aWkb === undefined) throw new Error(`${msg.op} needs a reference geometry`);
      using a = geos.fromWKB(new Uint8Array(msg.aWkb));
      result.mask = geos.predicateAll(pred, a, gs);
    }
  }
  return result;
}

port.on("message", (msg: ToWorker) => {
  if (msg.kind === "shutdown") {
    geos.dispose();
    port.postMessage({ kind: "bye" } satisfies FromWorker);
    port.close();
    return;
  }
  // run — errors are stringified back; the chunk is all-or-nothing (D22)
  try {
    const result = runChunk(msg);
    const transfer: ArrayBuffer[] = [];
    if (result.wkb !== undefined) transfer.push(result.wkb);
    port.postMessage(result, transfer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const geosMessage =
      err instanceof Error && "geosMessage" in err
        ? String((err as { geosMessage?: unknown }).geosMessage ?? "")
        : "";
    const out: FromWorker = {
      kind: "error",
      id: msg.id,
      message,
      ...(geosMessage ? { geosMessage } : {}),
    };
    port.postMessage(out);
  }
});

port.postMessage({ kind: "ready" } satisfies FromWorker);
