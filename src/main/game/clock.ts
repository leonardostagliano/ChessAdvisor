import type { ClockConfig, ClockState } from '@shared/types/session'

/**
 * The clocks of one game (spec §4.3).
 *
 * The main process is the only authority: every charge is the difference between two timestamps
 * taken from the injected `now()`, never a count of ticks, so a slow interval, a suspended machine
 * or a throttled renderer cannot invent or lose time. The renderer receives {@link ClockState} and
 * interpolates it for the display only.
 *
 * The AI side is special (spec §4.3): with `aiClock:false` it has no clock at all, and with
 * `aiClock:true` its clock runs while it is thinking — so the display ticks and a flag fall is
 * noticed — but the real charge is {@link GameClock.chargeAi}, the wall time of the attempt that
 * produced the accepted move. Retries and fallbacks are given back.
 */

export type { ClockConfig, ClockState }

type Color = 'w' | 'b'

export class GameClock {
  private readonly remainingMs: { w: number; b: number }
  private running: Color | null = null
  /** When the running side started its turn, and what it had left at that moment. */
  private startedAt = 0
  private runStartRemaining = 0
  private updatedAt: number

  constructor(
    private readonly cfg: ClockConfig,
    remaining: { w: number; b: number },
    private readonly now: () => number
  ) {
    this.remainingMs = { w: Math.max(0, remaining.w), b: Math.max(0, remaining.b) }
    this.updatedAt = now()
  }

  /** The AI colour only has a clock in "Orologio anche per l'AI" mode. */
  private hasClock(color: Color): boolean {
    return this.cfg.aiColor !== color || this.cfg.aiClock
  }

  /**
   * Charges the running side for the time gone by since the last settle and restarts the
   * measurement from now. Idempotent: calling it twice in the same millisecond charges nothing.
   */
  private settle(): void {
    const at = this.now()
    const running = this.running
    if (running) {
      const elapsed = Math.max(0, at - this.startedAt)
      this.remainingMs[running] = Math.max(0, this.remainingMs[running] - elapsed)
      this.startedAt = at
    }
    this.updatedAt = at
  }

  /** Starts `color`'s clock, settling whatever was running before. A side with no clock stops it. */
  start(color: Color): void {
    this.settle()
    if (!this.hasClock(color)) {
      this.running = null
      return
    }
    if (this.running === color) return
    this.running = color
    this.startedAt = this.now()
    this.runStartRemaining = this.remainingMs[color]
    this.updatedAt = this.startedAt
  }

  /** Settles the elapsed time and leaves both clocks still. */
  stop(): void {
    this.settle()
    this.running = null
  }

  /**
   * The move is on the board: the mover's clock stops and the increment is credited right away,
   * before the opponent's clock is started (spec §4.3) — final move included. A side that has
   * already run out of time gets no increment: that game is lost on time.
   */
  onMoveCommitted(color: Color): { w: number; b: number } {
    this.settle()
    if (this.running === color) this.running = null
    if (this.hasClock(color) && this.remainingMs[color] > 0) {
      this.remainingMs[color] += Math.max(0, this.cfg.incrementMs)
    }
    return { ...this.remainingMs }
  }

  /**
   * Charges the AI exactly `ms`, the thinking time of the attempt that produced the accepted move
   * (`Move.thinkingMs`). The wall time burned by the retries (`Move.thinkingOverheadMs`) is never
   * charged, so the clock is corrected back to what the accepted attempt actually cost.
   */
  chargeAi(ms: number): void {
    const ai = this.cfg.aiColor
    if (!ai || !this.cfg.aiClock) return
    this.settle()
    const base = this.running === ai ? this.runStartRemaining : this.remainingMs[ai]
    this.remainingMs[ai] = Math.max(0, base - Math.max(0, ms))
    if (this.running === ai) {
      this.startedAt = this.now()
      this.runStartRemaining = this.remainingMs[ai]
    }
    this.updatedAt = this.now()
  }

  remaining(): { w: number; b: number } {
    this.settle()
    return { ...this.remainingMs }
  }

  /** The side whose flag has fallen, if any. A side without a clock can never run out. */
  expired(): Color | null {
    this.settle()
    const running = this.running
    // The running side is checked first: when both are at zero, the one on move lost.
    if (running && this.hasClock(running) && this.remainingMs[running] <= 0) return running
    for (const color of ['w', 'b'] as const) {
      if (this.hasClock(color) && this.remainingMs[color] <= 0) return color
    }
    return null
  }

  /** What the renderer interpolates from: the values at `updatedAt` and who is burning time. */
  snapshot(): ClockState {
    this.settle()
    return { remainingMs: { ...this.remainingMs }, running: this.running, updatedAt: this.updatedAt }
  }
}
