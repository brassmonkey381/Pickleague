// Startup crash diagnostics.
//
// A throw at module scope (anywhere in the app's import graph) has no visible
// failure mode in a release build: expo-updates installs an RN fatal handler,
// fails to recover, and re-raises the exception on its own dispatch queue. iOS
// records that as EXC_CRASH/SIGABRT with `abort() called` and NOTHING else —
// the JS message is not in the .ips, so the crash is unreadable without a Mac
// attached to the device.
//
// This module renders the error instead, on the kit's friendly CrashScreen in
// Rally's colours as plain hex (PKL-031). CrashScreen depends on nothing but
// react, react-native and react-native-svg: no theme, no navigation, no
// Supabase. The details (one tap, "Show details for support") keep the phase,
// the message and the stack in every build: this is the only way to read a
// startup crash on a phone without a Mac attached.
import React from 'react';
import { CrashScreen } from '@just-messin-around/expo-foundation/ui';
import { CRASH_BODY, CRASH_TITLE, CRASH_TITLE_FONT, PICKLEAGUE_CRASH_PALETTE } from './crashPalette';

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return [error.name + ': ' + error.message, '', error.stack ?? '(no stack)'].join('\n');
  }
  try {
    return typeof error === 'string' ? error : JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

export function StartupErrorScreen({ error, phase, onRetry }: { error: unknown; phase: string; onRetry?: () => void }) {
  return (
    <CrashScreen
      error={error}
      onRetry={onRetry}
      title={CRASH_TITLE}
      body={CRASH_BODY}
      palette={PICKLEAGUE_CRASH_PALETTE}
          titleFontFamily={CRASH_TITLE_FONT}
      showStack
      extraDetails={`Phase: ${phase}`}
    />
  );
}

// Fatal errors raised outside render (an async throw, a native module callback)
// reach neither index.ts's try/catch nor the error boundary — they go straight
// to RN's fatal handler and abort. Route them to the mounted boundary instead.
let onFatal: ((error: unknown) => void) | null = null;

export function installFatalErrorHandler() {
  const errorUtils = (global as { ErrorUtils?: unknown }).ErrorUtils as
    | {
        setGlobalHandler(cb: (error: unknown, isFatal?: boolean) => void): void;
        getGlobalHandler?(): (error: unknown, isFatal?: boolean) => void;
      }
    | undefined;
  if (!errorUtils?.setGlobalHandler) return;
  const previous = errorUtils.getGlobalHandler?.();
  errorUtils.setGlobalHandler((error, isFatal) => {
    // Deliberately not forwarding fatals to the default handler: that is what
    // aborts the process, and the whole point here is to show the message.
    if (isFatal && onFatal) onFatal(error);
    else previous?.(error, isFatal);
  });
}

/**
 * Catches errors thrown while rendering (as opposed to while evaluating the
 * bundle, which index.ts handles) so they are readable rather than fatal.
 */
export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: unknown; phase: string }
> {
  state: { error: unknown; phase: string } = { error: null, phase: 'while rendering' };

  static getDerivedStateFromError(error: unknown) {
    return { error, phase: 'while rendering' };
  }

  componentDidMount() {
    onFatal = (error) => this.setState({ error, phase: 'after launch (uncaught fatal)' });
  }

  componentWillUnmount() {
    onFatal = null;
  }

  render() {
    if (this.state.error) {
      return (
        <StartupErrorScreen
          error={this.state.error}
          phase={this.state.phase}
          onRetry={() => this.setState({ error: null, phase: 'while rendering' })}
        />
      );
    }
    return this.props.children;
  }
}
