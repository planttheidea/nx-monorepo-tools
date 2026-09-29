import { getProjectRoots, getProjectRootsByName } from '../internal/workspace.js';
import { checkExternals } from './externals.js';
import { checkSources } from './sources.js';

export interface BoundaryRule {
  name: string;
  /** A report naming the violation and its fix, or `undefined` when the project complies. */
  check: (
    workspaceRoot: string,
    projectRoot: string,
    projectRootsByName: Map<string, string>,
  ) => Promise<string | undefined> | string | undefined;
}

/**
 * Every rule about how a project reaches the workspace libraries it depends on.
 * Each covers different projects — esbuild builds, Vite configs — and does
 * nothing for the rest, so running them all on every project costs only the
 * ones that apply.
 */
export const RULES: BoundaryRule[] = [
  { name: 'externals', check: checkExternals },
  { name: 'sources', check: checkSources },
];

/**
 * Each rule's report for one project, labeled with the rule's name so a failure
 * says which rule broke before it says how to fix it.
 */
export async function getViolations(
  workspaceRoot: string,
  projectRoot: string,
  projectRootsByName: Map<string, string>,
  rules: BoundaryRule[] = RULES,
): Promise<string[]> {
  const violations: string[] = [];

  for (const rule of rules) {
    const report = await rule.check(workspaceRoot, projectRoot, projectRootsByName);

    if (report !== undefined) {
      violations.push(`[${rule.name}] ${report}`);
    }
  }

  return violations;
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
 * Projects run one at a time: the sources rule bundles each Vite config to
 * evaluate it, and a sweep gains little from interleaving those.
 *
 * Guarded on `import.meta.main` so importing this file — which the tests do, to
 * assert the rules above directly — does not read the runner's argv and exit
 * the process.
 */
if (import.meta.main) {
  const workspaceRoot = process.cwd();
  const [requestedRoot] = process.argv.slice(2);
  const projectRoots = getProjectRoots(workspaceRoot);
  const projectRootsByName = getProjectRootsByName(workspaceRoot, projectRoots);
  const roots = requestedRoot ? [requestedRoot] : projectRoots;

  let compliant = true;

  for (const root of roots) {
    const violations = await getViolations(workspaceRoot, root, projectRootsByName);

    for (const violation of violations) {
      console.error(`${violation}\n`);
    }

    compliant &&= violations.length === 0;
  }

  if (!compliant) {
    process.exit(1);
  }
}
