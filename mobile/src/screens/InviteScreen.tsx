import React from 'react';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList } from '../types';
import InviteCodeManager from '../components/InviteCodeManager';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Invite'>;
  route:      RouteProp<RootStackParamList, 'Invite'>;
};

export default function InviteScreen({ route }: Props) {
  const { leagueId, leagueName } = route.params;
  return (
    <InviteCodeManager
      scopeType="league"
      scopeId={leagueId}
      scopeName={leagueName}
    />
  );
}
