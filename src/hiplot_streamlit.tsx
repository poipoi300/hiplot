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
import { isString, isStringArray } from "./lib/savedstate";
import { Streamlit, StreamlitComponentBase, withStreamlitConnection } from "./streamlit";
import type { ComponentProps } from "./streamlit/StreamlitReact";
import type { HiPlotExperiment } from "./types";

/** The values HiPlot reports back to Python, as named in `experiment.display_st(ret=...)`. */
const RETURN_KEYS = ["selected_uids", "filtered_uids", "brush_extents"] as const;
type ReturnKey = (typeof RETURN_KEYS)[number];

function isReturnKey(name: string): name is ReturnKey {
  return RETURN_KEYS.some((key) => key === name);
}

interface State extends Record<ReturnKey, unknown> {
  experiment: HiPlotExperiment;
  experimentJson: string;
}

function readExperimentJson(args: ComponentProps["args"]): string {
  const experimentJson = args.experiment;
  if (!isString(experimentJson)) {
    throw new Error("Streamlit arg `experiment` must be a JSON string");
  }
  return experimentJson;
}

function readReturnSpec(args: ComponentProps["args"]): Array<string> {
  const returnSpec = args.ret;
  if (!isStringArray(returnSpec)) {
    throw new Error("Streamlit arg `ret` must be a list of strings");
  }
  return returnSpec;
}

function parseExperiment(experimentJson: string): HiPlotExperiment {
  const experiment: unknown = JSON5.parse(experimentJson);
  if (typeof experiment !== "object" || experiment === null) {
    throw new Error("Streamlit arg `experiment` must encode a JSON object");
  }
  return experiment;
}

class ReactTemplate extends StreamlitComponentBase<State> {
  constructor(props: ComponentProps) {
    super(props);
    const experimentJson = readExperimentJson(props.args);
    this.state = {
      selected_uids: null,
      filtered_uids: null,
      brush_extents: null,
      experiment: parseExperiment(experimentJson),
      experimentJson: experimentJson,
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

  public onChange = (type: string, data: unknown): void => {
    if (!isReturnKey(type)) {
      throw new Error(`Unexpected HiPlot change "${type}"`);
    }
    this.setState((state) => ({ ...state, [type]: data }));
    Streamlit.setFrameHeight();
  };

  public componentDidUpdate(prevProps: Readonly<ComponentProps>, prevState: Readonly<State>): void {
    const ret = readReturnSpec(this.props.args);
    let changed = false;
    const py_ret = ret.map((r) => {
      if (!isReturnKey(r)) {
        throw new Error(`Unknown HiPlot return value "${r}"`);
      }
      if (this.state[r] !== prevState[r]) {
        console.log(r, "changed");
        changed = true;
      }
      return this.state[r];
    });
    if (changed || JSON.stringify(this.props.args.ret) !== JSON.stringify(prevProps.args.ret)) {
      console.log("hiplot update return", py_ret, {
        "prevProps.args.ret": prevProps.args.ret,
        "this.props.args.ret": this.props.args.ret,
        changed: changed,
      });
      Streamlit.setComponentValue(py_ret);
    }
    const newExp = readExperimentJson(this.props.args);
    if (newExp !== this.state.experimentJson) {
      this.setState({
        experiment: parseExperiment(newExp),
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
