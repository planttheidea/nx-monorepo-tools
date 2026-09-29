import { basename, dirname, resolve } from 'node:path';
import type { CreateNodes, CreateNodesContext, TargetConfiguration } from '@nx/devkit';
import { describe, expect, test } from 'vitest';
import { createNodesV2 as biome } from '../src/biome/index.js';
import { createNodesV2 as externals } from '../src/externals/index.js';
import { createNodesV2 as knip } from '../src/knip/index.js';
import { createNodesV2 as sources } from '../src/sources/index.js';

interface DerivedProjects {
  projects?: Record<string, { targets: Record<string, TargetConfiguration> }>;
}

const CONTEXT = { nxJsonConfiguration: {}, workspaceRoot: '/workspace' } as CreateNodesContext;
const PROJECT_ROOT = 'libraries/consumer';
const SOURCE_ROOT = resolve(import.meta.dirname, '..', 'src');

const PLUGINS = [
  { name: 'biome', createNodesV2: biome },
  { name: 'externals', createNodesV2: externals },
  { name: 'knip', createNodesV2: knip },
  { name: 'sources', createNodesV2: sources },
] as const;

async function getTargets(createNodesV2: CreateNodes<object>): Promise<Record<string, TargetConfiguration>> {
  const [, deriveNodes] = createNodesV2;
  const results = await deriveNodes([`${PROJECT_ROOT}/package.json`], {}, CONTEXT);
  const { projects = {} } = (results.at(0)?.at(1) ?? {}) as DerivedProjects;

  return projects[PROJECT_ROOT]?.targets ?? {};
}

async function getCommand(createNodesV2: CreateNodes<object>, targetName: string): Promise<string> {
  const targets = await getTargets(createNodesV2);
  const { command } = targets[targetName] ?? {};

  if (typeof command !== 'string') {
    throw new Error(`No command found on the "${targetName}" target.`);
  }

  return command;
}

function getArgument(command: string, index: number): string {
  return command.split(' ').at(index) ?? '';
}

describe.each(PLUGINS)('$name', ({ createNodesV2 }) => {
  test('caches every target it injects, so a second run over an untouched package is free', async () => {
    const targets = Object.values(await getTargets(createNodesV2));

    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every(({ cache }) => cache === true)).toBe(true);
  });

  test('declares the package and its dependencies as inputs', async () => {
    for (const { inputs } of Object.values(await getTargets(createNodesV2))) {
      expect(inputs).toEqual(expect.arrayContaining(['default', '^default']));
    }
  });

  /**
   * Nx expands `{workspaceRoot}` only at the start of an option, never inside a
   * command, and fails the whole graph when it finds one elsewhere. Nothing
   * catches that until a workspace tries to load the plugin.
   */
  test('never places a workspaceRoot token inside a command', async () => {
    for (const { command } of Object.values(await getTargets(createNodesV2))) {
      expect(command).not.toContain('{workspaceRoot}');
    }
  });

  test('names the project it is deriving for, rather than hardcoding a path', async () => {
    for (const { command } of Object.values(await getTargets(createNodesV2))) {
      expect(command).toContain('{projectRoot}');
    }
  });

  test('leaves the workspace root alone, which is not a project', async () => {
    const [, deriveNodes] = createNodesV2;

    await expect(deriveNodes(['package.json'], {}, CONTEXT)).resolves.toEqual([['package.json', {}]]);
  });
});

describe('biome', () => {
  test('injects the four targets a package is driven through', async () => {
    expect(Object.keys(await getTargets(biome)).sort()).toEqual(['format', 'lint', 'polish', 'verify']);
  });

  test('fails each target on a warning, so nothing lands on a rule that only warns', async () => {
    for (const { command } of Object.values(await getTargets(biome))) {
      expect(command).toContain('--error-on-warnings');
    }
  });

  test('writes fixes for every target but verify, which CI runs and must not mutate the tree', async () => {
    expect(await getCommand(biome, 'format')).toContain('--write');
    expect(await getCommand(biome, 'lint')).toContain('--write');
    expect(await getCommand(biome, 'polish')).toContain('--write');
    expect(await getCommand(biome, 'verify')).not.toContain('--write');
  });

  test('treats the workspace Biome configuration as an input, so a rule change invalidates every package', async () => {
    for (const { inputs } of Object.values(await getTargets(biome))) {
      expect(inputs).toContain('{workspaceRoot}/biome.json');
      expect(inputs).toContain('{workspaceRoot}/biome.jsonc');
    }
  });
});

describe('externals', () => {
  test('injects a single externals target', async () => {
    expect(Object.keys(await getTargets(externals))).toEqual(['externals']);
  });

  /**
   * The plugin resolves the check as its own sibling. Moving either file
   * without the other leaves a command that fails only once a workspace runs
   * it, so the relationship is asserted rather than the literal path.
   */
  test('runs the check that sits beside it, by absolute path', async () => {
    const command = await getCommand(externals, 'externals');
    const checkPath = getArgument(command, 1);

    expect(command).toMatch(/^node /);
    expect(basename(checkPath)).toBe('check.mjs');
    expect(dirname(checkPath)).toBe(resolve(SOURCE_ROOT, 'externals'));
  });

  test('passes the project as the only argument, leaving the workspace to the working directory', async () => {
    const command = await getCommand(externals, 'externals');

    expect(getArgument(command, 2)).toBe('{projectRoot}');
    expect(command.split(' ')).toHaveLength(3);
  });
});

describe('sources', () => {
  test('injects a single sources target', async () => {
    expect(Object.keys(await getTargets(sources))).toEqual(['sources']);
  });

  test('runs the check that sits beside it, by absolute path', async () => {
    const command = await getCommand(sources, 'sources');
    const checkPath = getArgument(command, 1);

    expect(command).toMatch(/^node /);
    expect(basename(checkPath)).toBe('check.mjs');
    expect(dirname(checkPath)).toBe(resolve(SOURCE_ROOT, 'sources'));
  });

  test('passes the project as the only argument, leaving the workspace to the working directory', async () => {
    const command = await getCommand(sources, 'sources');

    expect(getArgument(command, 2)).toBe('{projectRoot}');
    expect(command.split(' ')).toHaveLength(3);
  });
});

describe('knip', () => {
  test('injects a single dependencies target', async () => {
    expect(Object.keys(await getTargets(knip))).toEqual(['dependencies']);
  });

  test('points knip at the configuration module beside it, which does the per-project merging', async () => {
    const command = await getCommand(knip, 'dependencies');
    const configPath = command.split(' ').at(command.split(' ').indexOf('--config') + 1) ?? '';

    expect(basename(configPath)).toBe('config.mjs');
    expect(dirname(configPath)).toBe(resolve(SOURCE_ROOT, 'knip'));
  });

  test('scopes the run to the project, which is also how the configuration finds the overrides file', async () => {
    expect(await getCommand(knip, 'dependencies')).toContain('--directory {projectRoot}');
  });

  test('silences the progress output, which is noise in a cached Nx target', async () => {
    expect(await getCommand(knip, 'dependencies')).toContain('--no-progress');
  });
});
