const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// expo-sqlite Web imports wa-sqlite.wasm directly.
config.resolver.assetExts.push('wasm');

module.exports = config;
