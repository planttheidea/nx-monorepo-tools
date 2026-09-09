import { TargetConfiguration, CreateNodes } from '@nx/devkit';

/**
 * The targets a plugin injects into one project, given where that project lives
 * and whatever options the workspace declared for the plugin in `nx.json`.
 */
type DeriveTargets<Options> = (projectRoot: string, options: Options | undefined) => Record<string, TargetConfiguration>;
/**
 * A `createNodes` tuple that visits every `package.json` in the workspace and
 * merges the derived targets into the project that owns it.
 *
 * Every plugin here works the same way — a package is a project, and each
 * project gets the same targets — so the glob, the root guard, and the result
 * shape live once rather than once per plugin.
 */
declare function createPackageJsonNodes<Options>(deriveTargets: DeriveTargets<Options>): CreateNodes<Options>;

export { createPackageJsonNodes };
export type { DeriveTargets };
