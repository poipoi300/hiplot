import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { isThemeChoice, storedThemeChoice, storeThemeChoice } from "./theme";

const securityError = (): never => {
  throw new DOMException("denied", "SecurityError");
};

/** Runs `run` while reading window.localStorage calls `getter`. */
function withStorage(getter: () => Storage, run: () => void): void {
  const own = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", { configurable: true, get: getter });
  try {
    run();
  } finally {
    if (own === undefined) {
      Reflect.deleteProperty(window, "localStorage");
    } else {
      Object.defineProperty(window, "localStorage", own);
    }
  }
}

afterEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
});

describe("theme choice", () => {
  test("a choice is stored and read back; anything else stored is ignored", () => {
    expect(storedThemeChoice()).toBeNull();
    storeThemeChoice("dark");
    expect(storedThemeChoice()).toBe("dark");
    localStorage.setItem("hiplot.theme", "sepia");
    expect(storedThemeChoice()).toBeNull();
    expect(isThemeChoice("system")).toBe(true);
  });

  test("a theme in the URL follows the choice, replacing the legacy parameter", () => {
    history.replaceState(null, "", "/?hip.dark=true&other=1");
    storeThemeChoice("light");
    const params = new URLSearchParams(location.search);
    expect(params.get("hip.theme")).toBe("light");
    expect(params.has("hip.dark")).toBe(false);
    expect(params.get("other")).toBe("1");
  });

  test("a URL without a theme is left alone", () => {
    history.replaceState(null, "", "/?other=1");
    storeThemeChoice("system");
    expect(location.search).toBe("?other=1");
  });

  test("without storage or history, as in a sandboxed iframe, nothing is kept and nothing breaks", () => {
    history.pushState(null, "", "/?hip.theme=dark");
    const replace = spyOn(history, "replaceState").mockImplementation(securityError);
    withStorage(securityError, () => {
      storeThemeChoice("light");
      expect(storedThemeChoice()).toBeNull();
    });
    replace.mockRestore();
  });

  test("other storage failures are not hidden", () => {
    const broken = (): never => {
      throw new TypeError("broken");
    };
    withStorage(broken, () => {
      expect(() => storedThemeChoice()).toThrow("broken");
    });
  });
});
