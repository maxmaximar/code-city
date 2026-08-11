import type { CityData } from "../../../ingest/types.js";

export interface ManifestEntry {
  slug: string;
  repoName: string;
  repoUrl: string;
  /** false when this entry was written by an older layout and must be rebuilt */
  stale?: boolean;
  /** the dataset file is gone; the entry is a memory, not a city */
  missing?: boolean;
  schema?: number;
  lots: number;
  standing: number;
  districts: number;
  frames: number;
  commits: number;
  files: number;
  lines: number;
  sampled: boolean;
  generatedAt: number;
}

export interface Manifest {
  default: string | null;
  repos: ManifestEntry[];
}

/** A dataset the server refused to serve, with why and whether it can be fixed. */
export class CityLoadError extends Error {
  readonly fault: string;
  readonly recoverable: boolean;
  readonly slug: string;
  readonly repoUrl: string | null;

  constructor(slug: string, message: string, fault: string, recoverable: boolean, repoUrl: string | null) {
    super(message);
    this.name = "CityLoadError";
    this.slug = slug;
    this.fault = fault;
    this.recoverable = recoverable;
    this.repoUrl = repoUrl;
  }
}

export interface Progress {
  stage: string;
  detail: string;
  pct: number;
}

export interface AnalyzeHandlers {
  onProgress(p: Progress): void;
  onDone(result: { slug: string; fromCache: boolean; ms: number }): void;
  onError(message: string): void;
}

export async function getManifest(): Promise<Manifest> {
  const res = await fetch("/api/manifest");
  if (!res.ok) return { default: null, repos: [] };
  return res.json();
}

export async function getCity(slug: string, repoUrl: string | null = null): Promise<CityData> {
  let res: Response;
  try {
    res = await fetch(`/api/data/${encodeURIComponent(slug)}`);
  } catch {
    throw new CityLoadError(slug, "the local analyzer is not responding — is `bun run dev` still running?", "offline", false, repoUrl);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      fault?: string;
      recoverable?: boolean;
    };
    throw new CityLoadError(
      slug,
      body.error ?? `could not load ${slug}`,
      body.fault ?? "unknown",
      body.recoverable ?? res.status === 409,
      repoUrl,
    );
  }

  // The server already validated the shape; parsing is the only thing left that
  // can fail here, and it should fail by name like everything else.
  try {
    return (await res.json()) as CityData;
  } catch {
    throw new CityLoadError(slug, "the stored city is not valid JSON", "unreadable", true, repoUrl);
  }
}

/**
 * Kicks off an ingest and streams its real stages back. Progress here is the
 * pipeline's own reporting — never a timer pretending to be work.
 */
export function analyze(
  url: string,
  options: { resync?: boolean; force?: boolean; rebuild?: boolean },
  handlers: AnalyzeHandlers,
): { cancel(): void } {
  let source: EventSource | null = null;
  let cancelled = false;

  void (async () => {
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, ...options }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "the analyzer refused that url");
      if (cancelled) return;

      source = new EventSource(`/api/jobs/${encodeURIComponent(body.jobId)}`);
      source.addEventListener("progress", (e) => {
        handlers.onProgress(JSON.parse((e as MessageEvent).data));
      });
      source.addEventListener("done", (e) => {
        source?.close();
        handlers.onDone(JSON.parse((e as MessageEvent).data));
      });
      source.addEventListener("error", (e) => {
        const data = (e as MessageEvent).data;
        source?.close();
        if (data) handlers.onError(JSON.parse(data).message ?? "ingest failed");
        else handlers.onError("lost the connection to the local analyzer");
      });
    } catch (err) {
      if (!cancelled) handlers.onError(err instanceof Error ? err.message : String(err));
    }
  })();

  return {
    cancel() {
      cancelled = true;
      source?.close();
    },
  };
}

/** `https://github.com/a/b` · `a/b` · `git@github.com:a/b.git` → a display name */
export function repoLabel(input: string): string {
  const m = input.trim().match(/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]} / ${m[2]}` : input.trim();
}
