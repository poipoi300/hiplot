/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import $ from "jquery";
import React from "react";
import LogoSVG from "../../hiplot/static/logo.svg";
import { mounted } from "../lib/refs";
import style from "./style.module.css";

// Injected by the Vite `define` option; absent when the source is not bundled by Vite.
declare const HIPLOT_PACKAGE_NAME_FULL: string | undefined;

interface TutorialStepProps {
  rootRef: React.RefObject<HTMLElement | null>;
}

/** The container that holds the plots next to the tutorial's navbar. */
function plotsContainer(rootRef: React.RefObject<HTMLElement | null>): JQuery {
  const container = mounted(rootRef).parentElement;
  if (container === null) {
    throw new Error("The tutorial navbar must be mounted inside the HiPlot container");
  }
  return $(container);
}

class _StepHiPlotInfo extends React.Component<TutorialStepProps> {
  render() {
    const pkgInfo = HIPLOT_PACKAGE_NAME_FULL ?? "hiplot (no version information)";
    return (
      <div className="alert alert-primary" role="alert">
        <div className="row">
          <div className="col-md-8">
            <h4 className="alert-heading">Welcome to HiPlot "getting started" tutorial</h4>
            Click the button "Next" to start
          </div>
          <div className="col-md-4">
            <img style={{ height: "50px" }} src={LogoSVG} alt="HiPlot" />
            <br />
            <span style={{ fontFamily: "monospace" }}>{pkgInfo}</span>
          </div>
        </div>

        <hr />
        <p>Learn more:</p>
        <ul>
          <li>
            <a href="https://ai.facebook.com/blog/hiplot-high-dimensional-interactive-plots-made-easy/">
              HiPlot launch on Facebook AI blog
            </a>
          </li>
          <li>
            <a href="https://github.com/facebookresearch/hiplot">
              https://github.com/facebookresearch/hiplot/
            </a>
            : star us on github or post issues
          </li>
          <li>
            <a href="https://facebookresearch.github.io/hiplot/">documentation</a>
          </li>
          <li>
            We provide both python (<a href="https://pypi.org/project/hiplot/">pip</a>,{" "}
            <a href="https://anaconda.org/conda-forge/hiplot">conda</a>) and javascript (
            <a href="https://www.npmjs.com/package/hiplot">hiplot on NPM</a>) packages
          </li>
        </ul>
        <hr />
        <p>Did you know that HiPlot can be used:</p>
        <ul>
          <li>
            In an{" "}
            <a href="https://facebookresearch.github.io/hiplot/getting_started.html#option-1-use-hiplot-in-an-ipython-notebook">
              ipython notebook
            </a>{" "}
            or in{" "}
            <a href="https://facebookresearch.github.io/hiplot/tuto_streamlit.html#tutostreamlit">
              Streamlit apps
            </a>
          </li>
          <li>
            As a{" "}
            <a href="https://facebookresearch.github.io/hiplot/tuto_javascript.html">
              HiPlot react component
            </a>
          </li>
          <li>
            As a{" "}
            <a href="https://facebookresearch.github.io/hiplot/getting_started.html#option-2-use-hiplot-webserver">
              standalone web server
            </a>
          </li>
          <li>
            Or simply{" "}
            <a href="https://facebookresearch.github.io/hiplot/_static/hiplot_upload.html">
              without any setup if you have a CSV file with your data
            </a>
          </li>
        </ul>
      </div>
    );
  }
}

class StepParallelPlot extends React.Component<TutorialStepProps> {
  componentDidMount() {
    plotsContainer(this.props.rootRef).find(".pplot-root").addClass(style.highlightElement);
  }
  componentWillUnmount() {
    plotsContainer(this.props.rootRef).find(".pplot-root").removeClass(style.highlightElement);
  }
  render() {
    return (
      <div className="alert alert-primary" role="alert">
        <h4 className="alert-heading">Step 1/4: The Parallel Plot</h4>
        <p>
          The first plot you see above is a <strong>Parallel Plot</strong>. Parallel plots are a
          convenient way to visualize and filter high-dimensional data. HiPlot will draw one
          vertical scaled axis for each metric you have in your dataset, and each training/data
          point is a continuous line that goes through its value on each of the axes.
        </p>
        <hr />
        <p className="mb-0">
          Learn more about{" "}
          <a href="https://en.wikipedia.org/wiki/Parallel_coordinates">Parallel coordinates</a> on
          Wikipedia.
        </p>
      </div>
    );
  }
}

class StepLearnToSlice extends React.Component<TutorialStepProps> {
  componentDidMount() {
    plotsContainer(this.props.rootRef).find(".pplot-brush").addClass(style.highlightElement);
  }
  componentWillUnmount() {
    plotsContainer(this.props.rootRef).find(".pplot-brush").removeClass(style.highlightElement);
  }
  render() {
    return (
      <div className="alert alert-primary" role="alert">
        <h4 className="alert-heading">Step 2/4: Slicing data</h4>
        <p>
          Slicing along an axis allows to discover patterns in the data.{" "}
          <strong>Drag vertically along an axis</strong> to display only a subset of the data. You
          also can do it on several axis at the same time. Drag on another part of the same axis to
          add a second slice: the axis then keeps the lines that go through any of its slices.
        </p>
        <hr />
        <p className="mb-0">
          Drag a slice to move it, or its top or bottom edge to resize it. To remove a slice, click
          on it.
        </p>
      </div>
    );
  }
}

class StepMoveAndRemoveColumns extends React.Component<TutorialStepProps> {
  componentDidMount() {
    plotsContainer(this.props.rootRef).find(".pplot-label").addClass(style.highlightText);
  }
  componentWillUnmount() {
    plotsContainer(this.props.rootRef).find(".pplot-label").removeClass(style.highlightText);
  }
  render() {
    return (
      <div className="alert alert-primary" role="alert">
        <h4 className="alert-heading">Step 3/4: Move and remove axis</h4>
        <p>
          Move an axis by <strong>dragging its label above</strong>. In parallel plots, we can very
          easily spot relationships between nearby axis. You can also <strong>remove</strong> an
          axis by moving it all the way to the left or to the right.
        </p>
      </div>
    );
  }
}

class StepDataTypeAndScaling extends React.Component<TutorialStepProps> {
  componentDidMount() {
    plotsContainer(this.props.rootRef).find(".pplot-label").addClass(style.highlightText);
  }
  componentWillUnmount() {
    plotsContainer(this.props.rootRef).find(".pplot-label").removeClass(style.highlightText);
  }
  render() {
    return (
      <div className="alert alert-primary" role="alert">
        <h4 className="alert-heading">Step 4/4: Data type and scaling</h4>
        <p>
          <strong>Right click on an axis</strong> to see options. You can chose how to color your
          datapoints, change the scaling and more!
        </p>
        <hr />
        <p className="mb-0">
          In this same menu, you can enable an <strong>XY plot</strong> by selecting an X and Y
          axis.
        </p>
      </div>
    );
  }
}

interface Props {
  onTutorialDone: () => void;
  navbarRoot: React.RefObject<HTMLDivElement | null>;
}

interface State {
  stepNum: number;
}

export class HiPlotTutorial extends React.Component<Props, State> {
  steps = [
    (p: TutorialStepProps) => <StepParallelPlot {...p} />,
    (p: TutorialStepProps) => <StepLearnToSlice {...p} />,
    (p: TutorialStepProps) => <StepMoveAndRemoveColumns {...p} />,
    (p: TutorialStepProps) => <StepDataTypeAndScaling {...p} />,
  ];

  constructor(props: Props) {
    super(props);
    this.state = {
      stepNum: 0,
    };
  }
  onClickNextTutorial() {
    if (this.state.stepNum === this.steps.length - 1) {
      this.props.onTutorialDone();
      return;
    }
    this.setState((prevState, _prevProps) => ({
      stepNum: Math.min(prevState.stepNum + 1, this.steps.length - 1),
    }));
  }
  onClickPreviousTutorial() {
    if (this.state.stepNum === 0) {
      this.props.onTutorialDone();
      return;
    }
    this.setState((prevState, _prevProps) => ({
      stepNum: Math.max(prevState.stepNum - 1, 0),
    }));
  }

  render() {
    return (
      <div className={`row ${style.tutoAlert}`}>
        <div className="col-md-9">
          {this.steps[this.state.stepNum]({
            rootRef: this.props.navbarRoot,
          })}
        </div>
        <div className="col-md-3">
          <button
            type="button"
            className="btn btn-outline-secondary"
            style={{ width: "6em" }}
            onClick={this.onClickPreviousTutorial.bind(this)}
          >
            {this.state.stepNum > 0 ? "Previous" : "Close"}
          </button>
          <button
            type="button"
            className="btn btn-outline-primary"
            style={{ width: "6em" }}
            onClick={this.onClickNextTutorial.bind(this)}
          >
            {this.state.stepNum + 1 < this.steps.length ? "Next" : "Finish"}
          </button>
        </div>
      </div>
    );
  }
}
