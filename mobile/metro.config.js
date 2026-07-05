// Metro config for consuming @just-messin-around/expo-foundation, a published
// GitHub Packages dependency that ships TypeScript SOURCE (Expo's Metro
// transpiles it like any other node_modules package — no build step).
//
// Single responsibility now that the foundation lives in node_modules:
//   single-copy resolution — force react / react-native / etc. to resolve to
//   THIS app's node_modules. The foundation declares them as peerDependencies,
//   but this pins it so a stray nested copy can never cause "Invalid hook call"
//   or a duplicate React context (which would silently break useTheme/useToast).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];

config.resolver.extraNodeModules = {
  react: path.resolve(projectRoot, 'node_modules/react'),
  'react-native': path.resolve(projectRoot, 'node_modules/react-native'),
  'react-native-web': path.resolve(projectRoot, 'node_modules/react-native-web'),
  'react-native-svg': path.resolve(projectRoot, 'node_modules/react-native-svg'),
  '@react-native-async-storage/async-storage': path.resolve(
    projectRoot,
    'node_modules/@react-native-async-storage/async-storage',
  ),
};

module.exports = config;
