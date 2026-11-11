// Signs the player in from the link in a Supabase auth email when the app (not
// the browser) opened it, and leaves Sign In a plain note when the link failed.
// Rules: lib/authLink.ts. Renders nothing.
import { useEffect } from 'react';
import { Linking, Platform } from 'react-native';
import { supabase } from '../lib/supabase';
import { navigateWhenReady } from '../lib/navigationRef';
import { track } from '../lib/analytics';
import { authLinkNotice, parseAuthLink, setAuthLinkNotice } from '../lib/authLink';

async function handle(url: string | null): Promise<void> {
  const r = parseAuthLink(url);
  if (!r) return;
  if (r.kind === 'error') {
    track('auth.link_failed', { code: r.code ?? 'unknown' });
    // Already signed in (e.g. typed the code first): nothing to say.
    const { data } = await supabase.auth.getSession();
    if (data.session) return;
    setAuthLinkNotice(authLinkNotice(r));
    // Signed out, the web opens on the welcome page: show Sign In with the note.
    navigateWhenReady('Login', {});
    return;
  }
  // The web client reads a success itself (detectSessionInUrl).
  if (Platform.OS === 'web') return;
  const { error } = await supabase.auth.setSession({ access_token: r.accessToken, refresh_token: r.refreshToken });
  if (error) {
    setAuthLinkNotice("Your email is confirmed. Sign in below to continue.");
    track('auth.link_failed', { code: 'set_session' });
  } else {
    // AppNavigator sees the new session and opens Home.
    track('auth.confirmed', { via: 'link' });
  }
}

export default function AuthLinkHandler() {
  useEffect(() => {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') void handle(window.location.href);
      return;
    }
    void Linking.getInitialURL().then(handle).catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => { void handle(url); });
    return () => sub.remove();
  }, []);
  return null;
}
