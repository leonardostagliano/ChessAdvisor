import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelInfo } from '@shared/types/codex'
import {
  DIFFICULTY_LEVELS,
  type ClockConfig,
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
 *
 * The clock is the other choice with a consequence the user cannot see: giving the AI a clock on
 * a short time control while the model thinks hard is a game it will probably lose on time, so
 * that combination is not started silently (spec §4.3).
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

export type ClockPresetId = 'none' | '5+0' | '10+0' | '15+10' | 'custom'

/** The presets of spec §4.3; `custom` takes its numbers from the two inputs next to it. */
export const CLOCK_PRESETS: { id: ClockPresetId; minutes?: number; increment?: number }[] = [
  { id: 'none' },
  { id: '5+0', minutes: 5, increment: 0 },
  { id: '10+0', minutes: 10, increment: 0 },
  { id: '15+10', minutes: 15, increment: 10 },
  { id: 'custom' }
]

/** Efforts the models spend real minutes on; the warning of spec §4.3 is about these. */
const HIGH_EFFORTS = ['high', 'xhigh', 'ultra']
const SHORT_INITIAL_MS = [5 * 60_000, 10 * 60_000]
export const MAX_CLOCK_MINUTES = 180
export const MAX_INCREMENT_SECONDS = 180

/** The clock the dialog asks for, or `null` for "Nessuno" — which is the default. */
export function clockOf(preset: ClockPresetId, minutes: number, increment: number, aiClock: boolean): ClockConfig | null {
  if (preset === 'none') return null
  const chosen = CLOCK_PRESETS.find((entry) => entry.id === preset)
  const min = chosen?.minutes ?? minutes
  const inc = chosen?.increment ?? increment
  if (!Number.isFinite(min) || min <= 0) return null
  return {
    initialMs: Math.round(Math.min(Math.max(min, 1), MAX_CLOCK_MINUTES) * 60_000),
    incrementMs: Math.round(Math.min(Math.max(Number.isFinite(inc) ? inc : 0, 0), MAX_INCREMENT_SECONDS) * 1000),
    aiClock
  }
}

/**
 * Spec §4.3: with a clock on the AI, a high effort and a 5+0 or 10+0 time control the user has to
 * choose explicitly, because the model will very likely lose on time while it reasons.
 */
export function needsClockWarning(clock: ClockConfig | null, effort: string): boolean {
  if (!clock || !clock.aiClock) return false
  if (!HIGH_EFFORTS.includes(effort)) return false
  return clock.incrementMs === 0 && SHORT_INITIAL_MS.includes(clock.initialMs)
}

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

export interface SegmentOption {
  /** Stable React key and test handle. */
  id: string
  label: string
  caption?: string
  checked: boolean
  onSelect(): void
}

export interface SegmentedRadioGroupProps {
  options: SegmentOption[]
  /** Id of the element that names the group. */
  labelledBy: string
  className?: string
}

/**
 * A segmented control that behaves like a real radio group: one Tab stop into the group and the
 * arrow keys move (and check) the selection, the way the ARIA authoring practices describe it and
 * the way the Select primitive already handles its own list.
 */
export function SegmentedRadioGroup({
  options,
  labelledBy,
  className
}: SegmentedRadioGroupProps): React.JSX.Element {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const checkedIndex = options.findIndex((option) => option.checked)
  // Nothing checked yet: the first option carries the Tab stop, as the pattern prescribes.
  const tabIndexOf = checkedIndex < 0 ? 0 : checkedIndex

  const select = (index: number): void => {
    const option = options[index]
    if (!option) return
    option.onSelect()
    buttons.current[index]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (options.length === 0) return
    const from = tabIndexOf
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault()
        select((from + 1) % options.length)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault()
        select((from - 1 + options.length) % options.length)
        break
      case 'Home':
        event.preventDefault()
        select(0)
        break
      case 'End':
        event.preventDefault()
        select(options.length - 1)
        break
      default:
        break
    }
  }

  return (
    <div className={className} role="radiogroup" aria-labelledby={labelledBy} onKeyDown={onKeyDown}>
      {options.map((option, index) => (
        <button
          key={option.id}
          ref={(node) => {
            buttons.current[index] = node
          }}
          type="button"
          role="radio"
          aria-checked={option.checked}
          tabIndex={index === tabIndexOf ? 0 : -1}
          className={cx(styles.option, option.checked && styles.selected)}
          onClick={() => option.onSelect()}
        >
          <span className={styles.optionLabel}>{option.label}</span>
          {option.caption ? <span className={styles.optionCaption}>{option.caption}</span> : null}
        </button>
      ))}
    </div>
  )
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
  const [clockPreset, setClockPreset] = useState<ClockPresetId>('none')
  const [customMinutes, setCustomMinutes] = useState(10)
  const [customIncrement, setCustomIncrement] = useState(5)
  const [aiClock, setAiClock] = useState(false)
  const [warning, setWarning] = useState<NewGameOptions | null>(null)
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
      setWarning(null)
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
  const clock = clockOf(clockPreset, customMinutes, customIncrement, aiClock)
  const clockLabel = (preset: { id: ClockPresetId; minutes?: number; increment?: number }): string => {
    if (preset.id === 'none') return t('clock.none')
    if (preset.id === 'custom') return t('clock.custom')
    return t('clock.preset', { minutes: preset.minutes ?? 0, increment: preset.increment ?? 0 })
  }

  // Six fixed personas plus the adaptive one: the seven options of spec §4.1, in that order.
  const difficultyOptions: SegmentOption[] = [
    ...LEVELS.map((level) => {
      const { key, elo } = DIFFICULTY_LEVELS[level]
      return {
        id: `level-${level}`,
        label: t(`difficulty.${key}`),
        caption: elo === null ? t('difficulty.maxCaption') : t('difficulty.elo', { elo }),
        checked: difficulty.mode === 'fixed' && difficulty.level === level,
        onSelect: () => setDifficulty({ mode: 'fixed', level })
      }
    }),
    {
      id: 'adaptive',
      label: t('difficulty.adaptive'),
      caption: adaptiveCaption,
      checked: difficulty.mode === 'adaptive',
      onSelect: () => setDifficulty((current) => ({ mode: 'adaptive', level: current.level }))
    }
  ]

  const launch = useCallback(async (options: NewGameOptions): Promise<void> => {
    setWarning(null)
    setSubmitting(true)
    setError(null)
    // Remembering the choice must never keep the game from starting.
    try {
      const stored = await window.api?.settings.save({
        defaultModel: options.model,
        defaultEffort: options.effort,
        lastDifficulty: options.difficulty,
        showReasoning: options.showReasoning
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
  }, [onStarted, onClose, t])

  const start = useCallback((): void => {
    if (!selected || submitting) return
    const effortId = preferredEffort(selected, effort, settings?.defaultEffort ?? null)
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
      commentsVisible,
      clock
    }
    // Two explicit choices, never a silent start (spec §4.3).
    if (needsClockWarning(clock, effortId)) {
      setWarning(options)
      return
    }
    void launch(options)
  }, [selected, submitting, settings, effort, color, difficulty, language, showReasoning, commentsVisible, clock, launch])

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
          <Button variant="primary" disabled={!selected || submitting} onClick={() => start()}>
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
          <SegmentedRadioGroup
            className={cx(styles.segmented, styles.colors)}
            labelledBy="new-game-color"
            options={COLORS.map((option) => ({
              id: option.value,
              label: t(`newGame.${option.key}`),
              checked: color === option.value,
              onSelect: () => setColor(option.value)
            }))}
          />
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
          <SegmentedRadioGroup
            className={cx(styles.segmented, styles.levels)}
            labelledBy="new-game-difficulty"
            options={difficultyOptions}
          />
          <span className={styles.hint}>{t('newGame.difficultyHint')}</span>
          {hintKey ? <span className={styles.hint}>{t(`newGame.${hintKey}`)}</span> : null}
        </div>

        <div className={styles.field}>
          <div className={styles.labelRow}>
            <span className={styles.label} id="new-game-clock">
              {t('clock.title')}
            </span>
            <span className={styles.hint}>{t('clock.hint')}</span>
          </div>
          <SegmentedRadioGroup
            className={cx(styles.segmented, styles.clocks)}
            labelledBy="new-game-clock"
            options={CLOCK_PRESETS.map((preset) => ({
              id: preset.id,
              label: clockLabel(preset),
              checked: clockPreset === preset.id,
              onSelect: () => setClockPreset(preset.id)
            }))}
          />
          {clockPreset === 'custom' ? (
            <div className={styles.customClock}>
              <label className={styles.numberField}>
                <span className={styles.hint}>{t('clock.minutes')}</span>
                <input
                  type="number"
                  className={styles.number}
                  min={1}
                  max={MAX_CLOCK_MINUTES}
                  value={customMinutes}
                  onChange={(event) => setCustomMinutes(Number(event.target.value))}
                />
              </label>
              <label className={styles.numberField}>
                <span className={styles.hint}>{t('clock.increment')}</span>
                <input
                  type="number"
                  className={styles.number}
                  min={0}
                  max={MAX_INCREMENT_SECONDS}
                  value={customIncrement}
                  onChange={(event) => setCustomIncrement(Number(event.target.value))}
                />
              </label>
            </div>
          ) : null}
          {clockPreset !== 'none' ? (
            <>
              <span className={styles.label} id="new-game-clock-mode">
                {t('clock.mode')}
              </span>
              <SegmentedRadioGroup
                className={cx(styles.segmented, styles.colors)}
                labelledBy="new-game-clock-mode"
                options={[
                  {
                    id: 'mine',
                    label: t('clock.mineOnly'),
                    checked: !aiClock,
                    onSelect: () => setAiClock(false)
                  },
                  {
                    id: 'both',
                    label: t('clock.alsoAi'),
                    checked: aiClock,
                    onSelect: () => setAiClock(true)
                  }
                ]}
              />
              <span className={styles.hint}>{t('clock.modeHint')}</span>
            </>
          ) : null}
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

      {/* Spec §4.3: the two choices are the only way out of this dialog — closing it goes back to
          the form, so no game ever starts without one of them being picked. */}
      <Modal
        open={!!warning}
        size="sm"
        title={t('clock.warningTitle')}
        closeOnBackdrop={false}
        onClose={() => setWarning(null)}
        footer={
          <div className={styles.footer}>
            <Button
              variant="primary"
              onClick={() => {
                setAiClock(false)
                if (warning) void launch({ ...warning, clock: warning.clock ? { ...warning.clock, aiClock: false } : null })
              }}
            >
              {t('clock.warningKeepMine')}
            </Button>
            <Button
              onClick={() => {
                if (warning) void launch(warning)
              }}
            >
              {t('clock.warningContinue')}
            </Button>
          </div>
        }
      >
        <p>
          {t('clock.warningBody', {
            preset: warning?.clock
              ? t('clock.preset', {
                  minutes: Math.round(warning.clock.initialMs / 60_000),
                  increment: Math.round(warning.clock.incrementMs / 1000)
                })
              : '',
            effort: t(`newGame.efforts.${warning?.effort ?? ''}`, { defaultValue: warning?.effort ?? '' })
          })}
        </p>
      </Modal>
    </Modal>
  )
}
