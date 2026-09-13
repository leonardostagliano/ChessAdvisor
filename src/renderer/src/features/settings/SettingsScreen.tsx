import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CodexState, ModelInfo, QuotaWindow } from '@shared/types/codex'
import type { Settings } from '@shared/types/settings'
import { Button } from '../../components/ui/Button'
import { Select, type SelectOption } from '../../components/ui/Select'
import { Switch } from '../../components/ui/Switch'
import { useCodexStore } from '../../stores/codexStore'
import { useEngineStore } from '../../stores/engineStore'
import { useUiStore, type Language, type ThemeChoice } from '../../stores/uiStore'
import screen from '../Screen.module.css'
import styles from './SettingsScreen.module.css'
import { UpdatesSection } from './UpdatesSection'

/**
 * Settings (spec §4.3, §8): appearance, the models a game starts with, the state of the Codex
 * session, the state of the engine, updates and licences.
 *
 * Appearance is the only section the renderer owns: theme and language live in `uiStore`, which
 * mirrors them to the main process. Everything else is a read of state the main process
 * publishes, or a write through `settings.save`.
 */

/** Efforts of `model`, or an empty list while the catalogue has not arrived. */
function effortsOf(models: ModelInfo[], id: string | null): SelectOption[] {
  const model = models.find((entry) => entry.id === id)
  return (model?.efforts ?? []).map((effort) => ({ value: effort.id, label: effort.id, hint: effort.description }))
}

/** Epoch seconds (what the app-server sends) or milliseconds, whichever the number looks like. */
export function quotaResetDate(resetsAt: number): Date | null {
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) return null
  return new Date(resetsAt < 1e12 ? resetsAt * 1000 : resetsAt)
}

function QuotaBar({ window: quota, label }: { window: QuotaWindow; label: string }): React.JSX.Element {
  const percent = Math.max(0, Math.min(100, quota.usedPercent))
  return (
    <div className={styles.quota}>
      <div
        className={styles.quotaTrack}
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={styles.quotaFill} style={{ width: `${percent}%` }} />
      </div>
      <span className={`${styles.quotaValue} mono`}>{`${Math.round(percent)}%`}</span>
    </div>
  )
}

export function SettingsScreen(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const theme = useUiStore((state) => state.theme)
  const setTheme = useUiStore((state) => state.setTheme)
  const language = useUiStore((state) => state.language)
  const setLanguage = useUiStore((state) => state.setLanguage)
  const codex = useCodexStore((state) => state.state)
  const models = useCodexStore((state) => state.models)
  const quota = useCodexStore((state) => state.quota)
  const retryCodex = useCodexStore((state) => state.retry)
  const engine = useEngineStore((state) => state.state)

  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    let alive = true
    const bridge = typeof window === 'undefined' ? undefined : window.api
    if (!bridge) return
    void bridge.settings
      .get()
      .then((value) => {
        if (alive) setSettings(value)
      })
      .catch(() => undefined)
    const unsubscribe = bridge.on('settings:changed', (value) => {
      if (alive) setSettings(value)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const save = useCallback(async (patch: Partial<Settings>): Promise<void> => {
    // Optimistic: the switch and the selects must answer immediately, the file follows.
    setSettings((current) => (current ? { ...current, ...patch } : current))
    try {
      const saved = await window.api?.settings.save(patch)
      if (saved) setSettings(saved)
    } catch {
      /* the settings file is not writable: the UI keeps the choice for this run */
    }
  }, [])

  const themeOptions: SelectOption<ThemeChoice>[] = [
    { value: 'system', label: t('settings.themeSystem') },
    { value: 'night', label: t('settings.themeNight') },
    { value: 'editorial', label: t('settings.themeEditorial') }
  ]
  const languageOptions: SelectOption<Language>[] = [
    { value: 'it', label: t('settings.languageIt') },
    { value: 'en', label: t('settings.languageEn') }
  ]
  const modelOptions: SelectOption[] = models.map((model) => ({
    value: model.id,
    label: model.displayName,
    hint: model.description
  }))

  const ready = codex.status === 'ready' ? (codex as Extract<CodexState, { status: 'ready' }>) : null
  const separateCoach = settings?.separateCoach ?? false
  const defaultEfforts = effortsOf(models, settings?.defaultModel ?? null)
  const coachEfforts = effortsOf(models, settings?.coachModel ?? settings?.defaultModel ?? null)
  const resetDate = quota?.primary ? quotaResetDate(quota.primary.resetsAt) : null

  return (
    <div className={screen.screen}>
      <header className={screen.header}>
        <p className="eyebrow">{t('rail.settings')}</p>
        <h1 className={screen.title}>{t('settings.title')}</h1>
        <p className={screen.subtitle}>{t('settings.subtitle')}</p>
      </header>

      <section className={screen.card}>
        <h2 className={screen.cardTitle}>{t('settings.appearance')}</h2>

        <div className={screen.field}>
          <span className={screen.fieldTexts}>
            <span className={screen.fieldLabel}>{t('settings.theme')}</span>
            <span className={screen.fieldHint}>{t('settings.themeHint')}</span>
          </span>
          <Select<ThemeChoice> value={theme} options={themeOptions} onChange={setTheme} label={t('settings.theme')} />
        </div>

        <div className={screen.field}>
          <span className={screen.fieldTexts}>
            <span className={screen.fieldLabel}>{t('settings.language')}</span>
            <span className={screen.fieldHint}>{t('settings.languageHint')}</span>
          </span>
          <Select<Language> value={language} options={languageOptions} onChange={setLanguage} label={t('settings.language')} />
        </div>
      </section>

      <section className={screen.card}>
        <h2 className={screen.cardTitle}>{t('settings.models')}</h2>
        <p className={screen.subtitle}>{t('settings.modelsHint')}</p>

        <div className={screen.field}>
          <span className={screen.fieldTexts}>
            <span className={screen.fieldLabel}>{t('settings.defaultModel')}</span>
            <span className={screen.fieldHint}>{t('settings.defaultModelHint')}</span>
          </span>
          <Select
            value={settings?.defaultModel ?? ''}
            options={modelOptions}
            onChange={(value) => void save({ defaultModel: value })}
            label={t('settings.defaultModel')}
            disabled={modelOptions.length === 0}
          />
        </div>

        <div className={screen.field}>
          <span className={screen.fieldTexts}>
            <span className={screen.fieldLabel}>{t('settings.defaultEffort')}</span>
            <span className={screen.fieldHint}>{t('settings.defaultEffortHint')}</span>
          </span>
          <Select
            value={settings?.defaultEffort ?? ''}
            options={defaultEfforts}
            onChange={(value) => void save({ defaultEffort: value })}
            label={t('settings.defaultEffort')}
            disabled={defaultEfforts.length === 0}
          />
        </div>

        <Switch
          checked={separateCoach}
          label={t('settings.separateCoach')}
          hint={t('settings.separateCoachHint')}
          onChange={(checked) => void save({ separateCoach: checked })}
        />

        {separateCoach ? (
          <>
            <div className={screen.field}>
              <span className={screen.fieldTexts}>
                <span className={screen.fieldLabel}>{t('settings.coachModel')}</span>
              </span>
              <Select
                value={settings?.coachModel ?? settings?.defaultModel ?? ''}
                options={modelOptions}
                onChange={(value) => void save({ coachModel: value })}
                label={t('settings.coachModel')}
                disabled={modelOptions.length === 0}
              />
            </div>
            <div className={screen.field}>
              <span className={screen.fieldTexts}>
                <span className={screen.fieldLabel}>{t('settings.coachEffort')}</span>
              </span>
              <Select
                value={settings?.coachEffort ?? settings?.defaultEffort ?? ''}
                options={coachEfforts}
                onChange={(value) => void save({ coachEffort: value })}
                label={t('settings.coachEffort')}
                disabled={coachEfforts.length === 0}
              />
            </div>
          </>
        ) : null}
      </section>

      <section className={screen.card}>
        <h2 className={screen.cardTitle}>{t('settings.codex')}</h2>
        <p className={screen.subtitle}>{t('settings.codexHint')}</p>

        <dl className={styles.grid}>
          <dt className={styles.term}>{t('settings.codexStatus')}</dt>
          <dd className={styles.value}>{statusLabel(codex, t)}</dd>
          <dt className={styles.term}>{t('settings.codexAccount')}</dt>
          <dd className={`${styles.value} selectable`}>{ready?.account.email ?? t('settings.unknown')}</dd>
          <dt className={styles.term}>{t('settings.codexPlan')}</dt>
          <dd className={styles.value}>{ready?.account.planType ?? quota?.planType ?? t('settings.unknown')}</dd>
          <dt className={styles.term}>{t('settings.codexCliVersion')}</dt>
          <dd className={`${styles.value} mono selectable`}>{ready?.cliVersion ?? t('settings.unknown')}</dd>
        </dl>

        {ready?.versionMismatch ? (
          <p className={styles.warning} role="status">
            {t('settings.codexMismatch')}
          </p>
        ) : null}

        <div className={styles.quotaBlock}>
          <span className={screen.fieldLabel}>{t('settings.codexQuota')}</span>
          {quota?.primary ? (
            <>
              <QuotaBar window={quota.primary} label={t('settings.codexQuota')} />
              <span className={screen.fieldHint}>
                {t('settings.codexQuotaUsed', { percent: Math.round(quota.primary.usedPercent) })}
                {resetDate ? ` · ${t('settings.codexQuotaReset', { date: resetDate.toLocaleString(i18n.language) })}` : ''}
              </span>
            </>
          ) : (
            <span className={screen.fieldHint}>{t('settings.codexQuotaUnknown')}</span>
          )}
          {quota && !quota.ordinaryUsageAllowed ? (
            <p className={styles.warning} role="status">
              {t('settings.codexBlocked')}
            </p>
          ) : null}
        </div>

        <div className={styles.actions}>
          <Button onClick={() => void retryCodex()}>{t('common.retry')}</Button>
        </div>
      </section>

      <section className={screen.card}>
        <h2 className={screen.cardTitle}>{t('settings.engine')}</h2>
        <p className={screen.subtitle}>{t('settings.engineHint')}</p>

        <dl className={styles.grid}>
          <dt className={styles.term}>{t('settings.engineState')}</dt>
          <dd className={styles.value}>{engine.available ? t('settings.engineAvailable') : t('settings.engineUnavailable')}</dd>
          <dt className={styles.term}>{t('settings.engineBinary')}</dt>
          <dd className={`${styles.value} mono`}>{engine.binary}</dd>
          <dt className={styles.term}>{t('settings.engineVersion')}</dt>
          <dd className={`${styles.value} mono selectable`}>{engine.version ?? t('settings.unknown')}</dd>
        </dl>

        {engine.message ? <p className={screen.fieldHint}>{engine.message}</p> : null}
        {!engine.available ? (
          <p className={styles.warning} role="status">
            {t('settings.engineNote')}
          </p>
        ) : null}
      </section>

      {/* Task 5: updates, version identity and licences. */}
      <UpdatesSection />
    </div>
  )
}

/** One short label per Codex state, so the section reads even while the session is not ready. */
function statusLabel(state: CodexState, t: (key: string) => string): string {
  switch (state.status) {
    case 'ready':
      return t('codexStatus.ready')
    case 'starting':
      return t('codexStatus.starting.label')
    case 'not-installed':
      return t('codexStatus.notInstalled.label')
    case 'not-authenticated':
      return t('codexStatus.notAuthenticated.label')
    case 'not-isolated':
      return t('codexStatus.notIsolated.label')
    default:
      return t('codexStatus.crashed.label')
  }
}
