import { useTranslation } from 'react-i18next'
import { Board } from '../../board/Board'
import { Button } from '../../components/ui/Button'
import styles from './PlayScreen.module.css'

const PREVIEW_FEN = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 5 4'

export interface PlayHomeProps {
  onNewGame(): void
  onArchive(): void
}

/** The play landing screen is a real board invitation, not a generic empty-state card. */
export function PlayHome({ onNewGame, onArchive }: PlayHomeProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <section className={styles.home} aria-labelledby="play-home-title">
      <div className={styles.homeCopy}>
        <p className={styles.homeEyebrow}>{t('play.homeEyebrow')}</p>
        <h2 className={styles.homeTitle} id="play-home-title">
          {t('play.noGameTitle')}
        </h2>
        <p className={styles.homeBody}>{t('play.noGameBody')}</p>

        <div className={styles.homeActions}>
          <Button variant="primary" onClick={onNewGame}>
            {t('controls.newGame')}
          </Button>
          <Button variant="ghost" onClick={onArchive}>
            {t('play.tabArchive')}
          </Button>
        </div>

        <ol className={styles.homeSequence} aria-label={t('play.homeSequence')}>
          <li>
            <span className={styles.homeStep}>01</span>
            <span>
              <strong>{t('play.homeChooseTitle')}</strong>
              <small>{t('play.homeChooseBody')}</small>
            </span>
          </li>
          <li>
            <span className={styles.homeStep}>02</span>
            <span>
              <strong>{t('play.homeThinkTitle')}</strong>
              <small>{t('play.homeThinkBody')}</small>
            </span>
          </li>
          <li>
            <span className={styles.homeStep}>03</span>
            <span>
              <strong>{t('play.homeLearnTitle')}</strong>
              <small>{t('play.homeLearnBody')}</small>
            </span>
          </li>
        </ol>
      </div>

      <div className={styles.homeBoard}>
        <div className={styles.homeBoardHead}>
          <span>{t('play.previewTitle')}</span>
          <span className="mono">4. O-O</span>
        </div>
        <div className={styles.homeBoardFrame}>
          <Board
            fen={PREVIEW_FEN}
            lastMove={['e1', 'g1']}
            viewOnly
            label={t('play.previewBoard')}
          />
        </div>
        <p className={styles.homeBoardCaption}>{t('play.previewCaption')}</p>
      </div>
    </section>
  )
}
