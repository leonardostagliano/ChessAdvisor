import pkg from '../../../package.json'

/**
 * Codex CLI version the generated bindings in `./protocol` were produced from.
 *
 * Declared in `package.json` (`codexCli.testedVersion`) so the packaged app, the regeneration
 * script and the startup check cannot drift apart. At runtime the app compares it with
 * `codex --version` and shows a non-blocking warning on mismatch (spec §3.1).
 */
export const TESTED_CODEX_VERSION: string = pkg.codexCli.testedVersion
