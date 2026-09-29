import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  getBuildOutputImports,
  getEffectiveConditions,
  getExportEntries,
  getSourcesReport,
  getResolveEnvironments,
  getSourceConditions,
  getViteConfigFile,
  isBuildOutput,
  resolveExportTarget,
} from '../src/boundaries/sources.js';

/** The built file, for the same reason as the externals check: it is what Nx runs. */
const CHECK_FILE_PATH = join(import.meta.dirname, '..', 'dist', 'es', 'boundaries', 'check.mjs');

const VITE = {
  defaultClientConditions: ['module', 'browser', 'development|production'],
  defaultServerConditions: ['module', 'node', 'development|production'],
  loadConfigFromFile: () => Promise.resolve(null),
};

/** A library exposing source under `source` and build output under everything else. */
const SOURCE_EXPORTS = {
  './package.json': './package.json',
  '.': {
    source: './src/index.ts',
    types: './out-tsc/index.d.ts',
    import: './dist/index.js',
    default: './dist/index.js',
  },
};

/** A library with no source entry at all. */
const BUILD_ONLY_EXPORTS = {
  '.': { types: './out-tsc/index.d.ts', import: './dist/index.js', default: './dist/index.js' },
};

describe('resolveExportTarget', () => {
  test('returns a string target as-is', () => {
    expect(resolveExportTarget('./dist/index.js', new Set())).toBe('./dist/index.js');
  });

  test('picks the first key the conditions include, in the object own order', () => {
    const target = { source: './src/index.ts', import: './dist/index.js' };

    expect(resolveExportTarget(target, new Set(['import', 'source']))).toBe('./src/index.ts');
  });

  test('falls through to default when no named condition matches', () => {
    expect(resolveExportTarget({ source: './src/index.ts', default: './dist/index.js' }, new Set())).toBe(
      './dist/index.js',
    );
  });

  test('resolves nested conditions', () => {
    const target = { import: { types: './index.d.ts', default: './dist/index.mjs' } };

    expect(resolveExportTarget(target, new Set(['import']))).toBe('./dist/index.mjs');
  });

  test('moves on to the next key when a matching branch resolves nothing', () => {
    const target = { import: { browser: './browser.js' }, default: './dist/index.js' };

    expect(resolveExportTarget(target, new Set(['import']))).toBe('./dist/index.js');
  });

  test('tries array entries in order', () => {
    expect(resolveExportTarget([{ node: './node.js' }, './fallback.js'], new Set())).toBe('./fallback.js');
  });

  test('returns undefined when nothing matches', () => {
    expect(resolveExportTarget({ node: './node.js' }, new Set(['browser']))).toBeUndefined();
  });
});

describe('getExportEntries', () => {
  test('lists each subpath, leaving out package.json', () => {
    expect(getExportEntries({ exports: SOURCE_EXPORTS }).map(([subpath]) => subpath)).toEqual(['.']);
  });

  test('treats a bare string as the root export', () => {
    expect(getExportEntries({ exports: './dist/index.js' })).toEqual([['.', './dist/index.js']]);
  });

  test('treats a conditions object as the root export', () => {
    const exports = { import: './dist/index.js' };

    expect(getExportEntries({ exports })).toEqual([['.', exports]]);
  });

  test('falls back to module, then main, without exports', () => {
    expect(getExportEntries({ module: './dist/index.mjs', main: './dist/index.cjs' })).toEqual([
      ['.', './dist/index.mjs'],
    ]);
    expect(getExportEntries({ main: './dist/index.cjs' })).toEqual([['.', './dist/index.cjs']]);
  });

  test('returns nothing for a package with no entry at all', () => {
    expect(getExportEntries({})).toEqual([]);
  });
});

describe('isBuildOutput', () => {
  test.each(['./dist/index.js', './build/index.js', './lib/index.js', './out-tsc/lib/index.d.ts', 'dist/src/index.js'])(
    'flags %s',
    (target) => {
      expect(isBuildOutput(target)).toBe(true);
    },
  );

  test.each(['./src/index.ts', './testing/index.ts', './distance.ts', './library/index.ts'])(
    'does not flag %s',
    (target) => {
      expect(isBuildOutput(target)).toBe(false);
    },
  );
});

describe('getSourceConditions', () => {
  test('names the conditions that reach source', () => {
    expect(getSourceConditions(SOURCE_EXPORTS['.'])).toEqual(['source']);
  });

  test('ignores types, which no bundler loads', () => {
    expect(getSourceConditions({ types: './src/index.d.ts', default: './dist/index.js' })).toEqual([]);
  });

  test('returns nothing for a library without a source entry', () => {
    expect(getSourceConditions(BUILD_ONLY_EXPORTS['.'])).toEqual([]);
  });

  test('returns nothing for a bare string target', () => {
    expect(getSourceConditions('./src/index.ts')).toEqual([]);
  });
});

describe('getEffectiveConditions', () => {
  test('adds import and default, and resolves the mode placeholder to production', () => {
    expect([...getEffectiveConditions(['apps', 'development|production'])]).toEqual([
      'apps',
      'production',
      'import',
      'default',
    ]);
  });
});

describe('getResolveEnvironments', () => {
  test("falls back to Vite's defaults for client and ssr", () => {
    expect(getResolveEnvironments({}, VITE)).toEqual([
      { name: 'client', conditions: VITE.defaultClientConditions },
      { name: 'ssr', conditions: VITE.defaultServerConditions },
    ]);
  });

  test('reads client and ssr conditions from the config', () => {
    const environments = getResolveEnvironments(
      { resolve: { conditions: ['apps'] }, ssr: { resolve: { conditions: ['apps', 'node'] } } },
      VITE,
    );

    expect(environments).toEqual([
      { name: 'client', conditions: ['apps'] },
      { name: 'ssr', conditions: ['apps', 'node'] },
    ]);
  });

  test('lets an environment entry override or add to them', () => {
    const environments = getResolveEnvironments(
      { environments: { ssr: { resolve: { conditions: ['edge'] } }, worker: { resolve: { conditions: ['worker'] } } } },
      VITE,
    );

    expect(environments).toEqual([
      { name: 'client', conditions: VITE.defaultClientConditions },
      { name: 'ssr', conditions: ['edge'] },
      { name: 'worker', conditions: ['worker'] },
    ]);
  });
});

describe('getBuildOutputImports', () => {
  const dependencies = [{ name: 'shared', manifest: { exports: SOURCE_EXPORTS } }];

  test('reports a dependency resolving to build output, with the condition that would fix it', () => {
    expect(getBuildOutputImports([{ name: 'client', conditions: ['module'] }], dependencies)).toEqual([
      {
        environment: 'client',
        dependency: 'shared',
        subpath: '.',
        target: './dist/index.js',
        sourceConditions: ['source'],
      },
    ]);
  });

  test('reports nothing once the consumer lists the source condition', () => {
    expect(getBuildOutputImports([{ name: 'client', conditions: ['source', 'module'] }], dependencies)).toEqual([]);
  });

  test('reports each environment separately', () => {
    const imports = getBuildOutputImports(
      [
        { name: 'client', conditions: ['source'] },
        { name: 'ssr', conditions: ['node'] },
      ],
      dependencies,
    );

    expect(imports.map(({ environment }) => environment)).toEqual(['ssr']);
  });
});

describe('getSourcesReport', () => {
  test('suggests the condition the library already answers to', () => {
    const report = getSourcesReport('applications/app', [
      {
        environment: 'client',
        dependency: 'shared',
        subpath: '.',
        target: './dist/index.js',
        sourceConditions: ['source'],
      },
    ]);

    expect(report).toContain('[client] shared → ./dist/index.js');
    expect(report).toContain("resolve: { conditions: ['source', ...defaultClientConditions] }");
  });

  test('suggests a source entry for a library that has none', () => {
    const report = getSourcesReport('applications/app', [
      {
        environment: 'client',
        dependency: 'shared',
        subpath: './testing',
        target: './dist/testing.js',
        sourceConditions: [],
      },
    ]);

    expect(report).toContain('[client] shared/testing → ./dist/testing.js');
    expect(report).toContain('Give "shared" a source entry');
    expect(report).not.toContain('resolve: { conditions');
  });
});

/**
 * The shell around the logic, run the way Nx runs it: the built file, the
 * workspace as the working directory, and a real Vite config for it to load.
 */
describe('boundaries check, sources rule', () => {
  let workspaceRoot: string;

  function setFile(relativePath: string, content: string): void {
    const absolute = join(workspaceRoot, relativePath);

    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content);
  }

  function createWorkspace(consumerConfig: string | undefined, libraryExports: unknown = SOURCE_EXPORTS): void {
    setFile('package.json', JSON.stringify({ workspaces: ['applications/*', 'libraries/*'] }));
    setFile('libraries/shared/package.json', JSON.stringify({ name: 'shared', exports: libraryExports }));
    setFile(
      'applications/app/package.json',
      JSON.stringify({ name: 'app', dependencies: { shared: 'workspace:*', react: '^19.0.0' } }),
    );

    if (consumerConfig !== undefined) {
      setFile('applications/app/vite.config.mjs', consumerConfig);
    }
  }

  function runCheck(...args: string[]) {
    return spawnSync('node', [CHECK_FILE_PATH, ...args], { cwd: workspaceRoot, encoding: 'utf8' });
  }

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'sources-'));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { force: true, recursive: true });
  });

  test('finds the config by name', () => {
    createWorkspace('export default {};');

    expect(getViteConfigFile(workspaceRoot, 'applications/app')).toBe(
      join(workspaceRoot, 'applications/app/vite.config.mjs'),
    );
    expect(getViteConfigFile(workspaceRoot, 'libraries/shared')).toBeUndefined();
  });

  test('exits 0 for a project without a Vite config', () => {
    createWorkspace(undefined);

    expect(runCheck('applications/app').status).toBe(0);
  });

  test('exits 1 and names the fix when a config resolves a library to build output', () => {
    createWorkspace('export default {};');

    const { status, stderr } = runCheck('applications/app');

    expect(status).toBe(1);
    expect(stderr).toContain('[sources] applications/app');
    expect(stderr).toContain('[client] shared → ./dist/index.js');
    expect(stderr).toContain('[ssr] shared → ./dist/index.js');
    expect(stderr).toContain("'source'");
  });

  test('exits 0 once both environments list the source condition', () => {
    createWorkspace(
      [
        'export default {',
        "  resolve: { conditions: ['source', 'module', 'browser'] },",
        "  ssr: { resolve: { conditions: ['source', 'module', 'node'] } },",
        '};',
      ].join('\n'),
    );

    expect(runCheck('applications/app').status).toBe(0);
  });

  test('reads a config exported as a function, loaded as a production build', () => {
    createWorkspace(
      [
        'export default ({ command, mode }) => {',
        "  if (command !== 'build' || mode !== 'production') {",
        "    throw new Error('loaded outside a production build');",
        '  }',
        '',
        "  return { resolve: { conditions: ['source'] }, ssr: { resolve: { conditions: ['source'] } } };",
        '};',
      ].join('\n'),
    );

    const { status, stderr } = runCheck('applications/app');

    expect(stderr).toBe('');
    expect(status).toBe(0);
  });

  test('asks for a source entry when the library has none', () => {
    createWorkspace('export default {};', BUILD_ONLY_EXPORTS);

    const { status, stderr } = runCheck('applications/app');

    expect(status).toBe(1);
    expect(stderr).toContain('Give "shared" a source entry');
  });

  test('reports every rule a project breaks, each under its own label', () => {
    createWorkspace('export default {};');
    setFile(
      'applications/app/project.json',
      JSON.stringify({ targets: { build: { executor: '@nx/esbuild:esbuild', options: { external: [] } } } }),
    );

    const { status, stderr } = runCheck('applications/app');

    expect(status).toBe(1);
    expect(stderr).toContain('[externals] applications/app');
    expect(stderr).toContain('[sources] applications/app');
  });

  test('sweeps every workspace package when given no project', () => {
    createWorkspace('export default {};');

    const { status, stderr } = runCheck();

    expect(status).toBe(1);
    expect(stderr).toContain('applications/app');
  });
});
