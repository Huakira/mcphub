import { logger } from '../../utils/logger.js';
import { mcpEventBus } from '../mcpEventBus.js';
import { getStartupCatalogConfig, isAllowedLlmBaseUrl } from './config.js';
import { CatalogSummaries, createLlmClient, type LlmClient } from './summaries.js';
import { SkillsBundleSource } from './skillsBundle.js';
import {
  configureStartupBundle,
  getCatalogSummaries,
  getStartupBundleSnapshotProvider,
  setCatalogSummaries,
  setSkillsBundleSource,
} from './startupBundle.js';

/**
 * Wiring for the startup catalog: build the summary service, subscribe to the
 * MCP event bus (tool list changes only, no polling) and refresh the snapshot.
 * The snapshot itself is supplied by mcpService, which owns server state.
 */

let initialized = false;
let unsubscribe: (() => void) | null = null;

export const initStartupCatalog = async (): Promise<void> => {
  if (initialized) {
    return;
  }
  initialized = true;
  const config = getStartupCatalogConfig();
  configureStartupBundle({ bundleTtlMs: config.bundleTtlMs, compactBudget: config.compactBudget });
  setSkillsBundleSource(new SkillsBundleSource(config.skills));

  let llm: LlmClient | null = null;
  if (!config.llm) {
    logger.log(
      'CATALOG_LLM_BASE_URL / CATALOG_LLM_API_KEY not set; server summaries will not be generated.',
    );
  } else if (!isAllowedLlmBaseUrl(config.llm.baseUrl)) {
    logger.warn(
      'CATALOG_LLM_BASE_URL must be https (or http on loopback) without credentials, query or fragment; server summaries stay off.',
    );
  } else {
    llm = createLlmClient(config.llm);
  }

  const service = new CatalogSummaries({
    storePath: config.storePath,
    seedPath: config.seedPath,
    llm,
    debounceMs: config.debounceMs,
    concurrency: config.concurrency,
    backoffBaseMs: config.backoffBaseMs,
    backoffMaxMs: config.backoffMaxMs,
    flushBudgetMs: config.flushBudgetMs,
  });
  await service.init();
  setCatalogSummaries(service);

  unsubscribe = mcpEventBus.subscribe((event) => {
    if ((event as { kind?: string } | undefined)?.kind !== 'tools_list_changed') {
      return;
    }
    void refreshStartupCatalog();
  });

  await refreshStartupCatalog();
  logger.log(
    `Startup catalog ready (summaries ${llm ? 'on' : 'off'}, store ${config.storePath})`,
  );
};

/** Re-read the served tool snapshot and let the summary service reconcile it. */
export const refreshStartupCatalog = async (): Promise<void> => {
  const provider = getStartupBundleSnapshotProvider();
  const service = getCatalogSummaries();
  if (!provider || !service) {
    return;
  }
  try {
    service.setSnapshot(await provider());
  } catch (error) {
    logger.warn(
      'Failed to refresh the startup catalog snapshot',
      error instanceof Error ? error.message : error,
    );
  }
};

/** Test/reset hook: stop listening and release timers. */
export const stopStartupCatalog = (): void => {
  unsubscribe?.();
  unsubscribe = null;
  getCatalogSummaries()?.close();
  setCatalogSummaries(null);
  initialized = false;
};
