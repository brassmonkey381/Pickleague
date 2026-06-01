import { createNavigationContainerRef } from '@react-navigation/native';
import { RootStackParamList } from '../types';

// Shared ref so non-component code (e.g. push-notification tap handlers in
// lib/push.ts) can navigate without prop-drilling the navigation object.
export const navigationRef = createNavigationContainerRef<RootStackParamList>();
