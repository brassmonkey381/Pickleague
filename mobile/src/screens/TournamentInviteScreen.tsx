import React, { useEffect, useState } from 'react';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
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
      const { data } = await supabase
        .from('tournaments')
        .select('pickle_ante')
        .eq('id', tournamentId)
        .maybeSingle();
      setAnte((data as any)?.pickle_ante ?? 0);
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
