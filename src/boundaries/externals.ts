import { join } from 'node:path';
import { getJson, getPackageManifest, getWorkspaceDependencies } from '../internal/workspace.js';

const ESBUILD_EXECUTOR = '@nx/esbuild:esbuild';

export interface ProjectConfiguration {
  targets?: Record<string, { executor?: string; options?: { external?: string[] } }>;
}

function getProjectConfiguration(path: string): ProjectConfiguration | undefined {
  return getJson(path) as ProjectConfiguration | undefined;
}

/**
 * esbuild's `external` accepts `*` wildcards, so `ribi-*` covers every package
 * with that prefix. Membership cannot be a plain `includes` or a consumer that
 * legitimately externalizes by prefix would read as a violation.
 */
export function isExternal(name: string, external: string[]): boolean {
  return external.some((pattern) => {
    const expression = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');

    return new RegExp(`^${expression}$`).test(name);
  });
}

/**
 * The `workspace:*` dependencies this project's esbuild target would inline —
 * empty when the project is compliant, and empty for any project this check
 * does not cover.
 *
 * Only esbuild inlines workspace dependencies by default. vite resolves one
 * specifier to one copy, so a vite consumer cannot split a library in two and
 * has nothing to declare. Anything else is unknown to this check rather than
 * proven safe by it.
 */
export function getInlinedDependencies(workspaceRoot: string, projectRoot: string): string[] {
  const project = getProjectConfiguration(join(workspaceRoot, projectRoot, 'project.json'));
  const buildTarget = project?.targets?.build;

  if (buildTarget?.executor !== ESBUILD_EXECUTOR) {
    return [];
  }

  const manifest = getPackageManifest(join(workspaceRoot, projectRoot, 'package.json'));
  const external = buildTarget.options?.external ?? [];

  return getWorkspaceDependencies(manifest).filter((name) => !isExternal(name, external));
}

/**
 * Names the inlined libraries and the `external` entry that stops it.
 * @internal Exported for tests.
 */
export function getExternalsReport(projectRoot: string, inlined: string[]): string {
  const singular = inlined.length === 1;
  const listed = inlined.map((name) => `"${name}"`).join(', ');

  return [
    `${projectRoot} bundles ${singular ? 'a workspace library' : 'workspace libraries'} instead of importing ${singular ? 'it' : 'them'}: ${listed}.`,
    '',
    'esbuild inlines workspace dependencies while leaving npm packages external, so the',
    'consumer ends up with a private copy of the library. Anything that library owns at',
    'module scope — a registry, a cache, a counter — then exists twice in one process and',
    'the two copies stop seeing each other. Nothing throws; the symptom is a wrong value.',
    '',
    `Add ${singular ? 'it' : 'them'} to the build target's external list in ${projectRoot}/project.json:`,
    '',
    `    "external": [${listed}]`,
  ].join('\n');
}

/** The externals rule: a report when the project's esbuild build inlines a workspace library. */
export function checkExternals(workspaceRoot: string, projectRoot: string): string | undefined {
  const inlined = getInlinedDependencies(workspaceRoot, projectRoot);

  return inlined.length === 0 ? undefined : getExternalsReport(projectRoot, inlined);
}
