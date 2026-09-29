import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PackageManifest } from '../internal/workspace.js';
import { getPackageManifest, getProjectRoots, getWorkspaceDependencies } from '../internal/workspace.js';

const VITE_CONFIG_FILE_NAMES = [
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
];

/**
 * Directories a library's build writes to. An import resolving into one of
 * these reads whatever was last built — stale locally, and absent from a clean
 * checkout that has not built the library first.
 */
const BUILD_OUTPUT_DIRECTORIES = new Set(['build', 'dist', 'lib', 'out-tsc']);

/** Vite substitutes the mode for this placeholder; the check loads the config in production mode. */
const MODE_CONDITION = 'development|production';

/** Conditions no source entry answers to: `types` targets declarations, which no bundler loads. */
const NON_SOURCE_CONDITIONS = new Set(['types']);

export interface ResolveEnvironment {
  /** `client`, `ssr`, or a custom environment's name. */
  name: string;
  conditions: string[];
}

export interface BuildOutputImport {
  environment: string;
  dependency: string;
  /** The export subpath, e.g. `.` or `./testing`. */
  subpath: string;
  target: string;
  /** Conditions in the library's `exports` that do reach source, if any. */
  sourceConditions: string[];
}

interface ViteModule {
  defaultClientConditions: readonly string[];
  defaultServerConditions: readonly string[];
  loadConfigFromFile: (
    configEnv: { command: 'build' | 'serve'; mode: string },
    configFile?: string,
    configRoot?: string,
    logLevel?: 'error' | 'info' | 'silent' | 'warn',
  ) => Promise<{ config: ViteUserConfig } | null>;
}

interface ViteResolveConfig {
  resolve?: { conditions?: string[] };
}

interface ViteUserConfig extends ViteResolveConfig {
  ssr?: ViteResolveConfig;
  environments?: Record<string, ViteResolveConfig | undefined>;
}

/** The project's Vite config file, or `undefined` when it has none — which takes it out of the check. */
export function getViteConfigFile(workspaceRoot: string, projectRoot: string): string | undefined {
  return VITE_CONFIG_FILE_NAMES.map((fileName) => join(workspaceRoot, projectRoot, fileName)).find((filePath) =>
    existsSync(filePath),
  );
}

/**
 * Resolves one `exports` target the way Node and Vite do: a string is the
 * answer, an array is tried in order, and an object answers with its first key
 * that is `default` or one of `conditions` — in the object's own key order, not
 * the order of `conditions`.
 */
export function resolveExportTarget(target: unknown, conditions: ReadonlySet<string>): string | undefined {
  if (typeof target === 'string') {
    return target;
  }

  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveExportTarget(item, conditions);

      if (resolved !== undefined) {
        return resolved;
      }
    }

    return undefined;
  }

  if (typeof target === 'object' && target !== null) {
    for (const [key, value] of Object.entries(target)) {
      if (key !== 'default' && !conditions.has(key)) {
        continue;
      }

      const resolved = resolveExportTarget(value, conditions);

      if (resolved !== undefined) {
        return resolved;
      }
    }
  }

  return undefined;
}

/**
 * A manifest's exports as subpath → target, whichever of the three shapes it
 * uses: a bare string, a conditions object for `.` alone, or a subpath map.
 * Without `exports`, `module` or `main` stands in for `.`. `./package.json` is
 * left out, since it is data rather than code.
 */
export function getExportEntries(manifest: PackageManifest): Array<[string, unknown]> {
  const { exports } = manifest;

  if (exports === undefined) {
    const entry = manifest.module ?? manifest.main;

    return entry ? [['.', entry]] : [];
  }

  if (typeof exports !== 'object' || exports === null || Array.isArray(exports)) {
    return [['.', exports]];
  }

  const keys = Object.keys(exports);

  if (!keys.every((key) => key.startsWith('.'))) {
    return [['.', exports]];
  }

  return Object.entries(exports).filter(([subpath]) => subpath !== './package.json');
}

/** Whether a resolved target sits in a build directory, at any depth. */
export function isBuildOutput(target: string): boolean {
  return target.split(/[\\/]/).some((segment) => BUILD_OUTPUT_DIRECTORIES.has(segment));
}

/**
 * Conditions in a target that reach something other than build output — what a
 * consumer would add to reach source. Empty when the library exposes no source
 * at all, which moves the fix to the library's own `exports`.
 */
export function getSourceConditions(target: unknown): string[] {
  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    return [];
  }

  return Object.entries(target)
    .filter(([key]) => key !== 'default' && !NON_SOURCE_CONDITIONS.has(key))
    .filter(([key, value]) => {
      const resolved = resolveExportTarget(value, new Set([key]));

      return resolved !== undefined && !isBuildOutput(resolved);
    })
    .map(([key]) => key);
}

/**
 * The full condition set Vite resolves with in an environment: the configured
 * list, the mode in place of its placeholder, and `import` and `default`, which
 * Vite always applies to an ESM import.
 */
export function getEffectiveConditions(conditions: readonly string[]): Set<string> {
  return new Set([
    ...conditions.map((condition) => (condition === MODE_CONDITION ? 'production' : condition)),
    'import',
    'default',
  ]);
}

/**
 * The resolve conditions of every environment a Vite config declares.
 *
 * `client` and `ssr` are always present, from their own settings or Vite's
 * defaults, and an entry under `environments` overrides either or adds another.
 */
export function getResolveEnvironments(config: ViteUserConfig, vite: ViteModule): ResolveEnvironment[] {
  const environments = new Map<string, readonly string[]>([
    ['client', config.resolve?.conditions ?? vite.defaultClientConditions],
    ['ssr', config.ssr?.resolve?.conditions ?? vite.defaultServerConditions],
  ]);

  for (const [name, environment] of Object.entries(config.environments ?? {})) {
    const conditions = environment?.resolve?.conditions;

    if (conditions) {
      environments.set(name, conditions);
    }
  }

  return [...environments].map(([name, conditions]) => ({ name, conditions: [...conditions] }));
}

/**
 * Every export of every workspace dependency that resolves into build output
 * under one of the consumer's environments. Each dependency is reported once
 * per environment and subpath, so a library missing a source condition
 * altogether is not listed once per build directory.
 */
export function getBuildOutputImports(
  environments: ResolveEnvironment[],
  dependencies: Array<{ name: string; manifest: PackageManifest }>,
): BuildOutputImport[] {
  const imports: BuildOutputImport[] = [];

  for (const environment of environments) {
    const conditions = getEffectiveConditions(environment.conditions);

    for (const { name, manifest } of dependencies) {
      for (const [subpath, target] of getExportEntries(manifest)) {
        const resolved = resolveExportTarget(target, conditions);

        if (resolved === undefined || !isBuildOutput(resolved)) {
          continue;
        }

        imports.push({
          environment: environment.name,
          dependency: name,
          subpath,
          target: resolved,
          sourceConditions: getSourceConditions(target),
        });
      }
    }
  }

  return imports;
}

/** Loads Vite from the workspace — a peer dependency, so the consumer's own copy. */
async function getVite(): Promise<ViteModule> {
  try {
    return await import('vite');
  } catch (error) {
    throw new Error('The sources check found a Vite config but could not load `vite`. Install it in the workspace.', {
      cause: error,
    });
  }
}

/**
 * Evaluates the config without running its plugins' hooks. A plugin's `config`
 * hook can write files — TanStack Start generates its route tree there — and a
 * cached check has no business doing that. The cost is not seeing a condition a
 * plugin adds itself, which is rare.
 *
 * Loaded as a production build, so a config that only demands dev-server
 * resources — certificates, a running database — does not throw.
 */
async function getViteConfig(configFile: string, projectDirectory: string, vite: ViteModule): Promise<ViteUserConfig> {
  const loaded = await vite.loadConfigFromFile(
    { command: 'build', mode: 'production' },
    configFile,
    projectDirectory,
    'silent',
  );

  return loaded?.config ?? {};
}

export async function getProjectBuildOutputImports(
  workspaceRoot: string,
  projectRoot: string,
  projectRootsByName: Map<string, string>,
): Promise<BuildOutputImport[]> {
  const configFile = getViteConfigFile(workspaceRoot, projectRoot);

  if (!configFile) {
    return [];
  }

  const manifest = getPackageManifest(join(workspaceRoot, projectRoot, 'package.json'));
  const dependencies = getWorkspaceDependencies(manifest).flatMap((name) => {
    const dependencyRoot = projectRootsByName.get(name);
    const dependencyManifest = dependencyRoot
      ? getPackageManifest(join(workspaceRoot, dependencyRoot, 'package.json'))
      : undefined;

    return dependencyManifest ? [{ name, manifest: dependencyManifest }] : [];
  });

  if (dependencies.length === 0) {
    return [];
  }

  const vite = await getVite();
  const config = await getViteConfig(configFile, join(workspaceRoot, projectRoot), vite);

  return getBuildOutputImports(getResolveEnvironments(config, vite), dependencies);
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

/**
 * Names each offending import and the fix that applies to it: add a condition
 * the library already answers to, or give the library a source entry if it has
 * none.
 */
export function getReport(projectRoot: string, imports: BuildOutputImport[]): string {
  const lines = [
    `${projectRoot} resolves workspace libraries to their build output instead of their source:`,
    '',
    ...imports.map(
      ({ environment, dependency, subpath, target }) =>
        `  [${environment}] ${subpath === '.' ? dependency : `${dependency}/${subpath.slice(2)}`} → ${target}`,
    ),
    '',
    'Vite reads whatever the library last built: a stale copy locally, and nothing at all on a',
    'clean checkout — where the importing module fails to load. Nothing warns locally, because',
    'a leftover build makes it work.',
    '',
  ];

  const conditions = [...new Set(imports.flatMap(({ sourceConditions }) => sourceConditions))];
  const withoutSource = [
    ...new Set(
      imports.filter(({ sourceConditions }) => sourceConditions.length === 0).map(({ dependency }) => dependency),
    ),
  ];

  if (conditions.length > 0) {
    const listed = conditions.map((condition) => `'${condition}'`).join(', ');

    lines.push(
      `Add the source condition to ${projectRoot}'s Vite config, for each environment listed:`,
      '',
      `    resolve: { conditions: [${listed}, ...defaultClientConditions] },`,
      `    ssr: { resolve: { conditions: [${listed}, ...defaultServerConditions] } },`,
    );
  }

  if (withoutSource.length > 0) {
    lines.push(
      ...(conditions.length > 0 ? [''] : []),
      `Give ${withoutSource.map((name) => `"${name}"`).join(', ')} a source entry in its package.json exports,`,
      'under a condition the Vite config lists, e.g. { "source": "./src/index.ts", "import": "./dist/index.js" }.',
    );
  }

  return lines.join('\n');
}

export async function isCompliant(
  workspaceRoot: string,
  projectRoot: string,
  projectRootsByName: Map<string, string>,
): Promise<boolean> {
  const imports = await getProjectBuildOutputImports(workspaceRoot, projectRoot, projectRootsByName);

  if (imports.length === 0) {
    return true;
  }

  console.error(getReport(projectRoot, imports));

  return false;
}

/**
 * The executable shell, as in the externals check: an optional project root,
 * the workspace from the working directory, and the exit code Nx reads. With no
 * root, it sweeps every package.
 *
 * Guarded on `import.meta.main` so the tests can import the rules above without
 * this reading their argv and exiting.
 */
if (import.meta.main) {
  const workspaceRoot = process.cwd();
  const [requestedRoot] = process.argv.slice(2);
  const projectRoots = getProjectRoots(workspaceRoot);
  const projectRootsByName = getProjectRootsByName(workspaceRoot, projectRoots);
  const roots = requestedRoot ? [requestedRoot] : projectRoots;

  let compliant = true;

  // One at a time: each config is bundled to evaluate it, and interleaving
  // those would gain little over a sweep that is cached per project anyway.
  for (const root of roots) {
    compliant = (await isCompliant(workspaceRoot, root, projectRootsByName)) && compliant;
  }

  if (!compliant) {
    process.exit(1);
  }
}
