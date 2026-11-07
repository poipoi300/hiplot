/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type React from "react";
import { useEffect, useId, useRef, useState } from "react";
import controls from "./controls.module.css";
import style from "./popover.module.css";

interface PopoverProps {
  /** Content of the button that opens the panel. */
  trigger: React.ReactNode;
  /** Accessible name of the panel. */
  label: string;
  /** Tooltip of the button. */
  title: string;
  /** Which edge of the button the panel lines up with. */
  align: "start" | "end";
  /** Panel content; `close` closes the panel. */
  children: (close: () => void) => React.ReactNode;
  testId?: string;
}

/**
 * A button that opens a panel below it. The panel closes on Escape (focus
 * returns to the button), on a pointer press outside it, and from its content.
 */
export function Popover({
  trigger,
  label,
  title,
  align,
  children,
  testId,
}: PopoverProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className={style.anchor} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={controls.button}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-testid={testId}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={label}
          className={`${style.panel} ${align === "end" ? style.alignEnd : style.alignStart}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
