# Contributing to cutroom

Thanks for helping. This guide covers setup, the test suites, and how releases are checked.

## Setup

You need Node 20+, `ffmpeg`/`ffprobe`, and a transcription backend ([uv](https://docs.astral.sh/uv/) is easiest). `cutroom doctor` checks all of it and prints the install command for your OS.

```bash
npm install
npm run doctor            # check ffmpeg, filters, transcription, permissions
npm run fixtures          # synthetic test videos (macOS `say`, or espeak-ng on Linux)
npm run dev               # editor on :5173 with hot reload, API on :4321
```

`npm run dev` opens `.dev-project/` (set `CUTROOM_PROJECT=~/videos/x` to use another project). To run the CLI from source, use `npm run cutroom -- <args>`.

## Layout

| Path | |
| --- | --- |
| `src/core/shared/` | Browser-safe engine: schema, ops, timeline math, render plan, captions |
| `src/core/` | Node: project store, media analysis, transcription, ffmpeg renderer |
| `src/server/` | HTTP + WebSocket server for the editor |
| `src/mcp/` | MCP server |
| `src/cli.ts` | CLI (`cutroom`, `cutroom <video>`, `cutroom doctor`, subcommands) |
| `web/` | React editor, built into `dist/web` and shipped prebuilt |
| `test/*.test.ts` | Unit tests (`node:test` via tsx) |
| `test/e2e/` | Playwright tests that drive the built editor |
| `scripts/` | Transcriber script (shipped), fixtures and release checks (not shipped) |

## Tests

```bash
npm run typecheck         # server, web and e2e TypeScript
npm test                  # unit tests for the edit engine
npm run build             # dist/ (CLI + prebuilt editor)
npx playwright install chromium   # once
npm run test:e2e          # end-to-end editor tests (needs a build, ffmpeg and a transcriber)
npm run test:pack         # pack the tarball, install it in a temp dir, run the CLI, doctor and MCP
```

The e2e suite transcribes `test/fixtures/talking.mp4` once with `cutroom init` (generating the fixture if it is missing), then gives every test its own copy of that project and its own `cutroom open --no-browser` server on a free port. Tests use role and text selectors plus the editor's JSON API (`/api/state`), so please keep visible labels stable or update the tests with them. The suite takes under a minute on a laptop once the Whisper model is downloaded.

CI (`.github/workflows/ci.yml`) runs all of the above on Ubuntu and macOS.

## Pull requests

- Every project change goes through `applyOps()` (`src/core/shared/ops.ts`). Add a unit test for new ops.
- Keep preview and export in sync. Both renderers use the same plan and math, so put shared logic in `src/core/shared/`.
- Run `npm run typecheck && npm test && npm run test:e2e` before opening a PR.

## Releasing

1. Bump `version` in `package.json` (and `VERSION` in `src/mcp/server.ts`).
2. Run `npm run test:pack` to build, pack and smoke-test the tarball exactly as users install it.
3. Run `npm publish`. `prepublishOnly` runs the typecheck and unit tests, and `prepack` builds a clean `dist/`.

The package ships only `dist/` (no source maps) and `scripts/transcribe_faster_whisper.py`. The web editor is prebuilt, so React and Vite are dev dependencies.
