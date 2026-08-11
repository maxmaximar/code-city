import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export interface CloneOptions {
  /** git url, or an absolute path to a local repo */
  url: string;
  /** where bare clones are kept, one dir per repo */
  cacheDir: string;
  /** shallow depth; 0 / undefined means full history */
  depth?: number;
  /** re-clone even if a cached copy exists */
  force?: boolean;
  onLog?: (line: string) => void;
}

export interface CloneResult {
  /** path to the bare repo we will read from */
  gitDir: string;
  /** normalised remote url */
  url: string;
  slug: string;
  owner: string | null;
  name: string | null;
  shallow: boolean;
  cached: boolean;
  ms: number;
}

const GIT_HOST = /^(?:https?:\/\/|git@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/;

/** `facebook/react` · `https://github.com/facebook/react` · `git@github.com:facebook/react.git` */
export function normaliseUrl(input: string): {
  url: string;
  owner: string | null;
  name: string | null;
  slug: string;
} {
  const raw = input.trim();

  if (raw.startsWith("/") || raw.startsWith(".")) {
    const abs = path.resolve(raw);
    return { url: abs, owner: null, name: path.basename(abs), slug: path.basename(abs) };
  }

  // bare `owner/repo` shorthand → github
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) {
    const [owner, name] = raw.split("/");
    return {
      url: `https://github.com/${owner}/${name}.git`,
      owner,
      name,
      slug: `${owner}__${name}`,
    };
  }

  const m = raw.match(GIT_HOST);
  if (!m) throw new Error(`cannot parse repo url: ${input}`);
  const segments = m[2].split("/");
  const name = segments[segments.length - 1];
  const owner = segments.length > 1 ? segments[segments.length - 2] : null;
  return {
    url: raw.endsWith(".git") ? raw : `${raw.replace(/\/$/, "")}.git`,
    owner,
    name,
    slug: [owner, name].filter(Boolean).join("__"),
  };
}

/**
 * Turns git's stderr into something a person can act on.
 *
 * The raw text is a command line containing local filesystem paths — useless to
 * a user and not something to put on a public screen. The original still goes to
 * the server console for whoever is debugging.
 */
export class CloneError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = "CloneError";
    this.detail = detail;
  }
}

function explainGitFailure(stderr: string, url: string): string {
  const text = stderr.toLowerCase();
  const where = url.replace(/\.git$/, "");

  if (/repository not found|not found\b|404/.test(text)) {
    return `no public repository at ${where} — check the owner and name, or it may be private`;
  }
  if (/authentication failed|could not read username|permission denied|access denied|terminal prompts disabled/.test(text)) {
    return `${where} needs credentials — CodeCity only reads public repositories`;
  }
  if (/could not resolve host|network is unreachable|connection refused|operation timed out|temporary failure/.test(text)) {
    return "could not reach the host — check your network connection";
  }
  if (/does not appear to be a git repository|invalid path|unable to access/.test(text)) {
    return `${where} does not look like a git repository`;
  }
  if (/you appear to have cloned an empty repository|remote head refers to nonexistent/.test(text)) {
    return `${where} has no commits yet`;
  }
  if (/no space left/.test(text)) return "the disk is full — free some space and try again";
  return `git could not clone ${where}`;
}

function run(cmd: string, args: string[], onLog?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const feed = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-4000);
      if (onLog) {
        for (const line of chunk.toString().split(/[\r\n]/)) {
          const t = line.trim();
          if (t) onLog(t);
        }
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}\n${tail}`));
    });
  });
}

/**
 * Bare-clone the target repo into the cache. Bare keeps it small (no working
 * tree) while still letting `git log --numstat` compute real per-file line
 * deltas — which the GitHub REST API cannot give us cheaply or without rate
 * limits.
 */
export async function cloneRepo(opts: CloneOptions): Promise<CloneResult> {
  const started = Date.now();
  const { url, owner, name, slug } = normaliseUrl(opts.url);

  // A local path is used in place: nothing to clone.
  if (!url.includes("://") && !url.startsWith("git@")) {
    const gitDir = existsSync(path.join(url, ".git")) ? path.join(url, ".git") : url;
    return {
      gitDir,
      url,
      slug,
      owner,
      name,
      shallow: existsSync(path.join(gitDir, "shallow")),
      cached: true,
      ms: Date.now() - started,
    };
  }

  await mkdir(opts.cacheDir, { recursive: true });
  const gitDir = path.join(opts.cacheDir, `${slug}.git`);

  if (existsSync(path.join(gitDir, "HEAD")) && !opts.force) {
    return {
      gitDir,
      url,
      slug,
      owner,
      name,
      shallow: existsSync(path.join(gitDir, "shallow")),
      cached: true,
      ms: Date.now() - started,
    };
  }

  const args = ["clone", "--bare", "--single-branch", "--no-tags", "--progress"];
  if (opts.depth && opts.depth > 0) args.push(`--depth=${opts.depth}`);
  args.push(url, gitDir);

  try {
    await run("git", args, opts.onLog);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error("[codecity] clone failed\n", detail);
    throw new CloneError(explainGitFailure(detail, url), detail);
  }

  return {
    gitDir,
    url,
    slug,
    owner,
    name,
    shallow: existsSync(path.join(gitDir, "shallow")),
    cached: false,
    ms: Date.now() - started,
  };
}

function capture(gitDir: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", ["--git-dir", gitDir, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out.trim()));
  });
}

/** SHA at HEAD — the cheap check for "has anything actually changed?". */
export async function headSha(gitDir: string): Promise<string> {
  return capture(gitDir, ["rev-parse", "HEAD"]);
}

/** The commit the city is built from. */
export async function headCommit(gitDir: string) {
  const raw = await capture(gitDir, ["log", "-1", "--format=%H%x1f%an%x1f%at%x1f%s", "HEAD"]);
  if (!raw) return null;
  const [hash, author, ts, ...rest] = raw.split("\x1f");
  return {
    hash,
    short: hash.slice(0, 7),
    author: author ?? "",
    ts: Number(ts) || 0,
    subject: rest.join("\x1f"),
  };
}

/** Pull new commits into an existing cached clone. Returns the SHA before/after. */
export async function fetchRepo(
  gitDir: string,
  onLog?: (line: string) => void,
): Promise<{ before: string; after: string; changed: boolean }> {
  const before = await headSha(gitDir);
  try {
    await run("git", ["--git-dir", gitDir, "fetch", "--prune", "--no-tags", "--progress"], onLog);
  } catch {
    // offline, or the remote is gone — fall back to what we already have
    return { before, after: before, changed: false };
  }
  const after = await headSha(gitDir);
  return { before, after, changed: before !== after };
}

/** Current branch name of a bare repo (best effort). */
export async function currentBranch(gitDir: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", ["--git-dir", gitDir, "symbolic-ref", "--short", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.on("error", () => resolve("HEAD"));
    child.on("close", () => resolve(out.trim() || "HEAD"));
  });
}
