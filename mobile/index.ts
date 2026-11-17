import React from 'react';
import { registerRootComponent } from 'expo';

import { StartupErrorScreen, installFatalErrorHandler } from './src/lib/StartupErrorScreen';

// The web landing page is no longer a JavaScript redirect: the deployed site
// serves public/landing.html AS the home page (/) to everyone, and the app at
// /home and its other paths (vercel.json, scripts/web-postbuild.mjs, PKL-028).
// Signed-in visitors and sign-in email links are forwarded from / to /home by
// a script in landing.html. `document` discriminates web from native.
// Dev web only: /?sharelab draws the share card QA grid (src/dev/ShareLabWeb),
// /?lookslab the shared parts in the current look (src/dev/LooksLabWeb),
// /?revamplab=<scene> the PKL-031 overlays and screens (src/dev/RevampLabWeb).
const shareLab =
  __DEV__ && typeof document !== 'undefined' && new URLSearchParams(window.location.search).has('sharelab');
const looksLab =
  __DEV__ && typeof document !== 'undefined' && new URLSearchParams(window.location.search).has('lookslab');
const revampLab =
  __DEV__ && typeof document !== 'undefined' && new URLSearchParams(window.location.search).has('revamplab');

installFatalErrorHandler();

// `./App` is pulled in with require(), not a top-level import, on purpose: ES
// imports are hoisted, so `import App from './App'` would evaluate the whole app
// graph BEFORE any try/catch here could run. Requiring it inside the try means a
// module-scope throw anywhere in that graph becomes a readable screen instead of
// a silent SIGABRT. See src/lib/StartupErrorScreen.tsx.
let Root: React.ComponentType;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Root = shareLab
    ? // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('./src/dev/ShareLabWeb').default
    : looksLab
      ? // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('./src/dev/LooksLabWeb').default
      : revampLab
        ? // eslint-disable-next-line @typescript-eslint/no-var-requires
          require('./src/dev/RevampLabWeb').default
        : require('./App').default;
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
