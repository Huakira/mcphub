import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { getCatalogPayload, getStartupBundle } from '../services/startupCatalog/startupBundle.js';

/**
 * Read endpoints for the startup catalog, both gated by catalogTokenAuth.
 * GET /catalog returns the JSON directory; GET /startup returns the bundle that
 * the session-start hook injects and that the startup-bundle MCP tool mirrors.
 */

export const getCatalog = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', 'no-store').json(await getCatalogPayload());
  } catch (error) {
    logger.warn(
      'Failed to build the catalog payload',
      error instanceof Error ? error.message : error,
    );
    next(error);
  }
};

export const getStartup = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const bundle = await getStartupBundle();
    res.type('text/plain; charset=utf-8').set('Cache-Control', 'no-store').send(bundle);
  } catch (error) {
    logger.warn(
      'Failed to build the startup bundle',
      error instanceof Error ? error.message : error,
    );
    next(error);
  }
};
