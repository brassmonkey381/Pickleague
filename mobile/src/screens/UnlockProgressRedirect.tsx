// The old Unlock Progress route (/unlock-progress, pushes, saved links). Its
// content now lives on Achievements: progress bars on the medals, what each
// badge unlocks in the detail sheet, Getting started as a group. Swaps itself
// for that screen so Back doesn't land on a blank page.
import React, { useEffect } from 'react';
import { View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'UnlockProgress'>;

export default function UnlockProgressRedirect({ navigation }: Props) {
  const { colors: c } = useTheme();
  useEffect(() => { navigation.replace('Achievements'); }, [navigation]);
  return <View style={{ flex: 1, backgroundColor: c.bg }} />;
}
