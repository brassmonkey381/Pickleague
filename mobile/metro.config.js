// Metro config so the app can consume the local @stockman/rn-foundation package
// (declared as `file:../shared`) which ships TypeScript source.
//
// Two responsibilities:
//   1. watchFolders — let Metro serve/transpile the package source that lives
//      outside the app root, and hot-reload edits to it.
//   2. single-copy resolution — force react / react-native / etc. to resolve to
//      THIS app's node_modules. The foundation declares them as peerDependencies,
//      but this pins it so a stray nested copy can never cause "Invalid hook call"
//      or a duplicate React context (which would silently break useTheme/useToast).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '..', 'shared');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [sharedRoot];

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
