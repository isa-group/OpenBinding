import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import boundaries from 'eslint-plugin-boundaries'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'src/shared/api/openapi.ts']),
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
    // The layers of docs/ARCHITECTURE.md §5: shared ← entities ← widgets ← features ← pages. Each layer folder holds slices
    // (`src/widgets/workflow-graph`, `src/features/derive`, …). The legacy `components`, `api`, `utils` and `contexts` folders
    // count as shared and are importable from every layer.
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'shared', pattern: 'src/shared/*', capture: ['name'] },
        { type: 'shared', pattern: 'src/components' },
        { type: 'shared', pattern: 'src/api' },
        { type: 'shared', pattern: 'src/utils' },
        { type: 'shared', pattern: 'src/contexts' },
        { type: 'entity', pattern: 'src/entities/*', capture: ['name'] },
        { type: 'widget', pattern: 'src/widgets/*', capture: ['name'] },
        { type: 'feature', pattern: 'src/features/*', capture: ['name'] },
        { type: 'page', pattern: 'src/pages/*', capture: ['name'] },
      ],
      'import/resolver': { node: { extensions: ['.ts', '.tsx', '.js', '.jsx'] } },
    },
  },
  {
    // Report-only for the pages that predate the layers: an import from one page into another is a warning, never an error.
    files: ['src/pages/**/*.{ts,tsx}'],
    rules: {
      'boundaries/dependencies': [
        'warn',
        {
          default: 'allow',
          policies: [
            {
              from: { element: { type: 'page' } },
              disallow: {
                to: { element: { type: 'page', captured: { name: '!{{ from.element.captured.name }}' } } },
              },
            },
          ],
        },
      ],
    },
  },
  {
    // The new layers fail on a wrong-way import. Slices of one layer may use each other below the features (the renderer
    // composes the leaf widgets, the composition entity reads the binding entity); features never import each other, so a
    // widget that needs a feature's dialog takes a callback and the page mounts the dialog.
    files: ['src/{shared,entities,widgets,features}/**/*.{ts,tsx}'],
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          policies: [
            {
              from: { element: { type: 'shared' } },
              disallow: { to: { element: { types: { anyOf: ['entity', 'widget', 'feature', 'page'] } } } },
            },
            {
              from: { element: { type: 'entity' } },
              disallow: { to: { element: { types: { anyOf: ['widget', 'feature', 'page'] } } } },
            },
            {
              from: { element: { type: 'widget' } },
              disallow: { to: { element: { types: { anyOf: ['feature', 'page'] } } } },
            },
            {
              from: { element: { type: 'feature' } },
              disallow: { to: { element: { type: 'page' } } },
            },
            {
              from: { element: { type: 'feature' } },
              disallow: {
                to: { element: { type: 'feature', captured: { name: '!{{ from.element.captured.name }}' } } },
              },
            },
          ],
        },
      ],
    },
  },
])
