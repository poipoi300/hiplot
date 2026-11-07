/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as d3 from "d3";
import $ from "jquery";
import React from "react";
import ReactDOMClient from "react-dom/client";
import { HiPlot, type HiPlotProps } from "./hiplot";
import { build_props, type HiPlotRenderOptions } from "./hiplot_web";
import { mounted } from "./lib/refs";
import { ParallelPlot } from "./parallel/parallel";
import { PlotXY } from "./plotxy";

interface TesterState {
  testNum: number;
  testDone: boolean;
  renderNum: number;
  width: number;
  keepCount: number;
}

type Test = { name: string; test: (this: HiPlotTester) => void };

/** The DOM element the tester renders into, remembering its React root. */
interface HiPlotTesterMountPoint extends HTMLElement {
  __hiplot_test_root?: ReactDOMClient.Root;
}

export class HiPlotTester extends React.Component<{ hiplotProps: HiPlotProps }, TesterState> {
  root = React.createRef<HTMLDivElement>();
  hiplot = React.createRef<HiPlot>();

  timeout: ReturnType<typeof setTimeout> | null = null;
  state: TesterState = {
    testNum: -1,
    testDone: false,
    renderNum: 0,
    keepCount: 10,
    width: 1024,
  };
  testSelection: Array<Test> = [
    { name: "testSelect", test: this.testSelect },
    {
      name: "keepBtn",
      test: function () {
        this.testButton("Keep");
      },
    },
    {
      name: "kept",
      test: function () {
        console.assert(this.mountedHiPlot().state.rows_filtered.length === this.state.keepCount);
      },
    },
    {
      name: "restoreBtn",
      test: function () {
        this.testButton("Restore");
      },
    },
    {
      name: "restored",
      test: function () {
        console.assert(this.mountedHiPlot().state.rows_filtered.length !== this.state.keepCount);
      },
    },
    { name: "testSelect", test: this.testSelect },
    {
      name: "excludeBtn",
      test: function () {
        this.testButton("Exclude");
      },
    },
    {
      name: "restoreBtn",
      test: function () {
        this.testButton("Restore");
      },
    },
  ];

  testFn: Array<Test> = [
    {
      name: "responsiveWidth",
      test: function () {
        console.assert(mounted(this.root).scrollWidth === this.state.width);
      },
    },
    { name: "testSelect", test: this.testSelect },
    { name: "testSelectNone", test: this.testSelectNone },
    { name: "testSelectAll", test: this.testSelectAll },
    ...this.testSelection,
    {
      name: "testResize",
      test: function () {
        this.setState({ width: 800 });
      },
    },
    {
      name: "testResize2",
      test: () => {
        $(window).trigger("resize");
      },
    },
    {
      name: "responsiveWidth",
      test: function () {
        console.assert(mounted(this.root).scrollWidth === this.state.width);
      },
    },
    {
      name: "testResize",
      test: function () {
        this.setState({ width: 1024 });
      },
    },
    {
      name: "testResize2",
      test: () => {
        $(window).trigger("resize");
      },
    },
    { name: "changeColor", test: this.testChangeColor },
    { name: "changeColor", test: this.testChangeColor },
    { name: "changeColor", test: this.testChangeColor },
    { name: "changeColor", test: this.testChangeColor },
    { name: "changeColor", test: this.testChangeColor },
    { name: "changeColor", test: this.testChangeColor },
    { name: "changeColor", test: this.testChangeColor },
    ...test_pplot.bind(this)(),
    ...test_plotxy.bind(this)(),
  ];

  mountedHiPlot(): HiPlot {
    return mounted(this.hiplot);
  }

  // Selection/highlights
  testSelect() {
    const allRows = this.mountedHiPlot().state.rows_filtered;
    this.mountedHiPlot().setSelected(allRows.slice(0, this.state.keepCount));
  }
  testSelectNone() {
    this.mountedHiPlot().setSelected([]);
  }
  testSelectAll() {
    const allRows = this.mountedHiPlot().state.rows_filtered;
    this.mountedHiPlot().setSelected(allRows);
  }
  testHighlightAllSelected() {
    this.mountedHiPlot().setHighlighted(this.mountedHiPlot().state.rows_selected);
  }

  // Keep/restore/exclude buttons
  testButton(text: string) {
    const btn = $(mounted(this.root)).find(`button:contains(${text})`)[0];
    console.assert(btn !== undefined, `Can't find button "${text}"`);
    btn.click();
  }

  testChangeColor() {
    const s = this.mountedHiPlot().state;
    const params = Object.keys(s.params_def).filter((v) => v !== "uid" && v !== "from_uid");
    const currentColorIdx = s.colorby === null ? -1 : params.indexOf(s.colorby);
    const newColorIdx = (currentColorIdx + 1) % params.length;
    this.mountedHiPlot().setState({ colorby: params[newColorIdx] });
  }

  checkStartTesting() {
    console.log("Waiting for user to load an experiment...");
    const experiment = this.mountedHiPlot().state.experiment;
    if (experiment) {
      if (this.timeout !== null) {
        clearInterval(this.timeout);
      }
      if (experiment.datapoints === undefined) {
        throw new Error("The tester needs an experiment that provides `datapoints`");
      }
      this.setState({
        testNum: 0,
        keepCount: Math.floor(experiment.datapoints.length / 2),
      });
    }
  }
  componentDidMount() {
    this.timeout = setInterval(this.checkStartTesting.bind(this), 500);
  }
  componentDidUpdate() {
    if (this.state.testDone) {
      return;
    }
    if (this.state.testNum >= this.testFn.length) {
      console.log("Tests done!");
      return;
    }
    this.setState({ testDone: true });
    const testDef = this.testFn[this.state.testNum];
    console.log(`## TEST ${this.state.testNum}: ${testDef.name}`);
    testDef.test.call(this);
    const nextTestNum = this.state.testNum + 1;
    this.timeout = setTimeout(() => this.setState({ testNum: nextTestNum, testDone: false }), 500);
  }
  componentWillUnmount() {
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
    }
  }
  simulateRefresh() {
    const exp = this.mountedHiPlot().state.experiment;
    if (exp === null) {
      throw new Error("Cannot refresh before an experiment is loaded");
    }
    this.mountedHiPlot().loadWithPromise(Promise.resolve({ experiment: exp }));
  }

  render() {
    return (
      <div ref={this.root} style={{ width: this.state.width }}>
        <HiPlot ref={this.hiplot} key={this.state.renderNum} {...this.props.hiplotProps} />
      </div>
    );
  }

  pplot(): ParallelPlot {
    return this.mountedHiPlot().getPlugin(ParallelPlot);
  }
  plotxy(): PlotXY {
    return this.mountedHiPlot().getPlugin(PlotXY);
  }
}

function prefix(pre: string, tests: Array<Test>): Array<Test> {
  return tests.map((val) => {
    val.name = `${pre}_${val.name}`;
    return val;
  });
}

function test_pplot(this: HiPlotTester): Array<Test> {
  const pplot = this.pplot.bind(this);

  function brushIdx(pplot: ParallelPlot, colIdx: number) {
    let brush_el = d3.select(mounted(pplot.svg_ref)).selectAll<SVGGElement, string>(".pplot-brush");
    const size = brush_el.nodes().length; // Why does `brush_el.size()` returns 0?!
    console.assert(size > 0);
    brush_el = brush_el.filter((_d, i) => i === colIdx % size);
    pplot.d3brush.move(brush_el, [colIdx % 3 === 0 ? 0 : 100, 200]);
  }
  const brushKeepRestore = (colIdx: number): Array<Test> => {
    const tests: Array<Test> = [{ name: "brush", test: () => brushIdx(pplot(), colIdx) }];
    if (colIdx % 4 !== 0) {
      tests.push({
        name: "filter",
        test: function () {
          this.testButton(colIdx % 3 === 0 ? "Keep" : "Exclude");
        },
      });
      tests.push({
        name: "restore",
        test: function () {
          this.testButton("Restore");
        },
      });
    }
    tests.push({
      name: "clearBrush",
      test: () => {
        pplot().brush_clear_all();
      },
    });
    return prefix(`col${colIdx}`, tests);
  };

  let tests: Array<Test> = [];
  for (let i = 0; i < 15; ++i) {
    tests = tests.concat(brushKeepRestore(i));
  }
  return prefix("pplot", tests);
}

function test_plotxy(this: HiPlotTester): Array<Test> {
  const plotxy = this.plotxy.bind(this);

  const selectAxis = (idx: number): string => {
    const k = Object.keys(this.mountedHiPlot().state.params_def).filter(
      (v) => v !== "uid" && v !== "from_uid",
    );
    return k[idx % k.length];
  };

  const tests: Array<Test> = [
    {
      name: "enable",
      test: () => {
        plotxy().setState({ axis_x: selectAxis(0), axis_y: selectAxis(1) });
      },
    },
    {
      name: "change_axis_x",
      test: () => {
        plotxy().setState({ axis_x: selectAxis(2), axis_y: selectAxis(1) });
      },
    },
    {
      name: "refresh",
      test: function () {
        this.simulateRefresh();
      },
    },
    {
      name: "axisKept",
      test: () => {
        console.assert(plotxy().state.axis_x === selectAxis(2), `axis_x error: ${plotxy().state}`);
        console.assert(plotxy().state.axis_y === selectAxis(1), `axis_y error: ${plotxy().state}`);
      },
    },
  ];
  return prefix("plotxy", tests);
}

export function render(element: HTMLElement, extra?: HiPlotRenderOptions) {
  const props: HiPlotProps = build_props(extra);
  Object.assign(props, { asserts: true });
  const mountPoint: HiPlotTesterMountPoint = element;
  const existingRoot = mountPoint.__hiplot_test_root;
  const root = existingRoot ?? ReactDOMClient.createRoot(element);
  if (!existingRoot) {
    mountPoint.__hiplot_test_root = root;
  }
  root.render(
    <React.StrictMode>
      <HiPlotTester hiplotProps={props} />
    </React.StrictMode>,
  );
  return root;
}
