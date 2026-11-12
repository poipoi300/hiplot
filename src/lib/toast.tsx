/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type React from "react";
import { useState } from "react";
import { copyText } from "./clipboard";
import controls from "./controls.module.css";
import style from "./toast.module.css";

export interface Toast {
  id: number;
  message: string;
}

/** A message that stays available until dismissed, with a copy action. */
function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
}): React.ReactElement {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const copy = async (): Promise<void> => {
    setCopyStatus("copying");
    try {
      await copyText(toast.message);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };
  return (
    <div className={style.toast} role="alert" data-testid="toast">
      <span className={style.dot} aria-hidden="true" />
      <div className={style.message}>
        <span>{toast.message}</span>
        {(copyStatus === "copied" || copyStatus === "failed") && (
          <span className={style.status} role="status">
            {copyStatus === "copied" ? "Copied" : "Could not copy. Select and copy the message."}
          </span>
        )}
      </div>
      <div className={style.actions}>
        <button
          type="button"
          className={controls.button}
          aria-label="Copy message"
          disabled={copyStatus === "copying"}
          onClick={copy}
        >
          Copy
        </button>
        <button
          type="button"
          className={`${controls.button} ${controls.iconButton}`}
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
