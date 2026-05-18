/**
 * Convenience re-export so callers can `import { useToast } from '../lib/useToast'`.
 * The actual implementation lives in ToastProvider.tsx.
 */
export { useToast } from './ToastProvider';
export type { ToastContextValue, ToastKind, Toast } from './ToastProvider';
