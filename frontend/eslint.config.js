import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist', 'src/modules/core/api/openapi.ts']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    // SPHERE's module layout (docs/adr/0053-frontend-on-sphere-stack.md): src/modules/<domain>, with shared code in modules/core.
    // Outside src/modules there are only the application's root (App, main, config), the route table and the test kit.
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'core', pattern: 'src/modules/core' },
        {
          type: 'module-public',
          pattern: 'src/modules/*/{api,types,components,hooks,contexts}',
          capture: ['module'],
        },
        { type: 'module', pattern: 'src/modules/*', capture: ['module'] },
      ],
      'import/resolver': { node: { extensions: ['.ts', '.tsx', '.js', '.jsx'] } },
    },
  },
  {
    // The minimal module rule: modules/core imports no domain module, and a module imports another only through that module's
    // api/, types/, components/, hooks/ or contexts/ (SPHERE's own modules use `auth/hooks/useAuth`, so hooks and contexts are public too).
    files: ['src/modules/**/*.{ts,tsx}'],
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          policies: [
            {
              from: { element: { type: 'core' } },
              disallow: { to: { element: { types: { anyOf: ['module', 'module-public'] } } } },
            },
            {
              from: { element: { types: { anyOf: ['module', 'module-public'] } } },
              disallow: {
                to: {
                  element: {
                    type: 'module',
                    captured: { module: '!{{ from.element.captured.module }}' },
                  },
                },
              },
            },
          ],
        },
      ],
    },
  },
]);
