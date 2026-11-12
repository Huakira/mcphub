import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../../utils/logger.js';
import type { SkillsBundleConfig } from './config.js';

/**
 * Skill bodies for the startup bundle, read straight from the skills repository
 * on demand (no generated file, no polling):
 *
 *   1. skills/preload/SKILL.md  → the skill list between the preload markers
 *   2. skills/<name>/SKILL.md   → each skill body, YAML front matter removed
 *
 * A local mount (SKILLS_BUNDLE_LOCAL_PATH) wins. Otherwise each request checks
 * the remote branch with git and fetches only when its commit changed. Files
 * are read from a bare repository cache with `git show`; no working tree, PAT,
 * cron or GitHub HTTP API is needed. Failures keep the last good body.
 */

const MARKER_START = '<!-- preload:skills:start -->';
const MARKER_END = '<!-- preload:skills:end -->';
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const SKILL_NAME = /^\s*[-*]\s+`?([A-Za-z0-9][A-Za-z0-9._-]*)`?\s*$/;
const execFileAsync = promisify(execFile);

export interface SkillsBody {
  body: string;
  /** Root AGENTS.md, rendered ahead of the skill bodies. */
  agents: string;
  stale: boolean;
}

interface BundleCache {
  body: string;
  agents: string;
  commit?: string;
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

const quoteSshArgument = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

export class SkillsBundleSource {
  private cache: BundleCache | null = null;
  private inflight: Promise<boolean> | null = null;
  private warnedMissingSource = false;
  private warnedMissingList = false;

  constructor(private readonly config: SkillsBundleConfig) {
    this.loadDiskCache();
  }

  async getBody(): Promise<SkillsBody> {
    if (
      this.config.ttlMs > 0 &&
      this.cache &&
      Date.now() - this.cache.fetchedAt < this.config.ttlMs
    ) {
      return { body: this.cache.body, agents: this.cache.agents, stale: false };
    }
    const refreshed = await this.refresh();
    if (!this.cache) {
      return { body: '', agents: '', stale: true };
    }
    return { body: this.cache.body, agents: this.cache.agents, stale: !refreshed };
  }

  private describeSource(): string {
    if (this.config.localPath) {
      return `directory ${this.config.localPath}`;
    }
    if (this.config.gitRepo) {
      return `git ${this.config.gitRepo}@${this.config.ref}`;
    }
    return 'no source (SKILLS_BUNDLE_LOCAL_PATH / SKILLS_BUNDLE_GIT_REPO unset)';
  }

  /** Single-flight refresh; the boolean tells callers whether it succeeded. */
  private refresh(): Promise<boolean> {
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.fetchOnce()
      .then(() => true)
      .catch((error: unknown) => {
        logger.warn(
          `Failed to refresh skill bodies from ${this.describeSource()}; keeping the cached copy: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async fetchOnce(): Promise<void> {
    if (!this.config.localPath && !this.config.gitRepo) {
      if (!this.warnedMissingSource) {
        this.warnedMissingSource = true;
        logger.warn(
          'Startup bundle has no skill bodies: set SKILLS_BUNDLE_LOCAL_PATH or SKILLS_BUNDLE_GIT_REPO.',
        );
      }
      return;
    }

    const commit = this.config.localPath ? undefined : await this.syncGit();
    const preload = await this.readText(this.config.preloadPath);
    if (!preload) {
      throw new Error(`missing ${this.config.preloadPath}`);
    }
    const agentsPath = this.config.agentsPath ?? 'AGENTS.md';
    const agents = (await this.readText(agentsPath)) ?? '';
    const names = parseSkillList(preload);
    if (names.length === 0) {
      if (!this.warnedMissingList) {
        this.warnedMissingList = true;
        logger.warn(
          `No skills found between the preload markers in ${this.config.preloadPath}; the startup bundle will carry the catalog only.`,
        );
      }
      this.cache = { body: '', agents, commit, fetchedAt: Date.now() };
      return;
    }

    const sections: string[] = [];
    for (const name of names) {
      const sourcePath = `${this.config.skillsRoot}/${name}/SKILL.md`;
      const text = await this.readText(sourcePath);
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

    this.cache = { body, agents, commit, fetchedAt: Date.now() };
    this.persistDiskCache();
  }

  /** Clone once, then check the remote branch on every uncached request. */
  private async syncGit(): Promise<string> {
    const remote = this.config.gitRepo;
    if (!remote) {
      throw new Error('git source is not configured');
    }
    const branchRef = `refs/heads/${this.config.ref}`;
    await fs.promises.mkdir(path.dirname(this.config.gitCachePath), { recursive: true });

    if (!fs.existsSync(path.join(this.config.gitCachePath, 'HEAD'))) {
      await this.git([
        'clone',
        '--bare',
        '--single-branch',
        '--branch',
        this.config.ref,
        '--',
        remote,
        this.config.gitCachePath,
      ]);
    }

    const remoteOutput = await this.git([
      '--git-dir',
      this.config.gitCachePath,
      'ls-remote',
      '--exit-code',
      'origin',
      branchRef,
    ]);
    const remoteCommit = remoteOutput.split(/\s+/, 1)[0];
    if (!/^[0-9a-f]{40}$/i.test(remoteCommit)) {
      throw new Error(`git ls-remote did not return a commit for ${this.config.ref}`);
    }

    const localCommit = (
      await this.git(['--git-dir', this.config.gitCachePath, 'rev-parse', '--verify', branchRef])
    ).trim();
    if (localCommit !== remoteCommit) {
      await this.git([
        '--git-dir',
        this.config.gitCachePath,
        'fetch',
        '--depth=1',
        'origin',
        `+${branchRef}:${branchRef}`,
      ]);
    }
    return remoteCommit;
  }

  /** Read one file from a local directory or from the cached git commit. */
  private async readText(relativePath: string): Promise<string | null> {
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

    const revision = `refs/heads/${this.config.ref}:${relativePath}`;
    try {
      return await this.git(['--git-dir', this.config.gitCachePath, 'show', revision]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/does not exist|exists on disk, but not in|Not a valid object name/i.test(message)) {
        return null;
      }
      throw error;
    }
  }

  private async git(args: string[]): Promise<string> {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (this.config.gitSshKeyPath) {
      env.GIT_SSH_COMMAND = `ssh -i ${quoteSshArgument(
        this.config.gitSshKeyPath,
      )} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
    }
    try {
      const { stdout } = await execFileAsync('git', args, {
        env,
        timeout: this.config.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const remote = this.config.gitRepo;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `git ${args[0]} failed: ${remote ? detail.split(remote).join('<remote>') : detail}`,
      );
    }
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
      if (parsed && typeof parsed.body === 'string') {
        this.cache = {
          body: parsed.body,
          agents: typeof parsed.agents === 'string' ? parsed.agents : '',
          commit: typeof parsed.commit === 'string' ? parsed.commit : undefined,
          fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0,
        };
      }
    } catch {
      // No usable cache yet: the first read populates it.
    }
  }
}
