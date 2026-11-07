/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The theme the user picked with the Light / Dark / System toggle. It is kept
 * in localStorage, so every HiPlot page on the same origin opens with it, and
 * in the `hip.theme` URL parameter when the page was opened with one, which
 * wins over the stored choice.
 */
export type ThemeChoice = "light" | "dark" | "system";

export const THEME_CHOICES: ReadonlyArray<ThemeChoice> = ["light", "dark", "system"];

const STORAGE_KEY = "hiplot.theme";
/** URL parameters that set the theme, preferred first (see `build_props`). */
export const THEME_URL_PARAMETERS = [
  "hip.theme",
  "hiplot.theme",
  "HIPLOT.theme",
  "hip.dark",
  "hiplot.dark",
  "HIPLOT.dark",
] as const;

export const isThemeChoice = (value: unknown): value is ThemeChoice =>
  THEME_CHOICES.some((choice) => choice === value);

/**
 * The page's localStorage, or null where the browser denies it (sandboxed
 * iframes, some file:// pages), which it signals with a SecurityError.
 */
function pageStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch (error) {
    if (error instanceof DOMException && error.name === "SecurityError") {
      return null;
    }
    throw error;
  }
}

/** The theme stored by an earlier choice, if any. */
export function storedThemeChoice(): ThemeChoice | null {
  const stored = pageStorage()?.getItem(STORAGE_KEY);
  return isThemeChoice(stored) ? stored : null;
}

/**
 * Remembers a choice: in localStorage, and in the URL when the page was opened
 * with a theme parameter, so reloading the page keeps the choice.
 */
export function storeThemeChoice(choice: ThemeChoice): void {
  pageStorage()?.setItem(STORAGE_KEY, choice);
  const params = new URLSearchParams(location.search);
  if (!THEME_URL_PARAMETERS.some((name) => params.has(name))) {
    return;
  }
  for (const name of THEME_URL_PARAMETERS) {
    params.delete(name);
  }
  params.set("hip.theme", choice);
  try {
    history.replaceState(history.state, "", `?${params.toString()}`);
  } catch (error) {
    // Sandboxed iframes forbid history changes; localStorage still has the choice.
    if (!(error instanceof DOMException && error.name === "SecurityError")) {
      throw error;
    }
  }
}
