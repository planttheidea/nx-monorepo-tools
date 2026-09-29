import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  getInlinedDependencies,
  getProjectRoots,
  getWorkspaceDependencies,
  isCompliant,
  isExternal,
} from '../src/externals/check.js';

/**
 * The built file, which `npm test` produces first. The source cannot run in
 * place: Node strips its types but will not map a `.js` import specifier to the
 * `.ts` file beside it, and this is the file Nx actually runs.
 */
const CHECK_FILE_PATH = join(import.meta.dirname, '..', 'dist', 'es', 'externals', 'check.mjs');

interface ProjectFixture {
  root: string;
  dependencies?: Record<string, string>;
  executor?: string;
  external?: string[];
}

let workspaceRoot: string;

/**
 * A throwaway workspace on disk. The check reads `project.json` and
 * `package.json` off the filesystem and nothing else, so a fixture is two
 * files per project — no Nx graph, no install, no build.
 */
function createProject({ root, dependencies, executor, external }: ProjectFixture): void {
  mkdirSync(join(workspaceRoot, root), { recursive: true });

  writeFileSync(
    join(workspaceRoot, root, 'package.json'),
    JSON.stringify({ name: root.split('/').at(-1), dependencies }),
  );

  if (executor) {
    writeFileSync(
      join(workspaceRoot, root, 'project.json'),
      JSON.stringify({ targets: { build: { executor, options: { external } } } }),
    );
  }
}

function createWorkspaceManifest(workspaces: string[]): void {
  writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ workspaces }));
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'externals-'));
});

afterEach(() => {
  rmSync(workspaceRoot, { force: true, recursive: true });
});

describe('isExternal', () => {
  test('matches a package named exactly', () => {
    expect(isExternal('ribi-database', ['ribi-database'])).toBe(true);
  });

  test('does not match a package the list omits', () => {
    expect(isExternal('ribi-shared', ['ribi-database'])).toBe(false);
  });

  test('matches nothing against an empty list, so an esbuild target with no external inlines everything', () => {
    expect(isExternal('ribi-database', [])).toBe(false);
  });

  test('honours a prefix wildcard, so externalizing by prefix is not a false positive', () => {
    expect(isExternal('ribi-database', ['ribi-*'])).toBe(true);
  });

  test('keeps a prefix wildcard from covering a package outside the prefix', () => {
    expect(isExternal('kysely-explicit-migration-provider', ['ribi-*'])).toBe(false);
  });

  test('honours a bare wildcard, which externalizes every dependency at once', () => {
    expect(isExternal('kysely-explicit-migration-provider', ['*'])).toBe(true);
  });

  test('treats a dot in a pattern as a literal, not as the regular expression wildcard', () => {
    expect(isExternal('ribi-database', ['ribi.database'])).toBe(false);
  });

  test('treats a plus in a pattern as a literal, so a package name carrying one still matches', () => {
    expect(isExternal('c++tools', ['c++tools'])).toBe(true);
  });

  test('anchors both ends, so a pattern naming part of a package does not cover the whole', () => {
    expect(isExternal('ribi-database-extra', ['ribi-database'])).toBe(false);
  });
});

describe('getWorkspaceDependencies', () => {
  test('returns only the dependencies declared with the workspace protocol', () => {
    const names = getWorkspaceDependencies({
      dependencies: { kysely: '0.29.5', 'ribi-database': 'workspace:*' },
    });

    expect(names).toEqual(['ribi-database']);
  });

  test('returns nothing for a manifest that could not be read', () => {
    expect(getWorkspaceDependencies(undefined)).toEqual([]);
  });

  test('returns nothing for a manifest declaring no dependencies', () => {
    expect(getWorkspaceDependencies({ name: 'some-package' })).toEqual([]);
  });
});

describe('getInlinedDependencies', () => {
  test('reports a workspace dependency the esbuild target leaves off its external list', () => {
    createProject({
      root: 'libraries/consumer',
      dependencies: { 'ribi-database': 'workspace:*', 'ribi-shared': 'workspace:*' },
      executor: '@nx/esbuild:esbuild',
      external: ['ribi-shared'],
    });

    expect(getInlinedDependencies(workspaceRoot, 'libraries/consumer')).toEqual(['ribi-database']);
  });

  test('reports nothing when every workspace dependency is listed', () => {
    createProject({
      root: 'libraries/consumer',
      dependencies: { 'ribi-database': 'workspace:*', 'ribi-shared': 'workspace:*' },
      executor: '@nx/esbuild:esbuild',
      external: ['ribi-database', 'ribi-shared'],
    });

    expect(getInlinedDependencies(workspaceRoot, 'libraries/consumer')).toEqual([]);
  });

  test('reports nothing when a wildcard covers the workspace dependencies', () => {
    createProject({
      root: 'libraries/consumer',
      dependencies: { 'ribi-database': 'workspace:*', 'ribi-shared': 'workspace:*' },
      executor: '@nx/esbuild:esbuild',
      external: ['ribi-*'],
    });

    expect(getInlinedDependencies(workspaceRoot, 'libraries/consumer')).toEqual([]);
  });

  test('ignores an npm dependency, which esbuild leaves external without being told to', () => {
    createProject({
      root: 'libraries/consumer',
      dependencies: { kysely: '0.29.5' },
      executor: '@nx/esbuild:esbuild',
    });

    expect(getInlinedDependencies(workspaceRoot, 'libraries/consumer')).toEqual([]);
  });

  test('reports nothing for a vite consumer, which resolves one specifier to one copy', () => {
    createProject({
      root: 'applications/app',
      dependencies: { 'ribi-database': 'workspace:*' },
      executor: '@nx/vite:build',
    });

    expect(getInlinedDependencies(workspaceRoot, 'applications/app')).toEqual([]);
  });

  test('reports nothing for a project with no project.json, the normal case in a workspace', () => {
    createProject({
      root: 'libraries/plain',
      dependencies: { 'ribi-database': 'workspace:*' },
    });

    expect(getInlinedDependencies(workspaceRoot, 'libraries/plain')).toEqual([]);
  });

  test('reports nothing for a project root that does not exist', () => {
    expect(getInlinedDependencies(workspaceRoot, 'libraries/absent')).toEqual([]);
  });

  /**
   * A `project.json` that does not parse reads the same as one that is absent.
   * Nx fails on it long before this check runs, so treating it as uncovered
   * beats a second, worse error about the same file.
   */
  test('reports nothing for a project whose project.json does not parse', () => {
    createProject({
      root: 'libraries/malformed',
      dependencies: { 'ribi-database': 'workspace:*' },
      executor: '@nx/esbuild:esbuild',
    });
    writeFileSync(join(workspaceRoot, 'libraries/malformed', 'project.json'), '{ not json');

    expect(getInlinedDependencies(workspaceRoot, 'libraries/malformed')).toEqual([]);
  });

  test('reports nothing for a project declaring no build target at all', () => {
    createProject({ root: 'libraries/untargeted', dependencies: { 'ribi-database': 'workspace:*' } });
    writeFileSync(join(workspaceRoot, 'libraries/untargeted', 'project.json'), JSON.stringify({ targets: {} }));

    expect(getInlinedDependencies(workspaceRoot, 'libraries/untargeted')).toEqual([]);
  });

  test('reports the workspace dependency when an esbuild target carries no options at all', () => {
    createProject({ root: 'libraries/bare', dependencies: { 'ribi-database': 'workspace:*' } });
    writeFileSync(
      join(workspaceRoot, 'libraries/bare', 'project.json'),
      JSON.stringify({ targets: { build: { executor: '@nx/esbuild:esbuild' } } }),
    );

    expect(getInlinedDependencies(workspaceRoot, 'libraries/bare')).toEqual(['ribi-database']);
  });

  test('reports every workspace dependency when the esbuild target declares no external at all', () => {
    createProject({
      root: 'libraries/consumer',
      dependencies: { 'ribi-database': 'workspace:*', 'ribi-shared': 'workspace:*' },
      executor: '@nx/esbuild:esbuild',
    });

    expect(getInlinedDependencies(workspaceRoot, 'libraries/consumer')).toEqual(['ribi-database', 'ribi-shared']);
  });
});

describe('isCompliant', () => {
  test('fails a violating project and names the project and the dependency', () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    createProject({
      root: 'libraries/consumer',
      dependencies: { 'ribi-database': 'workspace:*' },
      executor: '@nx/esbuild:esbuild',
    });

    expect(isCompliant(workspaceRoot, 'libraries/consumer')).toBe(false);

    const message = reported.mock.calls.at(0)?.at(0) as string;

    expect(message).toContain('libraries/consumer');
    expect(message).toContain('"ribi-database"');

    reported.mockRestore();
  });

  test('passes a compliant project without reporting anything', () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    createProject({
      root: 'libraries/consumer',
      dependencies: { 'ribi-database': 'workspace:*' },
      executor: '@nx/esbuild:esbuild',
      external: ['ribi-database'],
    });

    expect(isCompliant(workspaceRoot, 'libraries/consumer')).toBe(true);
    expect(reported).not.toHaveBeenCalled();

    reported.mockRestore();
  });
});

describe('getProjectRoots', () => {
  test('expands every dir/* pattern to the package directories under it', () => {
    createWorkspaceManifest(['libraries/*', 'tools/*']);
    createProject({ root: 'libraries/first' });
    createProject({ root: 'libraries/second' });
    createProject({ root: 'tools/third' });

    expect(getProjectRoots(workspaceRoot).sort((a, b) => a.localeCompare(b))).toEqual([
      'libraries/first',
      'libraries/second',
      'tools/third',
    ]);
  });

  test('skips a loose file sitting beside the package directories', () => {
    createWorkspaceManifest(['libraries/*']);
    createProject({ root: 'libraries/first' });
    writeFileSync(join(workspaceRoot, 'libraries', 'README.md'), '');

    expect(getProjectRoots(workspaceRoot)).toEqual(['libraries/first']);
  });

  test.each(['libraries/**/*', 'libraries', 'libraries/*/src'])(
    'throws on the pattern %s rather than silently dropping every package under it',
    (pattern) => {
      createWorkspaceManifest([pattern]);

      expect(() => getProjectRoots(workspaceRoot)).toThrow(pattern);
    },
  );

  test('expands a nested parent path, which a workspace uses for grouped packages', () => {
    createWorkspaceManifest(['libraries/database/*']);
    createProject({ root: 'libraries/database/ribi' });

    expect(getProjectRoots(workspaceRoot)).toEqual(['libraries/database/ribi']);
  });

  test('returns nothing when the root manifest declares no workspaces', () => {
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'root' }));

    expect(getProjectRoots(workspaceRoot)).toEqual([]);
  });

  test('returns nothing when there is no root manifest to read', () => {
    expect(getProjectRoots(workspaceRoot)).toEqual([]);
  });

  /**
   * Same reasoning as the unsupported pattern above: a glob whose parent is not
   * there takes every package under it out of the check, and a sweep that
   * quietly covers nothing is worse than one that stops.
   */
  test('throws on a pattern whose parent directory does not exist', () => {
    createWorkspaceManifest(['tools/*']);

    expect(() => getProjectRoots(workspaceRoot)).toThrow(/tools/);
  });

  test('returns nothing for a parent directory holding no packages', () => {
    createWorkspaceManifest(['libraries/*']);
    mkdirSync(join(workspaceRoot, 'libraries'), { recursive: true });

    expect(getProjectRoots(workspaceRoot)).toEqual([]);
  });
});

/**
 * The shell around the logic: argument handling and the exit code Nx reads.
 *
 * The file under test is the one that ships, built and run by `node`. It reads the workspace from the working directory, the way
 * Nx runs it, so the fixture is handed over as `cwd` and needs no particular
 * layout of its own.
 */
describe('check', () => {
  function runCheck(...args: string[]) {
    return spawnSync('node', [CHECK_FILE_PATH, ...args], { cwd: workspaceRoot, encoding: 'utf8' });
  }

  test('exits 0 for the project root it is given when that project is compliant', () => {
    createProject({
      root: 'libraries/consumer',
      dependencies: { 'ribi-database': 'workspace:*' },
      executor: '@nx/esbuild:esbuild',
      external: ['ribi-database'],
    });

    expect(runCheck('libraries/consumer').status).toBe(0);
  });

  test('exits 1 and names the offending pair when the given project inlines a library', () => {
    createProject({
      root: 'libraries/consumer',
      dependencies: { 'ribi-database': 'workspace:*' },
      executor: '@nx/esbuild:esbuild',
    });

    const { status, stderr } = runCheck('libraries/consumer');

    expect(status).toBe(1);
    expect(stderr).toContain('libraries/consumer');
    expect(stderr).toContain('"ribi-database"');
  });

  test('sweeps every workspace package when given no project root, failing on any one violation', () => {
    createWorkspaceManifest(['libraries/*']);
    createProject({
      root: 'libraries/compliant',
      dependencies: { 'ribi-database': 'workspace:*' },
      executor: '@nx/esbuild:esbuild',
      external: ['ribi-database'],
    });
    createProject({
      root: 'libraries/violating',
      dependencies: { 'ribi-shared': 'workspace:*' },
      executor: '@nx/esbuild:esbuild',
    });

    const { status, stderr } = runCheck();

    expect(status).toBe(1);
    expect(stderr).toContain('libraries/violating');
    expect(stderr).not.toContain('libraries/compliant');
  });

  test('exits 0 sweeping a workspace where every consumer is compliant', () => {
    createWorkspaceManifest(['libraries/*']);
    createProject({
      root: 'libraries/compliant',
      dependencies: { 'ribi-database': 'workspace:*' },
      executor: '@nx/esbuild:esbuild',
      external: ['ribi-database'],
    });

    expect(runCheck().status).toBe(0);
  });
});
