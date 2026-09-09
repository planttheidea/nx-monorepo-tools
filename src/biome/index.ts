import { createPackageJsonNodes } from '../internal/createPackageJsonNodes.js';

export interface Options {}

/**
 * The workspace-level Biome configuration is an input to every target, so a
 * change to a rule invalidates the cache for every package rather than only
 * the ones whose own files moved. Both extensions are listed because Biome
 * accepts either and a glob matching nothing costs nothing.
 */
const INPUTS = ['default', '^default', '{workspaceRoot}/biome.json', '{workspaceRoot}/biome.jsonc'];

export const createNodesV2 = createPackageJsonNodes<Options>(() => ({
  format: {
    cache: true,
    command: 'biome format --write {projectRoot} --error-on-warnings',
    inputs: INPUTS,
  },
  lint: {
    cache: true,
    command: 'biome lint --write --unsafe {projectRoot} --error-on-warnings',
    inputs: INPUTS,
  },
  polish: {
    cache: true,
    command: 'biome check --write --unsafe {projectRoot} --error-on-warnings',
    inputs: INPUTS,
  },
  verify: {
    cache: true,
    command: 'biome ci {projectRoot} --error-on-warnings',
    inputs: INPUTS,
  },
}));
