import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { baseConfig } from '../src/knip/base.js';
import createConfig, { deriveConfig, OVERRIDES_FILE_NAME } from '../src/knip/config.js';

let originalCwd: string;
let workspaceRoot: string;

/**
 * `createConfig` resolves the overrides file against `process.cwd()` plus the
 * `--directory` knip was given, which is how Nx invokes it: the command runs
 * from the workspace root and names the project relative to it. The fixture
 * reproduces exactly that, rather than pointing at an absolute directory the
 * real invocation never uses.
 */
function createOverrides(projectRoot: string, contents: string): void {
  mkdirSync(join(workspaceRoot, projectRoot), { recursive: true });
  writeFileSync(join(workspaceRoot, projectRoot, OVERRIDES_FILE_NAME), contents);
}

beforeEach(() => {
  originalCwd = process.cwd();
  workspaceRoot = mkdtempSync(join(tmpdir(), 'knip-'));
  process.chdir(workspaceRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspaceRoot, { force: true, recursive: true });
});

describe('deriveConfig', () => {
  test('takes each key the project declares and leaves the rest of the base alone', () => {
    const config = deriveConfig({ entry: ['src/**/*.tsx'] });

    expect(config.entry).toContain('src/**/*.tsx');
    expect(config.entry).not.toContain('src/**/*.ts');
    expect(config.ignore).toEqual(baseConfig.ignore);
    expect(config.include).toEqual(baseConfig.include);
  });

  test('adds the overrides file to entry, so a project narrowing entry does not orphan its own config', () => {
    expect(deriveConfig({ entry: ['src/**/*.tsx'] }).entry).toEqual(['src/**/*.tsx', OVERRIDES_FILE_NAME]);
  });

  test('keeps the base entry when the project overrides something else', () => {
    expect(deriveConfig({ ignoreDependencies: ['pino-pretty'] }).entry).toEqual(['src/**/*.ts', OVERRIDES_FILE_NAME]);
  });

  test('accepts the bare string form of entry, which knip allows and a project may well write', () => {
    expect(deriveConfig({ entry: 'src/index.ts' }).entry).toEqual(['src/index.ts', OVERRIDES_FILE_NAME]);
  });

  test('replaces a base list rather than appending to it, so a project can narrow what the base opened up', () => {
    expect(deriveConfig({ ignore: ['coverage/**'] }).ignore).toEqual(['coverage/**']);
  });

  test('carries through a base key the project never mentions', () => {
    expect(deriveConfig({}).treatConfigHintsAsErrors).toBe(true);
  });

  test('leaves the base untouched, so one project cannot leak its overrides into the next', () => {
    deriveConfig({ entry: ['src/**/*.tsx'], ignoreDependencies: ['pino-pretty'] });

    expect(baseConfig.entry).toEqual(['src/**/*.ts']);
    expect(baseConfig).not.toHaveProperty('ignoreDependencies');
  });
});

describe('createConfig', () => {
  test('returns the base untouched for a project declaring no overrides', async () => {
    mkdirSync(join(workspaceRoot, 'libraries/plain'), { recursive: true });

    await expect(createConfig({ directory: 'libraries/plain' })).resolves.toEqual(baseConfig);
  });

  test('merges the overrides a project colocates with itself', async () => {
    createOverrides(
      'libraries/consumer',
      [
        "import type { KnipConfig } from 'knip';",
        '',
        'export const config: KnipConfig = {',
        "  entry: ['src/**/*.tsx'],",
        "  ignoreDependencies: ['pino-pretty'],",
        '};',
        '',
        'export default config;',
      ].join('\n'),
    );

    const config = await createConfig({ directory: 'libraries/consumer' });

    expect(config.entry).toEqual(['src/**/*.tsx', OVERRIDES_FILE_NAME]);
    expect(config.ignoreDependencies).toEqual(['pino-pretty']);
    expect(config.include).toEqual(baseConfig.include);
  });

  test('reads an overrides file that only names its export, with no default', async () => {
    createOverrides('libraries/named', ["export const config = { ignoreDependencies: ['tsx'] };"].join('\n'));

    await expect(createConfig({ directory: 'libraries/named' })).resolves.toMatchObject({
      ignoreDependencies: ['tsx'],
    });
  });

  test('resolves against the workspace root when knip is given no directory', async () => {
    createOverrides('.', "export default { ignoreDependencies: ['tsx'] };");

    await expect(createConfig()).resolves.toMatchObject({ ignoreDependencies: ['tsx'] });
  });

  test('returns the base for a directory that does not exist at all', async () => {
    await expect(createConfig({ directory: 'libraries/absent' })).resolves.toEqual(baseConfig);
  });

  test('reads one project without picking up the file colocated with another', async () => {
    createOverrides('libraries/first', "export default { ignoreDependencies: ['first-only'] };");
    createOverrides('libraries/second', "export default { ignoreDependencies: ['second-only'] };");

    await expect(createConfig({ directory: 'libraries/first' })).resolves.toMatchObject({
      ignoreDependencies: ['first-only'],
    });
    await expect(createConfig({ directory: 'libraries/second' })).resolves.toMatchObject({
      ignoreDependencies: ['second-only'],
    });
  });

  /**
   * An overrides file that does not parse has to surface as a failure. Falling
   * back to the base would run knip against the wrong configuration and report
   * a wall of unused dependencies, which reads as the project's problem rather
   * than the file's.
   */
  test('fails rather than falling back to the base when the overrides file will not load', async () => {
    createOverrides('libraries/broken', 'export default {');

    await expect(createConfig({ directory: 'libraries/broken' })).rejects.toThrow();
  });

  test('falls back to the base for a file that exports nothing a configuration can be read from', async () => {
    createOverrides('libraries/empty', 'export const unrelated = 1;');

    await expect(createConfig({ directory: 'libraries/empty' })).resolves.toMatchObject({
      entry: ['src/**/*.ts', OVERRIDES_FILE_NAME],
      include: baseConfig.include,
    });
  });
});
