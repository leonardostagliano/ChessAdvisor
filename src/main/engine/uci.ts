/**
 * Parsers for the two UCI output lines ChessAdvisor cares about.
 *
 * Scores stay exactly as the engine reports them: UCI convention, from the point of view of
 * the side to move. Nothing here flips a sign — the AnalysisPipeline (M3) and the eval bar do.
 */

export interface InfoLine {
  multipv: number
  depth: number
  scoreCp?: number
  scoreMate?: number
  pv: string[]
}

/**
 * Parses an `info … pv …` line. Returns `null` for anything that is not a usable evaluation:
 * `info string …`, search-progress lines (`currmove`), and `lowerbound`/`upperbound` lines,
 * whose score is only a bracket on the real one and would be wrong to display or compare.
 */
export function parseInfoLine(line: string): InfoLine | null {
  const tokens = line
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
  if (tokens.length === 0 || tokens[0] !== 'info') return null

  let multipv = 1
  let depth: number | null = null
  let scoreCp: number | undefined
  let scoreMate: number | undefined
  let pv: string[] | null = null

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!
    switch (token) {
      case 'string':
      case 'currmove':
      case 'currmovenumber':
      case 'lowerbound':
      case 'upperbound':
        return null
      case 'depth': {
        const value = toInt(tokens[i + 1])
        if (value === null) return null
        depth = value
        i += 1
        break
      }
      case 'multipv': {
        const value = toInt(tokens[i + 1])
        if (value === null) return null
        multipv = value
        i += 1
        break
      }
      case 'score': {
        const kind = tokens[i + 1]
        const value = toInt(tokens[i + 2])
        if (value === null) break
        if (kind === 'cp') scoreCp = value
        else if (kind === 'mate') scoreMate = value
        else break
        i += 2
        break
      }
      case 'pv':
        // The principal variation runs to the end of the line, so no token after it is a keyword.
        pv = tokens.slice(i + 1)
        i = tokens.length
        break
      default:
        break
    }
  }

  if (depth === null || pv === null || pv.length === 0) return null
  const parsed: InfoLine = { multipv, depth, pv }
  if (scoreCp !== undefined) parsed.scoreCp = scoreCp
  if (scoreMate !== undefined) parsed.scoreMate = scoreMate
  return parsed
}

/** `bestmove e2e4 ponder e7e5` → `e2e4`; `bestmove (none)` / `0000` (no legal move) → `null`. */
export function parseBestMove(line: string): string | null {
  const tokens = line
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
  if (tokens.length < 2 || tokens[0] !== 'bestmove') return null
  const move = tokens[1]!
  if (move === '(none)' || move === '0000') return null
  return move
}

function toInt(token: string | undefined): number | null {
  if (token === undefined) return null
  if (!/^-?\d+$/.test(token)) return null
  return Number.parseInt(token, 10)
}
