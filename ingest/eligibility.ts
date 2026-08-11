/**
 * Which repository files become buildings.
 *
 * The rule is one eligible file, one building — no sampling, no cap. What is
 * excluded is only what would not be a *building* in any meaningful sense:
 * code the repository vendored rather than wrote, output it generated rather
 * than authored, and blobs that have no lines to measure.
 *
 * Every rule here is conventional across ecosystems. None of them name a
 * specific project.
 */

export const EXCLUSION_REASONS = [
  "vendored",
  "build-output",
  "lockfile",
  "binary",
  "generated",
  "oversized",
] as const;

export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  vendored: "dependencies vendored into the repo, not authored in it",
  "build-output": "compiled or bundled output directories",
  lockfile: "dependency lockfiles — machine-written, thousands of lines",
  binary: "images, fonts, media, archives and compiled objects — no lines to measure",
  generated: "test baselines, snapshots and code generated from another file in the repo",
  oversized: "single files over 4 MB — data dumps rather than source",
};

/** Directory names that mean "this came from somewhere else". */
const VENDOR_DIRS = new Set([
  "node_modules",
  "bower_components",
  "jspm_packages",
  "vendor",
  "vendors",
  "third_party",
  "thirdparty",
  "3rdparty",
  "externals",
  "Godeps",
  "Pods",
  "Carthage",
  "packrat",
  "site-packages",
  "eggs",
  ".venv",
  "venv",
  "virtualenv",
]);

/** Directory names that mean "a tool wrote this". */
const BUILD_DIRS = new Set([
  "dist",
  "build",
  "_build",
  "out",
  "output",
  "bin",
  "obj",
  "target",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".terraform",
  "cmake-build-debug",
  "cmake-build-release",
  "DerivedData",
]);

/** Directory names that hold recorded expectations rather than source. */
const GENERATED_DIRS = new Set([
  "__snapshots__",
  "snapshots",
  "baselines",
  "goldens",
  "golden",
  "__generated__",
  "generated",
  "gen",
  "autogen",
]);

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "pdm.lock",
  "composer.lock",
  "gemfile.lock",
  "podfile.lock",
  "packages.lock.json",
  "go.sum",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
  "gradle.lockfile",
]);

const BINARY_EXT = new Set([
  // raster and vector art
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "icns", "webp", "tif", "tiff", "psd", "ai", "eps",
  "avif", "heic",
  // fonts
  "ttf", "otf", "woff", "woff2", "eot",
  // media
  "mp3", "wav", "ogg", "flac", "aac", "m4a", "mp4", "webm", "mov", "avi", "mkv", "wmv",
  // archives and images of filesystems
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "jar", "war", "iso", "dmg", "pkg", "deb",
  "rpm", "msi", "apk", "aab", "nupkg", "whl", "egg",
  // compiled objects and libraries
  "o", "a", "so", "dylib", "dll", "exe", "lib", "pdb", "obj", "class", "pyc", "pyo", "wasm",
  "bin", "dat", "node",
  // documents and databases
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "sqlite", "db", "mdb",
  // model and design blobs
  "blend", "fbx", "obj3d", "glb", "gltf", "stl", "sketch", "fig", "xd",
]);

/** Extensions that only ever appear as the output of something else in the tree. */
const GENERATED_EXT = new Set([
  "map", // source maps
  "types", "symbols", "baseline", "trace", // compiler test baselines
  "lock",
  "min", // *.min is caught by the suffix rule below, kept for completeness
]);

const GENERATED_SUFFIX = [
  ".min.js",
  ".min.css",
  ".min.mjs",
  ".bundle.js",
  ".chunk.js",
  ".d.ts.map",
  ".js.map",
  ".css.map",
  "_pb2.py",
  "_pb2_grpc.py",
  ".pb.go",
  ".pb.cc",
  ".pb.h",
  ".g.dart",
  ".freezed.dart",
  ".designer.cs",
  ".generated.cs",
  ".generated.ts",
  ".g.cs",
];

/** 4 MB of one file is a dataset, not a source file. */
const MAX_BYTES = 4 * 1024 * 1024;

export interface EligibilityResult {
  eligible: boolean;
  reason: ExclusionReason | null;
}

/**
 * `size` is the blob size at HEAD when known. Historical paths that no longer
 * exist are judged on their path alone.
 */
export function classify(path: string, size?: number): EligibilityResult {
  const lower = path.toLowerCase();
  const parts = path.split("/");
  const file = parts[parts.length - 1];
  const lowerFile = file.toLowerCase();

  for (let i = 0; i < parts.length - 1; i++) {
    const dir = parts[i];
    if (VENDOR_DIRS.has(dir)) return { eligible: false, reason: "vendored" };
    if (BUILD_DIRS.has(dir)) return { eligible: false, reason: "build-output" };
    if (GENERATED_DIRS.has(dir)) return { eligible: false, reason: "generated" };
  }

  if (LOCKFILES.has(lowerFile)) return { eligible: false, reason: "lockfile" };

  for (const suffix of GENERATED_SUFFIX) {
    if (lower.endsWith(suffix)) return { eligible: false, reason: "generated" };
  }

  const dot = lowerFile.lastIndexOf(".");
  const ext = dot > 0 ? lowerFile.slice(dot + 1) : "";
  if (ext && BINARY_EXT.has(ext)) return { eligible: false, reason: "binary" };
  if (ext && GENERATED_EXT.has(ext)) return { eligible: false, reason: "generated" };

  if (size !== undefined && size > MAX_BYTES) return { eligible: false, reason: "oversized" };

  return { eligible: true, reason: null };
}

/** Language bucket for a path, for the colour-by-language view and the filters. */
const LANGUAGES: Array<[string, string[]]> = [
  ["TypeScript", ["ts", "tsx", "mts", "cts"]],
  ["JavaScript", ["js", "jsx", "mjs", "cjs"]],
  ["Python", ["py", "pyi", "pyx"]],
  ["Rust", ["rs"]],
  ["Go", ["go"]],
  ["Java", ["java"]],
  ["Kotlin", ["kt", "kts"]],
  ["Swift", ["swift"]],
  ["C/C++", ["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx"]],
  ["C#", ["cs"]],
  ["Ruby", ["rb", "erb", "rake"]],
  ["PHP", ["php"]],
  ["Shell", ["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"]],
  ["Styles", ["css", "scss", "sass", "less", "styl"]],
  ["Markup", ["html", "htm", "vue", "svelte", "astro", "xml", "svg"]],
  ["Docs", ["md", "mdx", "rst", "txt", "adoc"]],
  ["Config", ["json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties"]],
  ["SQL", ["sql"]],
  ["Elixir", ["ex", "exs"]],
  ["Scala", ["scala", "sbt"]],
  ["Dart", ["dart"]],
  ["Lua", ["lua"]],
  ["Nix", ["nix"]],
  ["Haskell", ["hs"]],
  ["Zig", ["zig"]],
];

const EXT_TO_LANGUAGE = new Map<string, string>();
for (const [language, extensions] of LANGUAGES) {
  for (const ext of extensions) EXT_TO_LANGUAGE.set(ext, language);
}

export const LANGUAGE_NAMES = LANGUAGES.map(([name]) => name);

export function languageOf(path: string): string {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return "Other";
  return EXT_TO_LANGUAGE.get(lower.slice(dot + 1)) ?? "Other";
}
