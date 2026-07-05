// The Supabase client setup moved to @just-messin-around/expo-foundation. This file stays as
// the app's configured singleton — it injects the app's own env vars — so all
// existing `import { supabase } from '../lib/supabase'` call sites are unchanged.
import { createSupabase } from '@just-messin-around/expo-foundation/supabase';

export const supabase = createSupabase(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
);
