import type { KnipConfiguration } from 'knip';

/**
 * What every package gets before its own `.kniprc.ts` is applied. `out-tsc` is
 * listed alongside `dist` because Nx's TypeScript plugin emits declarations
 * there, and knip would otherwise report every one of them as an unused file.
 */
export const baseConfig: KnipConfiguration = {
  entry: ['src/**/*.ts'],
  ignore: ['dist/**', 'out-tsc/**'],
  include: ['dependencies', 'devDependencies', 'optionalPeerDependencies'],
  treatConfigHintsAsErrors: true,
};
