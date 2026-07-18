'use strict';

/**
 * Minimal lint gate (#286): deliberately small, high-signal correctness rules
 * only — unused variables/imports and unreachable code, the classes of defect
 * that shipped as the unused SHAPES import (#278) and ~40 unused catch
 * bindings. No formatting rules, no style churn: the two rules here must stay
 * cheap to keep green so the gate never becomes something to work around.
 *
 * Scope: runtime JS (lib/, nodes/) and the test tree. Editor HTML inline
 * scripts are out of scope — they run in the browser against the drift-test
 * pattern instead.
 */
module.exports = [
  {
    files: ['lib/**/*.js', 'nodes/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs'
    },
    linterOptions: {
      /** A disable comment for a rule that no longer fires is itself stale. */
      reportUnusedDisableDirectives: 'error'
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          args: 'after-used',
          caughtErrors: 'all',
          /**
           * The build node intentionally omits reserved envelope keys by
           * rest-destructuring past them — those siblings are the point, not
           * dead code.
           */
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
          argsIgnorePattern: '^_'
        }
      ],
      'no-unreachable': 'error'
    }
  }
];
