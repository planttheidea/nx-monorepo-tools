import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKSPACE_PROTOCOL = 'workspace:';

/**
 * A parent path and one trailing `*`, with no other wildcard anywhere in it.
 * Testing for a `/*` suffix alone is not enough: `libraries/**` + `/*` ends
 * that way too, and stripping the suffix leaves a literal `libraries/**` to
 * read a directory from.
 */
const SUPPORTED_WORKSPACES_PATTERN = /^[^*]+\/\*$/;

export interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  exports?: unknown;
  main?: string;
  module?: string;
  workspaces?: string[];
}

/**
 * Unchecked by design — nothing here is worth a schema. A malformed or missing
 * file reads as `undefined` and every caller already handles that, because an
 * absent `project.json` is the normal case for most packages in a workspace.
 */
export function getJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export function getPackageManifest(path: string): PackageManifest | undefined {
  return getJson(path) as PackageManifest | undefined;
}

/**
 * Package names declared with the `workspace:` protocol — the dependencies
 * that live in this repository rather than on npm.
 */
export function getWorkspaceDependencies(manifest: PackageManifest | undefined): string[] {
  return Object.entries(manifest?.dependencies ?? {})
    .filter(([, range]) => range.startsWith(WORKSPACE_PROTOCOL))
    .map(([name]) => name);
}

/**
 * Every package directory, expanded from the root `package.json` workspaces
 * globs, so the single-argument form covers the whole graph in one pass.
 *
 * Only the `dir/*` form is expanded. A deeper glob would quietly match nothing
 * and take every package under it out of the check, so it throws instead.
 */
export function getProjectRoots(workspaceRoot: string): string[] {
  const { workspaces = [] } = getPackageManifest(join(workspaceRoot, 'package.json')) ?? {};
  const projectRoots: string[] = [];

  for (const pattern of workspaces) {
    if (!SUPPORTED_WORKSPACES_PATTERN.test(pattern)) {
      throw new Error(`Unsupported workspaces pattern "${pattern}" — only the "dir/*" form is expanded.`);
    }

    const parent = pattern.slice(0, -2);

    for (const entry of readdirSync(join(workspaceRoot, parent), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        projectRoots.push(`${parent}/${entry.name}`);
      }
    }
  }

  return projectRoots;
}

/** Workspace package names mapped to their roots, so a dependency's manifest can be found by name. */
export function getProjectRootsByName(workspaceRoot: string, projectRoots: string[]): Map<string, string> {
  const roots = new Map<string, string>();

  for (const projectRoot of projectRoots) {
    const name = getPackageManifest(join(workspaceRoot, projectRoot, 'package.json'))?.name;

    if (name) {
      roots.set(name, projectRoot);
    }
  }

  return roots;
}
