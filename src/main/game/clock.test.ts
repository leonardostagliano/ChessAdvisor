import { describe, expect, it } from 'vitest'
import { GameClock, type ClockConfig } from './clock'

/** 5+3, both sides on the clock unless the test says otherwise. */
const config = (over: Partial<ClockConfig> = {}): ClockConfig => ({
  initialMs: 300_000,
  incrementMs: 3_000,
  aiClock: true,
  aiColor: 'b',
  ...over
})

/** A hand-driven wall clock: nothing in {@link GameClock} may read the real time. */
function ticker(start = 1_700_000_000_000): { now: () => number; advance(ms: number): void } {
  let value = start
  return {
    now: () => value,
    advance(ms: number) {
      value += ms
    }
  }
}

const fresh = (
  cfg: ClockConfig = config(),
  start?: number
): { clock: GameClock; time: ReturnType<typeof ticker> } => {
  const time = ticker(start)
  return { clock: new GameClock(cfg, { w: cfg.initialMs, b: cfg.initialMs }, time.now), time }
}

describe('GameClock', () => {
  it('charges the elapsed time by difference between timestamps', () => {
    const { clock, time } = fresh()
    clock.start('w')
    time.advance(2_500)
    clock.stop()

    expect(clock.remaining()).toEqual({ w: 297_500, b: 300_000 })
    expect(clock.snapshot().running).toBeNull()
  })

  it('never drifts, however often it is read while running', () => {
    const { clock, time } = fresh()
    clock.start('w')
    // A whole minute read back one hundred times: the total must be the difference, not a sum of ticks.
    for (let tick = 0; tick < 100; tick += 1) {
      time.advance(600)
      clock.snapshot()
    }
    expect(clock.remaining().w).toBe(300_000 - 60_000)

    // Reading it again without time passing changes nothing.
    expect(clock.remaining().w).toBe(240_000)
    expect(clock.snapshot().updatedAt).toBe(time.now())
  })

  it('credits the increment to whoever has just moved, and only then', () => {
    const { clock, time } = fresh()
    clock.start('w')
    time.advance(10_000)
    const remaining = clock.onMoveCommitted('w')

    expect(remaining).toEqual({ w: 293_000, b: 300_000 })
    expect(clock.snapshot().running).toBeNull()

    // The opponent's clock only starts when it is explicitly started.
    time.advance(5_000)
    expect(clock.remaining()).toEqual({ w: 293_000, b: 300_000 })
    clock.start('b')
    time.advance(4_000)
    expect(clock.remaining()).toEqual({ w: 293_000, b: 296_000 })
  })

  it('keeps the increment out of a game already lost on time', () => {
    const { clock, time } = fresh(config({ initialMs: 5_000 }))
    clock.start('w')
    time.advance(6_000)
    expect(clock.onMoveCommitted('w')).toEqual({ w: 0, b: 5_000 })
    expect(clock.expired()).toBe('w')
  })

  it('never runs nor charges the AI side when it has no clock', () => {
    const { clock, time } = fresh(config({ aiClock: false }))
    clock.start('b')
    time.advance(30_000)
    expect(clock.snapshot().running).toBeNull()
    expect(clock.remaining()).toEqual({ w: 300_000, b: 300_000 })

    clock.chargeAi(20_000)
    expect(clock.onMoveCommitted('b')).toEqual({ w: 300_000, b: 300_000 })
    expect(clock.expired()).toBeNull()

    // The user's side keeps working as usual.
    clock.start('w')
    time.advance(1_000)
    expect(clock.remaining().w).toBe(299_000)
  })

  it('charges the AI exactly the thinking time of the accepted attempt', () => {
    const { clock, time } = fresh()
    clock.start('b')
    // Two retries burned nine seconds of wall time; only the accepted attempt is charged.
    time.advance(12_000)
    clock.chargeAi(3_000)
    const remaining = clock.onMoveCommitted('b')

    expect(remaining).toEqual({ w: 300_000, b: 300_000 })
    expect(clock.snapshot().running).toBeNull()
  })

  it('flags the AI when its thinking time is longer than what is left', () => {
    const { clock, time } = fresh(config({ initialMs: 4_000 }))
    clock.start('b')
    time.advance(1_000)
    clock.chargeAi(9_000)

    expect(clock.remaining().b).toBe(0)
    expect(clock.expired()).toBe('b')
  })

  it('reports the side that ran out while it was running', () => {
    const { clock, time } = fresh(config({ initialMs: 2_000 }))
    expect(clock.expired()).toBeNull()
    clock.start('w')
    time.advance(1_999)
    expect(clock.expired()).toBeNull()
    time.advance(1)
    expect(clock.expired()).toBe('w')
    // A clock at zero stays at zero, never negative.
    time.advance(60_000)
    expect(clock.remaining().w).toBe(0)
  })

  it('publishes a snapshot the renderer can interpolate from', () => {
    const { clock, time } = fresh(undefined, 1_000)
    clock.start('w')
    time.advance(1_500)
    const snapshot = clock.snapshot()

    expect(snapshot).toEqual({
      remainingMs: { w: 298_500, b: 300_000 },
      running: 'w',
      updatedAt: 2_500
    })
    // The snapshot is a copy: mutating it never reaches the clock.
    snapshot.remainingMs.w = 0
    expect(clock.remaining().w).toBe(298_500)
  })

  it('starts from the remaining time it is given, not from the initial one', () => {
    const time = ticker()
    const clock = new GameClock(config(), { w: 12_000, b: 34_000 }, time.now)
    expect(clock.remaining()).toEqual({ w: 12_000, b: 34_000 })
    clock.start('w')
    time.advance(2_000)
    expect(clock.remaining()).toEqual({ w: 10_000, b: 34_000 })
  })

  it('switches sides without losing a millisecond', () => {
    const { clock, time } = fresh()
    clock.start('w')
    time.advance(1_000)
    clock.start('b')
    time.advance(3_000)
    clock.start('w')
    time.advance(2_000)

    expect(clock.remaining()).toEqual({ w: 297_000, b: 297_000 })
    expect(clock.snapshot().running).toBe('w')
  })
})
