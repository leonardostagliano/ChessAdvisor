import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelInfo } from '@shared/types/codex'
import {
  DIFFICULTY_LEVELS,
  type DifficultyChoice,
  type DifficultyLevel,
  type NewGameOptions,
  type SessionState
} from '@shared/types/session'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types/settings'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { Select, type SelectOption } from '../../components/ui/Select'
import { Switch } from '../../components/ui/Switch'
import { cx } from '../../components/ui/cx'
import { defaultModel, useCodexStore } from '../../stores/codexStore'
import { useGameStore } from '../../stores/gameStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './NewGameDialog.module.css'

/**
 * The dialog that starts a game (spec §4.3).
 *
 * Difficulty is the only choice that has no counterpart in the Codex API: it never changes the
 * model or the effort, only the persona the opponent is asked to play, so the seven options are
 * shown with the Elo they aim at and the effort hint that goes with them (spec §4.1). Model,
 * effort and difficulty are written back to the settings, and are the preselection next time.
 */

export interface NewGameDialogProps {
  open: boolean
  onClose(): void
  onStarted?(state: SessionState): void
}

type ColorChoice = NewGameOptions['userColor']

const COLORS: { value: ColorChoice; key: 'white' | 'black' | 'randomColor' }[] = [
  { value: 'w', key: 'white' },
  { value: 'b', key: 'black' },
  { value: 'random', key: 'randomColor' }
]

const LEVELS: DifficultyLevel[] = [1, 2, 3, 4, 5, 6]

/** Levels 1-3 answer faster with a small effort; level 6 deserves a big one (spec §4.1). */
export function effortHintKey(difficulty: DifficultyChoice): 'hintLowEffort' | 'hintHighEffort' | null {
  if (difficulty.mode === 'adaptive') return difficulty.level <= 3 ? 'hintLowEffort' : null
  if (difficulty.level <= 3) return 'hintLowEffort'
  return difficulty.level === 6 ? 'hintHighEffort' : null
}

/** Effort preselected for `model`: the remembered one, else the model's own default. */
export function preferredEffort(model: ModelInfo, current: string, remembered: string | null): string {
  const ids = model.efforts.map((effort) => effort.id)
  if (ids.includes(current)) return current
  if (remembered && ids.includes(remembered)) return remembered
  if (ids.includes(model.defaultEffort)) return model.defaultEffort
  return ids[0] ?? model.defaultEffort
}

export function NewGameDialog({ open, onClose, onStarted }: NewGameDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const language = useUiStore((state) => state.language)
  const models = useCodexStore((state) => state.models)

  const [settings, setSettings] = useState<Settings | null>(null)
  const [adaptive, setAdaptive] = useState<{ elo: number; games: number } | null>(null)
  const [modelId, setModelId] = useState('')
  const [effort, setEffort] = useState('')
  const [color, setColor] = useState<ColorChoice>('w')
  const [difficulty, setDifficulty] = useState<DifficultyChoice>(DEFAULT_SETTINGS.lastDifficulty)
  const [commentsVisible, setCommentsVisible] = useState(true)
  const [showReasoning, setShowReasoning] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Opening the dialog reloads the remembered choices and the current adaptive rating.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      const api = typeof window === 'undefined' ? undefined : window.api
      const stored = await api?.settings.get().catch(() => null)
      const rating = await api?.game.adaptiveElo().catch(() => null)
      if (cancelled) return
      if (stored) {
        setSettings(stored)
        setDifficulty(stored.lastDifficulty ?? DEFAULT_SETTINGS.lastDifficulty)
        setShowReasoning(stored.showReasoning)
      }
      setAdaptive(rating ?? null)
      setError(null)
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  /*
   * The model list arrives from Codex asynchronously and can change under the dialog, so the
   * selection is derived instead of synchronised: `modelId`/`effort` hold what the user picked,
   * and everything not picked yet falls back to the remembered setting, then to the default.
   */
  const selected = useMemo<ModelInfo | null>(() => {
    if (models.length === 0) return null
    const picked = models.find((model) => model.id === modelId)
    if (picked) return picked
    const remembered = models.find((model) => model.id === settings?.defaultModel)
    return remembered ?? defaultModel(models)
  }, [models, modelId, settings])

  const activeEffort = selected ? preferredEffort(selected, effort, settings?.defaultEffort ?? null) : ''

  const modelOptions: SelectOption[] = models.map((model) => ({
    value: model.id,
    label: model.displayName,
    hint: model.description
  }))
  const effortOptions: SelectOption[] = (selected?.efforts ?? []).map((option) => ({
    value: option.id,
    label: t(`newGame.efforts.${option.id}`, { defaultValue: option.id }),
    hint: option.description
  }))

  const adaptiveCaption = adaptive ? t('difficulty.elo', { elo: adaptive.elo }) : t('difficulty.adaptiveStart')
  const hintKey = effortHintKey(difficulty)

  const start = useCallback(async (): Promise<void> => {
    if (!selected || submitting) return
    const effortId = preferredEffort(selected, effort, settings?.defaultEffort ?? null)
    setSubmitting(true)
    setError(null)
    const base = settings ?? DEFAULT_SETTINGS
    const coach = base.separateCoach
      ? { model: base.coachModel ?? selected.id, effort: base.coachEffort ?? effortId }
      : { model: selected.id, effort: effortId }
    const options: NewGameOptions = {
      userColor: color,
      model: selected.id,
      effort: effortId,
      difficulty,
      coach,
      language,
      showReasoning,
      commentsVisible
    }
    // Remembering the choice must never keep the game from starting.
    try {
      const stored = await window.api?.settings.save({
        defaultModel: selected.id,
        defaultEffort: effortId,
        lastDifficulty: difficulty,
        showReasoning
      })
      if (stored) setSettings(stored)
    } catch {
      /* the settings file is not reachable: play anyway */
    }
    const state = await useGameStore.getState().newGame(options)
    setSubmitting(false)
    if (!state) {
      setError(useGameStore.getState().error ?? t('newGame.failed'))
      return
    }
    onStarted?.(state)
    onClose()
  }, [selected, submitting, settings, effort, color, difficulty, language, showReasoning, commentsVisible, onStarted, onClose, t])

  return (
    <Modal
      open={open}
      title={t('newGame.title')}
      onClose={onClose}
      size="lg"
      footer={
        <div className={styles.footer}>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!selected || submitting} onClick={() => void start()}>
            {submitting ? t('newGame.starting') : t('newGame.start')}
          </Button>
        </div>
      }
    >
      <div className={styles.form}>
        <div className={styles.field}>
          <span className={styles.label} id="new-game-color">
            {t('newGame.color')}
          </span>
          <div className={cx(styles.segmented, styles.colors)} role="radiogroup" aria-labelledby="new-game-color">
            {COLORS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={color === option.value}
                className={cx(styles.option, color === option.value && styles.selected)}
                onClick={() => setColor(option.value)}
              >
                <span className={styles.optionLabel}>{t(`newGame.${option.key}`)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={styles.field}>
          <div className={styles.labelRow}>
            <span className={styles.label}>{t('newGame.model')}</span>
            <span className={styles.hint}>{t('newGame.modelHint')}</span>
          </div>
          <Select
            value={selected?.id ?? ''}
            options={modelOptions}
            onChange={setModelId}
            label={t('newGame.model')}
            disabled={models.length === 0}
          />
        </div>

        <div className={styles.field}>
          <div className={styles.labelRow}>
            <span className={styles.label}>{t('newGame.effort')}</span>
            <span className={styles.hint}>{t('newGame.effortHint')}</span>
          </div>
          <Select
            value={activeEffort}
            options={effortOptions}
            onChange={setEffort}
            label={t('newGame.effort')}
            disabled={effortOptions.length === 0}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.label} id="new-game-difficulty">
            {t('difficulty.title')}
          </span>
          <div
            className={cx(styles.segmented, styles.levels)}
            role="radiogroup"
            aria-labelledby="new-game-difficulty"
          >
            {LEVELS.map((level) => {
              const { key, elo } = DIFFICULTY_LEVELS[level]
              const checked = difficulty.mode === 'fixed' && difficulty.level === level
              return (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  className={cx(styles.option, checked && styles.selected)}
                  onClick={() => setDifficulty({ mode: 'fixed', level })}
                >
                  <span className={styles.optionLabel}>{t(`difficulty.${key}`)}</span>
                  <span className={styles.optionCaption}>
                    {elo === null ? t('difficulty.maxCaption') : t('difficulty.elo', { elo })}
                  </span>
                </button>
              )
            })}
            <button
              type="button"
              role="radio"
              aria-checked={difficulty.mode === 'adaptive'}
              className={cx(styles.option, difficulty.mode === 'adaptive' && styles.selected)}
              onClick={() => setDifficulty({ mode: 'adaptive', level: difficulty.level })}
            >
              <span className={styles.optionLabel}>{t('difficulty.adaptive')}</span>
              <span className={styles.optionCaption}>{adaptiveCaption}</span>
            </button>
          </div>
          <span className={styles.hint}>{t('newGame.difficultyHint')}</span>
          {hintKey ? <span className={styles.hint}>{t(`newGame.${hintKey}`)}</span> : null}
        </div>

        <div className={styles.switches}>
          <Switch
            checked={commentsVisible}
            onChange={setCommentsVisible}
            label={t('newGame.commentsVisible')}
            hint={t('newGame.commentsVisibleHint')}
          />
          <Switch
            checked={showReasoning}
            onChange={setShowReasoning}
            label={t('newGame.showReasoning')}
            hint={t('newGame.showReasoningHint')}
          />
        </div>

        {models.length === 0 ? <p className={styles.warning}>{t('newGame.noModels')}</p> : null}
        {error ? <p className={styles.warning}>{error}</p> : null}
      </div>
    </Modal>
  )
}
