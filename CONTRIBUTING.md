# Contributing to Vertix

## Setup

```bash
npm install
npm run build:wasm   # compiles wasm/ and writes bindings to src/core/wasm/
npm run dev          # http://localhost:5173
```

Prerequisites: [Node.js](https://nodejs.org/) 20+ (see `.nvmrc` for the
exact version this repo targets), [Rust](https://rustup.rs/) stable, and
[wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
(`cargo install wasm-pack`).

`src/core/wasm/` is generated and gitignored — re-run `npm run build:wasm`
after cloning, and again after any change under `wasm/src/`.

## Before opening a PR

```bash
npm run lint
npm run format:check
npm run build
```

These three are what CI runs on every push and PR
(`.github/workflows/ci.yml`) — a PR that fails any of them won't pass
checks. `npm run format` and `npm run lint:fix` will fix most issues
automatically.

There's no automated test suite yet. Changes are validated by the checks
above plus manual testing in a real browser — WASM/canvas rendering
doesn't run headlessly in most CI sandboxes, so "it builds and lints" is
necessary but not sufficient; actually load a video and watch it reframe
before calling something done. A proper test setup (particularly for
`src/core/layoutEngine.ts`'s pure functions) would be a welcome
contribution on its own.

## Where things live

See the [Architecture](README.md#architecture) section of the README for
the full picture. The one rule that matters most for a contribution:

**`src/core/` has zero dependency on React or any UI framework**, on
purpose — it's meant to be usable as a standalone package dropped into
any video player. If a change to the engine needs something from React
(a hook, a component prop, browser-only UI state), it belongs in
`src/hooks/` or `src/components/` instead, not in `src/core/`. See
[`src/core/README.md`](src/core/README.md) for the engine's own API
surface.

Changes to face detection or the ONNX model pipeline go in `wasm/src/`
(Rust) — rebuild with `npm run build:wasm` and confirm `npm run build`
still passes before opening a PR.

## Code style

Formatting and linting are enforced (ESLint + Prettier, see above) —
don't hand-format around them. Beyond that: comments should explain
*why*, not *what* — a comment that just restates the line above it is
noise. Favor clear naming over a comment that compensates for unclear
naming.

## Commit messages

This repo follows `type: short, specific summary` (`feat`, `fix`, `perf`,
`docs`, `chore`, `ci`, ...) — see `git log` for real examples. The body,
when there is one, explains *why* the change was made, not a restatement
of the diff.

## Reporting bugs

Open a GitHub issue. Include the browser/OS, and — since almost
everything here depends on real video decode and WASM — whether it
reproduces with one of the built-in sample clips (rules out anything
specific to your own file).

## License

MIT. By contributing, you agree your contribution is licensed under the
same terms (see [LICENSE](LICENSE)).
