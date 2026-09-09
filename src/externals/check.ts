import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ESBUILD_EXECUTOR = '@nx/esbuild:esbuild';
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
  workspaces?: string[];
}

export interface ProjectConfiguration {
  targets?: Record<string, { executor?: string; options?: { external?: string[] } }>;
}

/**
 * Unchecked by design — nothing here is worth a schema. A malformed or missing
 * file reads as `undefined` and every caller already handles that, because an
 * absent `project.json` is the normal case for most packages in a workspace.
 */
function getJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function getPackageManifest(path: string): PackageManifest | undefined {
  return getJson(path) as PackageManifest | undefined;
}

function getProjectConfiguration(path: string): ProjectConfiguration | undefined {
  return getJson(path) as ProjectConfiguration | undefined;
}

/**
 * Package names declared with the `workspace:` protocol. Those are exactly the
 * ones esbuild inlines — npm packages are left external already — so they are
 * the whole surface this check has to cover.
 */
export function getWorkspaceDependencies(manifest: PackageManifest | undefined): string[] {
  return Object.entries(manifest?.dependencies ?? {})
    .filter(([, range]) => range.startsWith(WORKSPACE_PROTOCOL))
    .map(([name]) => name);
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

function reportInlined(projectRoot: string, inlined: string[]): void {
  const singular = inlined.length === 1;
  const listed = inlined.map((name) => `"${name}"`).join(', ');

  console.error(
    [
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
    ].join('\n'),
  );
}

export function isCompliant(workspaceRoot: string, projectRoot: string): boolean {
  const inlined = getInlinedDependencies(workspaceRoot, projectRoot);

  if (inlined.length === 0) {
    return true;
  }

  reportInlined(projectRoot, inlined);

  return false;
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

/**
 * The executable shell: take an optional project root and turn the result into
 * the exit code Nx reads. With none, it sweeps every package in the workspace.
 *
 * The workspace is the working directory, which is where Nx runs a target's
 * command from and where anyone invoking this by hand already stands. It cannot
 * be derived from this file's own location — the file ships inside
 * `node_modules`, at no fixed depth below the workspace — and it cannot be
 * passed as an argument either, because Nx only expands `{workspaceRoot}` at
 * the start of an option, never in the middle of a command.
 *
 * Guarded on `import.meta.main` so importing this file — which the tests do, to
 * assert the rules above directly — does not read the runner's argv and exit
 * the process.
 */
if (import.meta.main) {
  const workspaceRoot = process.cwd();
  const [requestedRoot] = process.argv.slice(2);
  const roots = requestedRoot ? [requestedRoot] : getProjectRoots(workspaceRoot);
  const failed = roots.filter((root) => !isCompliant(workspaceRoot, root));

  if (failed.length > 0) {
    process.exit(1);
  }
}
