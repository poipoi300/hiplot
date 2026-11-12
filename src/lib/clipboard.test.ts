import { afterEach, expect, test } from "bun:test";
import { copyText } from "./clipboard";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const commandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");

afterEach(() => {
  for (const [object, key, descriptor] of [
    [navigator, "clipboard", clipboardDescriptor],
    [document, "execCommand", commandDescriptor],
  ] as const) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(object, key);
    } else {
      Object.defineProperty(object, key, descriptor);
    }
  }
  document.body.replaceChildren();
});

function clipboard(value: { writeText: (text: string) => Promise<void> } | undefined): void {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

function command(value: ((name: string) => boolean) | undefined): void {
  Object.defineProperty(document, "execCommand", { configurable: true, value });
}

test("copying preserves the full message and uses the clipboard API when available", async () => {
  const copied: string[] = [];
  clipboard({
    writeText: async (text) => {
      copied.push(text);
    },
  });
  command(() => {
    throw new Error("The legacy copy command should not run");
  });
  await copyText('Column "checkpoint": no finite values.\nCheck NaN and ±Infinity.');
  expect(copied).toEqual(['Column "checkpoint": no finite values.\nCheck NaN and ±Infinity.']);
  expect(document.querySelector("textarea")).toBeNull();
});

for (const api of ["unavailable", "denied"] as const) {
  test(`copying falls back when the clipboard API is ${api} and restores focus`, async () => {
    clipboard(
      api === "unavailable"
        ? undefined
        : {
            writeText: async () => {
              throw new Error("Permission denied");
            },
          },
    );
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    const copied: string[] = [];
    command((name) => {
      expect(name).toBe("copy");
      expect(document.activeElement).toBeInstanceOf(HTMLTextAreaElement);
      copied.push((document.activeElement as HTMLTextAreaElement).value);
      return true;
    });
    await copyText("The complete warning");
    expect(copied).toEqual(["The complete warning"]);
    expect(document.activeElement).toBe(button);
    expect(document.querySelector("textarea")).toBeNull();
  });
}

for (const outcome of ["missing", "false", "throws"] as const) {
  test(`copy failures (${outcome}) are reported and temporary elements are removed`, async () => {
    clipboard(undefined);
    command(
      outcome === "missing"
        ? undefined
        : () => {
            if (outcome === "throws") throw new Error("Copy denied");
            return false;
          },
    );
    await expect(copyText("Warning")).rejects.toThrow();
    expect(document.querySelector("textarea")).toBeNull();
  });
}
