import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger.js';
import type { SkillsBundleConfig } from './config.js';

/**
 * Skill bodies for the startup bundle, read straight from the skills repository
 * on demand (no generated file, no polling):
 *
 *   1. skills/preload/SKILL.md  → the skill list between the preload markers
 *   2. skills/<name>/SKILL.md   → each skill body, YAML front matter removed
 *
 * A local mount (SKILLS_BUNDLE_LOCAL_PATH) wins; otherwise the GitHub contents
 * API is used with one conditional request per file, so an unchanged repository
 * costs only 304s. Any failure keeps the last good copy instead of returning
 * nothing.
 */

const MARKER_START = '<!-- preload:skills:start -->';
const MARKER_END = '<!-- preload:skills:end -->';
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const SKILL_NAME = /^\s*[-*]\s+`?([A-Za-z0-9][A-Za-z0-9._-]*)`?\s*$/;

export interface SkillsBody {
  body: string;
  stale: boolean;
}

interface FileCache {
  text: string;
  etag?: string;
}

interface BundleCache {
  body: string;
  files: Record<string, FileCache>;
  fetchedAt: number;
}

/** Skill names in preload order; the markers are the single source of truth. */
export const parseSkillList = (markdown: string): string[] => {
  const start = markdown.indexOf(MARKER_START);
  const end = markdown.indexOf(MARKER_END);
  if (start < 0 || end <= start) {
    return [];
  }
  const block = markdown.slice(start + MARKER_START.length, end);
  const names: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const match = SKILL_NAME.exec(line);
    if (match) {
      names.push(match[1]);
    }
  }
  return [...new Set(names)];
};

export const stripFrontMatter = (markdown: string): string => markdown.replace(FRONT_MATTER, '');

const renderSection = (name: string, sourcePath: string, markdown: string): string =>
  `## ${name}\n\n来源：${sourcePath}；其中相对路径以 skills/${name}/ 为基准。\n\n${stripFrontMatter(
    markdown,
  ).trim()}`;

export class SkillsBundleSource {
  private cache: BundleCache | null = null;
  private inflight: Promise<void> | null = null;
  private warnedMissingSource = false;
  private warnedMissingList = false;

  constructor(private readonly config: SkillsBundleConfig) {
    this.loadDiskCache();
  }

  async getBody(): Promise<SkillsBody> {
    if (this.config.ttlMs > 0 && this.cache && Date.now() - this.cache.fetchedAt < this.config.ttlMs) {
      return { body: this.cache.body, stale: false };
    }
    const before = this.cache?.fetchedAt ?? 0;
    await this.refresh();
    if (!this.cache) {
      return { body: '', stale: true };
    }
    return { body: this.cache.body, stale: this.cache.fetchedAt === before };
  }

  private describeSource(): string {
    if (this.config.localPath) {
      return `directory ${this.config.localPath}`;
    }
    if (this.config.repo) {
      return `github ${this.config.repo}@${this.config.ref}`;
    }
    return 'no source (SKILLS_BUNDLE_LOCAL_PATH / SKILLS_BUNDLE_REPO unset)';
  }

  private refresh(): Promise<void> {
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.fetchOnce()
      .catch((error: unknown) => {
        logger.warn(
          `Failed to refresh skill bodies from ${this.describeSource()}; keeping the cached copy: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async fetchOnce(): Promise<void> {
    if (!this.config.localPath && !this.config.repo) {
      if (!this.warnedMissingSource) {
        this.warnedMissingSource = true;
        logger.warn(
          'Startup bundle has no skill bodies: set SKILLS_BUNDLE_LOCAL_PATH or SKILLS_BUNDLE_REPO.',
        );
      }
      return;
    }

    const nextFiles: Record<string, FileCache> = { ...(this.cache?.files ?? {}) };
    const preload = await this.readText(this.config.preloadPath, nextFiles);
    if (!preload) {
      throw new Error(`missing ${this.config.preloadPath}`);
    }
    const names = parseSkillList(preload);
    if (names.length === 0) {
      if (!this.warnedMissingList) {
        this.warnedMissingList = true;
        logger.warn(
          `No skills found between the preload markers in ${this.config.preloadPath}; the startup bundle will carry the catalog only.`,
        );
      }
      this.cache = { body: '', files: nextFiles, fetchedAt: Date.now() };
      return;
    }

    const sections: string[] = [];
    for (const name of names) {
      const sourcePath = `${this.config.skillsRoot}/${name}/SKILL.md`;
      const text = await this.readText(sourcePath, nextFiles);
      if (!text || !text.trim()) {
        logger.warn(`Startup bundle skipped skill '${name}': ${sourcePath} is missing or empty`);
        continue;
      }
      sections.push(renderSection(name, sourcePath, text));
    }

    const body =
      sections.length === 0
        ? ''
        : [
            `# 开场技能（${sections.length} 个）`,
            ...sections,
            `以上 ${sections.length} 个开场技能已全部加载，直接遵循即可，不要再逐个调用技能工具。`,
          ].join('\n\n') + '\n';

    this.cache = { body, files: nextFiles, fetchedAt: Date.now() };
    this.persistDiskCache();
  }

  /** Read one repository file, reusing its cached text on 304. */
  private async readText(
    relativePath: string,
    nextFiles: Record<string, FileCache>,
  ): Promise<string | null> {
    if (this.config.localPath) {
      const absolute = path.join(this.config.localPath, relativePath);
      try {
        return await fs.promises.readFile(absolute, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    }

    const cached = this.cache?.files[relativePath];
    const encoded = relativePath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const url = `https://api.github.com/repos/${this.config.repo}/contents/${encoded}?ref=${encodeURIComponent(
      this.config.ref,
    )}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.raw',
      'User-Agent': 'mcphub-startup-catalog',
    };
    if (this.config.token) {
      headers.Authorization = `Bearer ${this.config.token}`;
    }
    if (cached?.etag) {
      headers['If-None-Match'] = cached.etag;
    }

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (response.status === 304) {
      return cached?.text ?? null;
    }
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from the GitHub contents API for ${relativePath}`);
    }
    const text = await response.text();
    const etag = response.headers.get('etag') ?? undefined;
    nextFiles[relativePath] = { text, etag };
    return text;
  }

  private persistDiskCache(): void {
    if (!this.cache) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.config.cachePath), { recursive: true });
      fs.writeFileSync(this.config.cachePath, JSON.stringify(this.cache), 'utf8');
    } catch (error) {
      logger.warn(
        `Failed to persist the skills cache at ${this.config.cachePath}`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private loadDiskCache(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.config.cachePath, 'utf8')) as BundleCache;
      if (parsed && typeof parsed.body === 'string' && parsed.files) {
        this.cache = {
          body: parsed.body,
          files: parsed.files,
          fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0,
        };
      }
    } catch {
      // No usable cache yet: the first read populates it.
    }
  }
}
