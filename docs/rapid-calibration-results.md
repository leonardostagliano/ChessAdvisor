# Chess.com Rapid difficulty pilot

This pilot uses a bounded sample of public Chess.com Rapid games to give the opponent human move context and to guide its engine fallback. It does **not** measure the app's playing Elo. The earlier [difficulty research](difficulty-calibration-research.md) records the proposal and pre-pilot policy; its old fixed loss targets and model-move adjustment rates are historical, not the current settings.

## What changed

The model still sees the full legal move list and can choose a sound move at every level. Stockfish provides a level-dependent search pool and checks proposed moves against a tactical loss ceiling. Accepted model moves are no longer intentionally replaced with weaker ones. The fallback, used when the model cannot produce a usable move, samples from observed human centipawn-loss quantiles where the pilot has enough support. If a rating or phase cohort is unsupported, the lookup falls back to a supported aggregate or to the best engine candidate. Observed opening moves are context, never a legal-move whitelist or an enforced script.

| Mode                                        | Requested reference                                           | Behavior                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Beginner, Easy, Medium, Challenging, Strong | Nominal Chess.com Rapid targets of 600, 900, 1200, 1500, 1800 | Distinct search pools and tactical ceilings; supported pilot cohorts guide fallback and context. These targets are not measured app ratings.          |
| Maximum                                     | No Elo target                                                 | Deepest opponent search and strongest available fallback; no human error quota.                                                                       |
| Adaptive                                    | Target from the user's in-app results, bounded to 500–2400    | Policy interpolates continuously; the model persona and search profile use the nearest rated fixed level. An in-app target is not a Chess.com rating. |

A runtime cohort needs at least 40 scored decisions from 8 players. Sparse phase cohorts use supported all-phase data; any neighbouring rating source must be within 300 points of the requested target. These are operational support thresholds, not statistical confidence guarantees.

## Reproduce the pilot

The collector uses the [Chess.com Published-Data API](https://www.chess.com/news/view/published-data-api): an explicit username file and/or currently active players from country lists, each player's archive list, then recent complete monthly archives. It requests serially, retries bounded rate limits, caches source JSON, and limits accounts, months, and games. Only rated standard Rapid games with both historical numeric ratings and PGN enter `games.jsonl`. The ratings in the monthly JSON are **after the game**, not current profile ratings. The collection manifest records endpoints, limits, skipped games, and source bias.

```sh
node scripts/collect-rapid-games.mjs --country IT --country US --country IN --country XE --seed rapid-2026-09 --max-players 400 --months 3 --max-games 30000
node --experimental-strip-types scripts/analyze-rapid-games.mjs --nodes 40000 --positions-per-cell 250 --workers 4 --max-games 30000 --seed rapid-2026-09
node scripts/benchmark-rapid-policy.mjs --per-band 3 --seeds 32
```

These commands describe the 22 September 2026 run. Exact replay requires retaining its collected JSONL and manifest: live country lists and the most recent complete months change over time. The first command writes `resources/data/.download/rapid/games.jsonl` and `manifest.json`. Analysis uses local Stockfish, writes `observations.jsonl` and the bundled `resources/data/rapid-calibration.json`, and keeps train and held-out players separate. It limits contributions per player and samples positions by rating and phase with a fixed seed. For each selected position it compares a root search with a search after the human move; mate scores and missing evaluations stay separate from centipawn losses. The benchmark forces three unusable mocked model responses through the real playOpponentTurn function, then records the actual fallback after its child-position safety check. It compares all six levels on the same held-out positions with the frozen former unverified fallback selector and checks each distinct returned move with Stockfish. No live language-model request is made. Its JSON report is `docs/rapid-policy-benchmark.json`. The hard ceiling is 21 distinct positions and `--seeds` is at most 64. Smaller runs can use `--per-band 1`, which rotates the preferred phase across rating bands.

## Results

| Measure                                                                                                                   | Result                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collection: games, accounts, archives, date window, countries                                                             | 30,000 unique games; 655 archives from 261 accounts with eligible monthly archives; June–August 2026; active-country lists IN, IT, US, XE. The 30,000-game cap stopped collection before all 400 selected accounts were processed.                                   |
| Analysis: train and held-out games/positions, usable cohorts by rating and phase, mate and missing-score counts           | 8,301 admitted games (7,684 train / 617 holdout); 10,604 reservoir observations from 7,904 distinct decisions (7,000 train / 3,604 holdout rows). All 28 training cohorts are usable. 642 mate transitions, zero missing scores or analysis errors.                  |
| Fallback benchmark: positions, supported rating bands, per-level current versus former fallback loss and mate/draw counts | 15 distinct held-out positions (5 opening, 5 middlegame, 5 endgame), 480 returned choices per level per policy; all six fixed levels compared. Source bands 600–1800; no held-out 2100/2400 position. No mate transitions or missing scores in this selected sample. |
| Complete-game opponent strength or Chess.com Elo                                                                          | Not measured by this pilot.                                                                                                                                                                                                                                          |

The country lists reflect currently active players who self-identify with a country; account selection, archive availability, recent months, and collection caps introduce selection bias. The sample is not a global Rapid population estimate. Centipawn distributions are conditional on positions with usable finite Stockfish scores and a bounded root evaluation; they exclude mate transitions and some extreme positions. The current pilot keeps the precise time control as source metadata but does not stratify results by clock format or remaining time. A 10+0 distribution may differ from 15+10. The benchmark measures **fallback move selection**, not full games played by the language model, and does not simulate the former model-move adjustment stage. Claims of calibrated Elo would require complete games against a defined reference population, with uncertainty estimates and matching clock conditions.

## Training reference coverage

Stockfish 17.1 used 40,000 nodes per root and child search, one thread and 32 MB hash. The table uses the independent all-phase reservoir, after the ±600 cp and finite-score filters. Phase-specific reservoirs are stored separately and overlap with it: the 5,926 total training profile placements are not 5,926 unique decisions. There are 1,491 eligible all-phase placements.

| Anchor | Observed rating range | Eligible decisions | Players | Median loss (cp) | Loss >150 cp |
| ------ | --------------------- | -----------------: | ------: | ---------------: | -----------: |
| 600    | 500–750               |                194 |     118 |               12 |        10.8% |
| 900    | 751–1048              |                204 |     119 |             11.5 |         9.8% |
| 1200   | 1051–1350             |                207 |     117 |               10 |        10.6% |
| 1500   | 1351–1649             |                219 |     103 |                6 |         8.7% |
| 1800   | 1651–1922             |                224 |     122 |               15 |         9.4% |
| 2100   | 1977–2250             |                223 |      92 |                0 |         4.9% |
| 2400   | 2251–2493             |                220 |      42 |                0 |         5.0% |

The noisy rates are not a monotonic Elo conversion. The holdout has no 2100 or 2400 cohort; those adaptive anchors have training references but lack independent human-cohort validation in this run. The 1200 and 1800 holdout reservoirs are also smaller than the requested cap. No player or game occurs in both train and holdout.

Accepted game controls: 600: 7636; 1200: 61; 1800: 169; 600+5: 38; 900+10: 397. The sample is predominantly 10+0.

Raw PGNs, account names, source caches and local observation files remain in the ignored `.download` directory. Windows packaging explicitly excludes download caches; only aggregate statistics and opening counts ship with the app.

## Application verification

The final source and real calibration artifact passed 936 automated tests and both TypeScript checks. This includes all six real Stockfish search profiles, legal move selection, tactical ceilings, mate handling, retained model comments, and supported bundled cohorts. The Windows 0.2.2 NSIS and portable builds completed successfully. The packaged smoke check passed (manifest, Stockfish, all rated fixed cohorts, and excluded download caches), and the isolated Electron end-to-end run passed all 46 checks.

## Fallback comparison

[Machine-readable benchmark](rapid-policy-benchmark.json). Each policy is applied to the same positions, with 32 deterministic seeds per position. Repeated seeds are not independent human games; root references use the search profile of the level being tested.

| Level   | Former mean loss (cp) | Current mean loss (cp) | Former loss >150 cp | Current loss >150 cp |
| ------- | --------------------: | ---------------------: | ------------------: | -------------------: |
| 600     |                411.18 |                  80.89 |               86.5% |                15.8% |
| 900     |                188.71 |                  49.75 |               45.2% |                 5.8% |
| 1200    |                 97.45 |                  34.23 |               14.6% |                 3.1% |
| 1500    |                 50.23 |                  24.53 |                0.0% |                 1.0% |
| 1800    |                 26.61 |                  28.58 |                0.0% |                 0.0% |
| Maximum |                 13.67 |                  13.67 |                0.0% |                 0.0% |

The lower levels show much smaller evaluation losses than under the former repeated-loss fallback. This sample does not establish a strict ordering of adjacent levels: Strong has a slightly higher mean loss than Challenging and than its former fallback, while Maximum is unchanged. The sample is too small to interpret these differences as Elo.

The runtime independently verified all sampled returns at levels 1–5. At Maximum, 32/480 returns used its best legal line without a passing independent loss check; the benchmark still obtained finite child scores for them. Such returns are explicitly marked unverified by the app, and their tactical ceiling is not guaranteed. Mate behavior is covered by separate regression fixtures because no mate transition occurred in this selected benchmark.
