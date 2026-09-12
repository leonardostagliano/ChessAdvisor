# Codex app-server protocol bindings

Generated TypeScript bindings for the Codex CLI app-server protocol. **Do not edit by hand.**

- Generated from: **Codex CLI 0.154.0** (`codex-cli 0.154.0`, Windows x64)
- Regeneration command: `npm run codex:types`
  (which runs `codex app-server generate-ts -o src/main/codex/protocol`)

The whole directory is committed so the build does not depend on a local Codex installation.
The version above is mirrored in `package.json` under `codexCli.testedVersion` and re-exported by
`src/main/codex/protocolVersion.ts` as `TESTED_CODEX_VERSION`; at startup the app compares it with
the output of `codex --version` and shows a non-blocking warning when they differ.

After regenerating, re-run `npm run typecheck` and `npm test`: the fake app-server in
`test/fake-app-server-lib.mjs` is written against these shapes and must be kept in step.

Note: the app-server transport is NDJSON **without** a `jsonrpc` field — see
`src/main/codex/ndjson.ts` and `src/main/codex/rpcClient.ts`.
