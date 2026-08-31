// ESLint flat config. Goal: catch shadows / unused vars / undefined
// references going forward without forcing a sweeping style cleanup — CI
// should flag real bugs, not stylistic preferences.
//
// A bug here reaches every consumer's vendored copy on their next pin bump,
// and that copy lands as bundler output nobody reads line by line — which is
// why the kits lint at all.
//
// index.js is browser-first (fetch, AbortController, localStorage, atob/btoa)
// but is imported by Node consumers too, so both global sets are on. It must
// resolve every global at CALL time and touch none at module scope —
// `"sideEffects": false` depends on that, and the vendoring CLI tree-shakes
// narrowed builds on the promise.
import js from '@eslint/js';
import globals from 'globals';

const rules = {
  'no-shadow': 'error',
  'no-unused-vars': ['error', {
    args: 'after-used',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_?$',
  }],
  'no-undef': 'error',
  'no-redeclare': 'error',
  // A deliberate best-effort swallow (localStorage in private mode, a quota
  // error on write) is allowed, but should say why.
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-useless-escape': 'off',
  'prefer-const': 'off',
  // OFF, deliberately: the vendor suite matches a known two-space indent in
  // generated output, where `/^  (\w+): /` reads better than `/^ {2}(\w+): /`.
  'no-regex-spaces': 'off',
};

export default [
  js.configs.recommended,
  {
    files: ['index.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules,
  },
  {
    files: ['bin/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules,
  },
  { ignores: ['node_modules/**'] },
];
