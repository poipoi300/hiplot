/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type React from "react";
import { useEffect } from "react";
import style from "./toast.module.css";

/** How long a toast stays up before it dismisses itself. */
export const TOAST_MS = 8000;

export interface Toast {
  id: number;
  message: string;
}

/** One toast: its message, a dismiss button, and a timer that dismisses it. */
function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
}): React.ReactElement {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast.id, onDismiss]);
  return (
    <div className={style.toast} role="alert" data-testid="toast">
      <span className={style.dot} aria-hidden="true" />
      <span className={style.message}>{toast.message}</span>
      <button
        type="button"
        className={style.dismiss}
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => onDismiss(toast.id)}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M2 2l6 6M8 2 2 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

/** The stack of toasts, bottom right of the window. */
export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: ReadonlyArray<Toast>;
  onDismiss: (id: number) => void;
}): React.ReactElement {
  return (
    <div className={style.stack}>
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
