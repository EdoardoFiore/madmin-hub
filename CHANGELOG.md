# Changelog

All notable changes to MADMIN Manager. Versions follow [Semantic Versioning](https://semver.org/):

- **patch** (1.1.1): fixes only;
- **minor** (1.2.0): new features, schema steps, new API;
- **major**: a break of compatibility with the agents (never while protocol v1 lasts) or of the provisioning API.

Every block of work that is pushed bumps the version (`MANAGER_VERSION` in `backend/config.py`), adds an entry here and is tagged `vX.Y.Z`. The manager is updated by rerunning `setup-manager.sh` from a checkout of the version (schema steps run at startup). The wire protocol has its own versioning (`docs/PROTOCOL.md`), the MADMIN instances theirs (MADMIN `CHANGELOG.md`).

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
