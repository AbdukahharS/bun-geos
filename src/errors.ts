/**
 * Error model (D13): programming errors throw `TypeError`/`RangeError`;
 * data and GEOS failures throw `GeosError` carrying the captured GEOS
 * message, the operation name, and (where known) structural detail.
 */
import type { ShimPtr } from "./types.ts";

/** Structural context attached to data errors (D13 / io.md §7). */
export interface GeosErrorDetail {
  ring?: number;
  vertex?: number;
  byteOffset?: number;
  jsonPath?: string;
}

/**
 * Repair-op diagnostics (D21): the invalidity details of a failed repair /
 * strict op, as STRINGS — an exception must not own C resources (a geometry
 * field on a thrown error is a disposal footgun). `locationWKT` is the
 * `GEOSisValidDetail_r` location, `simpleLocationsWKT` the
 * `GEOSisSimpleDetail_r` MULTIPOINT of non-simple nodes (WKT).
 */
export interface GeosErrorDiagnostics {
  validReason?: string;
  locationWKT?: string;
  simpleLocationsWKT?: string;
}

export class GeosError extends Error {
  readonly op: string;
  readonly geosMessage?: string;
  readonly detail?: GeosErrorDetail;
  readonly diagnostics?: GeosErrorDiagnostics;

  constructor(
    op: string,
    geosMessage?: string,
    detail?: GeosErrorDetail,
    opts?: { cause?: unknown; diagnostics?: GeosErrorDiagnostics },
  ) {
    const msg = geosMessage ? `GEOS ${op} failed: ${geosMessage}` : `GEOS ${op} failed`;
    // Only install an error `cause` when one was given — `{ cause: undefined }`
    // would add a meaningless own property to every GeosError.
    super(
      detail ? `${msg} (${formatDetail(detail)})` : msg,
      opts?.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = "GeosError";
    this.op = op;
    if (geosMessage !== undefined) this.geosMessage = geosMessage;
    if (detail !== undefined) this.detail = detail;
    if (opts?.diagnostics !== undefined) this.diagnostics = opts.diagnostics;
  }
}

function formatDetail(detail: GeosErrorDetail): string {
  const parts: string[] = [];
  if (detail.jsonPath !== undefined) parts.push(`at ${detail.jsonPath}`);
  if (detail.ring !== undefined) parts.push(`ring ${detail.ring}`);
  if (detail.vertex !== undefined) parts.push(`vertex ${detail.vertex}`);
  if (detail.byteOffset !== undefined) parts.push(`byte ${detail.byteOffset}`);
  return parts.join(", ");
}

/** Native library loading / environment failures (loader.ts). */
export class LoaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoaderError";
  }
}

/**
 * Build the canonical `GeosError` for a failed GEOS call: read (and consume)
 * the thread-local message captured by the shim. If GEOS somehow failed
 * without leaving a message, say so rather than inventing text.
 */
export function lastError(
  shimApi: { geos_shim_last_error: (shim: ShimPtr) => string | null },
  shim: ShimPtr,
  op: string,
): GeosError {
  const msg = shimApi.geos_shim_last_error(shim);
  return new GeosError(op, msg ?? "(GEOS reported failure without a message)");
}
