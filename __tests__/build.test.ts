import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { CreateNodes, CreateNodesContext, TargetConfiguration } from '@nx/devkit';
import { describe, expect, test } from 'vitest';
import rollupConfig from '../config/rollup.config.js';
import { createNodesV2 as externals } from '../src/externals/index.js';
import { createNodesV2 as knip } from '../src/knip/index.js';

type ExportEntry = string | { default?: string; import?: { default?: string } };

interface PackageManifest {
  exports: Record<string, ExportEntry>;
  main: string;
  module: string;
  types: string;
}

interface RollupOutput {
  file?: string;
}

interface DerivedProjects {
  projects?: Record<string, { targets: Record<string, TargetConfiguration> }>;
}

const CONTEXT = { nxJsonConfiguration: {}, workspaceRoot: '/workspace' } as CreateNodesContext;
const PROJECT_ROOT = 'libraries/consumer';
const PLUGIN_SUBPATHS = ['./biome', './knip', './externals'];
const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageManifest;

/** Some entries name their output absolutely and some relative to the root. */
function getRepositoryPath(file: string): string {
  return isAbsolute(file) ? relative(REPOSITORY_ROOT, file) : file.replace(/^\.\//, '');
}

/**
 * Every file the build writes. Rollup entries carry either a single `file` or a
 * list of outputs, and both forms appear here — `createRollupConfig` emits the
 * declaration rollups as lists.
 */
const BUILT_FILES = new Set(
  (rollupConfig as Array<{ output: RollupOutput | RollupOutput[] }>).flatMap(({ output }) =>
    (Array.isArray(output) ? output : [output]).flatMap(({ file }) => (file ? [getRepositoryPath(file)] : [])),
  ),
);

function getExportTarget(subpath: string): string {
  const entry = manifest.exports[subpath];

  if (typeof entry === 'string') {
    return entry.replace(/^\.\//, '');
  }

  return (entry?.default ?? entry?.import?.default ?? '').replace(/^\.\//, '');
}

/**
 * The manifest and the build are edited independently, and a subpath naming a
 * file rollup never writes fails only once something imports it — for the
 * plugin subpaths, that is a consumer's whole Nx graph refusing to load. Both
 * sides are read here so a rename on either one is caught by the test run.
 */
describe('build outputs', () => {
  const subpaths = Object.keys(manifest.exports).filter((subpath) => subpath !== './package.json');

  test.each(subpaths)('writes the file %s resolves to', (subpath) => {
    expect(BUILT_FILES).toContain(getExportTarget(subpath));
  });

  test('writes the file main and module point at', () => {
    expect(BUILT_FILES).toContain(manifest.main.replace(/^\.\//, ''));
    expect(BUILT_FILES).toContain(manifest.module.replace(/^\.\//, ''));
  });

  test('writes the root declaration file the types field names', () => {
    expect(BUILT_FILES).toContain(manifest.types.replace(/^\.\//, ''));
  });

  test('exports every plugin Nx is meant to register', () => {
    expect(subpaths).toEqual(expect.arrayContaining(PLUGIN_SUBPATHS));
  });

  /**
   * Nx resolves a plugin specifier with whichever conditions its own loader
   * sets, and an `import`-only subpath is simply not found — the graph fails to
   * build with no indication that the file exists.
   */
  test.each(PLUGIN_SUBPATHS)('resolves %s under any condition, not only import', (subpath) => {
    expect(manifest.exports[subpath]).toHaveProperty('default');
  });
});

/**
 * Two plugins reach a second file of their own by resolving a sibling: the
 * externals plugin spawns its check, and the knip plugin hands its
 * configuration module to the knip CLI. Both paths are strings the compiler
 * never sees, naming a `.mjs` that exists only once rollup writes it, so the
 * source path is translated into the built one and looked up.
 */
describe('sibling files the plugins resolve', () => {
  async function getResolvedSiblings(createNodesV2: CreateNodes<object>): Promise<string[]> {
    const [, deriveNodes] = createNodesV2;
    const results = await deriveNodes([`${PROJECT_ROOT}/package.json`], {}, CONTEXT);
    const { projects = {} } = (results.at(0)?.at(1) ?? {}) as DerivedProjects;
    const targets = projects[PROJECT_ROOT]?.targets ?? {};

    return Object.values(targets)
      .flatMap(({ command }) => (typeof command === 'string' ? command.split(' ') : []))
      .filter((argument) => argument.endsWith('.mjs'))
      .map((argument) => relative(REPOSITORY_ROOT, argument).replace(/^src\//, 'dist/es/'));
  }

  test.each([
    { name: 'externals', createNodesV2: externals },
    { name: 'knip', createNodesV2: knip },
  ])('$name resolves only siblings the build writes', async ({ createNodesV2 }) => {
    const siblings = await getResolvedSiblings(createNodesV2);

    expect(siblings.length).toBeGreaterThan(0);

    for (const sibling of siblings) {
      expect(BUILT_FILES).toContain(sibling);
    }
  });
});
