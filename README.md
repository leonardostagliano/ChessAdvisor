# ChessAdvisor

Windows desktop app to learn chess by playing full games against OpenAI models through your authenticated Codex CLI session, with an AI coach and a training section.

## Development
- `npm install`
- `npm run fetch:stockfish` (downloads Stockfish 17 binaries into `resources/engine`)
- `npm run dev` (set `CHESSADVISOR_FAKE_CODEX=1` to run the UI against the fake app-server without using quota)
- `npm test`, `npm run typecheck`
- `npm run codex:types` regenerates the app-server protocol bindings from the installed Codex CLI

## License
GPL-3.0. Third-party notices in `THIRD-PARTY-NOTICES.md`.
