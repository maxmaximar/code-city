/**
 * Thin local API in front of the ingest pipeline. The browser cannot run
 * `git clone`, so the paste-a-URL flow needs something on this side of the
 * wire — this is it, and nothing more: no database, no auth, no accounts.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingest, outDir, type Progress } from "../ingest/run.js";
import { normaliseUrl } from "../ingest/clone.js";
import { validateCityData, CityDataError } from "../ingest/schema.js";
import { SCHEMA_VERSION } from "../ingest/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 5181);

type JobStatus = "running" | "done" | "error";

interface Job {
  id: string;
  slug: string;
  repoUrl: string;
  status: JobStatus;
  progress: Progress;
  /** every progress event so far, replayed to late subscribers */
  history: Progress[];
  fromCache: boolean;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  listeners: Set<(chunk: string) => void>;
}

const jobs = new Map<string, Job>();
const bySlug = new Map<string, string>();

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcast(job: Job, event: string, data: unknown): void {
  const chunk = sse(event, data);
  for (const send of job.listeners) {
    try {
      send(chunk);
    } catch {
      job.listeners.delete(send);
    }
  }
}

function startJob(repoUrl: string, options: { resync: boolean; force: boolean; rebuild: boolean }): Job {
  const { slug } = normaliseUrl(repoUrl);

  const runningId = bySlug.get(slug);
  const running = runningId ? jobs.get(runningId) : undefined;
  if (running && running.status === "running") return running;

  const job: Job = {
    id: `${slug}-${Date.now().toString(36)}`,
    slug,
    repoUrl,
    status: "running",
    progress: { stage: "CLONING", detail: "queued", pct: 0 },
    history: [],
    fromCache: false,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    listeners: new Set(),
  };
  jobs.set(job.id, job);
  bySlug.set(slug, job.id);

  void (async () => {
    try {
      const outcome = await ingest({
        url: repoUrl,
        root: ROOT,
        maxBuildings: 60000,
        maxFrames: 240,
        aggregateThreshold: 15,
        depth: 0,
        force: options.force,
        rebuild: options.rebuild,
        resync: options.resync,
        noGithub: false,
        quiet: true,
        onProgress: (p) => {
          job.progress = p;
          job.history.push(p);
          broadcast(job, "progress", p);
        },
      });
      job.slug = outcome.slug;
      job.fromCache = outcome.fromCache;
      job.status = "done";
      job.finishedAt = Date.now();
      job.progress = { stage: "CITY READY", detail: outcome.fromCache ? "cached" : "built", pct: 1 };
      job.history.push(job.progress);
      broadcast(job, "done", {
        slug: outcome.slug,
        fromCache: outcome.fromCache,
        ms: Date.now() - job.startedAt,
      });
    } catch (err) {
      job.status = "error";
      job.finishedAt = Date.now();
      // the readable message goes to the browser; the raw failure stays here
      console.error(`[codecity] ingest failed for ${repoUrl}\n`, err);
      job.error = err instanceof Error ? err.message : String(err);
      broadcast(job, "error", { message: job.error });
    } finally {
      for (const send of job.listeners) {
        try {
          send("");
        } catch {
          /* already gone */
        }
      }
    }
  })();

  return job;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function serveDataset(slug: string): Promise<Response> {
  let body: string;
  try {
    body = await readFile(path.join(outDir(ROOT), `${path.basename(slug)}.json`), "utf8");
  } catch {
    return json({ error: `no city for "${slug}" — analyze it first`, fault: "missing" }, 404);
  }

  // Validate here rather than in the browser: a dataset written by an older
  // layout must never reach the renderer, and the client should be told to
  // re-analyze rather than shown a stack trace.
  try {
    validateCityData(JSON.parse(body), slug);
  } catch (err) {
    if (err instanceof CityDataError) {
      return json({ error: err.message, fault: err.fault, recoverable: err.recoverable, slug }, 409);
    }
    return json({ error: "the stored city could not be read", fault: "unreadable", slug }, 409);
  }

  return new Response(body, {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

Bun.serve({
  port: PORT,
  idleTimeout: 255,

  async fetch(request) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/health") return json({ ok: true });

    if (pathname === "/api/manifest") {
      try {
        const manifest = JSON.parse(await readFile(path.join(outDir(ROOT), "manifest.json"), "utf8"));
        const repos: Array<Record<string, unknown>> = Array.isArray(manifest.repos) ? manifest.repos : [];

        // Entries written by an older layout stay listed — they are real work
        // the user did — but they are flagged, and the default never lands on
        // one, because opening it would only produce an error.
        for (const entry of repos) {
          const onDisk = existsSync(path.join(outDir(ROOT), `${String(entry.slug)}.json`));
          entry.stale = !onDisk || entry.schema !== SCHEMA_VERSION;
          entry.missing = !onDisk;
        }
        // never default to something that would 404 or 409 the moment it opens
        const fresh = repos.find((entry) => !entry.stale);
        return json({ default: fresh ? fresh.slug : null, repos });
      } catch {
        return json({ default: null, repos: [] });
      }
    }

    if (pathname.startsWith("/api/data/")) {
      return serveDataset(decodeURIComponent(pathname.slice("/api/data/".length)));
    }

    if (pathname === "/api/analyze" && request.method === "POST") {
      let body: { url?: string; resync?: boolean; force?: boolean; rebuild?: boolean };
      try {
        body = await request.json();
      } catch {
        return json({ error: "expected a JSON body" }, 400);
      }
      const repoUrl = (body.url ?? "").trim();
      if (!repoUrl) return json({ error: "no repository url" }, 400);
      try {
        normaliseUrl(repoUrl);
      } catch {
        return json({ error: "that does not look like a git url" }, 400);
      }

      const job = startJob(repoUrl, {
        resync: body.resync ?? false,
        force: body.force ?? false,
        rebuild: body.rebuild ?? false,
      });
      return json({ jobId: job.id, slug: job.slug, status: job.status });
    }

    if (pathname.startsWith("/api/jobs/")) {
      const id = pathname.slice("/api/jobs/".length).replace(/\/events$/, "");
      const job = jobs.get(id);
      if (!job) return json({ error: "unknown job" }, 404);

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          let closed = false;
          const send = (chunk: string) => {
            if (closed) return;
            if (chunk === "") {
              closed = true;
              job.listeners.delete(send);
              try {
                controller.close();
              } catch {
                /* already closed */
              }
              return;
            }
            controller.enqueue(encoder.encode(chunk));
          };

          // replay so a subscriber that connects mid-run sees the whole story
          for (const p of job.history) send(sse("progress", p));

          if (job.status === "done") {
            send(sse("done", { slug: job.slug, fromCache: job.fromCache, ms: (job.finishedAt ?? Date.now()) - job.startedAt }));
            send("");
            return;
          }
          if (job.status === "error") {
            send(sse("error", { message: job.error }));
            send("");
            return;
          }
          job.listeners.add(send);
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        },
      });
    }

    // production: serve the built viewer
    const dist = path.join(ROOT, "dist");
    const filePath = path.join(dist, pathname === "/" ? "index.html" : pathname.slice(1));
    const file = Bun.file(filePath);
    if (await file.exists()) return new Response(file);
    const index = Bun.file(path.join(dist, "index.html"));
    if (await index.exists()) return new Response(index);

    return json({ error: "not found" }, 404);
  },
});

process.stderr.write(`\nCODE CITY api  ·  http://127.0.0.1:${PORT}\n`);
