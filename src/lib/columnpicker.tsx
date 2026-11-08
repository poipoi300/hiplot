/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type React from "react";
import { useEffect, useId, useRef, useState } from "react";
import style from "./columnpicker.module.css";
import { Popover } from "./popover";

/** A column a picker offers. */
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

/** Options PageUp and PageDown move by. */
const PAGE_OPTIONS = 8;
const MOVE_KEYS: ReadonlySet<string> = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp"]);

/**
 * The option a key makes active among `count` options, from `active` (null
 * before any is); null for a key that does not move it. The first move
 * enters the list at `entry`; moves stop at the first and last options.
 */
export function movedActive(
  active: number | null,
  key: string,
  count: number,
  entry: number,
): number | null {
  if (count === 0 || !MOVE_KEYS.has(key)) {
    return null;
  }
  if (active === null) {
    return Math.min(count - 1, entry);
  }
  const last = count - 1;
  switch (key) {
    case "ArrowDown":
      return Math.min(last, active + 1);
    case "ArrowUp":
      return Math.max(0, active - 1);
    case "PageDown":
      return Math.min(last, active + PAGE_OPTIONS);
    case "PageUp":
      return Math.max(0, active - PAGE_OPTIONS);
    default:
      return null;
  }
}

/**
 * What a picker chooses: several columns at once (the axes of the parallel
 * plot), or exactly one column or none (a scatter axis).
 */
export type ColumnChoice =
  | {
      kind: "several";
      chosen: ReadonlySet<string>;
      onShow: (names: string[]) => void;
      onHide: (names: string[]) => void;
    }
  | {
      kind: "one";
      chosen: string | null;
      onPick: (name: string | null) => void;
    };

/** One row of the list: a column, or "None" (`name` null) when a single choice may be empty. */
export interface PickerOption {
  name: string | null;
  label: string;
}

const NONE_LABEL = "None";

/** The options shown for `query`: "None" first when one column is picked, then the matches. */
export function pickerOptions(
  columns: ReadonlyArray<PickableColumn>,
  kind: ColumnChoice["kind"],
  query: string,
): PickerOption[] {
  const matching: PickerOption[] = matchingColumns(columns, query);
  return kind === "one" ? [{ name: null, label: NONE_LABEL }, ...matching] : matching;
}

/** Where the keyboard enters the list: the chosen column of a single choice, else the top. */
export function entryOption(options: ReadonlyArray<PickerOption>, choice: ColumnChoice): number {
  if (choice.kind === "several") {
    return 0;
  }
  return Math.max(
    0,
    options.findIndex((option) => option.name === choice.chosen),
  );
}

/**
 * The option a filter makes active: the first column it matches, which
 * Enter then picks; none while the filter is blank or matches nothing.
 */
export function filteredActive(options: ReadonlyArray<PickerOption>, query: string): number | null {
  if (query.trim() === "") {
    return null;
  }
  const index = options.findIndex((option) => option.name !== null);
  return index === -1 ? null : index;
}

const isChosen = (choice: ColumnChoice, name: string | null): boolean =>
  choice.kind === "several" ? name !== null && choice.chosen.has(name) : choice.chosen === name;

const CHECK = (
  <svg className={style.check} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M3.5 8.5 6.5 11.5 12.5 4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

interface ColumnListProps {
  columns: ReadonlyArray<PickableColumn>;
  choice: ColumnChoice;
  /** Accessible name of the list. */
  label: string;
  /** Closes the panel the list is in. */
  close: () => void;
}

/**
 * A filter box over a list of columns, as a combobox: focus stays in the
 * filter while the arrow keys, PageUp and PageDown move through the list and
 * Enter picks; the pointer picks with a click. Picking toggles a column when
 * several are chosen, and chooses it (or "None") and closes when one is.
 */
function ColumnList({ columns, choice, label, close }: ColumnListProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const options = pickerOptions(columns, choice.kind, query);
  /** The option the keyboard acts on; null until a key or the pointer picks one. */
  const [active, setActive] = useState<number | null>(null);
  /** Whether the keyboard moved the active option last, which then shows a focus ring. */
  const [keyboard, setKeyboard] = useState(false);
  const listId = useId();
  const optionId = (index: number): string => `${listId}-option-${index}`;
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (keyboard && active !== null) {
      listRef.current
        ?.querySelector(`[data-index="${active}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [active, keyboard]);

  const pick = (option: PickerOption): void => {
    if (choice.kind === "one") {
      choice.onPick(option.name);
      close();
      return;
    }
    if (option.name === null) {
      throw new Error("Only a single choice offers None");
    }
    if (choice.chosen.has(option.name)) {
      choice.onHide([option.name]);
    } else {
      choice.onShow([option.name]);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (active !== null) {
        pick(options[active]);
      }
      return;
    }
    const next = movedActive(active, event.key, options.length, entryOption(options, choice));
    if (next === null) {
      return;
    }
    event.preventDefault();
    setActive(next);
    setKeyboard(true);
  };

  const columnNames = options.flatMap((option) => (option.name === null ? [] : [option.name]));
  return (
    <>
      <input
        type="search"
        role="combobox"
        className={style.search}
        placeholder="Filter columns"
        aria-label="Filter columns"
        aria-expanded={true}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active === null ? undefined : optionId(active)}
        value={query}
        // biome-ignore lint/a11y/noAutofocus: the panel opens to be typed into.
        autoFocus
        onChange={(event) => {
          const nextQuery = event.target.value;
          const nextActive = filteredActive(
            pickerOptions(columns, choice.kind, nextQuery),
            nextQuery,
          );
          setQuery(nextQuery);
          setActive(nextActive);
          setKeyboard(nextActive !== null);
        }}
        onKeyDown={onKeyDown}
      />
      {choice.kind === "several" && (
        <div className={style.actions}>
          <button
            type="button"
            disabled={columnNames.every((name) => choice.chosen.has(name))}
            onClick={() => choice.onShow(columnNames.filter((name) => !choice.chosen.has(name)))}
          >
            Select all
          </button>
          <button
            type="button"
            disabled={columnNames.every((name) => !choice.chosen.has(name))}
            onClick={() => choice.onHide(columnNames.filter((name) => choice.chosen.has(name)))}
          >
            Deselect all
          </button>
          <span className={style.count}>
            {choice.chosen.size} of {columns.length} shown
          </span>
        </div>
      )}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={label}
        aria-multiselectable={choice.kind === "several"}
        className={style.list}
      >
        {options.map((option, index) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the filter box takes the keys (aria-activedescendant).
          <div
            key={option.name ?? "\u0000none"}
            id={optionId(index)}
            role="option"
            aria-selected={isChosen(choice, option.name)}
            tabIndex={-1}
            data-index={index}
            data-active={index === active}
            data-keyboard={index === active && keyboard}
            className={option.name === null ? `${style.option} ${style.none}` : style.option}
            onPointerMove={() => {
              if (index !== active || keyboard) {
                setActive(index);
                setKeyboard(false);
              }
            }}
            // Focus stays in the filter box.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => pick(option)}
          >
            <span className={style.label}>{option.label}</span>
            {CHECK}
          </div>
        ))}
      </div>
      {columnNames.length === 0 && (
        <p className={style.empty} role="status">
          No column matches “{query}”
        </p>
      )}
    </>
  );
}

interface ColumnPickerProps {
  columns: ReadonlyArray<PickableColumn>;
  shown: ReadonlySet<string>;
  onShow: (names: string[]) => void;
  onHide: (names: string[]) => void;
}

/** The "Columns" menu: which columns the parallel plot shows as axes. */
export function ColumnPicker({
  columns,
  shown,
  onShow,
  onHide,
}: ColumnPickerProps): React.ReactElement {
  return (
    <Popover
      trigger={
        <>
          Columns
          <span className={style.badge}>
            {shown.size}/{columns.length}
          </span>
        </>
      }
      label="Columns shown as axes"
      title="Choose the columns shown as axes"
      align="end"
      testId="columns-button"
    >
      {(close) => (
        <ColumnList
          columns={columns}
          choice={{ kind: "several", chosen: shown, onShow, onHide }}
          label="Columns"
          close={close}
        />
      )}
    </Popover>
  );
}
