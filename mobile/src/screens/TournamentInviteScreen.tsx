import React, { useEffect, useState } from 'react';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { RootStackParamList } from '../types';
import InviteCodeManager from '../components/InviteCodeManager';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'TournamentInvite'>;
  route:      RouteProp<RootStackParamList, 'TournamentInvite'>;
};

export default function TournamentInviteScreen({ route }: Props) {
  const { tournamentId, tournamentName } = route.params;
  const [ante, setAnte] = useState<number | undefined>(undefined);

  useEffect(() => {
    (async () => {
      try {
        const data = await sbCall(() =>
          supabase.from('tournaments').select('pickle_ante').eq('id', tournamentId).maybeSingle(),
        );
        setAnte((data as any)?.pickle_ante ?? 0);
      } catch {
        // Leave it undefined rather than defaulting to 0 — the invite copy
        // quotes this figure, and telling people a paid tournament is free is
        // worse than omitting the buy-in.
      }
    })();
  }, [tournamentId]);

  return (
    <InviteCodeManager
      scopeType="tournament"
      scopeId={tournamentId}
      scopeName={tournamentName}
      tournamentAnte={ante}
    />
  );
}
