import { expect, test } from "bun:test";
import { statementTargets } from "./statement_starts";

const lines = (...source: string[]): string => source.join("\n");

test("continuation lines of a statement map to its first line", () => {
  const source = lines(
    "export function f(a: number): number {",
    "  if (",
    "    a > 1 &&",
    "    a < 3",
    "  ) {",
    "    return a;",
    "  }",
    "  return 0;",
    "}",
  );
  const targets = statementTargets("a.ts", source);
  expect(targets.get(3)).toBe(2);
  expect(targets.get(4)).toBe(2);
  expect(targets.get(5)).toBe(2);
  expect(targets.get(7)).toBe(2);
  expect(targets.has(6)).toBe(false);
  expect(targets.has(8)).toBe(false);
});

test("signature and closing lines of a function map to its first statement", () => {
  const source = lines(
    "class C {",
    "  method(",
    "    value: number,",
    "  ): number {",
    "    const doubled = value * 2;",
    "    return doubled;",
    "  }",
    "}",
  );
  const targets = statementTargets("a.ts", source);
  expect(targets.get(2)).toBe(5);
  expect(targets.get(3)).toBe(5);
  expect(targets.get(4)).toBe(5);
  expect(targets.get(7)).toBe(5);
  expect(targets.has(1)).toBe(false);
  expect(targets.has(8)).toBe(false);
});

test("a statement start inside a callback keeps its own line", () => {
  const source = lines("items.forEach((item) => {", "  use(", "    item,", "  );", "});");
  const targets = statementTargets("a.ts", source);
  expect(targets.has(1)).toBe(false);
  expect(targets.has(2)).toBe(false);
  expect(targets.get(3)).toBe(2);
  expect(targets.get(4)).toBe(2);
  expect(targets.get(5)).toBe(2);
});

test("an arrow function's expression body is a statement of its own", () => {
  const source = lines("const f = (value: number) =>", "  value +", "  1;");
  const targets = statementTargets("a.ts", source);
  expect(targets.has(2)).toBe(false);
  expect(targets.get(3)).toBe(2);
});

test("class property initializers and JSX count like istanbul statements", () => {
  const source = lines(
    "class View {",
    "  handler = (): void => {",
    "    this.go();",
    "  };",
    "  render() {",
    "    return (",
    '      <button type="button" onClick={() =>',
    "        this.go()",
    "      }>",
    "        Go",
    "      </button>",
    "    );",
    "  }",
    "}",
  );
  const targets = statementTargets("view.tsx", source);
  expect(targets.has(2)).toBe(false);
  expect(targets.get(4)).toBe(3);
  expect(targets.get(5)).toBe(6);
  expect(targets.get(7)).toBe(6);
  expect(targets.has(8)).toBe(false);
  expect(targets.get(9)).toBe(6);
  expect(targets.get(13)).toBe(6);
});

test("an empty function maps its lines to its own first line", () => {
  const source = lines("function noop(", "  _value: number,", "): void {}");
  const targets = statementTargets("a.ts", source);
  expect(targets.get(2)).toBe(1);
  expect(targets.get(3)).toBe(1);
});
