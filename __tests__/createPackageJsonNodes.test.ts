import type { CreateNodesContext } from '@nx/devkit';
import { describe, expect, test } from 'vitest';
import { createPackageJsonNodes } from '../src/internal/createPackageJsonNodes.js';

interface Options {
  suffix?: string;
}

const CONTEXT = { nxJsonConfiguration: {}, workspaceRoot: '/workspace' } as CreateNodesContext;

function createNodes(configFiles: string[], options?: Options) {
  const [, deriveNodes] = createPackageJsonNodes<Options>((projectRoot, pluginOptions) => ({
    [`check${pluginOptions?.suffix ?? ''}`]: { command: `check ${projectRoot}` },
  }));

  return deriveNodes(configFiles, options, CONTEXT);
}

describe('createPackageJsonNodes', () => {
  test('matches every package.json in the workspace', () => {
    const [glob] = createPackageJsonNodes(() => ({}));

    expect(glob).toBe('**/package.json');
  });

  test('registers the derived targets against the directory that owns the manifest', async () => {
    const results = await createNodes(['libraries/consumer/package.json']);

    expect(results).toEqual([
      [
        'libraries/consumer/package.json',
        { projects: { 'libraries/consumer': { targets: { check: { command: 'check libraries/consumer' } } } } },
      ],
    ]);
  });

  test('skips the workspace root, which is not a project', async () => {
    const results = await createNodes(['package.json']);

    expect(results).toEqual([['package.json', {}]]);
  });

  test('passes the plugin options through to the derivation', async () => {
    const results = await createNodes(['libraries/consumer/package.json'], { suffix: '-deep' });

    expect(results.at(0)?.at(1)).toHaveProperty('projects.libraries/consumer.targets.check-deep');
  });

  test('derives each package separately when handed the whole workspace at once', async () => {
    const results = await createNodes([
      'applications/app/package.json',
      'libraries/database/ribi/package.json',
      'package.json',
    ]);

    expect(results).toEqual([
      [
        'applications/app/package.json',
        { projects: { 'applications/app': { targets: { check: { command: 'check applications/app' } } } } },
      ],
      [
        'libraries/database/ribi/package.json',
        {
          projects: {
            'libraries/database/ribi': { targets: { check: { command: 'check libraries/database/ribi' } } },
          },
        },
      ],
      ['package.json', {}],
    ]);
  });

  test('keeps the full nested path as the project root, not just the directory name', async () => {
    const results = await createNodes(['libraries/database/ribi/package.json']);

    expect(results.at(0)?.at(1)).toHaveProperty(['projects', 'libraries/database/ribi']);
  });

  test('registers whatever the derivation returns, without adding targets of its own', async () => {
    const [, deriveNodes] = createPackageJsonNodes(() => ({
      first: { command: 'first' },
      second: { command: 'second' },
    }));
    const results = await deriveNodes(['libraries/consumer/package.json'], {}, CONTEXT);
    const [, result] = results.at(0) ?? [];

    expect(Object.keys((result as { projects: Record<string, { targets: object }> }).projects.consumer ?? {})).toEqual(
      [],
    );
    expect(result).toEqual({
      projects: {
        'libraries/consumer': { targets: { first: { command: 'first' }, second: { command: 'second' } } },
      },
    });
  });

  test('registers nothing at all when the derivation returns no targets', async () => {
    const [, deriveNodes] = createPackageJsonNodes(() => ({}));
    const results = await deriveNodes(['libraries/consumer/package.json'], {}, CONTEXT);

    expect(results.at(0)?.at(1)).toEqual({ projects: { 'libraries/consumer': { targets: {} } } });
  });
});
