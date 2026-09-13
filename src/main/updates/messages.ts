import type { Language } from '@shared/types/settings'
import { UPDATE_REPOSITORY } from './source'

/**
 * Main-side i18n for the updater. The renderer shows `UpdateStatus.message` verbatim,
 * so the strings must already be in the language the user picked in Settings.
 */

const it = {
  // transport
  accessPrefix: (status: number, detail: string) =>
    `GitHub ha rifiutato l’accesso alle release (HTTP ${status}). ${detail}`,
  rateLimit: (status: number) =>
    `GitHub ha limitato le richieste (HTTP ${status}). Attendi prima di verificare nuovamente.`,
  accessCredentials:
    'La sessione GitHub dell’app non è valida o è scaduta. Premi “Collega GitHub e controlla” per accedere nuovamente.',
  accessNotFound: `Il repository ${UPDATE_REPOSITORY} o la release richiesta non è visibile alla credenziale usata. Verifica che l’account collegato abbia accesso a questo repository.`,
  accessSso:
    'GitHub richiede l’autorizzazione SSO della credenziale per l’organizzazione. Autorizzala nelle impostazioni GitHub e ripeti il controllo.',
  accessOauthPolicy:
    'L’organizzazione limita l’accesso delle applicazioni OAuth. Richiedi l’approvazione di Git Credential Manager per l’account collegato dall’app.',
  accessPermissions:
    'La sessione collegata non dispone dei permessi richiesti. Verifica che l’account sia autorizzato a leggere il repository degli aggiornamenti.',
  accessForbidden:
    'La richiesta è stata negata. Verifica i permessi sul repository e le eventuali restrizioni dell’organizzazione per l’account o il token usato.',
  httpFailed: (status: number) =>
    `GitHub non ha completato la richiesta di aggiornamento (HTTP ${status}).`,
  urlNotAllowed: 'La release contiene un indirizzo di download non consentito.',
  redirectWithoutTarget: 'Redirect della release privo di destinazione.',
  redirectInvalid: 'Redirect della release non valido.',
  requestTimeout: 'Richiesta aggiornamento interrotta o tempo massimo superato.',
  networkUnreachable: 'Impossibile raggiungere GitHub. Verifica l’accesso HTTPS dalla rete in uso.',
  transferIncomplete: 'Il trasferimento dell’aggiornamento non è stato completato.',
  responseTooLarge: 'Risposta GitHub troppo grande.',
  metadataInvalid: 'GitHub ha restituito metadati della release non validi.',
  installerSizeMismatch: 'La dimensione dell’installer non corrisponde alla release.',
  installerTooLarge: 'L’installer supera la dimensione prevista.',
  installerWriteFailed: 'Impossibile scrivere l’installer sul disco locale.',
  installerIncomplete: 'Download dell’installer incompleto.',

  // service
  initial: 'Verifica le release pubblicate del repository di questa applicazione.',
  checksumManifestInvalid: 'Manifest checksum della release non valido.',
  localInstallerChanged: 'L’installer locale è cambiato: scaricalo nuovamente.',
  localVerifyTimeout: 'Verifica locale dell’installer scaduta.',
  localSizeChanged: 'La dimensione dell’installer locale è cambiata.',
  localIncomplete: 'L’installer locale è incompleto.',
  busyAuth: 'Completa prima il collegamento GitHub in corso.',
  busyUpdate: 'Un aggiornamento è già in corso.',
  busyOperation: 'Un’operazione di aggiornamento è già in corso.',
  busyGame:
    'Un turno della partita è in corso: attendi la mossa dell’avversario prima di installare l’aggiornamento.',
  preferenceInvalid: 'Preferenza aggiornamenti non valida.',
  preferenceSaveFailed: 'Impossibile salvare la preferenza degli aggiornamenti.',
  closing: 'L’applicazione si sta chiudendo.',
  genericFailure:
    'Operazione di aggiornamento non completata. Riprova dopo aver verificato rete e spazio disponibile.',
  authRequired:
    'Premi “Collega GitHub e controlla” e accedi con l’account che vede il repository degli aggiornamenti.',
  authRequiredUnreadable:
    'La sessione GitHub salvata dall’app non è leggibile. Premi “Collega GitHub e controlla” per accedere nuovamente.',
  linkedAccount: (account: string) => ` Account collegato dall’app: ${account}.`,
  authInProgress:
    'Collegamento GitHub in corso. Nel browser scegli l’account che vede il repository e, se richiesto, completa login e autorizzazione.',
  authSaving: 'Account GitHub individuato. Salvataggio del collegamento…',
  authCancelledNotice: 'Collegamento GitHub annullato. Puoi riprovare quando vuoi.',
  versionUnstable:
    'La versione corrente non ha una base SemVer stabile: usa un checkout con tag di release o una release ufficiale.',
  checking: 'Verifica delle release GitHub in corso…',
  releaseListInvalid: 'Elenco release GitHub non valido.',
  noRelease: 'Nessuna release stabile con installer Windows x64 compatibile è disponibile.',
  upToDateDev: (base: string, latest: string) =>
    `Versione di sviluppo con base ${base}. Ultima release stabile disponibile: ${latest}.`,
  upToDate: 'Questa applicazione è già aggiornata rispetto alle release stabili disponibili.',
  available: (version: string, suffix: string) => `Disponibile la versione ${version}.${suffix}`,
  suffixDevelopment: ' Download e installazione sono disponibili nella versione installata.',
  suffixPortable:
    ' Per la versione portable usa la pagina della release e sostituisci manualmente l’eseguibile.',
  suffixUnsupported: ' Installazione integrata disponibile solo su Windows x64.',
  suffixNoChecksum: ' La release non pubblica un checksum di confronto.',
  downloadState: 'Verifica prima una nuova release dalla versione Windows x64 installata.',
  downloading: 'Download dell’installer in corso…',
  checksumNotUnique:
    'Il manifest SHA256SUMS non contiene un checksum univoco per questo installer.',
  checksumConflict: 'I checksum pubblicati da GitHub e SHA256SUMS non coincidono.',
  integrityMismatch:
    'Checksum SHA-256 non corrispondente: installer eliminato, installazione annullata.',
  notWindowsExecutable: 'Il download non è un eseguibile Windows valido.',
  downloadedVerified:
    'Installer scaricato e SHA-256 verificato. Installa quando sei pronto a riavviare l’app.',
  downloadedUnverified:
    'Installer scaricato via HTTPS. La release non pubblica checksum: integrità confrontabile solo con il file locale scaricato.',
  installState: 'Scarica prima l’installer dalla versione Windows x64 installata.',
  notNewer: 'La release scaricata non è più recente della versione corrente.',
  integrityChangedLocally:
    'L’installer locale è cambiato: installazione annullata. Scaricalo nuovamente.',
  finalVerification: 'Verifica finale dell’installer…',
  installerNotStarted:
    'Windows non ha avviato l’installer. Verifica autorizzazioni e protezione del sistema.',
  installStarted:
    'Aggiornamento avviato. L’app si chiude e viene riaperta dall’installer al termine; partite e impostazioni vengono conservate.',
  releaseChanged: 'La release è cambiata dopo la verifica. Controlla nuovamente gli aggiornamenti.',
  browserFailed: 'Impossibile aprire la pagina GitHub nel browser di sistema.',

  // credentials
  authCancelled: 'Collegamento GitHub interrotto.',
  authPlatform: 'Il collegamento GitHub integrato richiede Git Credential Manager per Windows.',
  authStorageUnavailable:
    'La protezione della sessione GitHub non è disponibile su questo PC. Il collegamento non può essere salvato.',
  gcmMissing:
    'Git Credential Manager non disponibile. Installa Git for Windows con Git Credential Manager e riprova.',
  authTimeout:
    'Il collegamento GitHub non è terminato entro tre minuti. Ripeti il collegamento e completa login e autorizzazione nel browser.',
  authSpawnFailed:
    'Windows non ha avviato Git Credential Manager. Verifica l’installazione di Git for Windows.',
  authProcessFailed: (code: number | undefined) =>
    `Git Credential Manager ha interrotto il collegamento${code === undefined ? '.' : ` (codice ${code}).`} Ripeti il collegamento e completa l’autorizzazione GitHub nel browser.`,
  authCredentialInvalid: (detail: string) =>
    `Git Credential Manager ha concluso il comando senza restituire una sessione valida. ${detail}`,
  detailMissingAccount: 'Manca un nome account valido nella risposta OAuth.',
  detailMissingToken: 'Manca un token valido nella risposta OAuth.',
  detailInvalidScope: 'La risposta non corrisponde all’accesso HTTPS a GitHub.',
  detailOversize: 'La risposta OAuth supera la dimensione consentita.',
  authSaveFailed:
    'Accesso GitHub completato, ma non è stato possibile salvare la sessione cifrata dell’app. Verifica che la cartella dati dell’app sia scrivibile.'
}

type UpdateMessages = typeof it

const en: UpdateMessages = {
  accessPrefix: (status, detail) =>
    `GitHub refused access to the releases (HTTP ${status}). ${detail}`,
  rateLimit: (status) =>
    `GitHub rate-limited the request (HTTP ${status}). Wait before checking again.`,
  accessCredentials:
    'The app’s GitHub session is invalid or expired. Press “Connect GitHub and check” to sign in again.',
  accessNotFound: `The repository ${UPDATE_REPOSITORY} or the requested release is not visible to the credential in use. Make sure the connected account can access this repository.`,
  accessSso:
    'GitHub requires SSO authorisation of the credential for the organisation. Authorise it in your GitHub settings and check again.',
  accessOauthPolicy:
    'The organisation restricts OAuth application access. Request approval of Git Credential Manager for the account connected by the app.',
  accessPermissions:
    'The connected session lacks the required permissions. Make sure the account may read the updates repository.',
  accessForbidden:
    'The request was denied. Check the repository permissions and any organisation restrictions for the account or token in use.',
  httpFailed: (status) => `GitHub did not complete the update request (HTTP ${status}).`,
  urlNotAllowed: 'The release contains a download address that is not allowed.',
  redirectWithoutTarget: 'The release redirect has no destination.',
  redirectInvalid: 'The release redirect is not valid.',
  requestTimeout: 'The update request was interrupted or exceeded the time limit.',
  networkUnreachable: 'GitHub is unreachable. Check HTTPS access from this network.',
  transferIncomplete: 'The update transfer did not complete.',
  responseTooLarge: 'The GitHub response is too large.',
  metadataInvalid: 'GitHub returned invalid release metadata.',
  installerSizeMismatch: 'The installer size does not match the release.',
  installerTooLarge: 'The installer exceeds the expected size.',
  installerWriteFailed: 'The installer could not be written to the local disk.',
  installerIncomplete: 'The installer download is incomplete.',

  initial: 'Check the published releases of this application’s repository.',
  checksumManifestInvalid: 'The release checksum manifest is not valid.',
  localInstallerChanged: 'The local installer changed: download it again.',
  localVerifyTimeout: 'Local verification of the installer timed out.',
  localSizeChanged: 'The size of the local installer changed.',
  localIncomplete: 'The local installer is incomplete.',
  busyAuth: 'Finish the GitHub connection in progress first.',
  busyUpdate: 'An update is already in progress.',
  busyOperation: 'An update operation is already in progress.',
  busyGame:
    'A game turn is in progress: wait for the opponent’s move before installing the update.',
  preferenceInvalid: 'Invalid update preference.',
  preferenceSaveFailed: 'The update preference could not be saved.',
  closing: 'The application is shutting down.',
  genericFailure:
    'The update operation did not complete. Try again after checking the network and available disk space.',
  authRequired:
    'Press “Connect GitHub and check” and sign in with the account that can see the updates repository.',
  authRequiredUnreadable:
    'The GitHub session saved by the app cannot be read. Press “Connect GitHub and check” to sign in again.',
  linkedAccount: (account) => ` Account connected by the app: ${account}.`,
  authInProgress:
    'Connecting to GitHub. In the browser pick the account that can see the repository and, if asked, complete sign-in and authorisation.',
  authSaving: 'GitHub account found. Saving the connection…',
  authCancelledNotice: 'GitHub connection cancelled. You can try again whenever you like.',
  versionUnstable:
    'The current version has no stable SemVer base: use a checkout on a release tag or an official release.',
  checking: 'Checking the GitHub releases…',
  releaseListInvalid: 'The GitHub release list is not valid.',
  noRelease: 'No stable release with a compatible Windows x64 installer is available.',
  upToDateDev: (base, latest) =>
    `Development build based on ${base}. Latest stable release available: ${latest}.`,
  upToDate: 'This application is already up to date with the available stable releases.',
  available: (version, suffix) => `Version ${version} is available.${suffix}`,
  suffixDevelopment: ' Download and installation are available in the installed build.',
  suffixPortable:
    ' For the portable build use the release page and replace the executable manually.',
  suffixUnsupported: ' Built-in installation is available on Windows x64 only.',
  suffixNoChecksum: ' The release publishes no checksum to compare against.',
  downloadState: 'Check for a new release from the installed Windows x64 build first.',
  downloading: 'Downloading the installer…',
  checksumNotUnique: 'The SHA256SUMS manifest has no unique checksum for this installer.',
  checksumConflict: 'The checksums published by GitHub and by SHA256SUMS do not match.',
  integrityMismatch:
    'SHA-256 checksum mismatch: the installer was deleted and the installation cancelled.',
  notWindowsExecutable: 'The download is not a valid Windows executable.',
  downloadedVerified:
    'Installer downloaded and SHA-256 verified. Install when you are ready to restart the app.',
  downloadedUnverified:
    'Installer downloaded over HTTPS. The release publishes no checksum: integrity can only be compared with the downloaded local file.',
  installState: 'Download the installer from the installed Windows x64 build first.',
  notNewer: 'The downloaded release is not newer than the current version.',
  integrityChangedLocally:
    'The local installer changed: installation cancelled. Download it again.',
  finalVerification: 'Final verification of the installer…',
  installerNotStarted:
    'Windows did not start the installer. Check permissions and system protection.',
  installStarted:
    'Update started. The app closes and is reopened by the installer when it finishes; games and settings are preserved.',
  releaseChanged: 'The release changed after the check. Check for updates again.',
  browserFailed: 'The GitHub page could not be opened in the system browser.',

  authCancelled: 'GitHub connection interrupted.',
  authPlatform: 'The built-in GitHub connection requires Git Credential Manager for Windows.',
  authStorageUnavailable:
    'Protection of the GitHub session is unavailable on this PC. The connection cannot be saved.',
  gcmMissing:
    'Git Credential Manager is unavailable. Install Git for Windows with Git Credential Manager and try again.',
  authTimeout:
    'The GitHub connection did not finish within three minutes. Connect again and complete sign-in and authorisation in the browser.',
  authSpawnFailed:
    'Windows did not start Git Credential Manager. Check the Git for Windows installation.',
  authProcessFailed: (code) =>
    `Git Credential Manager interrupted the connection${code === undefined ? '.' : ` (exit code ${code}).`} Connect again and complete the GitHub authorisation in the browser.`,
  authCredentialInvalid: (detail) =>
    `Git Credential Manager ended the command without returning a valid session. ${detail}`,
  detailMissingAccount: 'The OAuth response has no valid account name.',
  detailMissingToken: 'The OAuth response has no valid token.',
  detailInvalidScope: 'The response does not match HTTPS access to GitHub.',
  detailOversize: 'The OAuth response exceeds the allowed size.',
  authSaveFailed:
    'GitHub sign-in completed, but the app’s encrypted session could not be saved. Check that the app data folder is writable.'
}

const CATALOG: Record<Language, UpdateMessages> = { it, en }

let current: Language = 'it'

/** Called by `register.ts` at boot and on every settings change. */
export function setUpdatesLanguage(language: Language): void {
  if (language === 'it' || language === 'en') current = language
}

export function updatesLanguage(): Language {
  return current
}

/** Message catalogue for the language currently selected in Settings. */
export function m(): UpdateMessages {
  return CATALOG[current]
}
