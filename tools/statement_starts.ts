/**
 * Maps the physical lines of TypeScript sources onto the statements istanbul
 * counts them under, so tools/merge_lcov.py can fold bun's per-line coverage
 * onto the lines the Playwright (istanbul) report uses.
 *
 * bun lists every physical line of a statement it saw; istanbul lists only the
 * first line of each statement. A line inside a statement maps to the first
 * line of the innermost statement around it. A line that belongs to a function
 * but to none of its statements (a multi-line signature, a closing brace) maps
 * to the function's first statement, which runs exactly when the function
 * does. Every other line maps to itself.
 *
 * Usage: bun tools/statement_starts.ts OUTPUT.json SOURCE...
 * OUTPUT maps each repo-relative POSIX source path to {line: target line} for
 * the lines whose target differs from the line itself.
 */

import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

/** Statement kinds that are declarations or containers, not executed statements. */
const NOT_EXECUTED = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Block,
  ts.SyntaxKind.EmptyStatement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.ImportDeclaration,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.MissingDeclaration,
]);

function isExecutedStatement(node: ts.Node): boolean {
  const kind = node.kind;
  if (kind >= ts.SyntaxKind.FirstStatement && kind <= ts.SyntaxKind.LastStatement) {
    return !NOT_EXECUTED.has(kind);
  }
  if (kind === ts.SyntaxKind.ExportAssignment) {
    return true;
  }
  if (ts.isPropertyDeclaration(node)) {
    return node.initializer !== undefined;
  }
  // The expression body of an arrow function is a statement of its own to istanbul.
  const parent: ts.Node | undefined = node.parent;
  return (
    parent !== undefined && ts.isArrowFunction(parent) && parent.body === node && !ts.isBlock(node)
  );
}

function functionBody(node: ts.Node): ts.Block | null {
  if (
    ts.isFunctionLike(node) &&
    "body" in node &&
    node.body !== undefined &&
    ts.isBlock(node.body)
  ) {
    return node.body;
  }
  return null;
}

/** A line range painted with a target line; deeper ranges paint over shallower ones. */
interface Painting {
  first: number;
  last: number;
  target: number;
  depth: number;
}

/** {line: target line} of one source, for the lines whose target is not the line itself. */
export function statementTargets(fileName: string, source: string): Map<number, number> {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (position: number): number =>
    file.getLineAndCharacterOfPosition(position).line + 1;
  const paintings: Painting[] = [];
  const statementStarts = new Set<number>();

  const visit = (node: ts.Node, depth: number): void => {
    const first = lineOf(node.getStart(file));
    const last = lineOf(node.getEnd());
    if (isExecutedStatement(node)) {
      paintings.push({ first, last, target: first, depth });
      statementStarts.add(first);
    } else {
      const body = functionBody(node);
      if (body !== null) {
        const firstStatement = body.statements[0];
        const target = firstStatement === undefined ? first : lineOf(firstStatement.getStart(file));
        paintings.push({ first, last, target, depth });
      }
    }
    node.forEachChild((child) => visit(child, depth + 1));
  };
  visit(file, 0);

  const targets = new Map<number, number>();
  paintings
    .sort((a, b) => a.depth - b.depth)
    .forEach(({ first, last, target }) => {
      for (let line = first; line <= last; ++line) {
        targets.set(line, target);
      }
    });
  // A statement's own first line is always counted under that statement.
  for (const line of statementStarts) {
    targets.delete(line);
  }
  for (const [line, target] of targets) {
    if (line === target) {
      targets.delete(line);
    }
  }
  return targets;
}

/** Writes the map of every SOURCE to OUTPUT; `argv` is OUTPUT then the sources. */
export function main(argv: ReadonlyArray<string>): void {
  const [output, ...sources] = argv;
  if (output === undefined || sources.length === 0) {
    throw new Error("Usage: bun tools/statement_starts.ts OUTPUT.json SOURCE...");
  }
  const map: { [path: string]: { [line: string]: number } } = {};
  for (const source of sources) {
    const path = source.split("\\").join("/");
    map[path] = Object.fromEntries(statementTargets(path, readFileSync(source, "utf-8")));
  }
  writeFileSync(output, `${JSON.stringify(map)}\n`);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
