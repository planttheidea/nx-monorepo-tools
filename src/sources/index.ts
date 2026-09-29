import { resolve } from 'node:path';
import { createPackageJsonNodes } from '../internal/createPackageJsonNodes.js';

/**
 * Run as its own process for the same reason as the externals check: Nx reads
 * the result as the exit code of a cacheable target. Built beside this file, so
 * the path holds wherever the package is installed.
 */
const CHECK_FILE_PATH = resolve(import.meta.dirname, 'check.mjs');

export interface Options {}

export const createNodesV2 = createPackageJsonNodes<Options>(() => ({
  sources: {
    cache: true,
    command: `node ${CHECK_FILE_PATH} {projectRoot}`,
    inputs: ['default', '^default'],
  },
}));
