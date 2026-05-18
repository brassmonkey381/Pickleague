import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import StatusBanner from '../components/StatusBanner';

/**
 * Global toast provider. Mount once at the app root (in AppNavigator).
 * Any descendant can call `useToast()` and trigger success / error toasts.
 *
 * ADDITIVE — existing screens using `useStatusMessage` + <StatusBanner>
 * stay as-is. New code can adopt `useToast` for floating, top-center messages.
 *
 * API mirrors `useStatusMessage` for mechanical migrations later:
 *   const toast = useToast();
 *   toast.success('Saved!');
 *   toast.error('Network failed');
 */

export type ToastKind = 'success' | 'error';

export type Toast = {
  id: number;
  kind: ToastKind;
  text: string;
};

export type ToastContextValue = {
  success: (text: string) => void;
  error: (text: string) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const AUTO_DISMISS_MS = 4000;

export default function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const push = useCallback((kind: ToastKind, text: string) => {
    const id = nextIdRef.current++;
    setToasts((prev) => [...prev, { id, kind, text }]);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timersRef.current.delete(id);
    }, AUTO_DISMISS_MS);
    timersRef.current.set(id, timer);
  }, []);

  const success = useCallback((text: string) => push('success', text), [push]);
  const error   = useCallback((text: string) => push('error',   text), [push]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ success, error, dismiss }),
    [success, error, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;

  // On web, `position: fixed` pins the stack to viewport; RN's type system
  // doesn't know 'fixed', so it's injected via a cast.
  const fixedOnWeb =
    Platform.OS === 'web' ? ({ position: 'fixed' } as any) : null;
  const webShadow =
    Platform.OS === 'web'
      ? ({ boxShadow: '0 4px 12px rgba(0,0,0,0.15)' } as any)
      : null;

  return (
    <View pointerEvents="box-none" style={[styles.container, fixedOnWeb]}>
      {toasts.map((t) => (
        <Pressable
          key={t.id}
          onPress={() => onDismiss(t.id)}
          style={[styles.toastWrap, webShadow]}
          accessibilityRole="button"
          accessibilityLabel={`${t.kind === 'error' ? 'Error' : 'Success'}: ${t.text}. Tap to dismiss.`}
        >
          <StatusBanner
            status={{ kind: t.kind, text: t.text }}
            style={styles.bannerOverride}
          />
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: Platform.OS === 'web' ? 16 : 48,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 9999,
    paddingHorizontal: 12,
  },
  toastWrap: {
    width: '100%',
    maxWidth: 360,
    marginBottom: 16,
    borderRadius: 10,
    elevation: 6,
  },
  bannerOverride: {
    // Override StatusBanner's marginVertical so the wrapper controls spacing.
    marginVertical: 0,
  },
});

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn('useToast called outside <ToastProvider>; toasts will be silently dropped.');
    }
    return {
      success: () => {},
      error:   () => {},
      dismiss: () => {},
    };
  }
  return ctx;
}
