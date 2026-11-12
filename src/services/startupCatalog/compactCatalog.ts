import type { CatalogRow } from './types.js';

/**
 * The startup bundle carries a compressed directory: roughly 800-1000
 * characters, one line per capability family, so agents can see what exists
 * without paying for the full tool catalog. Full detail stays available through
 * the mcphub-catalog tools.
 */
export const DEFAULT_COMPACT_BUDGET = 1000;
export const DEFAULT_COMPACT_SUMMARY_CHARS = 48;

interface CompactEntry {
  name: string;
  toolCount: number;
  summary?: string;
  familyCount?: number;
}

const truncate = (value: string, cap: number): string => {
  if (cap <= 0) {
    return '';
  }
  const text = value.trim();
  return text.length <= cap ? text : `${text.slice(0, cap - 1)}…`;
};

/** First alphanumeric token of a server name, used to fold sibling servers. */
const familyKey = (name: string): string => {
  const match = /^([A-Za-z0-9]+)[-_.]/.exec(name);
  return match ? match[1] : name;
};

/**
 * Fold servers that share a name prefix (e.g. tikhub-tiktok, tikhub-douyin)
 * into one line, mirroring the "tikhub is one line, no tool names" rule.
 */
export const groupByFamily = (rows: CatalogRow[]): CompactEntry[] => {
  const buckets = new Map<string, CatalogRow[]>();
  for (const row of rows) {
    const key = familyKey(row.name);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      buckets.set(key, [row]);
    }
  }

  const entries: CompactEntry[] = [];
  for (const [key, bucket] of buckets) {
    if (bucket.length > 1 && key.length >= 3) {
      const described = bucket.find((row) => (row.summary ?? '').trim().length > 0);
      entries.push({
        name: `${key}*`,
        toolCount: bucket.reduce((total, row) => total + row.toolCount, 0),
        summary: described?.summary,
        familyCount: bucket.length,
      });
      continue;
    }
    for (const row of bucket) {
      entries.push({ name: row.name, toolCount: row.toolCount, summary: row.summary });
    }
  }
  return entries;
};

const renderEntry = (entry: CompactEntry, summaryChars: number): string => {
  const label = entry.familyCount ? `${entry.name}（${entry.familyCount} 个）` : entry.name;
  const summary = truncate(entry.summary ?? '', summaryChars);
  if (summary) {
    return `- ${label}: ${summary}`;
  }
  return entry.toolCount > 0 ? `- ${label}: ${entry.toolCount} 个工具` : `- ${label}`;
};

const renderEntries = (entries: CompactEntry[], summaryChars: number): string =>
  entries.map((entry) => renderEntry(entry, summaryChars)).join('\n');

/**
 * Build the compressed directory. Summaries shrink first, then the least
 * informative tail lines are dropped, so the result never exceeds the budget
 * unless a single line alone is longer than it.
 */
export const buildCompactCatalog = (
  rows: CatalogRow[],
  options: { budget?: number; summaryChars?: number } = {},
): string => {
  const budget = options.budget ?? DEFAULT_COMPACT_BUDGET;
  const usable = rows.filter((row) => row.toolCount > 0);
  if (usable.length === 0) {
    return '- （当前没有可用的服务器）';
  }

  const entries = groupByFamily(usable);
  const caps: number[] = [];
  const start = options.summaryChars ?? DEFAULT_COMPACT_SUMMARY_CHARS;
  for (let cap = start; cap >= 0; cap -= 4) {
    caps.push(cap);
  }
  for (const cap of caps) {
    const text = renderEntries(entries, cap);
    if (text.length <= budget) {
      return text;
    }
  }

  let kept = entries;
  while (kept.length > 1) {
    kept = kept.slice(0, -1);
    const omitted = entries.length - kept.length;
    const text = `${renderEntries(kept, 0)}\n- 另有 ${omitted} 个服务器未列出`;
    if (text.length <= budget) {
      return text;
    }
  }
  return renderEntries(entries, 0).slice(0, budget);
};
