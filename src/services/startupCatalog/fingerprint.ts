import { createHash } from 'node:crypto';
import type { CatalogServerSnapshot, CatalogToolSnapshot } from './types.js';

/**
 * Summary fingerprints must stay byte-compatible with the standalone
 * mcphub-catalog service (catalog.py): a server's fingerprint is
 * sha256(json.dumps([SUMMARY_VERSION, pairs], ensure_ascii=False))[:16] where
 * pairs are sorted (qualified tool name, description or "") tuples.
 *
 * Reusing that format lets an existing summaries store be imported as-is:
 * fingerprints that still match are kept and never re-summarized.
 */
export const SUMMARY_VERSION = 2;
export const SUMMARY_INPUT_CHARS = 6000;
export const SAMPLE_TOOLS = 5;
export const UNMAPPED_SERVER = '(unmapped)';

const SPECIAL_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x22, '\\"'],
  [0x5c, '\\\\'],
  [0x08, '\\b'],
  [0x0c, '\\f'],
  [0x0a, '\\n'],
  [0x0d, '\\r'],
  [0x09, '\\t'],
]);

/**
 * Serialize a string the way Python's json.dumps(..., ensure_ascii=False) does:
 * quote, backslash and C0 control characters are escaped, everything else
 * (including DEL and non-ASCII) is kept verbatim.
 */
const escapePythonJsonString = (value: string): string => {
  let escaped = '"';
  for (const char of value) {
    const codePoint = char.codePointAt(0) as number;
    const special = SPECIAL_ESCAPES.get(codePoint);
    if (special !== undefined) {
      escaped += special;
      continue;
    }
    if (codePoint < 0x20 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      escaped += `\\u${codePoint.toString(16).padStart(4, '0')}`;
      continue;
    }
    escaped += char;
  }
  return `${escaped}"`;
};

/** Compare strings by Unicode code point, matching Python's `sorted`. */
export const compareCodePoints = (left: string, right: string): number => {
  const a = Array.from(left);
  const b = Array.from(right);
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const delta = (a[index].codePointAt(0) as number) - (b[index].codePointAt(0) as number);
    if (delta !== 0) {
      return delta;
    }
  }
  return a.length - b.length;
};

/** Qualify a cached tool name the way aggregate routes serve it. */
export const qualifiedToolName = (
  serverName: string,
  toolName: string,
  separator: string,
): string => {
  const prefix = `${serverName}${separator}`;
  return toolName.startsWith(prefix) ? toolName : `${prefix}${toolName}`;
};

/** Strip the server prefix from a served tool name. */
export const shortToolName = (serverName: string, toolName: string, separator: string): string => {
  const prefix = `${serverName}${separator}`;
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
};

export interface FingerprintPair {
  name: string;
  description: string;
}

/** Sorted (qualified name, description) pairs, the fingerprint's input. */
export const fingerprintPairs = (
  server: CatalogServerSnapshot,
  separator: string,
): FingerprintPair[] =>
  server.tools
    .map((tool: CatalogToolSnapshot) => ({
      name: qualifiedToolName(server.name, tool.name, separator),
      description: tool.description ?? '',
    }))
    .sort(
      (a, b) =>
        compareCodePoints(a.name, b.name) || compareCodePoints(a.description, b.description),
    );

/** json.dumps([SUMMARY_VERSION, pairs], ensure_ascii=False) without the newline. */
export const serializeFingerprintInput = (pairs: FingerprintPair[]): string => {
  const serializedPairs = pairs
    .map(
      (pair) =>
        `[${escapePythonJsonString(pair.name)}, ${escapePythonJsonString(pair.description)}]`,
    )
    .join(', ');
  return `[${SUMMARY_VERSION}, [${serializedPairs}]]`;
};

export const serverFingerprint = (pairs: FingerprintPair[]): string =>
  createHash('sha256').update(serializeFingerprintInput(pairs), 'utf8').digest('hex').slice(0, 16);

export interface ServerDigest {
  fingerprint: string;
  digest: string;
}

/**
 * Build the fingerprint plus the bounded prompt text for one server.
 * The fingerprint covers every tool; the prompt only a bounded sample.
 */
export const buildServerDigest = (
  server: CatalogServerSnapshot,
  separator: string,
): ServerDigest => {
  const pairs = fingerprintPairs(server, separator);
  const lines: string[] = [];
  let size = 0;
  for (const pair of pairs) {
    const collapsed = pair.description.split(/\s+/).filter(Boolean).join(' ');
    const line = `- ${shortToolName(server.name, pair.name, separator)}: ${collapsed.slice(0, 160)}`;
    if (size + line.length > SUMMARY_INPUT_CHARS) {
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  const truncated = lines.length === pairs.length ? '' : '，以下只列出一部分';
  const head = `工具（共 ${pairs.length} 个${truncated}）：`;
  return {
    fingerprint: serverFingerprint(pairs),
    digest: `${head}\n${lines.join('\n')}`,
  };
};
