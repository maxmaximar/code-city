/** Shared types for the ingest pipeline and the viewer. */

export interface FileDelta {
  path: string;
  added: number;
  removed: number;
  /** true when git reported `-` for both counts (binary blob) */
  binary: boolean;
}

export interface Commit {
  hash: string;
  author: string;
  /** unix seconds */
  ts: number;
  subject: string;
  files: FileDelta[];
}

export interface ParseResult {
  commits: Commit[];
  /** distinct author names across the parsed window */
  authors: number;
  /** true when the clone was shallow, i.e. history is truncated */
  shallow: boolean;
  /** commits that git reported but we did not parse (safety cap) */
  skipped: number;
}

/** One renderable thing in the city. */
export interface Building {
  /** index into `districts` */
  d: number;
  /** index into `blocks` */
  k: number;
  /** world centre of this building's lot */
  x: number;
  z: number;
  /** display label (basename, or `dir/…` for an aggregate) */
  n: string;
  /** full repo path (a directory path when aggregated) */
  p: string;
  /** 0 for a real file; N>0 when this block stands in for N files */
  a: number;
  /** bytes at HEAD (summed for an aggregate) — drives footprint, not height */
  b: number;
  /** language index into `CityData.languages` */
  l: number;
}

export interface District {
  /** short display name — the last segment of `path` */
  name: string;
  /** full folder path this district covers */
  path: string;
  /** ground plate rect (world units), including the district margin */
  px: number;
  pz: number;
  pw: number;
  pd: number;
  /** grid cells across this district's blocks — the density denominator */
  cells: number;
  /** plots in this district, history included */
  lots: number;
  lines: number;
}

/** A city block: one folder's worth of lots, bounded by streets. */
export interface Block {
  /** index into `districts` */
  d: number;
  /** the folder this block stands for */
  path: string;
  /** block rect in world units, streets excluded */
  x: number;
  z: number;
  w: number;
  h: number;
  cols: number;
  rows: number;
  lots: number;
  /** true for a deliberately empty block — a plaza */
  plaza: boolean;
}

export interface Frame {
  /** unix seconds of the bucket end */
  ts: number;
  /** YYYY-MM-DD */
  date: string;
  /** commits inside this bucket */
  commits: number;
  /** short hash of the last commit in the bucket */
  hash: string;
  /** buildings with height > 0 after this bucket */
  buildings: number;
  /** total lines after this bucket */
  lines: number;
  /** flat [buildingIndex, newHeightInLines, ...] pairs — changes only */
  delta: number[];
}

export interface IngestStep {
  label: string;
  /** right-hand readout; `null` renders the green check */
  value: string | null;
  ms: number;
}

/**
 * Bump whenever the shape of a dataset changes — the ingest refuses to reuse a
 * cached city built by a different layout, so a code change never leaves stale
 * geometry on disk.
 */
export const SCHEMA_VERSION = 4;

export interface CityMeta {
  /** the SCHEMA_VERSION this file was written with */
  schema: number;
  repoName: string;
  repoUrl: string;
  owner: string | null;
  name: string | null;
  defaultBranch: string;
  totalCommits: number;
  authors: number;
  /** distinct paths ever seen in the parsed window */
  totalPaths: number;
  /** paths with lines > 0 in the final frame */
  finalFiles: number;
  finalLines: number;
  /** every plot the city reserves, history included */
  lots: number;
  /** lots standing at HEAD — one per eligible file */
  standing: number;
  aggregates: number;
  districts: number;
  frames: number;
  /** bucket size label, e.g. `commit`, `1d`, `21d` */
  bucket: string;
  shallow: boolean;
  /** true when the aggregation guard collapsed anything */
  sampled: boolean;
  firstCommit: number;
  lastCommit: number;
  generatedAt: number;
  ingestMs: number;
  steps: IngestStep[];
  github: GithubMeta | null;
  /** the commit this city was built from */
  head: HeadCommit | null;
  /** total bytes at HEAD */
  bytes: number;
  /** every file at HEAD, before eligibility */
  filesAtHead: number;
  /** files at HEAD that became their own building */
  eligibleFiles: number;
  /** how many files each exclusion category removed, and why */
  excluded: Array<{ reason: string; label: string; files: number }>;
  /** language histogram at HEAD: name → files */
  languageFiles: Array<[string, number]>;
}

/** The commit the city was built from. */
export interface HeadCommit {
  hash: string;
  short: string;
  author: string;
  subject: string;
  ts: number;
}

export interface GithubMeta {
  stars: number;
  forks: number;
  description: string | null;
  homepage: string | null;
  language: string | null;
  pushedAt: string | null;
}

export interface CityData {
  meta: CityMeta;
  /** language names, indexed by `Building.l` */
  languages: string[];
  districts: District[];
  blocks: Block[];
  buildings: Building[];
  /** final state: `h` = lines per building, `t` = last-modified unix seconds */
  final: { h: number[]; t: number[] };
  frames: Frame[];
}
