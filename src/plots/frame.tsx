/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type React from "react";
import type { ParamDefMap } from "../infertypes";
import controls from "../lib/controls.module.css";
import { labelTextFromHtml } from "../lib/escape";
import style from "./plots.module.css";

const PLUS = (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M5 1.5v7M1.5 5h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
const CROSS = (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M2 2l6 6M8 2 2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/** The heading of a group of plots, with the button that adds one. */
export function SectionBar({
  title,
  addLabel,
  onAdd,
}: {
  title: string;
  addLabel: string;
  onAdd: () => void;
}): React.ReactElement {
  return (
    <div className={style.sectionBar}>
      <span className={style.sectionTitle}>{title}</span>
      <button type="button" className={controls.button} onClick={onAdd}>
        {PLUS}
        {addLabel}
      </button>
    </div>
  );
}

/** A labelled column picker; optional ones offer "None". */
export function ColumnSelect({
  label,
  value,
  params_def,
  optional,
  onChange,
}: {
  label: string;
  value: string | null;
  params_def: ParamDefMap;
  optional: boolean;
  onChange: (column: string | null) => void;
}): React.ReactElement {
  return (
    <label className={style.columnSelect}>
      <span>{label}</span>
      <select
        aria-label={label}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      >
        {(optional || value === null) && <option value="">{optional ? "None" : "Pick…"}</option>}
        {Object.keys(params_def).map((column) => (
          <option key={column} value={column}>
            {labelTextFromHtml(params_def[column].label_html, column)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The header of one plot: its controls, and a button that closes it. */
export function PanelHeader({
  name,
  onClose,
  children,
}: {
  name: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={style.panelHeader}>
      {children}
      <button
        type="button"
        className={style.close}
        title={`Close this ${name}`}
        aria-label={`Close ${name}`}
        onClick={onClose}
      >
        {CROSS}
      </button>
    </div>
  );
}
