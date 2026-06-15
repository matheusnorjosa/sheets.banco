// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import securityPlugin from 'eslint-plugin-security';
import promisePlugin from 'eslint-plugin-promise';

/**
 * Flat config (ESLint 9+). Starts intentionally lean — `recommended` for JS/TS
 * plus security smells. Type-checked rules are heavier and slower; opt in via
 * `tseslint.configs.recommendedTypeChecked` once the noise floor is stable.
 *
 * Rule philosophy:
 * - Errors fail CI. Warnings are kept visible but don't block.
 * - Rules that fire on intentional dynamic access (object-injection,
 *   non-literal-fs-filename) are off — the API resolves runtime paths/keys
 *   from validated config, not from user input that crosses the trust boundary.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '**/*.test.ts',
      'scripts/**', // ad-hoc tools, not production code
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  securityPlugin.configs.recommended,
  promisePlugin.configs['flat/recommended'],
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      // Allow `_`-prefixed names to indicate intentional unused
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // We DO use `any` deliberately in some places (Fastify dynamic plugin
      // options, error narrowing). Warn instead of error so it's visible
      // without blocking.
      '@typescript-eslint/no-explicit-any': 'warn',

      // The codebase legitimately uses dynamic object access for caches,
      // headers, and JSON envelopes. Security plugin's heuristic flags too
      // many false positives — turn off and rely on input validation at
      // the boundary (zod + Fastify schema).
      'security/detect-object-injection': 'off',

      // We read paths from validated env config, not user input.
      'security/detect-non-literal-fs-filename': 'off',

      // We build dynamic regexps from configured patterns (e.g., search
      // operators) — not user-controlled at runtime.
      'security/detect-non-literal-regexp': 'off',

      // `safe-regex`, which this rule wraps, has a well-known high false-
      // positive rate on perfectly safe patterns (anchored, no nested
      // quantifiers). Disabled after audit confirmed all initial hits were
      // false alarms (time HH:MM:SS, A1 notation, anchored ISO dates).
      'security/detect-unsafe-regex': 'off',

      // Promise rules: keep `no-callback-in-promise` as warning; we have a
      // few legitimate fire-and-forget patterns.
      'promise/no-callback-in-promise': 'warn',
      'promise/always-return': 'warn',
    },
  },
);
