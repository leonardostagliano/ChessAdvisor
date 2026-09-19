import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelInfo } from '@shared/types/codex'
import type { Game } from '@shared/types/game'
import { DIFFICULTY_LEVELS, type SessionState } from '@shared/types/session'
import { cx } from '../../components/ui/cx'
import { useCodexStore } from '../../stores/codexStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './PlayScreen.module.css'

/**
 * The opponent panel of the play screen (spec §4.3): who is playing, at which difficulty, and
 * what it is doing right now.
 *
 * Everything here is derived from the session the main process pushes — the renderer never times
 * a turn itself: the elapsed counter is drawn from `ai.startedAt`, so a re-render, a pause or a
 * lost `game:state` cannot make the displayed time drift away from the real one.
 */

export interface OpponentCardProps {
  session: SessionState
  /** Overrides the mirrored Codex catalogue; only tests and previews pass it. */
  models?: ModelInfo[]
  /** Captures and clock are attached to the player strip by the play screen. */
  meta?: ReactNode
}

/** `mm:ss`, minutes uncapped so a very slow turn still reads correctly. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

/** Elapsed milliseconds since `startedAt`, ticking every second while `running`. */
export function useElapsed(startedAt: number | null, running: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running || startedAt === null) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running, startedAt])

  if (startedAt === null) return 0
  return Math.max(0, now - startedAt)
}

/** "Medio · ~1200", "Adattiva · ~1275", "Massimo" (spec §4.1). */
export function difficultyLabel(
  game: Game,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const { difficulty } = game.opponent
  const name =
    difficulty.mode === 'adaptive'
      ? t('difficulty.adaptive')
      : t(`difficulty.${DIFFICULTY_LEVELS[difficulty.level].key}`)
  if (difficulty.targetElo === null) return name
  return `${name} · ${t('difficulty.elo', { elo: difficulty.targetElo })}`
}

export function OpponentCard({
  session,
  models,
  meta
}: OpponentCardProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const mirrored = useCodexStore((state) => state.models)
  const uiLanguage = useUiStore((state) => state.language)
  const catalogue = models ?? mirrored
  const game = session.game
  const elapsed = useElapsed(session.ai.startedAt, session.ai.thinking)

  if (!game) return null

  const info = catalogue.find((model) => model.id === game.opponent.model)
  const displayName = info?.displayName ?? game.opponent.model ?? t('opponent.unknownModel')
  const effortLabel = t(`newGame.efforts.${game.opponent.effort}`, {
    defaultValue: game.opponent.effort
  })
  const lastAiMove = [...game.moves].reverse().find((move) => move.by === 'ai')
  const rerouted =
    lastAiMove?.effectiveModel && lastAiMove.effectiveModel !== game.opponent.model
      ? lastAiMove.effectiveModel
      : null

  return (
    <section className={styles.opponent} aria-label={t('opponent.title')}>
      <div className={styles.opponentHead}>
        <div className={styles.opponentIdentity}>
          <span
            className={cx(
              styles.opponentStone,
              game.userColor === 'w' ? styles.stoneBlack : styles.stoneWhite
            )}
            aria-hidden="true"
          />
          <div>
            <p className="eyebrow">{t('opponent.title')}</p>
            <h2 className={styles.opponentModel}>{displayName}</h2>
          </div>
        </div>
        <div className={styles.opponentHeadEnd}>
          <div className={styles.chips}>
            <span className={styles.chip}>{effortLabel}</span>
            <span className={cx(styles.chip, styles.chipAccent)}>{difficultyLabel(game, t)}</span>
            {rerouted ? (
              <span className={cx(styles.chip, styles.chipWarn)} title={t('opponent.reroutedHint')}>
                {t('opponent.rerouted', { model: rerouted })}
              </span>
            ) : null}
            {lastAiMove?.fallback ? (
              <span className={cx(styles.chip, styles.chipWarn)}>
                {lastAiMove.fallback === 'engine'
                  ? t('opponent.fallbackEngine')
                  : t('opponent.fallbackRandom')}
              </span>
            ) : null}
          </div>
          {meta}
        </div>
      </div>

      <div className={styles.opponentStatus} role="status" aria-live="polite">
        {session.ai.thinking ? (
          <>
            <span className={styles.thinkingDot} aria-hidden="true" />
            <span>{`${displayName} ${t('opponent.thinking')}`}</span>
            <span className={cx(styles.timer, 'mono')}>{formatElapsed(elapsed)}</span>
            {session.ai.retries > 0 ? (
              <span className={cx(styles.chip, styles.chipWarn)}>
                {t('opponent.retries', { count: session.ai.retries })}
              </span>
            ) : null}
          </>
        ) : (
          <span>{session.userToMove ? t('play.yourTurn') : t('play.waitingOpponent')}</span>
        )}
      </div>

      {session.ai.reasoning ? (
        <div className={styles.reasoning}>
          <p className="eyebrow">{t('opponent.reasoning')}</p>
          <p className={cx(styles.reasoningText, 'selectable')}>{session.ai.reasoning}</p>
        </div>
      ) : null}

      {/* Changing the UI language only applies from the next turn (spec §4.3): what is already
          written keeps its own language and says so, instead of pretending to be translated. */}
      {!session.ai.thinking && lastAiMove?.aiShortComment ? (
        <p className={styles.comment}>
          <span className={cx(styles.moveTag, 'mono')}>{lastAiMove.san}</span>
          <span className="selectable">{lastAiMove.aiShortComment}</span>
          {game.language !== uiLanguage ? (
            <span className={styles.chip}>
              {t('coach.languageBadge', {
                language: t(game.language === 'it' ? 'settings.languageIt' : 'settings.languageEn')
              })}
            </span>
          ) : null}
        </p>
      ) : null}
    </section>
  )
}
