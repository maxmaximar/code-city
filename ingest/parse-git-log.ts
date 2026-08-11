import { spawn } from "node:child_process";
import readline from "node:readline";
import type { Commit, FileDelta, ParseResult } from "./types.js";

const REC = "\x01";
const SEP = "\x1f";

export interface ParseOptions {
  gitDir: string;
  /** hard safety cap on commits held in memory */
  maxCommits?: number;
  onProgress?: (commits: number) => void;
}

/**
 * Streams `git log --numstat` and parses it into commits with per-file line
 * deltas. Streaming matters: a large repo emits millions of numstat lines and
 * buffering the whole stdout would blow past the heap.
 *
 * `--no-renames` is deliberate — a rename becomes a delete + an add, which is
 * exactly how the city should read it (the old building disappears, a new one
 * grows) and it keeps the parser to a single line format.
 */
export function parseGitLog(opts: ParseOptions): Promise<ParseResult> {
  const maxCommits = opts.maxCommits ?? 400_000;

  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "-c",
        "core.quotePath=false",
        "--git-dir",
        opts.gitDir,
        "log",
        "--all",
        "--numstat",
        "--no-renames",
        `--format=${REC}%H${SEP}%an${SEP}%at${SEP}%s`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const commits: Commit[] = [];
    const authors = new Set<string>();
    let current: Commit | null = null;
    let skipped = 0;
    let stderr = "";

    child.stderr.on("data", (c) => (stderr = (stderr + c.toString()).slice(-4000)));
    child.on("error", reject);

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    rl.on("line", (line) => {
      if (line.length === 0) return;

      if (line.charCodeAt(0) === 1) {
        if (commits.length >= maxCommits) {
          skipped++;
          current = null;
          return;
        }
        const [hash, author, ts, ...rest] = line.slice(1).split(SEP);
        current = {
          hash,
          author: author ?? "",
          ts: Number(ts) || 0,
          subject: rest.join(SEP),
          files: [],
        };
        commits.push(current);
        authors.add(current.author);
        if (opts.onProgress && commits.length % 1000 === 0) opts.onProgress(commits.length);
        return;
      }

      if (!current) return;

      // `added \t removed \t path`  (added/removed are `-` for binary blobs)
      const t1 = line.indexOf("\t");
      if (t1 < 0) return;
      const t2 = line.indexOf("\t", t1 + 1);
      if (t2 < 0) return;

      const aRaw = line.slice(0, t1);
      const rRaw = line.slice(t1 + 1, t2);
      const path = line.slice(t2 + 1);
      if (!path) return;

      const binary = aRaw === "-" || rRaw === "-";
      const delta: FileDelta = {
        path,
        added: binary ? 0 : Number(aRaw) || 0,
        removed: binary ? 0 : Number(rRaw) || 0,
        binary,
      };
      current.files.push(delta);
    });

    rl.on("close", () => {
      child.on("close", (code) => {
        if (code !== 0 && commits.length === 0) {
          reject(new Error(`git log exited ${code}\n${stderr}`));
          return;
        }
        // git log walks newest-first; the city grows forward in time.
        commits.sort((a, b) => a.ts - b.ts || (a.hash < b.hash ? -1 : 1));
        resolve({ commits, authors: authors.size, shallow: false, skipped });
      });
    });
  });
}

/** Cheap total so the parse stage can report real progress instead of a spinner. */
export function countCommits(gitDir: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("git", ["--git-dir", gitDir, "rev-list", "--count", "--all"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.on("error", () => resolve(0));
    child.on("close", () => resolve(Number(out.trim()) || 0));
  });
}

export interface TreeCensus {
  /** path → blob size in bytes, for every file at HEAD */
  sizes: Map<string, number>;
  files: number;
  bytes: number;
}

/**
 * Authoritative file census at HEAD. Blob size is a genuinely different metric
 * from line count, which is what lets a building have an independent footprint
 * instead of being a scaled copy of its own height.
 */
export function censusTree(gitDir: string): Promise<TreeCensus> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      ["-c", "core.quotePath=false", "--git-dir", gitDir, "ls-tree", "-r", "-l", "HEAD"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const sizes = new Map<string, number>();
    let bytes = 0;

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      // `<mode> blob <sha> <size>\t<path>`, size right-padded with spaces
      const tab = line.indexOf("\t");
      if (tab < 0) return;
      const path = line.slice(tab + 1);
      const meta = line.slice(0, tab).split(/\s+/);
      if (meta[1] !== "blob") return;
      const size = Number(meta[3]) || 0;
      sizes.set(path, size);
      bytes += size;
    });
    rl.on("close", () => resolve({ sizes, files: sizes.size, bytes }));
    child.on("error", () => resolve({ sizes, files: 0, bytes: 0 }));
  });
}
