import type { NextFunction, Request, Response } from 'express';
import { hashBearerToken } from '../utils/bearerKeyToken.js';
import { safeCompare } from '../utils/safeCompare.js';

/**
 * Read-only bearer token for GET /catalog and GET /startup. It is separate from
 * the dashboard JWT: the token is meant to be embedded in client hook scripts,
 * so it only unlocks these two read endpoints. Missing or wrong tokens always
 * answer 401, never a partial payload.
 */
export const readCatalogToken = (): string => (process.env.CATALOG_READ_TOKEN ?? '').trim();

export const hasCatalogReadToken = (): boolean => readCatalogToken().length > 0;

export const catalogTokenAuth = (req: Request, res: Response, next: NextFunction): void => {
  const expected = readCatalogToken();
  if (!expected) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const header = req.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !safeCompare(hashBearerToken(match[1].trim()), hashBearerToken(expected))) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
};
