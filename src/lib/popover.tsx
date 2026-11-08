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

/** Where the open panel sits in the viewport, from its button's edges. */
interface PanelPlacement {
  top: number;
  left?: number;
  right?: number;
}

/** Gap between the button and its panel. */
const PANEL_GAP_PIXELS = 6;

/**
 * A button that opens a panel below it. The panel is fixed to the viewport,
 * so a toolbar that clips its content (the header row) cannot clip it. It
 * closes on Escape (focus returns to the button), on a pointer press outside
 * it, when the page scrolls or resizes under it, and from its content.
 */
export function Popover({
  trigger,
  label,
  title,
  align,
  children,
  testId,
}: PopoverProps): React.ReactElement {
  const [placement, setPlacement] = useState<PanelPlacement | null>(null);
  const open = placement !== null;
  const setOpen = (next: boolean): void => {
    const button = buttonRef.current;
    if (!next || button === null) {
      setPlacement(null);
      return;
    }
    const rect = button.getBoundingClientRect();
    const top = rect.bottom + PANEL_GAP_PIXELS;
    setPlacement(
      align === "end"
        ? { top, right: document.documentElement.clientWidth - rect.right }
        : { top, left: rect.left },
    );
  };
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setPlacement(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setPlacement(null);
        buttonRef.current?.focus();
      }
    };
    const onMove = (event: Event): void => {
      // Scrolling inside the panel (a long column list) keeps it open.
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) {
        return;
      }
      setPlacement(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
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
      {placement !== null && (
        <div
          id={panelId}
          role="dialog"
          aria-label={label}
          className={style.panel}
          style={placement}
        >
          {children(() => setPlacement(null))}
        </div>
      )}
    </div>
  );
}
