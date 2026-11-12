# Contributing to HiPlot

We want to make contributing to this project as easy and transparent as
possible.

## Rust browser kernels

Frontend builds and tests require Rust 1.88 or newer, Cargo and rustup. The
dependency-free crate in `rust/` accelerates numeric and categorical indexes,
outer-axis density reduction, and histogram texture packing through WebAssembly.
`bun run build:wasm`
installs the `wasm32-unknown-unknown` target if needed, compiles the crate and
generates `src/wasm/embedded.generated.ts`. Builds, type checks and Bun tests
run this step automatically. Do not commit the generated module or `target/`.
Python package users need no Rust toolchain: the compiled kernel is embedded
inside the JavaScript bundles, including inline workers and standalone HTML.

Run `cargo fmt --manifest-path rust/Cargo.toml --check`,
`cargo clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings`
and `cargo test --manifest-path rust/Cargo.toml --locked` when editing Rust.
`bun test src/wasm` checks parity with the JavaScript fallback, which remains
available when WebAssembly compilation is unsupported or blocked by CSP.

For copy-inclusive Chromium kernel timings, run `bun run build:wasm` then
`node bench/rust.ts`. Results are written to `outputs/rust/kernels.json`.
Use `--loads 3 --repetitions 15 --baseline-js <saved-benchmark.js>` for
alternating fresh-context controls. The candidate also measures changed
histogram packing and completed GPU uploads, separately from image latency.
Use `--uploads-only` to run only the transfer diagnostic.
`node bench/run.ts --dir <candidate-html-dir> --baseline-dir <baseline-html-dir>`
alternates standalone pages and records idle cadence, render mode and WASM
linear memory separately from the JS heap. Pass `--quality low` to exercise
continuous density explicitly.

## Pull Requests

We actively welcome your pull requests.

1. Fork the repo and create your branch from `master`.
2. If you've added code that should be tested, add tests.
3. If you've changed APIs, update the documentation.
4. Ensure the test suite passes.
5. Make sure your code lints.
6. If you haven't already, complete the Contributor License Agreement ("CLA").

## Contributor License Agreement ("CLA")

In order to accept your pull request, we need you to submit a CLA. You only need
to do this once to work on any of Facebook's open source projects.

Complete your CLA here: <https://code.facebook.com/cla>

## Issues

We use GitHub issues to track public bugs. Please ensure your description is
clear and has sufficient instructions to be able to reproduce the issue.

Facebook has a [bounty program](https://www.facebook.com/whitehat/) for the safe
disclosure of security bugs. In those cases, please go through the process
outlined on that page and do not file a public issue.

## License

By contributing to HiPlot, you agree that your contributions will be licensed
under the LICENSE file in the root directory of this source tree.
