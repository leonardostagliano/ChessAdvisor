# Third-party notices

ChessAdvisor is distributed under the **GNU General Public License, version 3**
(`LICENSE`). It bundles or links the components below. The full licence texts
ship with the application in `resources/licenses/` and are installed next to the
executable under `resources/licenses`.

| Component | Version | Licence | Text |
| --- | --- | --- | --- |
| Stockfish (Windows x64 binaries) | `sf_17.1`, see `resources/engine/VERSION.txt` | GPL-3.0-or-later | `licenses/stockfish-notice.txt`, `licenses/gpl-3.0.txt` |
| chessground (`@lichess-org/chessground`) | ^10 | GPL-3.0-or-later | `licenses/chessground-notice.txt` |
| chess.js | ^1.4 | BSD-2-Clause | below |
| playwright-core (end-to-end harness, development only) | ^1.63 | Apache-2.0 | not shipped |
| cburnett chess pieces | — | GPL (Colin M.L. Burnett) | `licenses/cburnett-notice.txt` |
| Inter, JetBrains Mono, Fraunces | @fontsource | SIL OFL 1.1 | `licenses/fonts-ofl.txt` |
| Lichess datasets (puzzle database, chess-openings) | dumps of 2026 | CC0 1.0 | `licenses/lichess-cc0.txt` |
| Electron, React, Vite, Zustand, i18next and the other npm dependencies | see `package-lock.json` | MIT / BSD / Apache-2.0 | in each package under `node_modules` |

## Stockfish

ChessAdvisor runs **Stockfish** as a separate process over the UCI protocol; it
does not link against its code. The binaries in `resources/engine` are shipped
unmodified, exactly as downloaded by `npm run fetch:stockfish` from the official
Stockfish release assets. `resources/engine/VERSION.txt`, written by that script,
records the release tag and the exact URL each binary came from:

- release **`sf_17.1`**:
  <https://github.com/official-stockfish/Stockfish/releases/tag/sf_17.1>
- `stockfish-avx2.exe` — `stockfish-windows-x86-64-avx2.zip` of that release
- `stockfish-popcnt.exe` — `stockfish-windows-x86-64-sse41-popcnt.zip` of that
  release

The source of that exact build — the commit the release was cut from, with its
full history — is published by the Stockfish project at
<https://github.com/official-stockfish/Stockfish/tree/sf_17.1>, and the source
archive of the same tag is attached to the release page linked above.

Stockfish is free software under the GNU General Public License, version 3.
**Written offer:** for at least three years from the date these binaries were
distributed, the author will supply, on request and for no more than the
physical cost of distribution, the complete corresponding source code of the
Stockfish version shipped here, under the terms of GPL-3.0. Open an issue titled
"Stockfish corresponding source" at
<https://github.com/leonardostagliano/ChessAdvisor>.

Upstream source: <https://github.com/official-stockfish/Stockfish>

## chessground

`@lichess-org/chessground` (the interactive board) is linked into the renderer
bundle and is licensed **GPL-3.0-or-later**, Copyright (C) Thibault Duplessis and
the Lichess contributors. ChessAdvisor's own GPL-3.0-only licence is compatible
with it. Source: <https://github.com/lichess-org/chessground>

## chess.js

Move generation and validation use **chess.js**, Copyright (c) Jeff Hlywa,
licensed **BSD-2-Clause**:

> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
>
> 1. Redistributions of source code must retain the above copyright notice, this
>    list of conditions and the following disclaimer.
> 2. Redistributions in binary form must reproduce the above copyright notice,
>    this list of conditions and the following disclaimer in the documentation
>    and/or other materials provided with the distribution.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
> ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
> WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
> DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
> ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
> (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
> LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
> ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
> (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
> SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## cburnett chess pieces

The piece set is **cburnett** by **Colin M.L. Burnett**, published on Wikimedia
Commons and used here under the **GNU General Public License**. Source:
<https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces>

## Fonts

**Inter**, **JetBrains Mono** and **Fraunces** ship through the `@fontsource`
packages and are licensed under the **SIL Open Font License 1.1**. No font is
loaded from a CDN. The full licence text is in `licenses/fonts-ofl.txt`.

## Lichess datasets

`resources/data/puzzles.json` and `resources/data/openings.json` derive from the
open Lichess datasets — the [puzzle database](https://database.lichess.org/) and
[`lichess-org/chess-openings`](https://github.com/lichess-org/chess-openings) —
both released under **CC0 1.0**, which waives every copyright restriction. The
subsets are produced by `npm run build:datasets` (`scripts/build-datasets.mjs`),
which also computes the EPD used to recognise openings by position and applies
the opponent premove of each puzzle. `fzstd` (MIT), used only by that script to
decompress the puzzle dump, is a development dependency and is not shipped.

`resources/data/endgames.json` is not derived from anything: the twenty canonical
positions are written by hand in the same script and are part of ChessAdvisor,
under its own GPL-3.0 licence.

## OpenAI models

ChessAdvisor plays through the **Codex CLI** session already authenticated on the
machine; it bundles no OpenAI software and stores no API key. Use of the models
is governed by the agreement between the user and OpenAI.
