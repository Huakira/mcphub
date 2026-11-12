/**
 * Snapshot and payload types shared by the startup catalog service.
 *
 * The snapshot is what MCPHub currently serves to downstream clients (server
 * name + its cached tools, after description overrides). The catalog payload is
 * the JSON view exposed on GET /catalog and rendered into the startup bundle.
 */

export interface CatalogToolSnapshot {
  name: string;
  description?: string;
}

export interface CatalogServerSnapshot {
  name: string;
  tools: CatalogToolSnapshot[];
}

export interface CatalogSnapshot {
  /** MCPHub nameSeparator, used to qualify tool names the same way clients see them. */
  separator: string;
  servers: CatalogServerSnapshot[];
}

export interface CatalogRow {
  name: string;
  toolCount: number;
  summary?: string;
  sampleTools?: string[];
}

export interface CatalogPayload {
  generatedAt: string;
  totalTools: number;
  servers: CatalogRow[];
  note: string;
}
