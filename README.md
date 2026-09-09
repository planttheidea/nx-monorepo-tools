# `@planttheidea/nx-monorepo-tools`

Three Nx plugins that treat every package in a monorepo as a project and give each one the same targets. Each is
registered separately in `nx.json`, so a workspace takes only the ones it wants.

```sh
yarn add --dev @planttheidea/nx-monorepo-tools
```

```jsonc
{
  "plugins": [
    { "plugin": "@planttheidea/nx-monorepo-tools/biome" },
    { "plugin": "@planttheidea/nx-monorepo-tools/knip" },
    { "plugin": "@planttheidea/nx-monorepo-tools/externals" },
  ],
}
```

Every plugin scans `**/package.json` and skips the workspace root, so a package is a project by virtue of having a
manifest — nothing has to be listed anywhere.

## `biome`

Injects four [Biome](https://biomejs.dev/) targets into every package. Do not invoke `biome` directly; use these.

| Target   | What it does                                |
| -------- | ------------------------------------------- |
| `format` | Auto-fix formatting                         |
| `lint`   | Auto-fix lint issues                        |
| `polish` | Format and lint in one pass — the usual one |
| `verify` | Check without writing, for CI               |

All four are cached, and the workspace's `biome.json` (or `biome.jsonc`) is an input, so changing a rule invalidates
every package rather than only the ones whose own files moved.

Requires `@biomejs/biome` in the workspace.

## `knip`

Injects a cached `dependencies` target into every package that runs [knip](https://knip.dev) against it, reporting
unused and missing dependencies.

Configuration is inherited rather than mapped. The plugin points knip at one configuration module inside this package,
which resolves a base configuration and then merges the `.kniprc.ts` colocated with whichever project is being checked:

```ts
// applications/ribi/.kniprc.ts
import type { KnipConfig } from 'knip';

export const config: KnipConfig = {
  entry: ['src/**/*.tsx', 'vite.config.ts'],
  ignoreDependencies: [
    // Used by fonts
    '@fontsource-variable/oxanium',
  ],
};

export default config;
```

A package without a `.kniprc.ts` gets the base untouched. The merge is key by key, so declaring `ignoreDependencies`
leaves `entry` at the base and vice versa; the file itself is appended to `entry` afterwards, because a package that
narrows `entry` would otherwise leave its own configuration unreferenced and knip would call it an unused file.

The base is deliberately small:

```jsonc
{
  "entry": ["src/**/*.ts"],
  "ignore": ["dist/**", "out-tsc/**"],
  "include": ["dependencies", "devDependencies", "optionalPeerDependencies"],
  "treatConfigHintsAsErrors": true,
}
```

Requires `knip` in the workspace.

### Why a configuration module rather than a plain file

knip resolves its own configuration with a single `join(cwd, name)` and no walk up the tree, so a colocated file
inherits nothing on its own. A configuration file may export a function, which knip awaits, so the merge happens when
knip runs rather than through generated files or a map of project names inside the plugin.

## `externals`

Injects a cached `externals` target into every package, failing any esbuild build that bundles a workspace library
instead of importing it.

`@nx/esbuild:esbuild` inlines workspace dependencies and leaves npm packages external. The consumer then holds a private
copy of the library, and anything that library owns at module scope — a registry, a cache, a counter — exists twice in
one process. Neither copy sees the other's state. Nothing throws; the symptom is a wrong value, and the library's own
tests pass because they run against source and always shared one instance.

The rule is blanket: every `workspace:*` dependency must appear in the consumer's `external`.

```json
{ "targets": { "build": { "options": { "external": ["ribi-database", "ribi-shared"] } } } }
```

`external` accepts `*` wildcards, so `["ribi-*"]` covers a whole prefix.

It is deliberately blanket rather than keyed on which libraries hold state. A rule that only covers libraries someone
remembered to mark cannot catch the case it exists for — the new library written by someone who did not know the rule.

### Scope

Only consumers whose `build` target uses `@nx/esbuild:esbuild` are checked. A vite consumer resolves one specifier to
one copy and has nothing to declare; any other bundler is unknown to this check rather than proven safe by it.

Project roots are expanded from the root manifest's `workspaces` globs, and only the `dir/*` form is supported. A deeper
glob throws rather than silently matching nothing and taking every package under it out of the check.

## `createPackageJsonNodes`

The helper the three plugins are built from, exported for writing a fourth in the same shape.

```ts
import { createPackageJsonNodes } from '@planttheidea/nx-monorepo-tools';

export const createNodesV2 = createPackageJsonNodes<Options>((projectRoot, options) => ({
  audit: { cache: true, command: `audit ${projectRoot}`, inputs: ['default', '^default'] },
}));
```

It supplies the `**/package.json` glob, skips the workspace root, and registers the returned targets against the
directory that owns the manifest.
