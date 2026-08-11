#!/usr/bin/env bun
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingest } from "../ingest/run.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `
CODE CITY — turn a git repository into a 3D city

  codecity <git-url|owner/repo|path> [options]

Options
  --max-buildings <n>   aggregation guard cap        (default 60000)
  --frames <n>          timeline frame cap           (default 240)
  --aggregate <n>       folder size that collapses first (default 15)
  --depth <n>           shallow clone depth, 0 = full history (default 0)
  --resync              fetch new commits into an existing clone
  --rebuild             rebuild the city from the cached clone
  --force               re-clone even if cached
  --no-github           skip the single GitHub metadata call
  --quiet               no progress output
  -h, --help

Examples
  codecity expressjs/express
  codecity https://github.com/facebook/react --depth 30000
  codecity torvalds/linux --depth 800
`;

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(`${HELP}\n`);
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const VALUE_FLAGS = new Set(["--max-buildings", "--frames", "--aggregate", "--depth"]);
  const positional: string[] = [];
  const opts = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) {
      positional.push(a);
    } else if (VALUE_FLAGS.has(a)) {
      opts.set(a, argv[++i] ?? "");
    } else {
      opts.set(a, true);
    }
  }
  const flag = (name: string) => opts.get(name) === true;
  const value = (name: string) => {
    const v = opts.get(name);
    return typeof v === "string" ? v : undefined;
  };

  const url = positional[0];
  if (!url) {
    process.stderr.write("error: no repository given\n");
    process.exit(1);
  }

  const quiet = flag("--quiet");
  if (!quiet) process.stderr.write(`\nCODE CITY · ingest · ${url}\n`);

  const out = await ingest({
    url,
    root: ROOT,
    maxBuildings: num(value("--max-buildings"), 60000),
    maxFrames: num(value("--frames"), 240),
    aggregateThreshold: num(value("--aggregate"), 15),
    depth: num(value("--depth"), 0),
    force: flag("--force"),
    resync: flag("--resync"),
    rebuild: flag("--rebuild"),
    noGithub: flag("--no-github"),
    quiet,
    onProgress: quiet
      ? undefined
      : (p) => process.stderr.write(`  ${p.stage.padEnd(16)} ${Math.round(p.pct * 100)}%  ${p.detail}\n`),
  });

  const m = out.data.meta;
  const f = new Intl.NumberFormat("en-US");
  process.stderr.write(
    [
      "",
      `  repo         ${m.repoName}`,
      `  commits      ${f.format(m.totalCommits)}${m.shallow ? " (shallow)" : ""}`,
      `  authors      ${f.format(m.authors)}`,
      `  paths seen   ${f.format(m.totalPaths)}`,
      `  files @HEAD  ${f.format(m.finalFiles)}`,
      `  lines        ${f.format(m.finalLines)}`,
      `  districts    ${f.format(m.districts)}`,
      `  lots         ${f.format(m.lots)}  (${f.format(m.aggregates)} aggregated, guard ${m.sampled ? "ACTIVE" : "idle"})`,
      `  standing     ${f.format(m.standing)}  buildings at HEAD`,
      `  frames       ${f.format(m.frames)}  bucket=${m.bucket}`,
      `  took         ${(m.ingestMs / 1000).toFixed(1)}s`,
      `  wrote        ${path.relative(ROOT, out.outFile)}${out.fromCache ? "  (unchanged, reused)" : ""}`,
      "",
      `  next: bun run dev  →  http://127.0.0.1:5180/?repo=${out.slug}`,
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  process.stderr.write(`\nerror: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
