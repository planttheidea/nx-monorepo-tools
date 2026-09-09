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
});
