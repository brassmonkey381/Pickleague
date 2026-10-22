// /play/start (PLAY_NAV_ENABLED): a link-only route. It renders nothing, opens
// the ▶ Play sheet (openPlayStart, which expands the island instead while a
// session runs) and takes itself out of the stack at once, so Back or a
// refresh never opens the sheet again (plan C10: replace, not push).
import React, { useEffect } from 'react';
import { View } from 'react-native';
import { CommonActions } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { openPlayStart } from '../lib/playSession';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'PlayStart'>;

export default function PlayStartScreen({ navigation }: Props) {
  useEffect(() => {
    navigation.dispatch((state) => {
      const routes = state.routes.filter((r) => r.name !== 'PlayStart');
      const next = routes.length > 0 ? routes : [{ key: `Home-${Date.now()}`, name: 'Home' as const }];
      return CommonActions.reset({ ...state, routes: next, index: next.length - 1 } as never);
    });
    openPlayStart();
  }, [navigation]);
  return <View />;
}
