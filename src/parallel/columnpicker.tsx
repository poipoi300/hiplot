/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type React from "react";
import { useState } from "react";
import { Popover } from "../lib/popover";
import style from "./columnpicker.module.css";

/** A column the parallel plot can show as an axis. */
export interface PickableColumn {
  name: string;
  label: string;
}

/** The columns whose name or label contains every whitespace-separated term of `query`. */
export function matchingColumns(
  columns: ReadonlyArray<PickableColumn>,
  query: string,
): PickableColumn[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return columns.filter((column) => {
    const text = `${column.name} ${column.label}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

interface ColumnPickerProps {
  columns: ReadonlyArray<PickableColumn>;
  shown: ReadonlySet<string>;
  onShow: (names: string[]) => void;
  onHide: (names: string[]) => void;
}

function ColumnList({ columns, shown, onShow, onHide }: ColumnPickerProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const matching = matchingColumns(columns, query);
  const names = matching.map((column) => column.name);
  return (
    <>
      <input
        type="search"
        className={style.search}
        placeholder="Filter columns"
        aria-label="Filter columns"
        value={query}
        // biome-ignore lint/a11y/noAutofocus: the panel opens to be typed into.
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className={style.actions}>
        <button
          type="button"
          disabled={names.every((name) => shown.has(name))}
          onClick={() => onShow(names.filter((name) => !shown.has(name)))}
        >
          Select all
        </button>
        <button
          type="button"
          disabled={names.every((name) => !shown.has(name))}
          onClick={() => onHide(names.filter((name) => shown.has(name)))}
        >
          Deselect all
        </button>
        <span className={style.count}>
          {shown.size} of {columns.length} shown
        </span>
      </div>
      <ul className={style.list}>
        {matching.map((column) => (
          <li key={column.name}>
            <label>
              <input
                type="checkbox"
                checked={shown.has(column.name)}
                onChange={(event) =>
                  event.target.checked ? onShow([column.name]) : onHide([column.name])
                }
              />
              <span>{column.label}</span>
            </label>
          </li>
        ))}
        {matching.length === 0 && <li className={style.empty}>No column matches “{query}”</li>}
      </ul>
    </>
  );
}

/** The "Columns" menu: which columns the parallel plot shows as axes. */
export function ColumnPicker(props: ColumnPickerProps): React.ReactElement {
  return (
    <Popover
      trigger={
        <>
          Columns
          <span className={style.badge}>
            {props.shown.size}/{props.columns.length}
          </span>
        </>
      }
      label="Columns shown as axes"
      title="Choose the columns shown as axes"
      align="end"
      testId="columns-button"
    >
      {() => <ColumnList {...props} />}
    </Popover>
  );
}
