import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { KnipConfiguration } from 'knip';
import { baseConfig } from './base.js';

/**
 * The per-project overrides file, colocated with the package it configures.
 *
 * knip resolves its own configuration with a single `join(cwd, name)` and no
 * walk up the tree, so a colocated file inherits nothing on its own. This
 * module is what the plugin points `--config` at, and it does the inheriting:
 * the base defaults first, then whatever the project declares on top.
 */
export const OVERRIDES_FILE_NAME = '.kniprc.ts';

/**
 * The arguments knip passes to a configuration file that exports a function.
 *
 * Only the directory matters here. `--directory` moves knip's notion of the
 * project without moving `process.cwd()`, which stays at the workspace root
 * because that is where Nx runs the target from.
 */
export interface ConfigOptions {
  directory?: string;
}

async function getOverrides(overridesFilePath: string): Promise<KnipConfiguration> {
  const overrides = (await import(pathToFileURL(overridesFilePath).href)) as {
    config?: KnipConfiguration;
    default?: KnipConfiguration;
  };

  return overrides.default ?? overrides.config ?? {};
}

/**
 * The base defaults with a project's overrides applied key by key.
 *
 * The overrides file is appended to `entry` afterwards. A project that narrows
 * `entry` — most of them do, to pick up `.tsx` or a build script — would
 * otherwise leave its own configuration file unreferenced, which knip reports
 * as an unused file.
 */
export function deriveConfig(overrides: KnipConfiguration): KnipConfiguration {
  const merged = { ...baseConfig, ...overrides };
  // `entry` accepts a bare string as well as a list, and both reach here from a
  // project's own file.
  const entry = typeof merged.entry === 'string' ? [merged.entry] : (merged.entry ?? []);

  return { ...merged, entry: [...entry, OVERRIDES_FILE_NAME] };
}

/**
 * Default-exported because knip reads a configuration module's default export,
 * and awaits it when it is a function.
 */
// eslint-disable-next-line import/no-default-export
export default async function createConfig({ directory = '.' }: ConfigOptions = {}): Promise<KnipConfiguration> {
  const overridesFilePath = resolve(process.cwd(), directory, OVERRIDES_FILE_NAME);

  if (!existsSync(overridesFilePath)) {
    return baseConfig;
  }

  return deriveConfig(await getOverrides(overridesFilePath));
}
