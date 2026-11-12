import type { Tool } from '../../types/index.js';
import { getStartupBundle } from './startupBundle.js';

/**
 * The startup-bundle MCP tool. It is listed next to the real tools on every
 * route and returns exactly what GET /startup returns, so a client that cannot
 * inject the bundle through a hook can still fetch it with one call.
 */
export const STARTUP_BUNDLE_TOOL_NAME = 'startup-bundle';

/**
 * The tool only joins the listed surface when the startup catalog is actually
 * provisioned for this instance. Instances that never read the bundle keep
 * their tool lists exactly as before.
 */
export const isStartupCatalogEnabled = (): boolean => {
  const env = process.env;
  return Boolean(
    (env.CATALOG_READ_TOKEN ?? '').trim() ||
      (env.SKILLS_BUNDLE_LOCAL_PATH ?? '').trim() ||
      (env.SKILLS_BUNDLE_GIT_REPO ?? '').trim(),
  );
};

export const getStartupBundleToolDefinition = (): Tool => ({
  name: STARTUP_BUNDLE_TOOL_NAME,
  title: 'Startup bundle',
  description:
    'Return the session startup bundle: the preloaded skill bodies followed by a live one-line-per-server capability catalog. Call it once at session start, and again after resuming, clearing or compacting a session.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    title: 'Startup bundle',
    readOnlyHint: true,
  },
});

export const buildStartupBundleToolResult = async (): Promise<{
  content: Array<{ type: 'text'; text: string }>;
}> => {
  const text = await getStartupBundle();
  return { content: [{ type: 'text', text }] };
};
