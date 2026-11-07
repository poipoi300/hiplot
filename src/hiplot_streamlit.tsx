/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import JSON5 from "json5";
import React, { type ReactNode } from "react";
import ReactDOMClient from "react-dom/client";
import { HiPlot } from "./hiplot";
import { Streamlit, StreamlitComponentBase, withStreamlitConnection } from "./streamlit";
import type { ComponentProps } from "./streamlit/StreamlitReact";

interface State {
  selected_uids: Array<string>;
  filtered_uids: Array<string>;
  brush_extents: Array<any>;
  experiment: any;
  experimentJson: string;
}

class ReactTemplate extends StreamlitComponentBase<State> {
  constructor(props: ComponentProps) {
    super(props);
    this.state = {
      selected_uids: null,
      filtered_uids: null,
      brush_extents: null,
      experiment: JSON5.parse(props.args.experiment),
      experimentJson: props.args.experiment,
    };
  }
  public render = (): ReactNode => {
    // Arguments that are passed to the plugin in Python are accessible
    // via `this.props.args`. Here, we access the "name" arg.
    const onChangeHandlers = {
      selected_uids: this.onChange.bind(this),
      filtered_uids: this.onChange.bind(this),
      brush_extents: this.onChange.bind(this),
      height_changed: () => Streamlit.setFrameHeight(),
    };
    return <HiPlot experiment={this.state.experiment} onChange={onChangeHandlers} />;
  };

  public onChange = (type: string, data: any): void => {
    // @ts-expect-error
    this.setState({ [type]: data });
    Streamlit.setFrameHeight();
  };

  public componentDidUpdate(prevProps, prevState: State): void {
    const ret: Array<string> = this.props.args["ret"];
    let changed = false;
    const py_ret = ret.map(
      function (r) {
        if (this.state[r] !== prevState[r]) {
          console.log(r, "changed");
          changed = true;
        }
        return this.state[r];
      }.bind(this),
    );
    if (changed || JSON.stringify(this.props.args.ret) !== JSON.stringify(prevProps.args.ret)) {
      console.log("hiplot update return", py_ret, {
        "prevProps.args.ret": prevProps.args.ret,
        "this.props.args.ret": this.props.args.ret,
        changed: changed,
      });
      Streamlit.setComponentValue(py_ret);
    }
    const newExp = this.props.args["experiment"];
    if (newExp !== this.state.experimentJson) {
      this.setState({
        experiment: JSON5.parse(newExp),
        experimentJson: newExp,
      });
    }
    Streamlit.setFrameHeight();
  }

  // Streamlit.setComponentValue( ... python return value )
}

const componentWrapped = withStreamlitConnection(ReactTemplate);

const rootElement = document.getElementById("root");
if (rootElement) {
  const root = ReactDOMClient.createRoot(rootElement);
  root.render(<React.StrictMode>{React.createElement(componentWrapped)}</React.StrictMode>);
}
