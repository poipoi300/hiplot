import type React from "react";

/**
 * The element or component behind a ref that must be mounted by now (lifecycle
 * methods, event handlers of the mounted tree). Fails loudly otherwise.
 */
export function mounted<T>(ref: React.RefObject<T | null>): T {
  if (ref.current === null) {
    throw new Error("Ref read before its element was mounted");
  }
  return ref.current;
}
