// ESLint flat config，基于 Expo 官方规则集
// 文档: https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettierConfig = require('eslint-config-prettier');

module.exports = defineConfig([
  expoConfig,
  prettierConfig,
  {
    ignores: ['dist/**', '.expo/**', 'web-build/**', 'node_modules/**'],
  },
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['__tests__/**/*.ts', '__tests__/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'import/first': 'off',
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
]);
