/** Runs the ingest API and the Vite dev server together under one command. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const children = [
  // --watch: editing anything under ingest/ or server/ restarts the API, so a
  // pipeline change is never silently served by a stale process
  spawn("bun", ["--watch", "run", "server/index.ts"], { cwd: ROOT, stdio: "inherit" }),
  spawn("bunx", ["vite", "--config", "viewer/vite.config.ts"], { cwd: ROOT, stdio: "inherit" }),
];

const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", stop);
