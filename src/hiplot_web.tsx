/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import React from "react";
import { flushSync } from "react-dom";
import ReactDOMClient from "react-dom/client";
import { defaultPlugins, HiPlot, type HiPlotProps, normalizeDarkModeSetting } from "./component";
import { StaticDataProvider } from "./dataproviders/static";
import { UploadDataProvider } from "./dataproviders/upload";
import { WebserverDataProvider } from "./dataproviders/webserver";
import { PersistentStateInURL } from "./lib/savedstate";
import { storedThemeChoice, THEME_URL_PARAMETERS } from "./lib/theme";
import type { DataProviderClass } from "./plugin";

const dataProviders = {
  webserver: WebserverDataProvider,
  upload: UploadDataProvider,
  none: StaticDataProvider,
} satisfies Record<string, DataProviderClass>;

/** Options accepted by `hiplot.render`: any HiPlot prop, plus two selectors resolved here. */
export interface HiPlotRenderOptions extends Partial<HiPlotProps> {
  dataProviderName?: keyof typeof dataProviders;
  persistentStateUrlPrefix?: string;
}

/** The DOM element HiPlot renders into, remembering what we mounted there. */
interface HiPlotMountPoint extends HTMLElement {
  __hiplot_root?: ReactDOMClient.Root;
  __hiplot_instance_ref?: React.RefObject<HiPlot | null>;
}

export function build_props(extra?: HiPlotRenderOptions): HiPlotProps {
  const searchParams = new URLSearchParams(location.search);
  // `hip.theme` is the preferred query parameter; `hip.dark` keeps existing links
  // working. Without either, the theme last chosen with the toggle applies.
  const themeParam =
    THEME_URL_PARAMETERS.map((name) => searchParams.get(name)).find((value) => value !== null) ??
    null;
  const darkValue = normalizeDarkModeSetting(themeParam ?? storedThemeChoice(), "auto");
  const props: HiPlotProps = {
    experiment: null,
    persistentState: new PersistentStateInURL("hip"),
    plugins: defaultPlugins,
    asserts: false,
    dataProvider: WebserverDataProvider,
    dark: darkValue,
    onChange: null,
  };
  if (extra !== undefined) {
    Object.assign(props, extra);
  }
  if (extra?.dataProviderName !== undefined) {
    props.dataProvider = dataProviders[extra.dataProviderName];
  }
  if (extra?.persistentStateUrlPrefix !== undefined) {
    props.persistentState = new PersistentStateInURL(extra.persistentStateUrlPrefix);
  }
  return props;
}

export function render(element: HTMLElement, extra?: HiPlotRenderOptions) {
  const mountPoint: HiPlotMountPoint = element;
  const existingRoot = mountPoint.__hiplot_root;
  const root = existingRoot ?? ReactDOMClient.createRoot(element);
  const instanceRef = mountPoint.__hiplot_instance_ref ?? React.createRef<HiPlot>();
  if (!existingRoot) {
    mountPoint.__hiplot_root = root;
    mountPoint.__hiplot_instance_ref = instanceRef;
  }
  flushSync(() => {
    root.render(
      <React.StrictMode>
        <HiPlot ref={instanceRef} {...build_props(extra)} />
      </React.StrictMode>,
    );
  });
  return instanceRef.current ?? root;
}

// Expose global for non-module consumers (legacy HTML templates).
if (typeof window !== "undefined") {
  Object.assign(window, {
    hiplot: {
      render,
      build_props,
    },
  });
}
