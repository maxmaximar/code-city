import { SCHEMA_VERSION, type CityData } from "./types.js";

/**
 * The single validation boundary between the ingest, the cache on disk and the
 * renderer.
 *
 * Everything that loads a dataset — the API, the viewer, the tools — goes
 * through here, so a dataset written by an older version of the layout can
 * never reach the renderer and fail with something like
 * "data.blocks is not iterable". It fails here instead, by name, with a reason
 * a person can act on.
 */

export type CityDataFault =
  | "not-an-object"
  | "stale-schema"
  | "missing-meta"
  | "missing-districts"
  | "missing-blocks"
  | "missing-buildings"
  | "missing-frames"
  | "missing-final"
  | "missing-languages"
  | "inconsistent-final"
  | "dangling-block"
  | "dangling-district";

export class CityDataError extends Error {
  readonly fault: CityDataFault;
  /** the dataset can be rebuilt from the cached clone — offer a re-analyze */
  readonly recoverable: boolean;
  readonly slug: string;

  constructor(fault: CityDataFault, slug: string, message: string, recoverable = true) {
    super(message);
    this.name = "CityDataError";
    this.fault = fault;
    this.slug = slug;
    this.recoverable = recoverable;
  }
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Throws `CityDataError` unless `value` is a dataset this build can render.
 * Cheap: shape and cross-reference checks only, not a walk of 20,000 buildings.
 */
export function validateCityData(value: unknown, slug = "?"): CityData {
  const fail = (fault: CityDataFault, message: string, recoverable = true): never => {
    throw new CityDataError(fault, slug, message, recoverable);
  };

  if (!value || typeof value !== "object") {
    return fail("not-an-object", "the dataset is not an object", false);
  }

  const data = value as Partial<CityData>;

  if (!data.meta || typeof data.meta !== "object") {
    return fail("missing-meta", "the dataset has no metadata block");
  }

  const schema = (data.meta as { schema?: unknown }).schema;
  if (schema !== SCHEMA_VERSION) {
    return fail(
      "stale-schema",
      `this city was built by an older version of CodeCity (schema ${
        typeof schema === "number" ? schema : "unknown"
      }, this build reads ${SCHEMA_VERSION}) — re-analyze the repository to rebuild it`,
    );
  }

  if (!isArray(data.districts) || data.districts.length === 0) {
    return fail("missing-districts", "the dataset has no districts");
  }
  if (!isArray(data.blocks)) return fail("missing-blocks", "the dataset has no city blocks");
  if (!isArray(data.buildings)) return fail("missing-buildings", "the dataset has no buildings");
  if (!isArray(data.frames) || data.frames.length === 0) {
    return fail("missing-frames", "the dataset has no timeline frames");
  }
  if (!isArray(data.languages)) return fail("missing-languages", "the dataset has no language table");

  const final = data.final as { h?: unknown; t?: unknown } | undefined;
  if (!final || !isArray(final.h) || !isArray(final.t)) {
    return fail("missing-final", "the dataset has no final-state arrays");
  }
  if (final.h.length !== data.buildings.length || final.t.length !== data.buildings.length) {
    return fail(
      "inconsistent-final",
      `final state covers ${final.h.length} buildings but the city has ${data.buildings.length}`,
    );
  }

  // Cross-references, sampled rather than exhaustive: a broken layout is broken
  // everywhere, and a full scan of a 50k-building city on every load is waste.
  const step = Math.max(1, Math.floor(data.buildings.length / 512));
  for (let i = 0; i < data.buildings.length; i += step) {
    const b = data.buildings[i] as { d?: number; k?: number };
    if (typeof b?.d !== "number" || b.d < 0 || b.d >= data.districts.length) {
      return fail("dangling-district", `building ${i} points at district ${String(b?.d)}`);
    }
    if (typeof b.k !== "number" || b.k < 0 || b.k >= data.blocks.length) {
      return fail("dangling-block", `building ${i} points at block ${String(b.k)}`);
    }
  }

  return data as CityData;
}

/** A manifest entry can be listed without being loadable; this says which. */
export function isRenderable(schema: unknown): boolean {
  return schema === SCHEMA_VERSION;
}
