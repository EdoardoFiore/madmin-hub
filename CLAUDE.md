# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**MADMIN Manager** is the central management for MADMIN instances (the routers in the virtual data centers): inventory with address history, backups, temporary support access (superuser UI and root SSH through tunnels opened by the instance), module licenses. Same stack and security principles as MADMIN; UI in Italian.

The previous attempt is in `../madmin-hub-legacy` (reference only, do not copy from it: see the design notes below for what it got wrong).

## Workflow

- **No test commands are run locally.** Tested on a separate test server.
- **No commits are made by Claude.** Commits are managed manually by the user.
- No DB migrations: `init_db()` only runs `create_all`; a new column needs a model default.

```bash
sudo MADMIN_MANAGER_ADMIN_PASSWORD='...' bash scripts/setup-manager.sh --host manager.example.com [--ip 10.0.0.5]
```

## Architecture

```
backend/
  main.py            app, lifespan (background tasks), /api/ui/menu
  config.py          Settings (.env): DATABASE_URL, SECRET_KEY, DATA_DIR
  core/              copied from MADMIN: auth (JWT, TOTP, lockout; roles instead of MADMIN's permissions), audit, secrets (Fernet/HKDF),
                     concurrency, http, sdnotify; settings (one SystemSettings row)
  manager/
    models.py        every table (Instance, InstanceAddress, AgentCertificate, EnrollmentToken,
                     Command, Backup, License, SupportSession, InstanceGroup)
    pki.py           agent CA, endpoint certificate, SSH CA, license key; CLI python -m manager.pki
    agents/          protocol.py (IDENTICAL to madmin/backend/core/manager/protocol.py),
                     auth (client cert), registry (live connections), dispatcher (commands), router (/agent/*)
    groups.py        hierarchy (manager) -> customer | (manager) -> partner -> customer, subtree_ids
    scope.py         what a user may see: filters every instance/backup/license/user query
    registration.py  optional fields (name, group, labels, external_ref) applied at enrollment
    enrollment/      tokens, shared identity issuing (service.py), token-less requests (requests.py)
    apikeys/         provisioning API keys (scoped, CIDR, hashed); provisioning/ = /api/provisioning/*
    instances/ backups/ licenses/ support/ (tunnels.py: listeners + /agent/tunnel)
frontend/            MADMIN SPA shell; views: dashboard, instances (detail tabs), support, licenses,
                     enrollment, users, logs, settings; views/manager-common.js
docs/PROTOCOL.md     wire protocol (the contract with MADMIN)
docs/API.md          provisioning API (for the system that creates instances)
scripts/setup-manager.sh
```

## Design rules (do not regress)

- **Identity = client certificate** (CN = instance_id, key generated on the instance, CSR only). Checked by nginx (`ssl_verify_client`) + one indexed lookup of the sha256 fingerprint (`manager/agents/auth.py`). Never a bearer token, never in a query string, never an O(N) hash loop.
- **CA pinned by the token** (`f` = sha256 of ca.pem). Never disable TLS verification on either side.
- **Enrollment only from the instance's root CLI** (`python -m core.manager enroll`): MADMIN exposes no bootstrap endpoint.
- **The manager never names hosts, ports or shell commands** for the instance: commands are an allowlist with validated arguments; tunnel targets are symbolic (`ui`, `ssh`); backups go only to/come only from this manager.
- **Newest connection wins** (4409 to the old one); **4401 = revoked**, the agent stops. Connection state is in memory only (`registry.py`), never persisted flags.
- **Commands are persisted and re-sent** until a result; the agent dedupes by id. Credentials in results (tickets) are returned to the caller and redacted before storage (`dispatcher._redact`).
- **One protocol file**, copied identically, with capability negotiation: the UI/API refuses (409) commands the connected agent does not advertise.
- Single uvicorn worker (registry, waiters, support listeners in process). Service runs as user `madmin-manager` with `ProtectSystem=strict`.
- nginx: the UI server returns 404 for `/agent/` and blanks `X-SSL-Client-*`; the agent server serves only `/agent/`.

## Enrollment paths

- Token from the UI or from `POST /api/provisioning/tokens`, which is single-use and idempotent on `external_ref` (it re-enrolls when the instance is known).
- `--manager-url` on the instance: an EnrollmentRequest, approved from Enrollment > In attesa with the same fields a token carries.
- All fields are optional. API keys work only on `/api/provisioning/*` (`require_scope`). The UI JWT dependencies never accept one. They are never installed on instances.

## Groups, roles and scope

Partners are top-level groups with customers under them; customers can also sit at the top level.

Users have a `role` (superuser | partner | customer), an `access` (rw | ro) and, for partners and customers, one `group_id` of the matching kind. Capabilities are derived, never stored (`core.auth.models.capabilities_for`): `scope.view`, `scope.manage`, `users.view`, `users.manage`, `manager.view`, `manager.manage`. `require_permission(<capability>)` checks the role; **every route on instances, backups, licenses and users must also filter by scope** (`manager/scope.py`: `group_ids`, `filter_instances`, `get_instance`, `check_group`). Out of scope = 404, never 403.

- partner/customer rw: edit their instances (not `external_ref`), backups (run, download, delete, restore), users of their subtree (never superusers).
- superuser only: support, enrollment, licenses (issue/revoke), groups, settings, API keys, logs, revoke/delete instances, clone suspects. `ro` superuser sees all of it, changes nothing.
- Nobody changes their own role, access or group; a change revokes the target's sessions.

## Data

`DATA_DIR/pki/` (CA and endpoint keys; private keys other than the endpoint's encrypted with the data key), `DATA_DIR/backups/<instance_id>/<backup_id>.bin` (archives encrypted by the instance with its passphrase, `Instance.backup_passphrase_enc`). Rotating `SECRET_KEY` makes the PKI and the passphrases unreadable.

## Not done yet

Remote update of instances (planned: release tarballs signed with an offline maintainer key whose public half is in the MADMIN repo, blue/green updater via `systemd-run` with automatic rollback, result reported in `hello`).
