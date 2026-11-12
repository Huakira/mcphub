import path from 'node:path';
import type { LlmConfig } from './summaries.js';

/**
 * Environment-driven settings for the startup catalog: summary scheduling, the
 * authenticated read endpoints, and where the skill bodies come from.
 * Everything is optional except CATALOG_READ_TOKEN, which gates /catalog.
 */

export interface SkillsBundleConfig {
  /** Git remote, normally git@github.com:Huakira/skills.git. */
  gitRepo?: string;
  /** Read-only deploy key used by git over SSH. */
  gitSshKeyPath?: string;
  /** Bare repository cache; no working tree is created. */
  gitCachePath: string;
  ref: string;
  /** Root of a local skills checkout; wins over the git remote when set. */
  localPath?: string;
  /** Preload file whose markers list the skills to bundle. */
  preloadPath: string;
  /** Repo-root instruction file rendered ahead of the skills. */
  agentsPath?: string;
  /** Directory holding <name>/SKILL.md. */
  skillsRoot: string;
  cachePath: string;
  ttlMs: number;
  timeoutMs: number;
}

export interface StartupCatalogConfig {
  readToken: string;
  storePath: string;
  seedPath?: string;
  llm: LlmConfig | null;
  debounceMs: number;
  concurrency: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  flushBudgetMs: number;
  bundleTtlMs: number;
  compactBudget: number;
  skills: SkillsBundleConfig;
}

const readString = (name: string): string | undefined => {
  const value = (process.env[name] ?? '').trim();
  return value ? value : undefined;
};

const readInt = (name: string, fallback: number, min: number, max: number): number => {
  const raw = readString(name);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
};

const defaultDataDir = (): string => path.resolve(process.cwd(), 'data');

/** https anywhere, or http on loopback only — never credentials, query or fragment. */
export const isAllowedLlmBaseUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
    const schemeOk = url.protocol === 'https:' || (url.protocol === 'http:' && local);
    return (
      schemeOk &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
};

export const getStartupCatalogConfig = (): StartupCatalogConfig => {
  const dataDir = defaultDataDir();
  const llmBaseUrl = readString('CATALOG_LLM_BASE_URL');
  const llmApiKey = readString('CATALOG_LLM_API_KEY');
  const llm: LlmConfig | null =
    llmBaseUrl && llmApiKey
      ? {
          baseUrl: llmBaseUrl.replace(/\/+$/, ''),
          apiKey: llmApiKey,
          model: readString('CATALOG_LLM_MODEL'),
          fallbackModel: readString('CATALOG_LLM_FALLBACK_MODEL'),
        }
      : null;

  return {
    readToken: readString('CATALOG_READ_TOKEN') ?? '',
    storePath: readString('CATALOG_SUMMARY_STORE') ?? path.join(dataDir, 'catalog-summaries.json'),
    seedPath: readString('CATALOG_SUMMARY_SEED'),
    llm,
    debounceMs: readInt('CATALOG_SUMMARY_DEBOUNCE_MS', 2000, 0, 60000),
    concurrency: readInt('CATALOG_SUMMARY_CONCURRENCY', 2, 1, 16),
    backoffBaseMs: readInt('CATALOG_SUMMARY_BACKOFF_BASE_MS', 30000, 1000, 3600000),
    backoffMaxMs: readInt('CATALOG_SUMMARY_BACKOFF_MAX_MS', 300000, 1000, 86400000),
    flushBudgetMs: readInt('CATALOG_SUMMARY_BUDGET_MS', 40000, 5000, 600000),
    bundleTtlMs: readInt('STARTUP_BUNDLE_TTL_MS', 0, 0, 3600000),
    compactBudget: readInt('STARTUP_CATALOG_BUDGET_CHARS', 1000, 200, 20000),
    skills: {
      gitRepo: readString('SKILLS_BUNDLE_GIT_REPO'),
      gitSshKeyPath: readString('SKILLS_BUNDLE_GIT_SSH_KEY'),
      gitCachePath:
        readString('SKILLS_BUNDLE_GIT_CACHE') ?? path.join(dataDir, 'startup-skills.git'),
      ref: readString('SKILLS_BUNDLE_REF') ?? 'main',
      localPath: readString('SKILLS_BUNDLE_LOCAL_PATH'),
      preloadPath: readString('SKILLS_BUNDLE_PRELOAD') ?? 'skills/preload/SKILL.md',
      agentsPath: readString('SKILLS_BUNDLE_AGENTS') ?? 'AGENTS.md',
      skillsRoot: readString('SKILLS_BUNDLE_ROOT') ?? 'skills',
      cachePath: readString('SKILLS_BUNDLE_CACHE') ?? path.join(dataDir, 'startup-skills.json'),
      ttlMs: readInt('SKILLS_BUNDLE_TTL_MS', 0, 0, 86400000),
      timeoutMs: readInt('SKILLS_BUNDLE_TIMEOUT_MS', 8000, 1000, 60000),
    },
  };
};
