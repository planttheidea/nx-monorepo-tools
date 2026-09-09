import { resolve } from 'node:path';
import { createPackageJsonNodes } from '../internal/createPackageJsonNodes.js';

/**
 * The single configuration knip is ever pointed at. It resolves the base
 * defaults and merges the `.kniprc.ts` colocated with whichever project it is
 * run against, so this plugin holds no per-project knowledge at all.
 */
const CONFIG_FILE_PATH = resolve(import.meta.dirname, 'config.mjs');

export interface Options {}

export const createNodesV2 = createPackageJsonNodes<Options>(() => ({
  dependencies: {
    cache: true,
    command: `knip --no-progress --config ${CONFIG_FILE_PATH} --directory {projectRoot}`,
    inputs: ['default', '^default'],
  },
}));
