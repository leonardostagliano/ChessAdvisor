# ChessAdvisor

Windows desktop app to learn chess by playing full games against OpenAI models through your
authenticated Codex CLI session, with an AI coach at the board, a post-game review and a training
section built from your own games.

## What it does

- **Play** a full game against a model you pick, at six difficulty levels or in adaptive mode,
  with optional clocks (yours only, or one for the model too), takebacks, draw offers and
  autosave: an interrupted game is always on disk and can be resumed from the archive.
- **Coach**: comments on every move as they are played, free questions with streamed answers, and
  a hint drawn on the board. With Stockfish present the coach reasons on real evaluations;
  without it, it says so and reasons on its own.
- **Review** of a finished game: Stockfish analysis, accuracy and ACPL per colour, evaluation
  graph, classified moves, key moments and a written lesson with three takeaways.
- **Progress**: estimated level, accuracy trend, classification of your moves, weak themes and the
  openings you actually play.
- **Training**: exercises carved out of your own mistakes, thematic puzzle sets, opening study
  with the deviations you repeat, twenty canonical endgames and a study plan.
- Two themes (Notturno and Editoriale), Italian and English, tray icon, in-app updates.

## Requirements

- **Windows 10 or 11**, x64.
- **[Codex CLI](https://github.com/openai/codex)** installed and already logged in
  (`codex login`). ChessAdvisor never asks for an API key: it drives the `codex app-server` of
  your own session. The build is generated and tested against the CLI version listed in
  Settings → Informazioni.
- A ChatGPT plan with Codex quota. Every move of the opponent and every word of the coach is a
  real turn against your quota.
- Stockfish is bundled with the installer; it is optional at runtime — without it the app drops
  the evaluations and keeps everything the model can do on its own.

## First run

1. Install with `ChessAdvisor-<version>-x64.exe`, or run the portable build.
2. Start the app. It checks that the Codex CLI is installed, logged in and **isolated** (see
   below) and guides you through anything that is missing.
3. Pick model, difficulty and colour in "Nuova partita" and play.

Building from source needs one extra step: the Stockfish binaries are not in git and are
downloaded by `npm run fetch:stockfish` before `npm run build:win`.

## Privacy

- **A dedicated Codex home.** The app never runs in your own `CODEX_HOME`: it creates
  `%APPDATA%\chessadvisor\codex-home` with a minimal `config.toml` (no plugins, no MCP servers,
  hooks off, read-only sandbox, approvals never) and copies `auth.json` into it. Your own
  configuration, hooks, MCP servers and instruction files are never loaded by a game thread, and
  the app verifies it at every start.
- **Your data stays local.** Games, analyses, profile, exercises and settings are JSON files in
  `%APPDATA%\chessadvisor`, written atomically. Nothing is uploaded anywhere: the only thing that
  leaves the machine is the text of the turns you start, which goes to OpenAI through the Codex
  CLI under the agreement you already have with them.
- The prompts carry the position, the moves and, when Stockfish is available, its evaluations —
  never a file of yours and never anything about your machine.
- `CHESSADVISOR_USER_DATA` points the whole data folder somewhere else (the end-to-end tests use
  it so they never touch a real profile).

## Development

```sh
npm install
npm run fetch:stockfish     # Stockfish 17.1 binaries into resources/engine (not in git)
npm run build:datasets      # optional: rebuilds openings/puzzles/endgames under resources/data
npm run dev                 # CHESSADVISOR_FAKE_CODEX=1 runs the UI against the fake app-server
```

| Script | What it does |
| --- | --- |
| `npm run dev` | electron-vite in watch mode |
| `npm test` | the whole Vitest suite (main, renderer, scripts) |
| `npm run typecheck` | `tsc --noEmit` over the node and web projects |
| `npm run build` | production bundle into `out/` |
| `npm run build:win` | bundle + NSIS installer and portable build into `release/` |
| `npm run smoke:win` | the packaged smoke test (see Packaging: it runs inside the built exe) |
| `npm run e2e` | end-to-end run against the fake app-server (no quota) |
| `npm run e2e:real` | the same run against the real Codex CLI — **spends quota** |
| `npm run codex:types` | regenerates the protocol bindings from the installed CLI |
| `npm run gen-icon` | rebuilds the icon set from `src/renderer/assets/chessadvisor-logo.svg` |
| `node scripts/check-contrast.mjs` | contrast of both palettes against the WCAG minimums |

### End-to-end

`npm run e2e` drives the packaged renderer with Playwright against `test/fake-app-server.mjs`: it
plays real chess moves, streams comments and never opens a network connection. It uses its own
data folder through `CHESSADVISOR_USER_DATA` and writes screenshots to `test/e2e/shots/fake/`.
`npm run e2e:real` runs the same script against the real CLI and does spend quota, so it is a
release check, not a habit.

### Packaging

`npm run build:win` produces `release/ChessAdvisor-<version>-x64.exe` (NSIS), the portable build
and `win-unpacked`. On Windows, electron-builder unpacks archives that contain symlinks, so run
it from a terminal that may create them: either enable Developer Mode (Settings → System → For
developers) or use an elevated terminal. Without that privilege the build stops with
`ERROR: Cannot create symbolic link`.

The smoke test of a build runs inside the packaged executable, as Node, and checks the version,
the Stockfish binaries and the three datasets:

```sh
RELEASE_VERSION=0.1.0 ELECTRON_RUN_AS_NODE=1 ./release/win-unpacked/ChessAdvisor.exe scripts/smoke-windows.cjs release/win-unpacked
```

Nothing is ever published from a local build: releases are cut by
`.github/workflows/windows-release.yml` on a push to `main`, which computes the version from the
conventional commits, builds, smoke-tests and attaches the two executables and `SHA256SUMS.txt`
to the GitHub release.

## Keyboard

`?` opens the shortcuts sheet: `←`/`→` walk the moves in the game and in the review, `Home`/`End`
jump to the ends, `1`–`4` pick the promotion piece and `Esc` closes any dialog.

## License

GPL-3.0-only (`LICENSE`). Third-party notices — Stockfish, chessground, chess.js, the cburnett
pieces, the fonts and the Lichess datasets — are in `THIRD-PARTY-NOTICES.md` and in the app under
Settings → Informazioni e licenze.
