import { createRollupConfig } from '@planttheidea/build-tools';
import typescript from '@rollup/plugin-typescript';
import tsc from 'typescript';

/**
 * Entry points that ship alongside the public API but are not part of it.
 *
 * Nx reaches each plugin by specifier from `nx.json`, `check` is spawned as its
 * own process, and `knip/config` is handed to the knip CLI by path. None of
 * them is ever imported by a consumer's TypeScript, so none needs declarations
 * — which is also why they are built here rather than through
 * `createRollupConfig`, whose single entry point drives `main` and `module`.
 *
 * Output mirrors `src` so that a module resolving a sibling by path — the
 * externals and sources plugins finding their `check`, the knip plugin finding its config — reads
 * the same relative path in both trees.
 */
const PLUGIN_ENTRIES = [
  { input: 'src/biome/index.ts', output: 'dist/es/biome/index.mjs' },
  { input: 'src/externals/index.ts', output: 'dist/es/externals/index.mjs' },
  { input: 'src/externals/check.ts', output: 'dist/es/externals/check.mjs' },
  { input: 'src/knip/index.ts', output: 'dist/es/knip/index.mjs' },
  { input: 'src/knip/config.ts', output: 'dist/es/knip/config.mjs' },
  { input: 'src/sources/index.ts', output: 'dist/es/sources/index.mjs' },
  { input: 'src/sources/check.ts', output: 'dist/es/sources/check.mjs' },
];

const [index, ...rest] = createRollupConfig({
  cjs: false,
  config: 'config',
  source: 'src',
  sourceMap: false,
  umd: false,
});

const plugins = PLUGIN_ENTRIES.map(({ input, output }) => ({
  // Reused so a plugin treats exactly the same packages as external that the
  // public entry does, without reading the manifest a second time.
  external: index.external,
  input,
  output: { file: output, format: 'es' },
  plugins: [
    typescript({
      compilerOptions: { declaration: false, declarationDir: undefined, declarationMap: false },
      tsconfig: 'config/types/es.json',
      typescript: tsc,
    }),
  ],
  treeshake: { preset: 'smallest' },
}));

export default [index, ...rest, ...plugins];
