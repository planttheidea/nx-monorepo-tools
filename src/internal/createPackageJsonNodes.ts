import { dirname } from 'node:path';
import type { CreateNodes, TargetConfiguration } from '@nx/devkit';
import { createNodesFromFiles } from '@nx/devkit';

/**
 * The targets a plugin injects into one project, given where that project lives
 * and whatever options the workspace declared for the plugin in `nx.json`.
 */
export type DeriveTargets<Options> = (
  projectRoot: string,
  options: Options | undefined,
) => Record<string, TargetConfiguration>;

/**
 * A `createNodes` tuple that visits every `package.json` in the workspace and
 * merges the derived targets into the project that owns it.
 *
 * Every plugin here works the same way — a package is a project, and each
 * project gets the same targets — so the glob, the root guard, and the result
 * shape live once rather than once per plugin.
 */
export function createPackageJsonNodes<Options>(deriveTargets: DeriveTargets<Options>): CreateNodes<Options> {
  return [
    '**/package.json',
    async (configFiles, options, context) =>
      await createNodesFromFiles(
        (configFilePath, fileOptions) => createProjects(configFilePath, fileOptions, deriveTargets),
        configFiles,
        options,
        context,
      ),
  ];
}

function createProjects<Options>(
  configFilePath: string,
  options: Options | undefined,
  deriveTargets: DeriveTargets<Options>,
) {
  const projectRoot = dirname(configFilePath);

  if (projectRoot === '.') {
    // The workspace root is not a project, and giving it these targets would
    // run every one of them a second time across the whole repository.
    return {};
  }

  return { projects: { [projectRoot]: { targets: deriveTargets(projectRoot, options) } } };
}
