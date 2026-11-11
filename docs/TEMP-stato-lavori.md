# Stato dei lavori — MADMIN Manager e agente (documento temporaneo)

Aggiornato al 2026-11-11. Riassume cosa è stato fatto nelle Fasi 0 e 1 della roadmap, come funziona e come si usa. La fonte di verità restano `docs/ROADMAP.md` e `docs/PROTOCOL.md` (questa repo) e `docs/RELEASING.md` (repo MADMIN); questo file si può eliminare quando il lavoro sarà unito in `main`.

---

## 1. Dove sta il lavoro

| Repo | Branch | Contenuto |
|---|---|---|
| `EdoardoFiore/madmin-manager` (ex `madmin-hub`) | `feat/manager-phase0` | manager: rename, protocollo v1, release, rescue, UI |
| `EdoardoFiore/madmin` | `feat/manager-agent` | agente (`backend/core/manager/`), installer, updater, rescue, migrazioni |
| `EdoardoFiore/madmin` | tag `agent-v1-baseline` (7df32bd) | agente di riferimento del protocollo v1 congelato |

Nessuno dei due branch è unito a `main`. Il vecchio branch `feat/hub-agent` di MADMIN è superato: i suoi 3 commit sono stati riportati in `feat/manager-agent`.

Stato: **Fase 0 (rename + congelamento protocollo) e Fase 1 (release firmate, updater, rescue) fatte e testate.** Prima del primo deploy mancano: cerimonia delle chiavi di firma, migrazioni del database del manager (§10.5 roadmap), hardening degli accessi di supporto (§10.4).

---

## 2. Quadro generale

- **Manager** (questa repo): FastAPI + PostgreSQL + nginx su una VM. UI per gli operatori (porta 443), endpoint agent con certificato client (porta 8443), porte dei tunnel di supporto (9100–9119).
- **Agente** (dentro MADMIN, `backend/core/manager/`): gira nel processo di MADMIN, apre una WebSocket mTLS verso il manager, esegue solo comandi di una allowlist con argomenti validati, li registra nell'audit locale come `manager:<operatore>`.
- **Protocollo**: `protocol.py` identico nelle due repo (`madmin/backend/core/manager/protocol.py` = `madmin-manager/backend/manager/agents/protocol.py`), specifica in `docs/PROTOCOL.md`. Ogni modifica va copiata dall'altra parte nello stesso lavoro.
- **Updater e rescue** (in MADMIN, `scripts/madmin-update`, `scripts/madmin-rescue`): script Python solo libreria standard, installati in `/opt/madmin/updater/`, fuori da qualunque release.

---

## 3. Fase 0 — cosa è stato fatto e come funziona

### 3.1 Rename hub → manager
Tutto ciò che è visibile sul filo, su disco o all'operatore:

| Prima | Ora |
|---|---|
| repo, servizio, utente, path `madmin-hub` | `madmin-manager` (DB `madmin_manager`) |
| token `MHUB1-` | `MMGR1-` |
| `core.hub`, `python -m core.hub` | `core.manager`, `python -m core.manager` |
| `DATA_DIR/hub/` sull'istanza | `DATA_DIR/manager/` |
| audit `hub:<op>`, metodo `HUB`, `hub://` | `manager:<op>`, `MANAGER`, `manager://` |
| ticket `#hub-ticket=` | `#manager-ticket=` (`/api/auth/token/manager-ticket`) |
| opzioni `--hub-*`, `MADMIN_HUB_*` | `--manager-*`, `MADMIN_MANAGER_*` |
| account di supporto `hub-...` | `mgr-<operatore>-<suffisso>` |
| capability `hub.view` / `hub.manage` | `manager.view` / `manager.manage` |

### 3.2 Regole di compatibilità (il cuore del congelamento)
Servono a non dover reinstallare le istanze quando il manager evolve. Sono normative in `docs/PROTOCOL.md`:
- `v` = versione maggiore della busta, **mai incrementata**.
- Revisioni: `hello` porta `revision_min`/`revision_max`, `hello_ack.revision` sceglie la più alta comune (4400 se nessuna).
- Tipo di frame, campo, evento o chiave di config sconosciuti: **ignorati**. Close code sconosciuto: riconnessione con backoff.
- **Comandi versionati uno per uno**: `hello.capabilities` = `{comando: versione}`. Se cambia argomenti o risultato si incrementa la versione del comando; il manager non manda mai un argomento che l'agente non conosce. Gli argomenti restano rigidi sull'agente (campo sconosciuto = `invalid_args`).
- **Features**: capacità che non sono comandi (`hello.features`, `hello_ack.features`).
- **Config dal manager**: `hello_ack.config` con heartbeat (30–600 s), intervallo fact (60–3600 s), backoff massimo (30–900 s); l'agente li limita a quei range. Si impostano in Impostazioni > "Agent delle istanze" e valgono dalla connessione successiva.
- **Errori strutturati**: `{"ok": false, "error": {"code", "message"}}` con codici `unsupported`, `invalid_args`, `expired`, `busy`, `timeout`, `precondition`, `failed`, `internal`. Il manager li mappa su 409/502/504 e li mostra nella scheda Comandi.

### 3.3 Comandi lunghi
- `exp` = scadenza di consegna (non si avvia dopo); `timeout` = durata massima dell'esecuzione (l'agente può solo abbassarla).
- Un comando lungo (backup, ripristino, update) manda `cmd_progress {"state": "running", "step", "percent", "message"}`. Da quel momento il manager lo segna `running` e aspetta fino al timeout + 5 minuti, poi lo segna fallito con `timeout`.
- Un comando rimandato mentre gira riceve un nuovo `cmd_progress`, mai una seconda esecuzione.

### 3.4 Stato nel `hello` e riconciliazione
Gli eventi sono "best effort"; ciò che non deve divergere viene mandato a ogni connessione in `hello.state`:
- `support`: accessi aperti → il manager chiude le sessioni che l'istanza non ha più;
- `licenses`: licenze valide installate → il manager reinvia quelle mancanti;
- `commands`: in corso / con risultato in cache;
- `ca`: CA fidate (per la rotazione);
- `update`: journal dell'updater (Fase 1).
Una sezione assente significa "sconosciuto": il manager non fa nulla. Eventi aggiuntivi: `ca.updated`, `update.status`.

### 3.5 Codici di chiusura
| Codice | Significato | Agente |
|---|---|---|
| 4400 | frame malformato / versione | riprova con backoff |
| 4401 | revocata | si ferma, rimuove accessi di supporto |
| 4403 | **sospesa** | mantiene tutto, riprova ogni 15 minuti |
| 4409 | sostituita da connessione più nuova | riprova |
| 4429 | manager occupato (motivo = secondi) | aspetta quei secondi (il manager non lo usa ancora) |

**Sospensione** (UI: Sospendi / Riattiva, solo superuser): nessuna connessione e nessun comando finché non è riattivata; rinnovo del certificato e unenroll continuano a funzionare.

### 3.6 Cambio indirizzo del manager (`manager.relocate`)
Il manager indica un `https://host:porta`, mai una CA. L'agente verifica che il nuovo indirizzo presenti un certificato della CA che già conosce e serva l'endpoint agent, lo salva come `manager_url_next`, ci si collega una volta: lo tiene solo dopo un `hello_ack` da lì, altrimenti resta sul vecchio. UI: "Cambia indirizzo" sull'istanza; API anche per tutte (`POST /api/instances/relocate`).

### 3.7 Rotazione della CA
L'agente si fida di più CA in `ca.pem`, ma ne aggiunge una nuova **solo se accompagnata da un certificato incrociato emesso da una CA già fidata**: un manager compromesso non può far accettare una CA qualsiasi.

### 3.8 Fact di identità
`version`, `build` (commit, `-dirty` se modificato), `release_id`, `layout` (0 = installazione piatta senza updater, 1 = release), `os_id` (`ubuntu-24.04`). Visibili nella pagina dell'istanza.

### 3.9 Test di compatibilità
`scripts/agent-compat-check.py` (questa repo) finge di essere un manager più nuovo: manda campi, frame, comandi e codici di chiusura sconosciuti e verifica che l'agente resti collegato e risponda correttamente. Da rifare contro `agent-v1-baseline` a ogni nuova versione del manager.

---

## 4. Fase 1 — release, updater, rescue

### 4.1 Formato della release
`madmin-<versione>+<build>.release` = tar non compresso con esattamente:
- `manifest.json`: versione, build, `min_from`, layout, OS supportati, versioni dello schema DB, moduli, pacchetti apt, sha256 del payload;
- `manifest.json.sig`: firma Ed25519 del manifest;
- `payload.tar.gz`: `backend/`, `frontend/`, `scripts/`, `wheels/<os>/` (tutte le dipendenze Python di core e moduli, fissate da `requirements.lock`).

La firma copre il manifest, il manifest contiene lo hash del payload: **nulla viene estratto prima che firma e hash siano verificati**.

### 4.2 Chiavi di firma
- Due chiavi Ed25519 cifrate con passphrase: primaria nel vault aziendale, riserva con un secondo metodo indipendente. Mai sul manager, mai in CI, mai nella repo.
- Le **chiavi pubbliche** vanno in `madmin/scripts/release-keys/*.pem`: vengono installate con ogni release in `/opt/madmin/updater/keys/`. Una release si verifica sempre con le chiavi della release **già installata**, mai con quelle che porta.
- Root può aggiungere una chiave di test su una singola istanza: `/etc/madmin/release-keys.d/<nome>.pem`.
- Il manager può verificare la firma anche all'upload: Impostazioni > Release > chiavi pubbliche.
- **La cerimonia non è ancora stata fatta**: oggi `scripts/release-keys/` contiene solo il README.

### 4.3 Struttura su disco dell'istanza (layout 1)
```
/opt/madmin/
  releases/<id>/        backend/ frontend/ scripts/ venv/ manifest.json
  current  -> releases/<id>   (versione in esecuzione)
  previous -> releases/<id>   (versione del rollback)
  etc/madmin.env        impostazioni (DATABASE_URL, SECRET_KEY, ...)
  data/                 DATA_DIR (identità manager, ssl, firewall, ...)
  updater/              madmin-update, madmin-rescue, keys/
  state/                update.json (journal), snapshots/, downloads/
  backups/ uploads/ cron-scripts/
```
Unit systemd: `madmin.service` (su `current/`), `madmin-firewall-boot.service`, `madmin-update-recover.service` (prima di madmin), `madmin-rescue.timer`.

### 4.4 Migrazioni del database
- `create_all` crea solo le tabelle nuove; **ogni modifica a tabella o colonna esistente richiede un passo numerato**:
  - core: `backend/core/migrations/NNNN_<nome>.py`
  - modulo: `backend/modules/<id>/upgrades/NNNN_<nome>.py`
  - ogni file definisce `async def upgrade(conn)`, idempotente dove possibile.
- Applicati all'avvio (core) e al caricamento del modulo; versione registrata in `schema_version`.
- DB nuovo: registra l'ultimo passo senza eseguirli. DB 1.2.0 preesistente: parte da 0.
- Attivare un modulo registra il suo ultimo passo; disattivarlo (tabelle eliminate) cancella la sua versione.
- Se un passo fallisce MADMIN non parte → l'updater fa rollback.

### 4.5 `madmin-update` (sull'istanza)
| Comando | Cosa fa |
|---|---|
| `verify FILE` | firma, hash, OS, layout, `min_from`, no downgrade, schema non più vecchio del DB |
| `install FILE [--deadline S] [--no-manager]` | aggiornamento completo (sotto) |
| `rollback [--keep-database]` | torna alla release precedente con il suo snapshot |
| `recover [--boot]` | chiude o annulla un update interrotto |
| `status` | release corrente/precedente, ultimo update, chiavi |
| `rebuild-venv` | ricrea il venv della release corrente |
| `bootstrap --from-checkout DIR` | prima installazione (usata da `setup-madmin.sh`) |

Passi di `install`, ognuno scritto nel journal prima di iniziare:
1. **verify**
2. **unpack** in `releases/<id>/`
3. **venv** solo dalle wheel incluse + pacchetti apt mancanti
4. **preflight**: il nuovo codice si importa con le impostazioni attuali — *fin qui nulla è cambiato*
5. **snapshot**: MADMIN fermo, `pg_dump` + copia di `etc/` e `data/` (conservati 7 giorni)
6. **switch** di `current`/`previous`
7. **start**: partono le migrazioni
8. **health**: entro la scadenza (default 5 minuti) servizio attivo e stabile, `/api/health` = 200 e, se registrata, **conferma del manager** dopo la riconnessione. Esce prima se il servizio si riavvia in loop.
9. **commit**: pulizia delle release vecchie (restano corrente e precedente); per ultimi vengono sostituiti updater, rescue e chiavi con quelli della nuova release.

Se qualcosa fallisce dopo lo snapshot: **rollback** (release precedente, DB ripristinato in un database separato che sostituisce l'originale solo se completo, `etc/` e `data/` ripristinati, MADMIN riavviato e controllato). Esito `rolled_back`, oppure `failed` se anche il rollback ha problemi.

Al boot `madmin-update-recover.service` (`recover --boot`) finisce o annulla un update interrotto, senza fermare né avviare MADMIN: ci pensa systemd subito dopo.

### 4.6 Aggiornamento dal manager
1. Superuser: Istanze > istanza > **Aggiorna**, sceglie una release.
2. Il manager manda `madmin.update {release_id, sha256}`.
3. L'agente scarica da `/agent/releases/<id>` del proprio manager, controlla sha256 ed esegue `madmin-update verify`, poi avvia `madmin-update install` in un'unità systemd transitoria e risponde "avviato".
4. Dopo il riavvio il `hello` porta `state.update = verifying`; il manager risponde `update_confirm`, l'agente lo scrive in `state/update-confirm` e l'updater può confermare.
5. L'esito (`ok` / `rolled_back` / `failed`) arriva con `update.status` ed è visibile in Panoramica ("Ultimo aggiornamento").

Solo superuser; solo istanze layout 1 (quelle installate prima vanno reinstallate).

### 4.7 Rescue
`madmin-rescue` gira ogni 5 minuti. Se MADMIN è attivo e l'agente collegato non fa nulla. Altrimenti:
1. chiude un update interrotto;
2. manda a `POST /agent/rescue` stato del servizio, ultime 200 righe di journal, release corrente e precedente, journal dell'update, spazio libero, esito dell'ultima azione;
3. esegue al massimo **un'azione** messa in coda da un superuser nella pagina dell'istanza: **riavvia**, **torna alla precedente**, **installa una release** (con le stesse verifiche di un update). Ogni azione viene eseguita una sola volta.

Non apre mai shell, tunnel o accessi di supporto. Nella panoramica dell'istanza compare un riquadro rosso "Rescue" finché arrivano report o c'è un'azione in attesa.

---

## 5. Procedure

### 5.1 Installare o reinstallare il manager
```bash
git clone -b feat/manager-phase0 https://github.com/EdoardoFiore/madmin-manager.git
cd madmin-manager
sudo MADMIN_MANAGER_ADMIN_PASSWORD='...' bash scripts/setup-manager.sh --ip <IP> [--host <nome>] -u <utente>
```
Rilanciarlo su un manager esistente conserva database e chiavi e aggiorna codice e nginx. Attenzione: imposta l'URL agent nelle impostazioni sul primo `--host` (o IP).
Nuove colonne su un manager esistente: oggi vanno aggiunte a mano con `ALTER TABLE` (migrazioni del manager non ancora fatte).

### 5.2 Installare un'istanza
```bash
git clone -b feat/manager-agent https://github.com/EdoardoFiore/madmin.git && cd madmin
sudo MADMIN_ADMIN_PASSWORD='...' bash scripts/setup-madmin.sh -u admin --manager-token-file /root/token.txt
```
- Il token si crea in Enrollment (o `POST /api/enrollment/tokens`). Per reinstallare mantenendo identità, backup e licenze si usa il **token di re-enroll** dell'istanza.
- Dopo l'installazione il firewall MADMIN blocca SSH: la sessione aperta resta attiva, ma va aggiunta una regola INPUT ACCEPT tcp 22123 (meglio limitata alla rete di gestione) prima della regola DROP finale.
- Non lanciare l'installer con umask restrittiva (ora la forza a 022, ma prima rompeva la UI).
- Su un'istanza già installata l'installer si rifiuta: si aggiorna con `madmin-update`, oppure si reinstalla (backup → `uninstall-madmin.sh` → setup → ripristino).

### 5.3 Cerimonia delle chiavi (da fare una volta)
```bash
bash scripts/release-key.sh primary    # primary.key.pem (segreta), primary.pub.pem
bash scripts/release-key.sh reserve
cp primary.pub.pem scripts/release-keys/primary.pem
cp reserve.pub.pem scripts/release-keys/reserve.pem
git add scripts/release-keys/*.pem && git commit -m "chore(release): release signing keys"
```
Poi incollare le due chiavi pubbliche in Manager > Impostazioni > Release.

### 5.4 Fare una release
1. Bump di `MADMIN_VERSION` (e della versione del modulo se cambia un modulo); se serve un passo di migrazione, crearlo.
2. Commit e tag.
3. Su una macchina Ubuntu 24.04: `bash scripts/build-release.sh` → `dist/madmin-<id>.unsigned.tar` (rifiuta modifiche non committate).
4. Sulla macchina offline: `bash scripts/sign-release.sh dist/madmin-<id>.unsigned.tar primary.key.pem` → mostra il manifest e chiede conferma e passphrase → `madmin-<id>.release`.
5. Manager > Release > **Carica release** → stato `candidate`.
6. Aggiornare un'istanza di test, poi **Promuovi a stable**.

### 5.5 Aggiornare, controllare, tornare indietro
- Dal manager: Istanze > istanza > **Aggiorna** (avanzamento nella scheda Comandi, esito in Panoramica).
- Sull'istanza (root):
```bash
/opt/madmin/updater/madmin-update status
/opt/madmin/updater/madmin-update install /percorso/madmin-<id>.release
/opt/madmin/updater/madmin-update rollback          # alla precedente, con lo snapshot di quell'update
journalctl -u 'madmin-update-*'                     # log degli update avviati dall'agente
cat /opt/madmin/state/update.json                   # journal
```

### 5.6 Rescue
Se un'istanza smette di rispondere, entro 5–10 minuti compare il riquadro "Rescue" nella sua pagina, con il journal di MADMIN. Si sceglie un'azione (Riavvia / Torna alla precedente / Installa una release); viene eseguita al report successivo e l'esito appare nel riquadro.

### 5.7 Altre operazioni
- **Sospendere / riattivare** un'istanza: pulsanti nella pagina (dopo la riattivazione si ricollega entro 15 minuti).
- **Cambiare indirizzo del manager**: "Cambia indirizzo" sull'istanza, oppure `POST /api/instances/relocate` per tutte. Il vecchio indirizzo deve restare raggiungibile finché lo spostamento non è confermato.
- **Rotazione CA** (sul manager, utente `madmin-manager`):
```bash
cd /opt/madmin-manager/backend
sudo -u madmin-manager ../venv/bin/python -m manager.pki rotate-ca status
sudo -u madmin-manager ../venv/bin/python -m manager.pki rotate-ca prepare
systemctl restart madmin-manager
# attendere che status non elenchi istanze senza la nuova CA
sudo -u madmin-manager ../venv/bin/python -m manager.pki rotate-ca activate
systemctl reload nginx && systemctl restart madmin-manager
# entro 90 giorni (rinnovi dei certificati agent), quando status è pulito:
sudo -u madmin-manager ../venv/bin/python -m manager.pki rotate-ca retire
systemctl reload nginx && systemctl restart madmin-manager
```
- **Parametri dell'agent**: Impostazioni > "Agent delle istanze".
- **Test di compatibilità** (sul manager):
```bash
systemctl stop madmin-manager
cd /opt/madmin-manager/backend && ../venv/bin/python /root/madmin-manager/scripts/agent-compat-check.py
systemctl start madmin-manager
```

---

## 6. Test eseguiti sulle VM (2026-11-11)

**Fase 0**: installazione di manager e istanza dai branch, enrollment con token, aggiorna dati, grafici, backup e ripristino con avanzamento, supporto UI 1000 min nel tunnel con ticket monouso, supporto SSH 900 min con certificato, codici di errore, parametri agent (heartbeat a 30 s misurato), sospensione (riconnessione dopo esattamente 900 s), riconciliazione di accesso SSH perso e licenza cancellata, cambio indirizzo (rifiuti, spostamento, ritorno), rotazione CA completa (prepare, activate, rinnovo, retire) senza perdere l'istanza, test di compatibilità 6/6.

**Fase 1**:
- reinstallazione nel nuovo layout, ripristino del backup;
- aggiornamento dal manager in circa 40 s;
- release che non si avvia → nessuna modifica;
- migrazione che fallisce → rollback in circa 1 minuto, dati intatti;
- manager irraggiungibile → rollback alla scadenza;
- updater ucciso durante il venv → ripulito; ucciso durante la verifica + riavvio della VM → rollback al boot e MADMIN ripartito da solo;
- release manomessa, chiave non fidata, downgrade, file non firmato → rifiutati;
- due update di fila (il secondo con migrazione) + rollback → versione intermedia e schema precedente;
- rescue con MADMIN fermo: report, "riavvia" e "installa" funzionano.

## 7. Bug trovati dai test e corretti
- Installer: con umask 077 la UI diventava illeggibile da nginx → ora `umask 022`.
- Rotazione CA: la nuova CA arrivava dopo il `hello` → aggiunto `ca.updated`; `retire` contava anche certificati già sostituiti.
- Build: la lettura di `/etc/os-release` sovrascriveva la versione.
- **Rollback con database vuoto**: il dump non era leggibile da `postgres` e il rollback risultava comunque riuscito → restore via stdin in un database separato, esito `failed` se qualcosa non va.
- **Stallo al boot**: il recover avviava MADMIN e ne attendeva la salute, mentre MADMIN attendeva il recover; poi uno `stop` cancellava l'avvio di MADMIN → `recover --boot` non tocca il servizio.
- Le release dei rollback restavano su disco → rimosse.

## 8. Limiti noti / da fare
- Cerimonia delle chiavi di firma.
- Migrazioni del database del manager (§10.5) e backup/ripristino documentato del manager.
- Hardening degli accessi di supporto (§10.4): step-up TOTP, chiavi SSH per utente con approvazione, massimo 4 sessioni, UI filtrata per IP.
- Non testato: disco pieno durante unpack e dump; rollback lanciato dal rescue (testato solo `madmin-update rollback`).
- Non fatto: ripresa dei download interrotti, pulizia automatica delle release sul manager, notifica degli eventi di rescue, controllo nel build della coerenza tra modelli e migrazioni, aggiornamento delle unit systemd tramite update (oggi le scrive solo l'installer), uso di 4429 da parte del manager.
- Fasi successive: inventario e vulnerabilità (3), azioni sul sistema operativo (4), rollout di gruppo e altre funzioni del manager (5).

## 9. Ambiente di test
- **Manager**: 10.178.0.102 (root, porta 22), checkout `/root/madmin-manager`, superuser `efroot`. Usa la CA ruotata il 2026-11-11.
- **Istanza** `madmin-staging`: 10.178.0.101 (root, porta 22123; SSH ammesso solo da 10.178.0.0/24), checkout `/root/madmin`, utente `admin`. Release attuale `1.2.0+9670f53e3549`.
- **Credenziali** impostate durante i test: nel file `creds.txt` della cartella temporanea della sessione di Claude (da cambiare o salvare altrove).
- **Chiave di firma di test**: `/root/test-release.key` sull'istanza, fidata via `/etc/madmin/release-keys.d/test.pem` e impostata nelle impostazioni del manager. Da rimuovere quando ci saranno le chiavi vere.
- **Script di test** sull'istanza: `/root/mkrel.sh <nome> [patch]` crea una release firmata di prova da `origin` + un commit (clone in `/root/mb`, file in `/root/rels/`); `/root/killtest.sh`.
- Sul manager restano caricate le release di prova.
