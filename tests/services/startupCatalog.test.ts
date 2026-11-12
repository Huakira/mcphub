import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCompactCatalog } from '../../src/services/startupCatalog/compactCatalog.js';
import {
  buildServerDigest,
  fingerprintPairs,
  serverFingerprint,
} from '../../src/services/startupCatalog/fingerprint.js';
import {
  parseSkillList,
  SkillsBundleSource,
  stripFrontMatter,
} from '../../src/services/startupCatalog/skillsBundle.js';
import {
  CatalogSummaries,
  type LlmClient,
} from '../../src/services/startupCatalog/summaries.js';
import {
  configureStartupBundle,
  getStartupBundle,
  resetStartupBundleCache,
  setCatalogSummaries,
  setSkillsBundleSource,
} from '../../src/services/startupCatalog/startupBundle.js';
import { buildStartupBundleToolResult } from '../../src/services/startupCatalog/builtinTool.js';
import { catalogTokenAuth } from '../../src/middlewares/catalogToken.js';
import type { CatalogSnapshot } from '../../src/services/startupCatalog/types.js';

const makeTempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'startup-catalog-'));

const snapshot = (servers: CatalogSnapshot['servers']): CatalogSnapshot => ({
  separator: '-',
  servers,
});

describe('skill list parsing', () => {
  it('reads only the names between the preload markers', () => {
    const markdown = [
      '# 预加载',
      '- `not-a-skill`',
      '<!-- preload:skills:start -->',
      '- `agent-startup`',
      '- `search-discipline`',
      '- `mcphub-catalog`',
      '<!-- preload:skills:end -->',
      '- `also-not-a-skill`',
    ].join('\n');
    expect(parseSkillList(markdown)).toEqual([
      'agent-startup',
      'search-discipline',
      'mcphub-catalog',
    ]);
  });

  it('returns nothing when the markers are missing', () => {
    expect(parseSkillList('- `agent-startup`')).toEqual([]);
  });

  it('strips YAML front matter but keeps the body', () => {
    const text = ['---', 'name: x', 'description: y', '---', '', '# Body'].join('\n');
    expect(stripFrontMatter(text)).toBe('\n# Body');
  });
});

describe('SkillsBundleSource', () => {
  it('assembles the listed skills from a local directory', async () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, 'skills', 'preload'), { recursive: true });
    fs.mkdirSync(path.join(root, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'skills', 'preload', 'SKILL.md'),
      '<!-- preload:skills:start -->\n- `demo`\n<!-- preload:skills:end -->\n',
    );
    fs.writeFileSync(
      path.join(root, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: d\n---\n\n## 用法\n\n跑 scripts/demo.py。\n',
    );

    const source = new SkillsBundleSource({
      localPath: root,
      ref: 'main',
      preloadPath: 'skills/preload/SKILL.md',
      skillsRoot: 'skills',
      cachePath: path.join(root, 'cache.json'),
      ttlMs: 0,
      timeoutMs: 1000,
    });
    const { body } = await source.getBody();
    expect(body).toContain('# 开场技能（1 个）');
    expect(body).toContain('## demo');
    expect(body).toContain('来源：skills/demo/SKILL.md');
    expect(body).toContain('以 skills/demo/ 为基准');
    expect(body).toContain('跑 scripts/demo.py。');
    expect(body).toContain('已全部加载');
    expect(body).not.toContain('description: d');
  });

  it('keeps the last copy when the source disappears', async () => {
    const root = makeTempDir();
    const skillsRoot = path.join(root, 'skills');
    fs.mkdirSync(path.join(skillsRoot, 'preload'), { recursive: true });
    fs.mkdirSync(path.join(skillsRoot, 'demo'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsRoot, 'preload', 'SKILL.md'),
      '<!-- preload:skills:start -->\n- `demo`\n<!-- preload:skills:end -->\n',
    );
    fs.writeFileSync(path.join(skillsRoot, 'demo', 'SKILL.md'), '## demo body\n');

    const source = new SkillsBundleSource({
      localPath: root,
      ref: 'main',
      preloadPath: 'skills/preload/SKILL.md',
      skillsRoot: 'skills',
      cachePath: path.join(root, 'cache.json'),
      ttlMs: 0,
      timeoutMs: 1000,
    });
    const first = await source.getBody();
    expect(first.body).toContain('## demo body');

    fs.rmSync(skillsRoot, { recursive: true, force: true });
    const second = await source.getBody();
    expect(second.body).toBe(first.body);
    expect(second.stale).toBe(true);
  });
});

describe('compact catalog', () => {
  const rows = [
    { name: 'tikhub', toolCount: 628, summary: '抓抖音、小红书、TikTok 等平台数据' },
    { name: 'zotero', toolCount: 12, summary: '读写 Zotero 文献库' },
    { name: 'empty', toolCount: 0 },
  ];

  it('drops servers without tools and keeps name plus summary', () => {
    const text = buildCompactCatalog(rows, { budget: 1000 });
    expect(text).toContain('tikhub');
    expect(text).toContain('抓抖音');
    expect(text).not.toContain('empty');
  });

  it('fits a small budget by trimming summaries and rows', () => {
    const text = buildCompactCatalog(rows, { budget: 60 });
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).toContain('tikhub');
  });
});

describe('server fingerprints', () => {
  const server = {
    name: 'zotero',
    tools: [
      { name: 'zotero-search', description: 'Search items' },
      { name: 'zotero-add', description: 'Add an item' },
    ],
  };

  it('is stable and independent of tool order', () => {
    const forward = serverFingerprint(fingerprintPairs(server, '-'));
    const reversed = serverFingerprint(
      fingerprintPairs({ ...server, tools: [...server.tools].reverse() }, '-'),
    );
    expect(forward).toBe(reversed);
    expect(forward).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when a description changes', () => {
    const changed = serverFingerprint(
      fingerprintPairs(
        { ...server, tools: [{ ...server.tools[0], description: 'Search items (v2)' }, server.tools[1]] },
        '-',
      ),
    );
    expect(changed).not.toBe(serverFingerprint(fingerprintPairs(server, '-')));
  });

  it('builds a digest with short names and the tool count', () => {
    const { digest } = buildServerDigest(server, '-');
    expect(digest).toContain('工具（共 2 个）');
    expect(digest).toContain('- add: Add an item');
    expect(digest).toContain('- search: Search items');
  });
});

describe('CatalogSummaries', () => {
  const buildStore = (dir: string, data: unknown): string => {
    const file = path.join(dir, 'store.json');
    fs.writeFileSync(file, JSON.stringify(data));
    return file;
  };

  it('imports seed summaries by fingerprint and only calls the LLM for changed servers', async () => {
    const dir = makeTempDir();
    const stable = { name: 'stable', tools: [{ name: 'stable-a', description: 'A' }] };
    const changed = { name: 'changed', tools: [{ name: 'changed-a', description: 'A' }] };
    const { fingerprint: stablePrint } = buildServerDigest(stable, '-');
    const { fingerprint: changedPrint } = buildServerDigest(changed, '-');

    const seedPath = path.join(dir, 'seed.json');
    fs.writeFileSync(
      seedPath,
      JSON.stringify({
        servers: {
          stable: { summary: '稳定简介', fingerprint: stablePrint },
          changed: { summary: '旧简介', fingerprint: 'stale-fingerprint' },
        },
        lastGoodModel: 'seed-model',
      }),
    );

    const calls: string[] = [];
    const llm: LlmClient = {
      candidates: () => ['test-model'],
      summarize: async (request) => {
        calls.push(request.server);
        return { summary: `新简介-${request.server}`, model: 'test-model' };
      },
    };
    const service = new CatalogSummaries({
      storePath: path.join(dir, 'store.json'),
      seedPath,
      llm,
      debounceMs: 0,
    });
    await service.init();
    service.setSnapshot(snapshot([stable, changed]));
    await service.flush();
    await service.flush();

    expect(calls).toEqual(['changed']);
    const rows = service.getRows();
    expect(rows.find((row) => row.name === 'stable')?.summary).toBe('稳定简介');
    expect(rows.find((row) => row.name === 'changed')?.summary).toBe('新简介-changed');
    service.close();
  });

  it('does not summarize unchanged tools twice', async () => {
    const dir = makeTempDir();
    const server = { name: 'svc', tools: [{ name: 'svc-run', description: 'Run' }] };
    const calls: string[] = [];
    const service = new CatalogSummaries({
      storePath: path.join(dir, 'store.json'),
      llm: {
        candidates: () => ['m'],
        summarize: async (request) => {
          calls.push(request.server);
          return { summary: '一句简介', model: 'm' };
        },
      },
      debounceMs: 0,
    });
    await service.init();
    service.setSnapshot(snapshot([server]));
    await service.flush();
    await service.flush();
    expect(calls).toEqual(['svc']);
    service.close();
  });

  it('keeps unsummarized servers when no LLM is configured', async () => {
    const dir = makeTempDir();
    const service = new CatalogSummaries({
      storePath: path.join(dir, 'store.json'),
      llm: null,
      debounceMs: 0,
    });
    await service.init();
    service.setSnapshot(snapshot([{ name: 'svc', tools: [{ name: 'svc-run', description: 'Run' }] }]));
    await service.flush();
    const row = service.getRows()[0];
    expect(row.summary).toBeUndefined();
    expect(row.sampleTools).toEqual(['run']);
    service.close();
  });

  it('fails backoff so a broken server is not retried on every round', async () => {
    const dir = makeTempDir();
    let calls = 0;
    let now = 1000;
    const service = new CatalogSummaries({
      storePath: path.join(dir, 'store.json'),
      llm: {
        candidates: () => ['m'],
        summarize: async () => {
          calls += 1;
          throw new Error('boom');
        },
      },
      debounceMs: 0,
      backoffBaseMs: 1000,
      now: () => now,
    });
    await service.init();
    service.setSnapshot(snapshot([{ name: 'svc', tools: [{ name: 'svc-run', description: 'Run' }] }]));
    await service.flush();
    expect(calls).toBe(1);
    await service.flush();
    expect(calls).toBe(1);
    now += 5000;
    await service.flush();
    expect(calls).toBe(2);
    service.close();
  });
});

describe('catalog token gate', () => {
  const makeRes = () => {
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(payload: unknown) {
        res.body = payload;
        return res;
      },
    };
    return res;
  };

  const run = (authorization: string | undefined, token: string | undefined) => {
    process.env.CATALOG_READ_TOKEN = token;
    const req = {
      get: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
    };
    const res = makeRes();
    const next = jest.fn();
    catalogTokenAuth(req as never, res as never, next);
    return { res, next };
  };

  afterEach(() => {
    delete process.env.CATALOG_READ_TOKEN;
  });

  it('rejects missing and wrong tokens with 401', () => {
    expect(run(undefined, 'secret').res.statusCode).toBe(401);
    expect(run('Bearer nope', 'secret').res.statusCode).toBe(401);
    expect(run('Bearer secret', undefined).res.statusCode).toBe(401);
  });

  it('accepts the configured token', () => {
    const { res, next } = run('Bearer secret', 'secret');
    expect(res.statusCode).toBe(200);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('startup bundle equality', () => {
  it('returns the same bytes through GET /startup and the MCP tool', async () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, 'skills', 'preload'), { recursive: true });
    fs.mkdirSync(path.join(root, 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'skills', 'preload', 'SKILL.md'),
      '<!-- preload:skills:start -->\n- `demo`\n<!-- preload:skills:end -->\n',
    );
    fs.writeFileSync(path.join(root, 'skills', 'demo', 'SKILL.md'), '## demo\n\n做事。\n');

    setSkillsBundleSource(
      new SkillsBundleSource({
        localPath: root,
        ref: 'main',
        preloadPath: 'skills/preload/SKILL.md',
        skillsRoot: 'skills',
        cachePath: path.join(root, 'cache.json'),
        ttlMs: 0,
        timeoutMs: 1000,
      }),
    );
    setCatalogSummaries(null);
    configureStartupBundle({ bundleTtlMs: 0, compactBudget: 400 });
    resetStartupBundleCache();

    const httpBody = await getStartupBundle();
    const toolBody = await buildStartupBundleToolResult();
    expect(httpBody.startsWith('STARTUP-BUNDLE ')).toBe(true);
    expect(httpBody).toContain('## 服务器目录（实时）');
    expect(toolBody.content[0].text).toBe(httpBody);
  });
});
