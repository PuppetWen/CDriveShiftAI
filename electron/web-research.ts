import path from "node:path";
import type { AnalysisWebSource } from "./types";

export interface WebResearchItem {
  name: string;
  query: string;
  snippets: string[];
  sources: AnalysisWebSource[];
}

function cleanText(value: unknown, maximum = 700): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function directoryName(targetPath: string): string {
  const trimmed = targetPath.replace(/[\\/]+$/, "");
  return path.win32.basename(trimmed) || trimmed;
}

function relevanceTokens(name: string): string[] {
  const expanded = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLocaleLowerCase();
  const ignored = new Set([
    "application",
    "cache",
    "data",
    "files",
    "folder",
    "local",
    "roaming",
    "temp",
    "windows"
  ]);
  return expanded
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !ignored.has(token));
}

function keepRelevant(
  name: string,
  value: { snippets: string[]; sources: AnalysisWebSource[] }
): { snippets: string[]; sources: AnalysisWebSource[] } {
  const tokens = relevanceTokens(name);
  const compact = name.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const relevant = (text: string) => {
    const lower = text.toLocaleLowerCase();
    return (
      (compact.length >= 5 && lower.replace(/[^\p{L}\p{N}]+/gu, "").includes(compact)) ||
      tokens.some((token) => lower.includes(token))
    );
  };
  if (tokens.length === 0 && compact.length < 5) return { snippets: [], sources: [] };
  return {
    snippets: value.snippets.filter(relevant),
    sources: value.sources.filter((source) => relevant(`${source.title} ${source.url}`))
  };
}

async function duckDuckGo(query: string): Promise<{ snippets: string[]; sources: AnalysisWebSource[] }> {
  const endpoint = new URL("https://api.duckduckgo.com/");
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("no_html", "1");
  endpoint.searchParams.set("no_redirect", "1");
  endpoint.searchParams.set("skip_disambig", "1");
  const response = await fetch(endpoint, {
    headers: { Accept: "application/json", "User-Agent": "CDriveShiftAI/0.1" },
    signal: AbortSignal.timeout(6_500)
  });
  if (!response.ok) throw new Error(`DuckDuckGo HTTP ${response.status}`);
  const value = (await response.json()) as Record<string, unknown>;
  const snippets: string[] = [];
  const sources: AnalysisWebSource[] = [];
  const abstract = cleanText(value.AbstractText);
  const abstractUrl = safeHttpUrl(value.AbstractURL);
  if (abstract) snippets.push(abstract);
  if (abstractUrl) {
    sources.push({
      title: cleanText(value.Heading, 180) || new URL(abstractUrl).hostname,
      url: abstractUrl
    });
  }
  const related = Array.isArray(value.RelatedTopics) ? value.RelatedTopics : [];
  for (const raw of related.slice(0, 8)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const text = cleanText(item.Text);
    const url = safeHttpUrl(item.FirstURL);
    if (text) snippets.push(text);
    if (url) sources.push({ title: text.slice(0, 180) || new URL(url).hostname, url });
    if (snippets.length >= 4) break;
  }
  return {
    snippets: [...new Set(snippets)].slice(0, 4),
    sources: [...new Map(sources.map((item) => [item.url, item])).values()].slice(0, 4)
  };
}

async function bingRss(query: string): Promise<{ snippets: string[]; sources: AnalysisWebSource[] }> {
  const endpoint = new URL("https://www.bing.com/search");
  endpoint.searchParams.set("format", "rss");
  endpoint.searchParams.set("q", query);
  const response = await fetch(endpoint, {
    headers: { Accept: "application/rss+xml, application/xml", "User-Agent": "CDriveShiftAI/0.1" },
    signal: AbortSignal.timeout(6_500)
  });
  if (!response.ok) throw new Error(`Bing HTTP ${response.status}`);
  const xml = await response.text();
  const snippets: string[] = [];
  const sources: AnalysisWebSource[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = match[1];
    const title = cleanText(item.match(/<title>([\s\S]*?)<\/title>/i)?.[1], 180);
    const description = cleanText(item.match(/<description>([\s\S]*?)<\/description>/i)?.[1]);
    const url = safeHttpUrl(cleanText(item.match(/<link>([\s\S]*?)<\/link>/i)?.[1], 2_048));
    if (description) snippets.push(description);
    if (url) sources.push({ title: title || new URL(url).hostname, url });
    if (snippets.length >= 4) break;
  }
  return { snippets, sources };
}

export async function researchDirectory(targetPath: string): Promise<WebResearchItem | undefined> {
  const name = directoryName(targetPath).trim().slice(0, 120);
  if (!name || /^[a-z]:$/i.test(name)) return undefined;
  const query = `"${name}" Windows folder application data purpose`;
  try {
    const primary = keepRelevant(name, await duckDuckGo(query));
    if (primary.snippets.length || primary.sources.length) {
      return { name, query, ...primary };
    }
  } catch {
    // The fallback below is intentionally best-effort.
  }
  try {
    const fallback = keepRelevant(name, await bingRss(query));
    if (fallback.snippets.length || fallback.sources.length) {
      return { name, query, ...fallback };
    }
  } catch {
    // Online research is optional evidence and must never make local analysis fail.
  }
  return undefined;
}

export async function researchUnknownDirectories(paths: string[]): Promise<WebResearchItem[]> {
  const unique = [
    ...new Map(
      paths
        .map((item) => [directoryName(item).toLocaleLowerCase(), item] as const)
        .filter(([name]) => name.length >= 2)
    ).values()
  ].slice(0, 4);
  const values = await Promise.all(unique.map((item) => researchDirectory(item)));
  return values.filter((item): item is WebResearchItem => Boolean(item));
}
