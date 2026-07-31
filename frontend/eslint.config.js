// ESLint flat config，基于 Expo 官方规则集
// 文档: https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettierConfig = require('eslint-config-prettier');

module.exports = defineConfig([
  expoConfig,
  prettierConfig,
  {
    ignores: [
      'dist/**',
      '.expo/**',
      'web-build/**',
      'node_modules/**',
      '_backup_*/**',
      '_shots/**',
      '**/*.apk',
      'android/**',
      'ios/**',
      'modules/**',
    ],
  },
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['src/features/**/*.ts', 'src/features/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/app',
                '@/app/*',
                '@/features/*',
                '@/features/*/*',
                '@/infrastructure',
                '@/infrastructure/*',
              ],
              message:
                'Features may depend only on contracts/shared and their own relative modules. Compose adapters in app.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'src/contracts/**/*.ts',
      'src/contracts/**/*.tsx',
      'src/shared/**/*.ts',
      'src/shared/**/*.tsx',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/app',
                '@/app/*',
                '@/dev',
                '@/dev/*',
                '@/features/*',
                '@/features/*/*',
                '@/infrastructure',
                '@/infrastructure/*',
              ],
              message: 'Contracts/shared must not depend on app, dev, features, or infrastructure.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/infrastructure/**/*.ts', 'src/infrastructure/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/app', '@/app/*', '@/dev', '@/dev/*', '@/features/*', '@/features/*/*'],
              message: 'Infrastructure must not depend on app, dev, or feature implementations.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/dev/**/*.ts', 'src/dev/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/*', '@/features/*/*'],
              message: 'Development fakes must not depend on feature-private implementations.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/app/**/*.ts', 'src/app/**/*.tsx', 'App.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/features/*/hooks/*',
                '@/features/*/components/*',
                '@/features/*/data/*',
                '@/features/*/domain/*',
                '@/features/*/application/*',
                '@/features/*/calendar/*',
                '@/features/*/editor/*',
                '@/features/*/detail/*',
                '@/features/*/screens/*',
                '@/features/*/model/*',
                '@/features/*/location/*',
                '@/features/*/native/*',
                '@/features/*/presentation/*',
                '@/features/*/services/*',
                '@/features/*/utils/*',
              ],
              message: 'Import from @/features/<name> public entry instead of deep paths.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['__tests__/**/*.ts', '__tests__/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'import/first': 'off',
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['jest.setup.js'],
    languageOptions: {
      globals: {
        jest: 'readonly',
      },
    },
  },
  {
    files: ['react-native.config.js'],
    languageOptions: {
      globals: {
        __dirname: 'readonly',
      },
    },
  },
]);
