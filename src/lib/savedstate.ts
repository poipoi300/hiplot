/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Hierarchical key-value storage for state that outlives the page (URL, notebook).
 * Values come back as they were stored, but storage is untyped and shared with
 * other versions of HiPlot, so readers validate them (see `readState`).
 */
export interface PersistentState {
  get(name: string): unknown;
  get(name: string, def_value: unknown): unknown;
  set(name: string, value: unknown): void;
  children(name: string): PersistentState;
  /** Told when a stored value was unusable and its fallback was used instead. */
  reportInvalid?(name: string, value: unknown): void;
}

/**
 * Reads `name`, falling back when it is missing or does not have the expected
 * shape; an unusable stored value is reported to the state.
 */
export function readState<T>(
  state: PersistentState,
  name: string,
  isValid: (value: unknown) => value is T,
  fallback: T,
): T {
  const value = state.get(name);
  if (isValid(value)) {
    return value;
  }
  if (value !== undefined) {
    state.reportInvalid?.(name, value);
  }
  return fallback;
}

/**
 * A persistent state that tells `onInvalid` about stored values its readers
 * could not use, with their full key, and stores everything in `inner`.
 */
export class ReportingPersistentState implements PersistentState {
  constructor(
    private readonly inner: PersistentState,
    private readonly onInvalid: (key: string, value: unknown) => void,
    private readonly prefix: string = "",
  ) {}
  get(name: string, def_value?: unknown): unknown {
    return this.inner.get(name, def_value);
  }
  set(name: string, value: unknown): void {
    this.inner.set(name, value);
  }
  children(name: string): ReportingPersistentState {
    return new ReportingPersistentState(
      this.inner.children(name),
      this.onInvalid,
      `${this.prefix}${name}.`,
    );
  }
  reportInvalid(name: string, value: unknown): void {
    this.onInvalid(this.prefix + name, value);
  }
}

export const isString = (value: unknown): value is string => typeof value === "string";
export const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
export const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

export class PersistentStateInURL implements PersistentState {
  prefix: string;
  // In case history doesnt work, like when we are embedded in an iframe
  params: { [key: string]: unknown } = {};
  constructor(name: string) {
    this.prefix = name === "" ? "" : `${name}.`;
  }
  get(name: string, def_value?: unknown): unknown {
    return this._get(this.prefix + name, def_value);
  }
  set(name: string, value: unknown): void {
    this._set(this.prefix + name, value);
  }
  _get(name: string, default_value?: unknown): unknown {
    if (this.params[name] !== undefined) {
      return this.params[name];
    }
    const searchParams = new URLSearchParams(location.search);
    const value = searchParams.get(name);
    if (value === null) {
      return default_value;
    }
    try {
      return JSON.parse(value);
    } catch {
      // A hand-edited or truncated URL: ignore the unreadable value.
      return default_value;
    }
  }
  _set(name: string, new_value: unknown): void {
    const searchParams = new URLSearchParams(location.search);
    searchParams.set(name, JSON.stringify(new_value));
    try {
      history.replaceState({}, "title", `?${searchParams.toString()}`);
    } catch {
      // Sandboxed iframes forbid history changes: keep the value in memory instead.
      this.params[name] = new_value;
    }
  }
  children(name: string): PersistentStateInURL {
    return new PersistentStateInURL(this.prefix + name);
  }
}

export class PersistentStateInMemory implements PersistentState {
  prefix: string;
  params: { [key: string]: unknown };
  constructor(name: string, params: { [key: string]: unknown }) {
    this.prefix = name === "" ? "" : `${name}.`;
    this.params = params;
  }
  get(name: string, def_value?: unknown): unknown {
    const v = this.params[this.prefix + name];
    return v !== undefined ? v : def_value;
  }
  set(name: string, value: unknown): void {
    this.params[this.prefix + name] = value;
  }
  clear(): void {
    Object.keys(this.params)
      .filter((key) => key.startsWith(this.prefix))
      .forEach((key) => {
        delete this.params[key];
      });
  }
  children(name: string): PersistentStateInMemory {
    return new PersistentStateInMemory(this.prefix + name, this.params);
  }
}
