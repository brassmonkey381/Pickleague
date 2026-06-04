import React from 'react';
import { ScrollView, Text } from 'react-native';

// Catches render-time crashes anywhere in the subtree and shows the error
// instead of a blank screen. Colors are hardcoded (no theme dependency) so the
// fallback renders even if a provider is what broke.
type Props = { children: React.ReactNode };
type State = { error: Error | null; stack: string | null };

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // Also log so it shows in the Metro terminal / browser console.
    console.error('[ErrorBoundary] render crash:', error, info?.componentStack);
    this.setState({ stack: info?.componentStack ?? null });
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children as React.ReactElement;
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: '#1c1c1c' }}
        contentContainerStyle={{ padding: 20, paddingTop: 60 }}
      >
        <Text style={{ color: '#ff6b6b', fontSize: 18, fontWeight: '800', marginBottom: 12 }}>
          💥 Something crashed
        </Text>
        <Text selectable style={{ color: '#fff', fontSize: 14, fontWeight: '700', marginBottom: 10 }}>
          {error.name}: {error.message}
        </Text>
        {error.stack ? (
          <Text selectable style={{ color: '#bbbbbb', fontSize: 11, marginBottom: 16 }}>
            {error.stack}
          </Text>
        ) : null}
        {stack ? (
          <Text selectable style={{ color: '#888888', fontSize: 11 }}>
            Component stack:{stack}
          </Text>
        ) : null}
      </ScrollView>
    );
  }
}
