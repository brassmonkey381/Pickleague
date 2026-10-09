import React from 'react';
import { registerRootComponent } from 'expo';

import { StartupErrorScreen, installFatalErrorHandler } from './src/lib/StartupErrorScreen';

// First-visit web landing: fresh visitors hitting the root get the static
// marketing page (public/landing.html - authored in marketing-studio, which
// stamps this flag so the redirect never loops). Runs before the app graph
// loads. `document` discriminates web from native (RN has a `window` global
// but no DOM).
if (
  typeof document !== 'undefined' &&
  window.location.pathname === '/' &&
  !window.localStorage.getItem('pickleague_landing_seen')
) {
  window.location.replace('/landing.html');
}

installFatalErrorHandler();

// `./App` is pulled in with require(), not a top-level import, on purpose: ES
// imports are hoisted, so `import App from './App'` would evaluate the whole app
// graph BEFORE any try/catch here could run. Requiring it inside the try means a
// module-scope throw anywhere in that graph becomes a readable screen instead of
// a silent SIGABRT. See src/lib/StartupErrorScreen.tsx.
let Root: React.ComponentType;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Root = require('./App').default;
} catch (error) {
  Root = () =>
    React.createElement(StartupErrorScreen, { error, phase: 'while loading the app bundle' });
}

// The OS can wake the app headless to deliver a court geofence event, so the
// task must be defined at the entry's module scope, before anything renders.
// Guarded: a failure here costs arrival alerts, never the app.
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('./src/lib/courtGeofence').defineCourtGeofenceTask();
} catch {
  // native module missing (web) or a load error: no arrival alerts
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(Root);
