export type ToastTone = "error" | "info";
export type ToastPush = (message: string, tone?: ToastTone) => void;

// Module-level escape hatch so non-React surfaces (the QueryClient MutationCache in
// AppProviders) can surface toasts. Wired up by ToastProvider while it is mounted.
let globalPush: ToastPush | null = null;

export function setGlobalToastPush(push: ToastPush | null) {
  globalPush = push;
}

export function emitGlobalToast(message: string, tone: ToastTone = "error") {
  globalPush?.(message, tone);
}
