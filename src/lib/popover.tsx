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
  /** Accessible name of the button, when its content does not read as one. */
  buttonLabel?: string;
  /** Which edge of the button the panel lines up with. */
  align: "start" | "end";
  /** Panel content; `close` closes the panel. */
  children: (close: () => void) => React.ReactNode;
  testId?: string;
}

/**
 * Where the open panel sits in the viewport, from its button's edges: below
 * the button (`top`) or above it (`bottom`), no taller than the room there.
 */
export interface PanelPlacement {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  maxHeight: number;
}

/** Gap between the button and its panel. */
const PANEL_GAP_PIXELS = 6;
/** Room kept between the panel and the viewport's edge. */
const VIEWPORT_MARGIN_PIXELS = 8;
/** Below the button is preferred while it has at least this much room. */
const PREFERRED_ROOM_PIXELS = 320;

/**
 * Where a panel opens from a button at `button` in a viewport of `width` by
 * `height`: below it while there is room, else on the side with more room.
 */
export function panelPlacement(
  button: { top: number; bottom: number; left: number; right: number },
  viewport: { width: number; height: number },
  align: "start" | "end",
): PanelPlacement {
  const below = viewport.height - button.bottom - PANEL_GAP_PIXELS - VIEWPORT_MARGIN_PIXELS;
  const above = button.top - PANEL_GAP_PIXELS - VIEWPORT_MARGIN_PIXELS;
  const horizontal =
    align === "end" ? { right: viewport.width - button.right } : { left: button.left };
  if (below >= PREFERRED_ROOM_PIXELS || below >= above) {
    return { top: button.bottom + PANEL_GAP_PIXELS, maxHeight: below, ...horizontal };
  }
  return {
    bottom: viewport.height - button.top + PANEL_GAP_PIXELS,
    maxHeight: above,
    ...horizontal,
  };
}

/**
 * A button that opens a panel below it, or above it near the bottom of the
 * viewport. The panel is fixed to the viewport, so a toolbar that clips its
 * content (the header row) cannot clip it. It closes on Escape (focus
 * returns to the button), on a pointer press outside it, when the page
 * scrolls or resizes under it, and from its content.
 */
export function Popover({
  trigger,
  label,
  title,
  buttonLabel,
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
    const viewport = document.documentElement;
    const rect = button.getBoundingClientRect();
    anchorRef.current = { top: rect.top, left: rect.left };
    setPlacement(
      panelPlacement(rect, { width: viewport.clientWidth, height: viewport.clientHeight }, align),
    );
  };
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  /** Where the button was when the panel opened, which the panel is placed from. */
  const anchorRef = useRef<{ top: number; left: number } | null>(null);
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
    // A scroll closes the panel once it moves the button away from it. Scroll
    // events arrive a frame late: one from before the panel opened, or from
    // inside it (a long column list), leaves the button where it was.
    const onScroll = (): void => {
      const anchor = anchorRef.current;
      const rect = buttonRef.current?.getBoundingClientRect();
      if (
        anchor !== null &&
        rect !== undefined &&
        Math.abs(rect.top - anchor.top) < 0.5 &&
        Math.abs(rect.left - anchor.left) < 0.5
      ) {
        return;
      }
      setPlacement(null);
    };
    const onResize = (): void => setPlacement(null);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <div className={style.anchor} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={controls.button}
        title={title}
        aria-label={buttonLabel}
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
