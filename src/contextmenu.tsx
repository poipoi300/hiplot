/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import $ from "jquery";
import React from "react";
import { mounted } from "./lib/refs";

type ContextMenuProps = Record<never, never>;

/** Appends this owner's entries to the menu for `column` ("" when not opened on a column). */
export type ContextMenuCallback = (column: string, element: HTMLDivElement) => void;

interface ContextMenuTrigger {
  cb: ContextMenuCallback;
  owner: object;
}

interface ContextMenuState {
  visible: boolean;
  column: string;

  top: number;
  left: number;
}

export class ContextMenu extends React.Component<ContextMenuProps, ContextMenuState> {
  context_menu_div = React.createRef<HTMLDivElement>();
  trigger_callbacks: ContextMenuTrigger[] = [];
  trigger_callbacks_last: ContextMenuTrigger[] = [];
  constructor(props: ContextMenuProps) {
    super(props);
    this.state = {
      visible: false,
      column: "",
      top: 0,
      left: 0,
    };
    $(window).on("click", this.hide);
  }
  hide = (): void => {
    if (this.state.visible) {
      this.setState({ visible: false });
    }
  };
  addCallback(fn: ContextMenuCallback, owner: object, priority: "normal" | "last" = "normal") {
    if (priority === "last") {
      this.trigger_callbacks_last.push({ cb: fn, owner });
    } else {
      this.trigger_callbacks.push({ cb: fn, owner });
    }
  }
  removeCallbacks(owner: object) {
    this.trigger_callbacks = this.trigger_callbacks.filter((trigger) => trigger.owner !== owner);
    this.trigger_callbacks_last = this.trigger_callbacks_last.filter(
      (trigger) => trigger.owner !== owner,
    );
  }
  show(pageX: number, pageY: number, column: string) {
    // This assumes parent has `relative` positioning
    const parent = mounted(this.context_menu_div).parentElement;
    const offset = parent === null ? undefined : $(parent).offset();
    this.setState({
      top: Math.max(0, pageY - 10 - (offset?.top ?? 0)),
      left: Math.max(0, pageX - 90 - (offset?.left ?? 0)),
      visible: true,
      column: column,
    });
  }
  onContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    this.show(event.pageX, event.pageY, "");
    event.preventDefault();
    event.stopPropagation();
  };
  componentWillUnmount() {
    $(window).off("click", this.hide);
  }
  componentDidUpdate(
    _prevProps: Readonly<ContextMenuProps>,
    prevState: Readonly<ContextMenuState>,
  ) {
    const cm = mounted(this.context_menu_div);
    cm.style.display = this.state.visible ? "block" : "none";
    cm.style.top = `${this.state.top}px`;
    cm.style.left = `${this.state.left}px`;
    cm.classList.toggle("show", this.state.visible);
    const needsUpdate =
      (this.state.visible && !prevState.visible) || this.state.column !== prevState.column;
    if (needsUpdate) {
      cm.innerHTML = "";
      this.trigger_callbacks.forEach((trigger) => {
        trigger.cb(this.state.column, cm);
      });
      this.trigger_callbacks_last.forEach((trigger) => {
        trigger.cb(this.state.column, cm);
      });
      // After content is added, check if menu overflows viewport and reposition if needed
      requestAnimationFrame(() => {
        const rect = cm.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // Check right edge overflow
        if (rect.right > viewportWidth) {
          const newLeft = Math.max(0, this.state.left - (rect.right - viewportWidth) - 10);
          cm.style.left = `${newLeft}px`;
        }

        // Check bottom edge overflow
        if (rect.bottom > viewportHeight) {
          const newTop = Math.max(0, this.state.top - (rect.bottom - viewportHeight) - 10);
          cm.style.top = `${newTop}px`;
        }
      });
    }
  }
  render() {
    return (
      <div
        ref={this.context_menu_div}
        className="dropdown-menu dropdown-menu-sm context-menu"
        style={{ fontSize: 16 }}
      ></div>
    );
  }
}
