import type { GithubMeta } from "./types.js";

/**
 * The single GitHub API call this project makes. Everything else — commits,
 * files, lines, authors, dates — comes out of the local clone, which is why we
 * never touch the 60 req/hour unauthenticated limit.
 *
 * Contributor count is deliberately NOT taken from the API (that would need a
 * second call plus Link-header paging); it is the distinct author count from
 * the parsed history instead.
 */
export async function fetchRepoMeta(
  owner: string | null,
  name: string | null,
  timeoutMs = 6000,
): Promise<GithubMeta | null> {
  if (!owner || !name) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "codecity",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    return {
      stars: Number(j.stargazers_count) || 0,
      forks: Number(j.forks_count) || 0,
      description: (j.description as string) ?? null,
      homepage: (j.homepage as string) ?? null,
      language: (j.language as string) ?? null,
      pushedAt: (j.pushed_at as string) ?? null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
