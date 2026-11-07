/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import $ from "jquery";
import React from "react";
import _ from "underscore";
import { mounted } from "./refs";
import style from "./resizable.module.css";

interface ResizableHProps {
  initialHeight: number;
  onResize: (height: number, width: number) => void;
  borderSize: number;
  minHeight: number;
  children?: React.ReactNode;

  onRemove?: () => void;
}

interface ResizableHState {
  height: number;
  width: number;
  internalHeight: number;
  removing: boolean;
}

export class ResizableH extends React.Component<ResizableHProps, ResizableHState> {
  div_ref = React.createRef<HTMLDivElement>();
  m_pos: number | null = null;

  constructor(props: ResizableHProps) {
    super(props);
    this.state = {
      width: 0,
      height: this.props.initialHeight,
      internalHeight: this.props.initialHeight,
      removing: false,
    };
  }
  static defaultProps = {
    borderSize: 4,
    minHeight: 100,
  };
  componentDidMount() {
    const element = mounted(this.div_ref);
    const div = $(element);
    div.on("mousedown", (e) => {
      if (e.offsetY > (div.height() ?? 0) - this.props.borderSize) {
        this.m_pos = e.clientY;
        document.addEventListener("mousemove", this.onMouseMove, false);
      }
    });

    document.addEventListener("mouseup", this.onMouseUp);
    $(window).on("resize", this.onWindowResize);
    const parent = element.parentElement;
    if (parent === null) {
      throw new Error("ResizableH must be mounted inside a parent element");
    }
    this.setState({ width: parent.offsetWidth });
  }
  componentDidUpdate(_prevProps: Readonly<ResizableHProps>, prevState: Readonly<ResizableHState>) {
    if (prevState.height !== this.state.height || prevState.width !== this.state.width) {
      this.props.onResize(this.state.height, this.state.width);
    }
  }
  componentWillUnmount() {
    document.removeEventListener("mousemove", this.onMouseMove, false);
    document.removeEventListener("mouseup", this.onMouseUp);
    $(window).off("resize", this.onWindowResize);
    this.onWindowResize.cancel();
  }
  render() {
    return (
      <div
        ref={this.div_ref}
        style={{ height: this.state.height }}
        className={`${style.resizableH} ${this.state.removing ? style.pendingDelete : ""}`}
      >
        {this.props.children}
      </div>
    );
  }
  onMouseMove = (e: MouseEvent): void => {
    if (this.m_pos === null) {
      return;
    }
    const dy = e.clientY - this.m_pos;
    this.m_pos = e.clientY;
    if (dy !== 0) {
      const internalHeight = this.state.internalHeight + dy;
      this.setState({
        height: Math.max(this.props.minHeight, internalHeight),
        internalHeight: internalHeight,
        removing: this.props.onRemove !== undefined && internalHeight < this.props.minHeight,
      });
    }
  };
  onMouseUp = (_e: MouseEvent): void => {
    if (this.m_pos === null) {
      return;
    }
    this.m_pos = null;
    document.removeEventListener("mousemove", this.onMouseMove, false);
    if (this.props.onRemove && this.state.removing) {
      this.props.onRemove();
    }
  };
  onWindowResize = _.debounce(() => {
    if (this.div_ref.current) {
      this.setState({ width: this.div_ref.current.offsetWidth });
    }
  }, 100);
}
