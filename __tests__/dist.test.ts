import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CreateNodes, CreateNodesContext, TargetConfiguration } from '@nx/devkit';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

interface DerivedProjects {
  projects?: Record<string, { targets: Record<string, TargetConfiguration> }>;
}

const CONTEXT = { nxJsonConfiguration: {}, workspaceRoot: '/workspace' } as CreateNodesContext;
const PROJECT_ROOT = 'libraries/consumer';
const PLUGIN_SUBPATHS = ['biome', 'knip', 'externals'];

/**
 * Everything here goes through the package's own name rather than a relative
 * path into `dist`. That is the one thing the source tests cannot cover: a
 * consumer — Nx included — reaches these files only through the `exports` map,
 * so resolving them the same way exercises the map, the built output, and the
 * paths those bundles resolve at runtime all at once.
 */
async function importSubpath(subpath: string): Promise<Record<string, unknown>> {
  return (await import(/* @vite-ignore */ `@planttheidea/nx-monorepo-tools/${subpath}`)) as Record<string, unknown>;
}

async function getTargets(createNodesV2: CreateNodes<object>): Promise<Record<string, TargetConfiguration>> {
  const [, deriveNodes] = createNodesV2;
  const results = await deriveNodes([`${PROJECT_ROOT}/package.json`], {}, CONTEXT);
  const { projects = {} } = (results.at(0)?.at(1) ?? {}) as DerivedProjects;

  return projects[PROJECT_ROOT]?.targets ?? {};
}

describe.each(PLUGIN_SUBPATHS)('%s', (subpath) => {
  test('resolves through the package name, the way Nx loads a plugin', async () => {
    await expect(importSubpath(subpath)).resolves.toHaveProperty('createNodesV2');
  });

  test('exports the glob and the derivation Nx reads off a plugin', async () => {
    const { createNodesV2 } = await importSubpath(subpath);
    const [glob, deriveNodes] = createNodesV2 as CreateNodes<object>;

    expect(glob).toBe('**/package.json');
    expect(typeof deriveNodes).toBe('function');
  });

  /**
   * The bundles resolve two of these by path at runtime. A file rollup failed
   * to write, or wrote somewhere else, produces a command that fails only when
   * a workspace runs the target.
   */
  test('resolves every file its commands name to something on disk', async () => {
    const { createNodesV2 } = await importSubpath(subpath);
    const named = Object.values(await getTargets(createNodesV2 as CreateNodes<object>))
      .flatMap(({ command }) => (typeof command === 'string' ? command.split(' ') : []))
      .filter((argument) => argument.endsWith('.mjs'));

    for (const path of named) {
      expect(existsSync(path), `${path} is named by a ${subpath} command but was not built`).toBe(true);
    }
  });
});

describe('package entry', () => {
  test('exports the factory the plugins are built from', async () => {
    await expect(import('@planttheidea/nx-monorepo-tools')).resolves.toHaveProperty('createPackageJsonNodes');
  });
});

describe('knip/config', () => {
  let originalCwd: string;
  let workspaceRoot: string;

  function createOverrides(projectRoot: string, contents: string): void {
    mkdirSync(join(workspaceRoot, projectRoot), { recursive: true });
    writeFileSync(join(workspaceRoot, projectRoot, '.kniprc.ts'), contents);
  }

  async function getCreateConfig() {
    const { default: createConfig } = await importSubpath('knip/config');

    return createConfig as (options?: { directory?: string }) => Promise<Record<string, unknown>>;
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    workspaceRoot = mkdtempSync(join(tmpdir(), 'dist-knip-'));
    process.chdir(workspaceRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(workspaceRoot, { force: true, recursive: true });
  });

  /**
   * The base is a separate module that rollup inlines into this bundle, and the
   * sidecar entries treeshake at the `smallest` preset. Nothing in the source
   * tests would notice it being dropped.
   */
  test('still carries the base configuration after bundling', async () => {
    const createConfig = await getCreateConfig();

    mkdirSync(join(workspaceRoot, 'libraries/plain'), { recursive: true });

    await expect(createConfig({ directory: 'libraries/plain' })).resolves.toEqual({
      entry: ['src/**/*.ts'],
      ignore: ['dist/**', 'out-tsc/**'],
      include: ['dependencies', 'devDependencies', 'optionalPeerDependencies'],
      treatConfigHintsAsErrors: true,
    });
  });

  /**
   * The overrides file is TypeScript loaded by a plain `.mjs` at runtime, which
   * leans on Node stripping its types. Under vitest the same import goes
   * through a transform instead, so this path is only ever really exercised
   * here.
   */
  test('loads a TypeScript overrides file from the bundle, with no transform in front of it', async () => {
    const createConfig = await getCreateConfig();

    createOverrides(
      'libraries/consumer',
      [
        "import type { KnipConfig } from 'knip';",
        '',
        'export const config: KnipConfig = {',
        "  entry: ['src/**/*.tsx'],",
        "  ignoreDependencies: ['tsx'],",
        '};',
        '',
        'export default config;',
      ].join('\n'),
    );

    await expect(createConfig({ directory: 'libraries/consumer' })).resolves.toMatchObject({
      entry: ['src/**/*.tsx', '.kniprc.ts'],
      ignoreDependencies: ['tsx'],
      include: ['dependencies', 'devDependencies', 'optionalPeerDependencies'],
    });
  });
});

/**
 * The check is spawned by Nx as a bare `node <path>`, with none of the
 * resolution a test runner would otherwise supply. Running the built file the
 * same way is the only thing that proves the shipped artifact is executable at
 * all.
 */
describe('externals check', () => {
  let workspaceRoot: string;

  async function getCheckPath(): Promise<string> {
    const { createNodesV2 } = await importSubpath('externals');
    const { command } = (await getTargets(createNodesV2 as CreateNodes<object>)).externals ?? {};

    return (command ?? '').split(' ').at(1) ?? '';
  }

  function createProject(root: string, dependencies: Record<string, string>, external?: string[]): void {
    mkdirSync(join(workspaceRoot, root), { recursive: true });
    writeFileSync(join(workspaceRoot, root, 'package.json'), JSON.stringify({ name: root, dependencies }));
    writeFileSync(
      join(workspaceRoot, root, 'project.json'),
      JSON.stringify({ targets: { build: { executor: '@nx/esbuild:esbuild', options: { external } } } }),
    );
  }

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'dist-externals-'));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { force: true, recursive: true });
  });

  test('is written beside the plugin that spawns it', async () => {
    const checkPath = await getCheckPath();

    expect(existsSync(checkPath)).toBe(true);
    expect(dirname(checkPath)).toBe(
      dirname(fileURLToPath(import.meta.resolve('@planttheidea/nx-monorepo-tools/externals'))),
    );
  });

  test('exits 0 for a compliant project', async () => {
    createProject('libraries/consumer', { 'ribi-database': 'workspace:*' }, ['ribi-database']);

    const { status } = spawnSync('node', [await getCheckPath(), 'libraries/consumer'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
    });

    expect(status).toBe(0);
  });

  test('exits 1 and names the dependency for a project that inlines one', async () => {
    createProject('libraries/consumer', { 'ribi-database': 'workspace:*' });

    const { status, stderr } = spawnSync('node', [await getCheckPath(), 'libraries/consumer'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
    });

    expect(status).toBe(1);
    expect(stderr).toContain('"ribi-database"');
  });

  test('sweeps the workspace it is run from when given no project', async () => {
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ workspaces: ['libraries/*'] }));
    createProject('libraries/violating', { 'ribi-shared': 'workspace:*' });

    const { status, stderr } = spawnSync('node', [await getCheckPath()], { cwd: workspaceRoot, encoding: 'utf8' });

    expect(status).toBe(1);
    expect(stderr).toContain('libraries/violating');
  });
});
