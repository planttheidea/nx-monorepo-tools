import { createEslintConfig } from '@planttheidea/build-tools';

export default createEslintConfig({
  config: 'config',
  development: 'dev',
  react: false,
  source: 'src',
  configs: [
    {
      // The build configuration pulls in `typescript` and rollup's TypeScript
      // plugin, neither of which the import plugin's own parser can read. The
      // same rules are already off for TypeScript sources, where the compiler
      // covers them; this extends that to the one JavaScript file that needs it.
      files: ['config/**/*.js'],
      rules: {
        'import/default': 'off',
        'import/namespace': 'off',
        'import/no-named-as-default': 'off',
        'import/no-named-as-default-member': 'off',
      },
    },
  ],
});
