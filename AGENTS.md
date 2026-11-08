# HiPlot (hiplot-mm)

HiPlot draws high-dimensional data as interactive parallel coordinates, an XY
scatter, per-column distributions and a table, from Python (notebooks,
Streamlit, a web server, standalone HTML) or as a JavaScript library. This
repository is the community fork published on PyPI as `hiplot-mm`; the import
package stays `hiplot`.

This file is the contributor instructions for coding agents. CLAUDE.md imports
it. It derives from forge's AGENTS.md: the project-specific sections are
rewritten for HiPlot, and the working rules travel unchanged.

## What makes HiPlot special?

People open HiPlot on sweeps of tens of thousands of runs and expect to brush
their way to an answer. Three things we never compromise on:

### 1. Interactive at 50,000 rows

Brushing, reordering and recoloring must stay fluid on large experiments.
`docs/PERFORMANCE.md` holds the benchmark and its numbers; a change to the
rendering, selection or payload path is measured with `bench/` before and
after, and a regression is a defect even when the change works.

### 2. One file that just works

`experiment.to_html()` produces a single page that renders offline, makes no
third-party requests, and keeps working when opened years later. The
documented Python API (`hip.Experiment`, `display`, `to_html`, `display_st`,
the fetchers) and the experiment payload stay backward compatible.

### 3. Honest, legible pictures

Presentation is part of the product: colorblind-safe palettes, a legend for
what color means, density instead of overplotting, readable axes, light and
dark themes that both look designed. A plot that works but misleads or reads
like slop does not land.

## A note from the maintainer

I like broad, general solutions — but never at the cost of design,
performance, or flexibility. Write structure, not quick fixes. Never implement
"for simplicity" or "defensively"; handle what the spec requires and fail
loudly otherwise. Use the existing, correct tool instead of hand-rolling one.
Never assume data shape or content — verify. No fragile systems: no reliance
on undefined ordering, and every field is identifiable at every point in the
program.

Treat the rest of this document as good defaults, not hard rules. If a rule
here fights the task in front of you, say so loudly and get sign-off before
breaking it.

## A small glossary

- **you** — the agent reading this file and changing the repo.
- **maintainer** — the human directing the work. That's who you're talking to.
- **experiment** — what HiPlot displays: datapoints (rows), column
  definitions, and per-display settings. Mirrored by `hiplot/experiment.py`
  and `src/types.ts`.
- **payload** — the serialized experiment the Python side embeds in a page or
  sends to the browser; both sides change together.
- **display / plugin** — one view (parallel plot, XY, distribution, table),
  a React component receiving `HiPlotPluginData` (`src/plugin.ts`).
- **filtered rows / selected rows** — rows left after Keep/Exclude, and the
  subset of those inside the current brushes.
- **bundle** — the Vite build in `hiplot/static/built/`, shipped inside the
  wheel. Generated, never committed.
- **gate** — one automated quality check. Deterministic gates are exact
  (format, lint, types, tests, coverage); non-deterministic gates are agent
  review passes judged against the spec.
- **acceptance area** — the region of "good enough" defined by all gates
  together. It only ever tightens.
- **the registry** — `tools/gates.py`, the machine-readable list of this
  repo's deterministic gates. It lives in `tools/` because `hiplot` is a
  published library and the gates describe the repository, not the library.

## The ways to hurt yourself

1. **Weakening a gate to make your change pass.** Don't lower thresholds, add
   excludes, blanket-`noqa`, `biome-ignore` without a reason, or
   `# type: ignore` without a code. The acceptance area only tightens;
   loosening it is a maintainer decision, not a side effect of a task. If a
   gate is genuinely wrong, stop and say so.
2. **Letting the registry drift.** Any change to `.pre-commit-config.yaml` or
   `.github/workflows/ci.yml` updates `tools/gates.py` and its tests in the
   same commit. The test suite enforces the mirror; a drift is a failing
   test, not a style issue.
3. **Breaking the payload or the Python API.** The payload is a contract
   between `hiplot/` and `src/`: change both sides in one commit, keep older
   payloads loading, and keep the documented Python API source compatible.
4. **Shipping a stale or instrumented bundle.** `uv build` packages whatever
   is in `hiplot/static/built/`. Rebuild with `bun run build` before building
   the wheel; `tools/e2e_coverage.sh` rebuilds the plain bundle after its
   instrumented run, never skip that step.
5. **Syncing with upstream.** This fork never pulls from or merges
   facebookresearch/hiplot. Port a fix by hand if you need one.

## Commands

Python runs through `uv`, the frontend through Bun. Never invoke `pip`, bare
`python`, `npm`, or a venv directly.

| Task | Command |
|---|---|
| Install / sync deps | `uv sync` and `bun install` |
| Build the bundles | `bun run build` |
| Dev server (needs a build) | `uv run --extra server hiplot --port 8765` |
| Python tests | `uv run pytest -q` |
| Frontend unit tests | `bun test ./src ./tools` |
| End-to-end tests (Playwright) | `bun run test:js` |
| Format | `uv run ruff format .` · `bun run biome check --write .` |
| Lint | `uv run ruff check .` · `bun run biome check --error-on-warnings .` |
| Types | `uv run mypy .` · `bun run typecheck` |
| All commit-stage gates | `uv run pre-commit run --all-files` |
| Push-stage gate | `bash tools/stack_coverage_gate.sh` (needs `origin/main`; override with `DIFF_COVER_COMPARE_BRANCH=main`) |
| Rendering benchmark | `uv run python bench/make_experiments.py --out <dir>` then `node bench/run.ts --dir <dir>` |
| Package | `bun run build && uv build` |

Fast gates block commits: hygiene, `ruff format`, `ruff check`,
`mypy --strict`, Biome, `tsc` (strict). Slow gates block pushes: pytest,
`bun test` and the Playwright suite against an instrumented bundle, merged
into one LCOV report, plus diff-cover requiring **≥90% coverage on changed
lines** across Python and TypeScript. CI re-runs everything on push/PR, so
bypassing hooks locally never lands unchecked code. Write code that passes on
the first run instead of iterating against the gates.

## Where code lives

- `hiplot/` — the Python package: `experiment.py` (the API and payload),
  `render.py` (standalone pages), `ipython.py` and `streamlit_helpers.py`
  (embeddings), `server.py` and `fetchers.py` (the `hiplot` web server),
  `tests/` (pytest).
- `src/` — the TypeScript frontend (React 19 class components, d3 v7).
  - `component.tsx` — the `HiPlot` root: loading, filtering, selection state.
  - `parallel/`, `plotxy.tsx`, `distribution/`, `rowsdisplaytable.tsx` — the
    displays; `plots/` holds the scatter and distribution panel lists, the
    3D scatter and its camera.
  - `infertypes.ts` — column type inference, scales and colors;
    `filters.ts` — serializable row filters; `lib/` — scales, persisted
    state, helpers.
  - `hiplot_web.tsx`, `hiplot_streamlit.tsx`, `hiplot.tsx` — bundle entry
    points (standalone page, Streamlit component, npm library).
  - `**/*.test.ts` — Bun unit tests; `test/setup.ts` registers happy-dom.
- `tests/` — the Playwright suite; `tests/fixtures.ts` collects coverage.
- `bench/` — the rendering benchmark (`docs/PERFORMANCE.md` has the numbers).
- `tools/` — gate scripts. `repo_hygiene.py` and `coverage_gate.sh` are
  verbatim from forge; `stack_coverage_gate.sh`, `e2e_coverage.sh` and
  `merge_lcov.py` with `statement_starts.ts` extend the push gate to Python
  plus TypeScript; `gates.py` is the registry.
- `docs/` — the Sphinx site; `examples/` — notebooks, Streamlit demos, and
  `hptuning/tune.py`, a real GPU hyperparameter search rendered with HiPlot
  (`uv run examples/hptuning/tune.py --out <page>`).

## Verifying

- A task is done when the gates pass, not when the edit is written. Run the
  relevant commands and report their real output — never declare success from
  the diff.
- Smallest proof first: the tests you touched, then the commit-stage gates.
- Bug fixes ship with the regression test that would have caught them.
- Test names state the behavior pinned, not the function called.

## Commits

- Small, complete increments: each commit passes all commit-stage gates and
  contains one coherent change with its tests. No WIP commits, no giant final
  commit.
- Imperative mood, capitalized subject, ≤50 chars, no trailing punctuation.
  Body only when it adds what the subject can't: wrap at 72, blank line after
  the subject, explain why rather than what.

## Taste

- Guard clauses first; handle edge cases early and exit.
- Abstract only when there is churn, or when one logical change would
  otherwise require edits in multiple files. Premature abstraction is a
  defect.
- Prefer renaming to explaining. Comments carry constraints the code can't
  say — invariants, external contracts, non-obvious "why". Never narrate the
  change you just made or reference the session that produced it.
- Types exhaustive but non-restrictive: `Iterable` over `list` for
  parameters, Python 3.12+ syntax.
- No `try/except` that swallows errors, no dead config knobs, no
  commented-out code, no debug statements.
