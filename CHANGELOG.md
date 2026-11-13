# Changelog

All notable changes to MADMIN Manager. Versions follow [Semantic Versioning](https://semver.org/):

- **patch** (1.1.1): fixes only;
- **minor** (1.2.0): new features, schema steps, new API;
- **major**: a break of compatibility with the agents (never while protocol v1 lasts) or of the provisioning API.

Every block of work that is pushed bumps the version (`MANAGER_VERSION` in `backend/config.py`), adds an entry here and is tagged `vX.Y.Z`. The manager is updated by rerunning `setup-manager.sh` from a checkout of the version (schema steps run at startup). The wire protocol has its own versioning (`docs/PROTOCOL.md`), the MADMIN instances theirs (MADMIN `CHANGELOG.md`).

## [1.2.0] - 2026-11-13

### Added
- Reboot worth it: findings of the running kernel fixed by a kernel already installed get the status "Corretta, serve riavvio" (not counted as fixable); "riavvio consigliato" when the reboot fixes critical/high findings or the microcode changed (Sistema tab, Vulnerabilità card and column, badge on Istanze, e-mail once per installed kernel). Ubuntu's "riavvio richiesto" stays informative.
- Time of the automatic security updates: Settings (default 03:00 Europe/Rome, random delay) and per group (inherited from the partner), applied to each instance with `os.autoupdate.set` and reconciled at every connection and change.
- Services running outdated libraries (from the instance) with "Riavvia servizi" now or at a time (`os.services.restart`).
- Rollouts: action "Riavvio servizi", filters by state (services to restart, reboot recommended/required), start at a chosen time; recurring schedules (days and time) that create rollouts.
- Sistema tab: the preview of the updates, the freshness of the data and the automatic update time.

### Fixed
- `instances.js` had been emptied by the 1.1.0 change (the instance pages did not load in 1.1.0–1.1.2): restored with the Sistema tab changes.

## [1.1.2] - 2026-11-13

### Fixed
- Updates preview: a CVE listed twice keeps the higher severity of the two records.

## [1.1.1] - 2026-11-13

### Fixed
- Updates preview counted a CVE twice when Ubuntu's record and its USN both list it.

## [1.1.0] - 2026-11-13

First tracked version after 1.0.0 (the work below was developed while the version stayed 1.0.0).

### Added
- Rename hub → manager; protocol v1 frozen: revisions, versioned capabilities, structured errors, long commands, state reconciliation, close codes, `manager.relocate`, CA rotation.
- Signed releases: upload, channels candidate/stable, update of an instance, rescue actions.
- Schema migrations (`backend/core/migrations/`, steps 0001–0005); `manager-backup.sh` / `manager-restore.sh`.
- Support hardening: TOTP at every opening, SSH only to the user's approved keys (`manager.keys`), at most 4 open sessions per user; `setup-manager.sh --ui-allow`.
- Inventory and vulnerabilities: OSV scan, Ubuntu tracker status of each finding (Canonical VEX), Vulnerabilità page, Sistema tab, CSV export; only fixable critical findings alert.
- Preview of the OS updates (what "Aggiornamenti di sicurezza" and "Aggiorna tutto" install, with the findings each package fixes), "Come funziona" panel.
- OS actions from the manager (refresh, upgrade, reboot with kernel on trial, cancel).
- Rollouts (canary, concurrency, stop threshold, maintenance windows), notifications (menu badges, e-mail), LDAP/AD users.
- One form kit for every modal (required/optional marks, hints, inline errors, coloured consequences, typed confirmations).

### Fixed
- Python findings are fixed by a MADMIN release, not by OS updates (status "Serve release MADMIN").
- SMTP port validator shadowed; LDAP user committed before the login answer; users API without `auth_source`.

## [1.0.0]

MADMIN Hub renamed: inventory, backups, support access, licenses, enrollment.
