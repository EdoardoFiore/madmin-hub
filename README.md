# MADMIN Manager

Gestione centralizzata delle istanze MADMIN: inventario, backup, accesso di supporto temporaneo, licenze dei moduli.

- Protocollo manager ↔ istanza: [docs/PROTOCOL.md](docs/PROTOCOL.md)
- API di provisioning: [docs/API.md](docs/API.md)

## Requisiti

- Ubuntu 24.04, accesso root
- Un nome DNS e/o un indirizzo IP con cui le istanze raggiungono il manager
- Porte in ingresso:

| Porta | Da chi | Uso |
|---|---|---|
| tcp/443 (`--ui-port`) | operatori | interfaccia web e API |
| tcp/8443 (`--agent-port`) | istanze MADMIN | canale agent (certificati client), enrollment, backup |
| tcp/9100-9119 | operatori | sessioni di supporto (UI e SSH in tunnel); il range si cambia in Impostazioni |

## Installazione

```bash
git clone <repo> madmin-manager && cd madmin-manager
sudo MADMIN_MANAGER_ADMIN_PASSWORD='Password!1' bash scripts/setup-manager.sh --host manager.example.com --ip 10.0.0.5
```

### Opzioni

| Opzione | Default | Descrizione |
|---|---|---|
| `--host <nome>` | — | Nome DNS del manager. Ripetibile. |
| `--ip <indirizzo>` | — | Indirizzo IP del manager. Ripetibile. |
| `-u`, `--username <nome>` | `admin` | Primo amministratore. |
| `-p`, `--password <pwd>` | — | Password dell'amministratore. Preferire la variabile `MADMIN_MANAGER_ADMIN_PASSWORD`, che non finisce nella history né in `ps`. |
| `--ui-port <porta>` | `443` | Porta HTTPS dell'interfaccia. |
| `--agent-port <porta>` | `8443` | Porta HTTPS del canale agent. |

Serve almeno un `--host` o un `--ip`. Tutti i nomi e gli indirizzi entrano nel certificato dell'endpoint agent. Il primo (prima `--host`, poi `--ip`) forma l'URL agent inserito nei token di enrollment: `https://<primo>:<agent-port>`.

La password deve avere almeno 8 caratteri, una maiuscola, una cifra e un carattere speciale.

### Cosa fa lo script

1. **Pacchetti**: PostgreSQL, Python (venv), nginx, openssl, curl.
2. **Utente e database**: crea l'utente di sistema `madmin-manager`, il ruolo e il database PostgreSQL `madmin_manager`. Genera la password del database e il `SECRET_KEY`.
3. **Codice**: copia `backend/` e `frontend/` in `/opt/madmin-manager`, crea il venv, installa le dipendenze (`requirements.txt` vincolato da `requirements.lock`) e scrive `/opt/madmin-manager/backend/.env`.
4. **PKI** (`python -m manager.pki`): CA degli agent, certificato dell'endpoint, CA SSH e chiave di firma delle licenze, in `/opt/madmin-manager/data/pki/`.
5. **nginx**: un server per la UI, che risponde 404 su `/agent/`, e un server per gli agent, che verifica i certificati client e serve solo `/agent/`.
6. **systemd**: unità `madmin-manager.service` (uvicorn con un solo worker, utente `madmin-manager`, `ProtectSystem=strict`). Lo script aspetta che `/api/health` risponda.
7. **Amministratore e impostazioni**: crea il primo amministratore e imposta l'URL agent in Impostazioni.

Al termine lo script stampa l'URL della UI, l'URL agent e il **fingerprint della CA**, che i token di enrollment portano con sé per il pinning.

### File installati

| Percorso | Contenuto |
|---|---|
| `/opt/madmin-manager/backend/` | codice backend e `.env` (`DATABASE_URL`, `SECRET_KEY`, `DATA_DIR`) |
| `/opt/madmin-manager/frontend/` | interfaccia web |
| `/opt/madmin-manager/venv/` | ambiente Python |
| `/opt/madmin-manager/data/pki/` | CA e chiavi; le chiavi private, tranne quella dell'endpoint, sono cifrate con il `SECRET_KEY` |
| `/opt/madmin-manager/data/backups/` | backup delle istanze (cifrati dall'istanza) |
| `/etc/nginx/sites-available/madmin-manager.conf` | configurazione nginx |
| `/etc/systemd/system/madmin-manager.service` | unità systemd |

> **Non cambiare il `SECRET_KEY`.** Senza la chiave originale le chiavi della PKI, i segreti TOTP e le passphrase dei backup non si possono più leggere.

## Aggiornamento e reinstallazione

Lo script si può rilanciare sopra un'installazione esistente:

```bash
cd madmin-manager && git pull
sudo MADMIN_MANAGER_ADMIN_PASSWORD='...' bash scripts/setup-manager.sh --host manager.example.com --ip 10.0.0.5
```

Se trova `/opt/madmin-manager/backend/.env`:

- tiene **database, password del database e `SECRET_KEY`**;
- tiene la **CA** (le istanze la hanno nel pin) e rigenera solo il certificato dell'endpoint con i `--host`/`--ip` passati, quindi vanno ripassati tutti;
- ricopia il codice, aggiorna le dipendenze e riscrive nginx e systemd;
- non ricrea l'amministratore se ne esiste già uno (avviso, non errore).

I file eliminati dal repository restano in `/opt/madmin-manager/backend/` perché la copia non cancella nulla. Di solito non è un problema. Se serve una copia pulita, eliminare `/opt/madmin-manager/backend/` e `/opt/madmin-manager/frontend/` tranne il `.env`, prima di rilanciare.

Non esistono migrazioni: all'avvio vengono create solo le tabelle mancanti. Una colonna aggiunta a una tabella esistente richiede un intervento manuale sul database.

### Solo codice backend

Per una correzione al solo backend basta copiarlo e riavviare il servizio:

```bash
sudo cp -r backend/* /opt/madmin-manager/backend/
sudo systemctl restart madmin-manager
```

## Disinstallazione

```bash
sudo bash scripts/uninstall-manager.sh [-y] [--keep-db]
```

| Opzione | Descrizione |
|---|---|
| `-y` | non chiede conferma |
| `--keep-db` | tiene il database e il ruolo PostgreSQL `madmin_manager` |

Rimuove il servizio, la configurazione nginx, `/opt/madmin-manager` (**PKI e backup compresi**) e l'utente `madmin-manager`. Le istanze registrate dovranno essere registrate di nuovo, perché la nuova CA ha un fingerprint diverso.

Anche con `--keep-db` il `SECRET_KEY` va perso insieme al `.env`, quindi i segreti nel database (TOTP, passphrase dei backup) non sono più leggibili. `--keep-db` serve a consultare i dati, non a reinstallare conservandoli: per questo basta rilanciare lo script di installazione.

## Utenti e ruoli

Ogni utente ha un **ruolo**, un **accesso** e, se partner o cliente, un **gruppo**:

| Ruolo | Vede | Gruppo |
|---|---|---|
| Superuser | tutto il manager | nessuno |
| Partner | le istanze del partner e dei suoi clienti | un gruppo partner |
| Cliente | le istanze del cliente | un gruppo cliente |

| Accesso | Partner e cliente | Superuser |
|---|---|---|
| Sola lettura (`ro`) | istanze, backup, licenze, comandi | in più: supporto, enrollment, impostazioni, chiavi API, log (senza modificarli) |
| Lettura e scrittura (`rw`) | in più: modifica delle istanze, backup (avvio, download, eliminazione, ripristino), utenti del proprio gruppo | tutto, compresi accesso di supporto, licenze, gruppi, revoca ed eliminazione di istanze |

- Un partner o cliente con `rw` crea utenti solo dentro il proprio gruppo (un partner anche per i suoi clienti) e mai superuser.
- Nessuno può cambiare ruolo, accesso o gruppo del proprio account.
- Il primo utente, creato dallo script di installazione, è superuser `rw` e può essere modificato solo da sé stesso.

## Registrare un'istanza

Il client del manager (`backend/core/manager/`, opzioni `--manager-*` di `setup-madmin.sh`) è nel branch `feat/manager-agent` del repository MADMIN e non ancora in `main`. Le istanze vanno installate da quel branch.

**Con token.** Creare un token in **Enrollment** dalla UI, oppure con `POST /api/provisioning/tokens` (vedi [docs/API.md](docs/API.md)). Salvarlo in un file sull'istanza ed eseguire:

```bash
setup-madmin.sh ... --manager-token-file /percorso/token.txt
```

**Senza token.** Installare l'istanza con `--manager-url https://manager.example.com:8443 [--manager-ca-sha256 <fingerprint>]`. La richiesta compare in **Enrollment → In attesa** e un operatore la approva.

## Comandi utili

```bash
journalctl -u madmin-manager -f                         # log del servizio
systemctl status madmin-manager
cd /opt/madmin-manager/backend
sudo -u madmin-manager ../venv/bin/python -m manager.pki fingerprint                       # fingerprint della CA
sudo -u madmin-manager ../venv/bin/python -m manager.pki server-cert --host <nome> --ip <ip>  # nuovi nomi/IP
sudo systemctl reload nginx                         # dopo server-cert
```

Se cambiano nomi o IP del manager, aggiornare anche l'URL agent in **Impostazioni**.
