/**
 * geos.parallel message protocol (D23) — shared by the pool (main thread)
 * and the worker entry. Pure data shapes; no Geos imports so both sides can
 * pull it in cheaply.
 *
 * Transfer currency (D23.2): WKB. Geometries never cross workers (D11) —
 * inputs cross as one WKB buffer + byte offsets per chunk, results come
 * back the same way; masks/measures cross as typed arrays. ArrayBuffers
 * travel via postMessage transfer lists (zero-copy).
 */

export type ParallelOp =
  | "intersectionAll"
  | "differenceAll"
  | "symDifferenceAll"
  | "unionAll"
  | "bufferAll"
  | "makeValid"
  | "areaAll"
  | "lengthAll"
  | "distanceAll"
  | "hausdorffAll"
  | "frechetAll"
  // predicate masks — one op name per predicate
  | `pred:${string}`;

/** main → worker: run one chunk of one op. */
export interface RunMessage {
  kind: "run";
  /** pool-assigned job id */
  id: number;
  op: ParallelOp;
  /** reference geometry (WKB), when the op is binary */
  aWkb?: ArrayBuffer;
  /** chunk inputs: one WKB buffer + end-byte offsets per geometry */
  wkb: ArrayBuffer;
  offsets: Uint32Array;
  /** op params (structured-cloneable): buffer distance/options, union strategy */
  params?: Record<string, unknown>;
}

/** main → worker: finish the session (ack before terminate — F9/D23.1). */
export interface ShutdownMessage {
  kind: "shutdown";
}

/** worker → main: session ready (its Geos is constructed). */
export interface ReadyMessage {
  kind: "ready";
}

/** worker → main: shutdown ack (the pool may now terminate safely). */
export interface ByeMessage {
  kind: "bye";
}

export interface BufferParams {
  distance: number;
  quadSegs?: number;
  join?: "round" | "mitre" | "bevel";
  mitreLimit?: number;
  singleSided?: boolean;
}

export interface UnionParams {
  strategy?: "auto" | "coverage" | "disjointSubset" | "unary";
}

/** worker → main: chunk succeeded. Buffers arrive transferred. */
export interface ResultMessage {
  kind: "result";
  id: number;
  /** geometry results (overlay/buffer/makeValid/unionAll): one WKB buffer */
  wkb?: ArrayBuffer;
  offsets?: Uint32Array;
  /** predicate masks */
  mask?: Uint8Array;
  /** measure values */
  values?: Float64Array;
}

/** worker → main: chunk failed (message strings only — D21). */
export interface ErrorMessage {
  kind: "error";
  id: number;
  message: string;
  geosMessage?: string;
}

export type ToWorker = RunMessage | ShutdownMessage;
export type FromWorker = ReadyMessage | ByeMessage | ResultMessage | ErrorMessage;
