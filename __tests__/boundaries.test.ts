import { describe, expect, test } from 'vitest';
import type { BoundaryRule } from '../src/boundaries/check.js';
import { getViolations, RULES } from '../src/boundaries/check.js';

describe('getViolations', () => {
  test('labels each report with the rule that produced it', async () => {
    const rules: BoundaryRule[] = [
      { name: 'first', check: () => 'first broke' },
      { name: 'second', check: () => Promise.resolve('second broke') },
    ];

    expect(await getViolations('/workspace', 'libraries/consumer', new Map(), rules)).toEqual([
      '[first] first broke',
      '[second] second broke',
    ]);
  });

  test('leaves out rules the project complies with', async () => {
    const rules: BoundaryRule[] = [
      { name: 'passing', check: () => undefined },
      { name: 'failing', check: () => 'broke' },
    ];

    expect(await getViolations('/workspace', 'libraries/consumer', new Map(), rules)).toEqual(['[failing] broke']);
  });

  test('passes the project and the name-to-root map to every rule', async () => {
    const received: unknown[] = [];
    const projectRootsByName = new Map([['shared', 'libraries/shared']]);

    await getViolations('/workspace', 'libraries/consumer', projectRootsByName, [
      {
        name: 'recording',
        check: (...args) => {
          received.push(args);

          return undefined;
        },
      },
    ]);

    expect(received).toEqual([['/workspace', 'libraries/consumer', projectRootsByName]]);
  });
});

describe('RULES', () => {
  test('runs the externals and sources rules, in that order', () => {
    expect(RULES.map(({ name }) => name)).toEqual(['externals', 'sources']);
  });
});
