# Taratura della difficoltà con partite umane

> Documento della ricerca iniziale. L'implementazione in 0.2.2, il campione e i risultati sono descritti in [Chess.com Rapid difficulty pilot](rapid-calibration-results.md).

Ricerca del 22 settembre 2026, riferita a ChessAdvisor 0.2.1. Richiesta: verificare e migliorare la taratura e i pattern di gioco di **tutti i livelli di difficoltà**. Il confronto con giocatori da 900 su Chess.com è un esempio del problema, non il limite dell'indagine.

Riferimento confermato dall'utente: **Rapid su Chess.com (10 minuti o più), per tutte le fasce di forza supportate**. Il campione deve usare la categoria Rapid di Chess.com e conservare anche la cadenza precisa, per confrontare separatamente controlli come 10+0 e 15+10. La verifica comprende i sei livelli fissi e la modalità adattiva. Blitz e Bullet richiedono campioni separati. Questa ricerca identifica fonti e interventi, ma non misura ancora il livello effettivo dell'app e non modifica la politica delle mosse.

## Archivi verificati

| Fonte                                                                                    | Dati disponibili                                                                                                                                                                                              | Uso nel progetto                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Lichess Open Database](https://database.lichess.org/#standard_games)                    | PGN mensili di partite standard rated; `WhiteElo`, `BlackElo`, `TimeControl`, mosse, risultati e orologi. Esportazioni CC0.                                                                                   | Corpus ampio per frequenze di mosse e tipi di errore, filtrato per rating e cadenza.                                                                                                                  |
| [Chess.com Published-Data API](https://www.chess.com/news/view/published-data-api)       | Archivi mensili per username, PGN, rating per partita, `rated`, `rules`, `time_class`, `time_control`.                                                                                                        | Riferimento diretto per tutte le fasce Chess.com da tarare. Si raccolgono archivi di giocatori e si filtrano: la documentazione consultata non espone un archivio globale scaricabile per fascia Elo. |
| [CSSLab / University of Toronto — dataset Maia](https://csslab.cs.toronto.edu/datasets/) | Test set ricavato da dicembre 2019, suddiviso in fasce di 100 punti da 1000 a 2500, con 10.000 partite per fascia dichiarate. CSV con posizione, mossa, rating, orologi e campi di valutazione, ove presenti. | Base pronta per prototipare analisi per fascia. I CSV mensili aggiuntivi includono solo partite analizzate da Stockfish: non sono un campione casuale di tutti i giocatori.                           |

Lichess pubblica oltre 8 miliardi di partite standard; agosto 2026 pesa circa 30 GB compressi. Conviene elaborare in streaming e conservare solo il campione necessario. Circa il 6% delle partite standard ha valutazioni incorporate: non confondere questo archivio con quello dei bot, quasi interamente analizzato. [Fonte](https://database.lichess.org/#standard_games).

I rating dei due siti appartengono a popolazioni e sistemi differenti: non usare 900 Lichess come sinonimo di 900 Chess.com, né una conversione fissa non misurata. [Spiegazione ufficiale Lichess](https://lichess.org/page/rating-systems).

Gli endpoint documentati per Chess.com sono `/pub/player/{username}/games/archives` e `/pub/player/{username}/games/{YYYY}/{MM}`. Per il rating storico usare il dato della partita, non quello attuale del profilo; conservare la provenienza, perché la documentazione descrive il rating JSON come successivo alla partita. Raccolta seriale, cache e gestione dei 429 seguono le indicazioni dell'[API ufficiale](https://www.chess.com/news/view/published-data-api).

Il rating dei puzzle Lichess misura la difficoltà dell'esercizio, non la forza dei giocatori della partita originaria; la libreria puzzle già presente nell'app non basta per tarare l'avversario. [Formato e significato dei dati](https://database.lichess.org/#puzzles).

## Politica attuale di tutti i livelli

I parametri seguenti sono impostazioni del codice, non statistiche ricavate da partite umane. Anche le etichette Elo sono indicative.

| Livello     | Elo nominale         | Perdita obiettivo (cp) | Limite della policy (cp) | Soglia di indebolimento |
| ----------- | -------------------- | ---------------------- | ------------------------ | ----------------------- |
| 1           | 600                  | 650                    | 1200                     | 0,80                    |
| 2           | 900                  | 390                    | 700                      | 0,60                    |
| 3           | 1200                 | 180                    | 350                      | 0,35                    |
| 4           | 1500                 | 80                     | 200                      | 0,15                    |
| 5           | 1800                 | 25                     | 100                      | 0,04                    |
| 6 — Massimo | Nessun Elo assegnato | 0                      | 50                       | 0                       |

Per ciascun livello vanno misurati sia la forza complessiva sia i pattern umani. La progressione deve essere verificata con risultati aggregati su partite complete: parametri monotoni non garantiscono livelli empiricamente distinti. Massimo va misurato nella configurazione effettiva di modello e motore, senza attribuirgli preventivamente un Elo.

La modalità adattiva memorizza un valore compreso tra 500 e 2400 (`src/main/game/gameSession.ts`). La policy è costante tra 500 e 600 e poi interpola tra ancore nominali fino a 2400; persona e profilo di ricerca seguono invece il più vicino dei cinque livelli con Elo, senza passare a Massimo. Vanno verificati anche estremi, valori intermedi e cambi di profilo: la sola interpolazione numerica non dimostra una progressione regolare della forza. Il valore adattivo deriva dai risultati nell'app e non costituisce una misura del rating Chess.com.

### Esempio diagnostico: il livello 900

Riferimenti locali: `src/shared/types/session.ts`, `src/main/game/difficultyPolicy.ts`, `src/main/game/opponentTurn.ts`, `src/main/engine/engineService.ts`.

| Parametro                    | Valore per livello 2 / adattivo 900              | Significato                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `targetLossCp`               | 390                                              | Obiettivo di perdita della candidata campionata, rispetto alla migliore linea della ricerca disponibile.                                                                    |
| Perdita desiderata effettiva | da 175,5 a meno di 526,5 cp                      | Variazione deterministica tramite seed; viene scelta la candidata disponibile più vicina. Non è una perdita garantita.                                                      |
| `maximumLossCp`              | 700                                              | Limite previsto dalla policy sulle linee iniziali e controllo sulle mosse del modello; non è una frequenza di errore.                                                       |
| `adjustmentRate`             | 0,60                                             | Soglia del seed per tentare di indebolire la mossa del modello. La sostituzione richiede anche una candidata diversa, verificata, peggiore di oltre 10 cp e sotto il tetto. |
| Contesto del modello         | 2 linee, migliore omessa se esistono alternative | La lista completa delle mosse legali rimane disponibile.                                                                                                                    |
| Ricerca iniziale             | profondità 10, limite 500 ms, MultiPV 18         | Pool di candidate; non è una profondità garantita né un Elo Stockfish misurato.                                                                                             |

La politica è dichiarata esplicitamente non calibrata. Il meccanismo può peggiorare deliberatamente una buona scelta senza sapere se un umano di quella fascia sbaglierebbe in quella posizione. Il tetto consente inoltre errori consistenti. È una spiegazione plausibile della debolezza segnalata, non ancora una misura del divario rispetto a Chess.com.

Il fallback dopo tre risposte inutilizzabili applica il limite alle linee della ricerca iniziale, senza ripetere la verifica sulla posizione risultante che viene applicata alle mosse del modello. I 700 cp non sono quindi una garanzia sulla perdita effettiva del fallback.

Non significa che il 60% delle mosse perda 390 cp: l'esito dipende dalle candidate, dalla mossa del modello e dalle verifiche. Il seed rende la scelta ripetibile; la soglia 0,60 non garantisce una frequenza osservata del 60% su partite reali.

Il libro attuale (`src/main/game/opponentBook.ts`) riconosce nomi e continuazioni di apertura per posizione, fino a 20 semimosse. Non contiene frequenze umane per fascia di rating. I test con motore reale confrontano livelli su tre posizioni e controllano una gaffe della donna: non stabiliscono l'equivalenza con Chess.com di alcuno dei livelli.

## Intervento consigliato

1. **Costruire campioni per tutta la scala.** Primo obiettivo operativo: 5.000–10.000 partite Chess.com rated Rapid per ciascuna fascia di taratura, con molteplici giocatori e periodi. È una dimensione iniziale proposta, non una garanzia statistica. Per i cinque livelli con Elo nominale usare inizialmente finestre di ±100 punti attorno a 600, 900, 1200, 1500 e 1800; coprire anche le fasce intermedie e gli estremi raggiungibili in modalità adattiva. Per Massimo estendere il confronto alle fasce necessarie a misurarne la forza. Conservare sempre il rating avversario come variabile. Limitare il contributo di ciascun giocatore e deduplicare le partite. Un archivio personale è utile per riprodurre l'esperienza dell'utente, ma non basta come campione generale.
2. **Misurare le decisioni nel loro contesto.** Per ogni mossa: posizione, rating del giocatore al tratto e dell'avversario, cadenza, fase, tempo residuo e valutazione iniziale. Analizzare con una versione/configurazione Stockfish comune; distinguere mate da centipawn e non scambiare valutazione assoluta con perdita della mossa. Non trattare valutazioni mancanti come zero.
3. **Ricavare frequenze condizionate per fascia.** Stimare quanto spesso vengono prese opportunità concrete: ricattura immediata, pezzo indifeso, matto in una, difesa da una minaccia, tattiche di diversa profondità. Il denominatore deve essere il numero di opportunità effettive. Tenere separati errori di apertura, tattica, finali e pressione di tempo. Per le fasce più forti includere anche conversione del vantaggio e difesa di posizioni inferiori. Questi sono pattern da misurare, non caratteristiche già dimostrate delle fasce.
4. **Sostituire l'obiettivo fisso di perdita con una distribuzione appresa.** La scelta deve consentire sequenze di mosse solide e assegnare errori plausibili alle posizioni in cui gli umani li commettono. Integrare frequenze di apertura in `opponentBookContext`; usare caratteristiche più generali nel mediogioco, dove le posizioni identiche sono rare. Evitare che un nuovo filtro Stockfish annulli sistematicamente gli errori umani misurati.
5. **Verificare ogni livello e la progressione su dati separati.** Tenere partite e giocatori distinti tra taratura e test, e prevedere anche un test su un periodo successivo. Confrontare distribuzione e gravità degli errori, frequenza dei pattern e probabilità delle mosse umane, non soltanto perdita media. Riportare risultati distinti per livello, configurazione del modello e cadenza precisa, evitando che una media globale nasconda una fascia mal tarata. Controllare anche livelli adiacenti e punti di transizione della modalità adattiva. Per dichiarare un Elo comparabile servono partite complete contro una popolazione di riferimento, con cadenza coerente e intervalli d'incertezza.

I dati elaborati possono diventare un piccolo artefatto locale versionato con sorgente, filtri, conteggi e configurazione del motore. Lo script `scripts/build-datasets.mjs` offre già un precedente per elaborazioni in streaming e dati utilizzabili offline; i nuovi profili di gioco dovrebbero restare distinti dai puzzle.

## Alternativa da valutare: Maia-3

[Maia-3 ufficiale](https://github.com/CSSLab/maia3) predice mosse umane condizionate dal rating. Offre interfaccia UCI, `SelfElo`, `OppoElo`, campionamento e modelli di diverse dimensioni; il 5M è indicato dagli autori come punto di partenza su CPU. [Maia-2](https://github.com/CSSLab/maia2) rimanda ora a Maia-3 per progetti nuovi.

Proposta: provarlo come riferimento esterno nel benchmark, prima di decidere se integrarlo. Può suggerire candidate umane, mentre Stockfish resta il riferimento di analisi e il modello linguistico cura le spiegazioni. Occorre misurare latenza e distribuzione Windows con le dipendenze effettive. I suoi valori UCI in centipawn derivano dalla previsione dell'esito e non sono valutazioni di ricerca Stockfish: non vanno passati al controllo di perdita attuale come se fossero equivalenti. [Documentazione UCI](https://github.com/CSSLab/maia3#uci-options).

Anche un modello condizionato dal rating richiede validazione sulla popolazione Chess.com: il parametro numerico non certifica automaticamente la forza di gioco. La versione originale di [Maia](https://github.com/CSSLab/maia-chess#how-to-run-maia) avverte già che i bot possono essere più forti della fascia usata per addestrarli.

Esito della ricerca: fonti adatte trovate e meccanismo applicativo da verificare sull'intera scala identificato. Restano da raccogliere i campioni di tutte le fasce, misurare i pattern e confrontare la nuova politica con quella attuale per ogni livello e per la modalità adattiva prima di assegnare Elo verificati.
