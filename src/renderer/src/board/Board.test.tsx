import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import '../i18n'

/**
 * chessground touches layout APIs jsdom does not implement (bounds, getBoundingClientRect on
 * custom elements), so the module is mocked with a miniature that keeps the two things the
 * wrapper is responsible for: the DOM it mounts, and the config it hands over on every update.
 */

interface CgConfig {
  fen?: string
  orientation?: string
  turnColor?: string
  check?: boolean | string
  lastMove?: string[]
  viewOnly?: boolean
  movable?: { color?: string; dests?: Map<string, string[]>; events?: { after?(orig: string, dest: string): void } }
  drawable?: { autoShapes?: { orig: string; dest?: string; brush?: string }[] }
  animation?: { enabled?: boolean; duration?: number }
  premovable?: { enabled?: boolean }
  draggable?: { showGhost?: boolean }
}

const created: { el: HTMLElement; configs: CgConfig[]; destroyed: boolean }[] = []

function lastBoard(): { el: HTMLElement; configs: CgConfig[]; destroyed: boolean } {
  const board = created[created.length - 1]
  expect(board).toBeDefined()
  return board
}

function lastConfig(): CgConfig {
  const { configs } = lastBoard()
  return configs[configs.length - 1]
}

vi.mock('@lichess-org/chessground', () => ({
  Chessground: (el: HTMLElement, config: CgConfig) => {
    const entry = { el, configs: [config], destroyed: false }
    created.push(entry)
    el.classList.add('cg-wrap')
    const container = document.createElement('cg-container')
    const board = document.createElement('cg-board')
    for (let i = 0; i < 64; i += 1) board.appendChild(document.createElement('square'))
    container.appendChild(board)
    el.appendChild(container)
    return {
      set: (next: CgConfig) => entry.configs.push(next),
      setAutoShapes: () => {},
      redrawAll: () => {},
      destroy: () => {
        entry.destroyed = true
      }
    }
  }
}))

const { act: reactAct, fireEvent: fire, screen: view } = await import('@testing-library/react')
const { Board } = await import('./Board')
const { EvalBar, evalLabel, whiteWinPercent } = await import('./EvalBar')

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const PROMOTION = '8/4P3/8/8/8/8/8/K6k w - - 0 1'

/** A `prefers-reduced-motion` media query the test drives by hand. */
function installReducedMotion(matches: boolean): { emit(next: boolean): void } {
  const listeners = new Set<(event: { matches: boolean }) => void>()
  const mql = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_type: string, cb: (event: { matches: boolean }) => void) => void listeners.add(cb),
    removeEventListener: (_type: string, cb: (event: { matches: boolean }) => void) => void listeners.delete(cb),
    addListener: (cb: (event: { matches: boolean }) => void) => void listeners.add(cb),
    removeListener: (cb: (event: { matches: boolean }) => void) => void listeners.delete(cb)
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mql)
  )
  return {
    emit: (next: boolean) => {
      mql.matches = next
      for (const cb of listeners) cb({ matches: next })
    }
  }
}

beforeEach(() => {
  created.length = 0
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Board', () => {
  it('mounts chessground and renders the 64 squares of the board', () => {
    render(<Board fen={START} />)
    const wrap = lastBoard().el
    expect(wrap).toBeInTheDocument()
    expect(wrap.querySelectorAll('square')).toHaveLength(64)
    expect(screen.getByRole('group', { name: 'Scacchiera' })).toContainElement(wrap)
  })

  it('derives the legal destinations of the position and the side to move', () => {
    render(<Board fen={START} movable={{ color: 'white' }} />)
    const config = lastConfig()
    expect(config.turnColor).toBe('white')
    expect(config.movable?.color).toBe('white')
    // 8 pawns + 2 knights can move from the initial position, 20 moves in total.
    const dests = config.movable?.dests
    expect(dests?.size).toBe(10)
    expect([...(dests?.values() ?? [])].reduce((total, list) => total + list.length, 0)).toBe(20)
    expect(dests?.get('e2')).toEqual(['e3', 'e4'])
  })

  it('reports the move in UCI when chessground fires the move event', () => {
    const onMove = vi.fn()
    render(<Board fen={START} movable={{ color: 'white' }} onMove={onMove} />)
    lastConfig().movable?.events?.after?.('e2', 'e4')
    expect(onMove).toHaveBeenCalledWith('e2e4')
  })

  it('asks which piece to promote to and sends the chosen one', () => {
    const onMove = vi.fn()
    render(<Board fen={PROMOTION} movable={{ color: 'white' }} onMove={onMove} />)
    reactAct(() => {
      lastConfig().movable?.events?.after?.('e7', 'e8')
    })
    expect(onMove).not.toHaveBeenCalled()
    const picker = view.getByTestId('promotion-picker')
    const choices = picker.querySelectorAll('button')
    expect(choices).toHaveLength(4)
    fire.click(view.getByRole('button', { name: 'Torre' }))
    expect(onMove).toHaveBeenCalledWith('e7e8r')
    expect(view.queryByTestId('promotion-picker')).toBeNull()
  })

  it('picks the promotion piece with the number keys, in the order of the column', () => {
    const onMove = vi.fn()
    render(<Board fen={PROMOTION} movable={{ color: 'white' }} onMove={onMove} />)
    reactAct(() => {
      lastConfig().movable?.events?.after?.('e7', 'e8')
    })
    reactAct(() => {
      fire.keyDown(window, { key: '3' })
    })
    // The column shows queen, knight, rook, bishop: the third key is the rook.
    expect(onMove).toHaveBeenCalledWith('e7e8r')
    expect(view.queryByTestId('promotion-picker')).toBeNull()
  })

  it('cancels the promotion with Escape and puts the pawn back', () => {
    const onMove = vi.fn()
    render(<Board fen={PROMOTION} movable={{ color: 'white' }} onMove={onMove} />)
    reactAct(() => {
      lastConfig().movable?.events?.after?.('e7', 'e8')
    })
    const before = created[0]!.configs.length
    reactAct(() => {
      fire.keyDown(window, { key: 'Escape' })
    })
    expect(onMove).not.toHaveBeenCalled()
    expect(view.queryByTestId('promotion-picker')).toBeNull()
    // The board was reset to the unchanged position.
    expect(created[0]!.configs.length).toBe(before + 1)
    expect(lastConfig().fen).toBe(PROMOTION)
  })

  it('draws a circle for an arrow without destination', () => {
    render(<Board fen={START} arrows={[{ from: 'e2', color: 'accent' }, { from: 'e2', to: 'e4', color: 'accent' }]} />)
    const shapes = lastConfig().drawable?.autoShapes ?? []
    expect(shapes).toHaveLength(2)
    expect(shapes[0]).toEqual({ orig: 'e2', brush: 'accent' })
    expect(shapes[1]).toEqual({ orig: 'e2', dest: 'e4', brush: 'accent' })
  })

  it('pushes fen, lastMove, check and arrows through set() without remounting', () => {
    const after = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'
    const { rerender } = render(<Board fen={START} />)
    expect(created).toHaveLength(1)
    rerender(
      <Board
        fen={after}
        lastMove={['e2', 'e4']}
        check
        arrows={[{ from: 'd7', to: 'd5', color: 'green' }]}
      />
    )
    expect(created).toHaveLength(1)
    const config = lastConfig()
    expect(config.fen).toBe(after)
    expect(config.lastMove).toEqual(['e2', 'e4'])
    expect(config.check).toBe(true)
    expect(config.turnColor).toBe('black')
    expect(config.drawable?.autoShapes).toEqual([{ orig: 'd7', dest: 'd5', brush: 'green' }])
  })

  it('uses the animation, premove and ghost settings the spec asks for', () => {
    installReducedMotion(false)
    render(<Board fen={START} />)
    const config = lastConfig()
    expect(config.animation?.enabled).toBe(true)
    expect(config.animation?.duration).toBe(200)
    expect(config.premovable?.enabled).toBe(false)
    expect(config.draggable?.showGhost).toBe(true)
  })

  it('drops the piece animation when the system asks for reduced motion', () => {
    installReducedMotion(true)
    render(<Board fen={START} />)
    // chessground animates from JavaScript, so the very first config must already say no.
    const config = lastConfig()
    expect(config.animation?.enabled).toBe(false)
    expect(config.animation?.duration).toBe(0)
  })

  it('follows a change of the reduced-motion preference while the board is mounted', () => {
    const media = installReducedMotion(false)
    render(<Board fen={START} />)
    expect(lastConfig().animation?.enabled).toBe(true)
    act(() => media.emit(true))
    expect(lastConfig().animation?.enabled).toBe(false)
  })

  it('locks the board while a position is only being browsed', () => {
    render(<Board fen={START} viewOnly />)
    expect(lastConfig().viewOnly).toBe(true)
    expect(lastConfig().movable?.color).toBeUndefined()
  })

  it('destroys the chessground instance on unmount', () => {
    const { unmount } = render(<Board fen={START} />)
    const board = lastBoard()
    unmount()
    expect(board.destroyed).toBe(true)
  })
})

describe('EvalBar', () => {
  it('maps the score to the White share of the bar', () => {
    expect(whiteWinPercent({ cp: 0 })).toBe(50)
    expect(whiteWinPercent({ mate: 3 })).toBe(100)
    expect(whiteWinPercent({ mate: -3 })).toBe(0)
    expect(whiteWinPercent(null)).toBe(50)
    expect(whiteWinPercent({ cp: 800 })).toBeGreaterThan(90)
    expect(whiteWinPercent({ cp: -800 })).toBeLessThan(10)
  })

  it('writes the score the way a chess UI does', () => {
    expect(evalLabel({ cp: 0 })).toBe('0.0')
    expect(evalLabel({ cp: 80 })).toBe('+0.8')
    expect(evalLabel({ cp: -125 })).toBe('-1.3')
    expect(evalLabel({ mate: 3 })).toBe('M3')
    expect(evalLabel({ mate: -2 })).toBe('-M2')
    expect(evalLabel(null)).toBe('—')
  })

  it('renders a labelled bar and hides itself when the engine is unavailable', () => {
    const { rerender, container } = render(<EvalBar evaluation={{ cp: 80 }} />)
    const bar = screen.getByRole('img', { name: /\+0\.8/ })
    expect(bar).toBeInTheDocument()
    expect(screen.getByText('+0.8')).toBeInTheDocument()
    rerender(<EvalBar evaluation={{ cp: 80 }} available={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})
