// @stockman/rn-foundation — root barrel.
// Domain-agnostic Expo/React Native foundation shared across apps.
// Submodules are added here phase by phase as they are extracted.

export * from './supabase';
export * from './theme';
export * from './styles';
export * from './ui';
export * from './toast';
export * from './navigation';
export * from './hooks';
export * from './platform';

// availability and drillTime both export `slotLabel`, so they are exposed as
// namespaces here (and as distinct subpaths) to avoid a name collision.
export * as availability from './scheduling/availability';
export * as drillTime from './scheduling/drillTime';
