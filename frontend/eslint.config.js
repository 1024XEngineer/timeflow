// ESLint flat config，基于 Expo 官方规则集
// 文档: https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettierConfig = require('eslint-config-prettier');

module.exports = defineConfig([
  expoConfig,
  prettierConfig,
  {
    ignores: ['dist/**', '.expo/**', 'web-build/**', 'node_modules/**', 'modules/**'],
  },
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
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
