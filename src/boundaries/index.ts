import { resolve } from 'node:path';
import { createPackageJsonNodes } from '../internal/createPackageJsonNodes.js';

/**
 * The check runs as its own process rather than inside the plugin, because Nx
 * reads its result as the exit code of a cacheable target. It is built beside
 * this file, so the path holds wherever the package is installed.
 */
const CHECK_FILE_PATH = resolve(import.meta.dirname, 'check.mjs');

export interface Options {}

export const createNodesV2 = createPackageJsonNodes<Options>(() => ({
  boundaries: {
    cache: true,
    command: `node ${CHECK_FILE_PATH} {projectRoot}`,
    inputs: ['default', '^default'],
  },
}));
