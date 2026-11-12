# Roadmap: from MADMIN Hub to a deployable MADMIN Manager

Status: plan, nothing in this document is implemented yet unless a step is ticked.
Written 2026-11-11. Version tracking of MADMIN starts at **1.2.0**; instances installed before the first managed release are reinstalled, not migrated.

## 1. Goal

Until now an instance was updated by backup → delete → create a new instance → restore. Instances are now diverging, and we need to:

- know what every instance runs (MADMIN version and build, modules, OS, kernel, packages);
- know which known vulnerabilities affect the OS packages and the Python packages of each instance;
- update the OS (the kernel in particular) and MADMIN in place, quickly, on one instance or on a group;
- install manageable instances as soon as possible **without having to reinstall them** when the manager or the agent gains a feature or a fix.

The last point drives the order of the work. Anything that can be delivered later through an update is not a reason to wait. Only four things cannot be repaired by an update and must be right before the first managed instance is installed:

1. the tolerance rules of the protocol (what an old agent does with something it does not know);
2. the trust roots (release signing keys, manager CA, manager address) and how they rotate;
3. the on-disk layout of an installation (what makes an atomic swap and a rollback possible);
4. the updater itself, with automatic rollback, and a rescue path for when MADMIN does not start.

## 2. Decisions taken

| Topic | Decision |
|---|---|
| Agent placement | The agent stays inside the MADMIN process (it needs the backup, module, audit and support code). A separate, minimal **rescue** unit covers the case where MADMIN does not start. |
| Modules | All modules live in the MADMIN repository and keep their own version. A module change is shipped as a new MADMIN release (at least a minor bump), so one release id describes everything on the instance and everything can be updated together. No separate module update command. |
| Rename | `madmin-hub` becomes `madmin-manager`. The rename is done in Phase 0, before any instance is enrolled. |
| Versioning | Semantic versions starting at 1.2.0. Every release also carries a build id (git commit). |
| Existing instances | Reinstalled with the first managed release. No migration path from the flat layout. |
| Supported OS | Ubuntu 24.04 only for now. Ubuntu 26.04 later, reached by replacement (path A in 9.2). |
| Release channels | `channel` on `Release`: `candidate` on upload, promoted to `stable` by a superuser. Manager metadata, outside the signed manifest. A candidate goes only to a single instance or a canary group; any other rollout requires `stable`. |
| Signing keys | Two Ed25519 keys, passphrase-encrypted: one in the company vault, one kept by a second, independent method. Never on the manager, never in CI. Releases are signed by hand on the maintainer's machine, from a tagged commit, before the upload. |
| VMs and snapshots | Created by an operator, by hand. The manager never creates a VM or a snapshot and cannot verify that one exists. |
| Who may update | Only superusers start MADMIN updates, OS upgrades, reboots and rollouts. Partner and customer users cannot, whatever their `access`; they see versions and findings of their own instances. |

## 3. Where we are

What is already sound and stays as it is: identity by client certificate with the CA pinned at enrollment, the command allowlist with validated arguments, command persistence with deduplication by id, capability negotiation, symbolic tunnel targets, credentials redacted before storage. The manager already stores the raw facts (`Instance.facts_json`), so new facts need no schema change.

What would force a reinstall today:

| # | Problem | Where | Consequence |
|---|---|---|---|
| G1 | The agent closes the connection on an unknown frame type | `core/hub/client.py` `_reader`, `protocol.parse` | A newer manager that sends a new frame puts every older agent in a reconnect loop |
| G2 | `v` must be equal on both sides; enroll and register refuse `protocol != 1` | `protocol.py`, `agents/router.py` | A version bump cuts off the whole fleet |
| G3 | Capabilities are command names only, arguments forbid unknown fields | `core/hub/commands.py` | Adding an optional argument to an existing command breaks older agents and the manager cannot know |
| G4 | No model for long commands | `agents/dispatcher.py` (30 s wait, no progress) | Updates and OS upgrades take minutes and restart the agent |
| G5 | The version is a hand-written constant, no build id | `madmin/backend/config.py` | Instances cannot be told apart |
| G6 | Flat layout `/opt/madmin/backend`, venv in place | `setup-madmin.sh` | No atomic swap, no rollback |
| G7 | MADMIN only runs `create_all` | `core/database.py` | An in-place update with a schema change is impossible |
| G8 | The agent dies with MADMIN | `main.py` lifespan | A release that does not start makes the instance unreachable |
| G9 | Errors are Italian strings; events are lost when offline | `commands.py`, `send_event` | The manager cannot react by code; state can drift |
| G10 | No way to change the manager address or rotate its CA | `state.json`, `ca.pem` | Moving or renaming the manager means a manual re-enrollment everywhere |

The agent code is on `feat/hub-agent` in the MADMIN repository (21 commits ahead of `main`, 18 behind): it needs a rebase before any of the work below.

## 4. Phases at a glance

| Phase | Content | Touches | Gate |
|---|---|---|---|
| 0 | Rename, protocol v1 frozen with tolerance rules | manager + agent | Compatibility tests pass |
| 1 | Releases, layout, migrations, updater, rescue | MADMIN + manager | 20+ update/rollback cycles with injected faults |
| 2 | First deployment | operations | Canary group stable for two weeks |
| 3 | Inventory and vulnerabilities | agent (via update) + manager | – |
| 4 | OS actions: upgrade, reboot, kernel | agent (via update) + manager | Tested on throwaway instances |
| 5 | Manager-only features | manager | Independent, can run in parallel with any phase |

Phases 0 and 1 block the deployment. From Phase 2 on, everything reaches the instances through the updater built in Phase 1.

## 5. Phase 0 — Rename and protocol freeze

No instance is enrolled yet, so the protocol can still be changed incompatibly. After this phase it cannot: v1 only grows by addition.

### 5.1 Rename

Everything visible on the wire or on the instance's disk is renamed now. Internal names on the manager side can follow at leisure.

| Today | Becomes |
|---|---|
| repository `madmin-hub`, service `madmin-hub`, user `madmin-hub` | `madmin-manager` |
| token prefix `MHUB1-` | `MMGR1-` |
| MADMIN package `core.hub`, CLI `python -m core.hub` | `core.manager`, `python -m core.manager` |
| instance directory `DATA_DIR/hub/` | `DATA_DIR/manager/` |
| audit user `hub:<operator>`, method `HUB`, path `hub://<name>` | `manager:<operator>`, `MANAGER`, `manager://<name>` |
| login ticket `#hub-ticket=`, `POST /api/auth/token/hub-ticket` | `#manager-ticket=`, `/api/auth/token/manager-ticket` |
| installer flags `--hub-token`, `--hub-url`, `--hub-ca-sha256`, env `MADMIN_HUB_*` | `--manager-token`, `--manager-url`, `--manager-ca-sha256`, `MADMIN_MANAGER_*` |
| manager package `hub/`, env `MADMIN_HUB_ADMIN_PASSWORD`, `setup-hub.sh` | `manager/`, `MADMIN_MANAGER_ADMIN_PASSWORD`, `setup-manager.sh` |

Unchanged because they are already neutral: URL prefix `/agent/`, SSH principal `madmin-support-<instance_id>`, frame and command names.

Steps:

- [x] Agent commits of `feat/hub-agent` applied on MADMIN `main` in the new branch `feat/manager-agent` (only 3 of its commits were not already in `main`).
- [x] Rename on the MADMIN side (package, CLI, data directory, audit names, ticket route, installer flags). Support accounts are named `mgr-<operator>-<suffix>`; the user column is `is_manager_support`.
- [x] Rename on the manager side (package, service, user, database, setup script, nginx names, capabilities `manager.view`/`manager.manage`, UI strings, `CLAUDE.md`, `docs/`).
- [x] Rename the repository and its directory to `madmin-manager`. The test manager was reinstalled from scratch (service, user, database and `/opt` path changed).
- [x] Update `docs/PROTOCOL.md` and `docs/API.md` with the new names.

### 5.2 Tolerance rules (G1, G2)

These rules are the core of forward compatibility. Both sides follow them.

- `v` in a frame is the **major** version. It changes only if the frame envelope itself changes. Both sides refuse a different major.
- `hello` carries `revision_min` and `revision_max` (the revisions of v1 the agent speaks); `hello_ack.revision` is the highest one both speak, and without one the manager closes with 4400. Enroll and register check only the major, which never changes: they need no revision.
- An unknown **frame type** is ignored and logged at debug level. It never closes the connection.
- An unknown **field** in a frame or in a payload is ignored.
- An unknown **event** name is logged by the manager and otherwise ignored.
- An unknown **close code** means reconnect with backoff.
- Command **arguments** stay strict (`extra="forbid"`): a command is a privileged action and a silently dropped argument could change its meaning. Compatibility is handled by command versions (5.3) instead.

Steps:

- [x] `protocol.parse`: accept any frame type that is a string; return it; callers ignore what they do not handle.
- [x] Agent `_reader`: remove the close on `ProtocolError` for unknown types; keep it for a wrong major and for non-JSON.
- [x] `hello` / `hello_ack` revision negotiation.
- [x] Reconnect on unknown close codes.

### 5.3 Capabilities with versions (G3)

- `hello.capabilities` becomes a map `{"backup.run": 1, "support.ui.open": 1, ...}`. A command version is bumped when its arguments or result change; the manager keeps, for every command, which arguments exist from which version, and never sends an argument the agent's version does not know.
- `hello.features` is a list of agent abilities that are not commands (for example `cmd_progress`, `facts.packages`, `rescue`).
- `hello_ack.features` is the same for the manager, so the agent never uses an endpoint the manager does not have.

Steps:

- [x] `@command(..., version=1)` in the agent registry; `capabilities()` returns the map.
- [x] Manager: `AgentConnection.capabilities` as a map, `check_capability(instance_id, name, min_version=1)`; `Instance.capabilities_json` stores the map.
- [x] `features` on both sides.

### 5.4 Settings pushed by the manager

`hello_ack.config` carries values the agent applies if it knows them, each clamped to a safe range on the agent: `heartbeat_interval` (30–600 s), `facts_interval` (60–3600 s), `backoff_max` (30–900 s). The fleet can then be tuned from the manager settings without an update. Unknown keys are ignored.

- [x] Agent: apply and clamp. Manager: settings fields and `hello_ack.config`.

### 5.5 Structured errors (G9)

`cmd_result` on failure: `{"ok": false, "error": {"code": "...", "message": "..."}}`. Stable codes: `unsupported`, `invalid_args`, `expired`, `busy`, `timeout`, `precondition` (the instance is not in a state where the command makes sense), `failed` (attempted, did not succeed), `internal`. The message is for the operator and may be in Italian; the manager's logic uses only the code.

- [x] Agent: `CommandError(code, message)`. Manager: store `Command.error_code`, map codes to HTTP statuses in `run_command`.

### 5.6 Long commands (G4)

- New frame `cmd_progress` (agent → manager, same `id` as the command): `{"state": "running", "step": "...", "percent": 0-100?, "message": "..."}`. The first one is sent when the command starts, so the manager knows it was accepted.
- Command states on the manager: queued → sent → **running** → done | failed | expired. A command that is `running` is never expired by the delivery TTL.
- Two separate times in the `cmd` frame: `exp` (do not start after this) and `timeout` (how long the execution may take, optional, clamped by the agent per command).
- Results of long commands are written to disk before they are sent (`persist_result`, already there), and progress of an interrupted command is recovered through the state in `hello` (5.7).

Steps:

- [x] Frame type, agent `ctx.report(...)`, manager `Command.status = "running"`, `progress_json`, UI display.
- [x] `exp` / `timeout` split; `expire_task` skips running commands and fails them only after `timeout` plus a margin.

### 5.7 State reconciliation instead of reliable events (G9)

Events stay best effort. What must never drift is sent as **state** in every `hello`, and the manager reconciles:

```json
"state": {
  "support": {"ui": ["<username>", "..."], "ssh": {"open": true, "expires_at": 1730000000}},
  "licenses": ["<license_id>", "..."],
  "commands": {"running": ["<cmd id>"], "finished": ["<cmd id>"]},
  "update": {"release_id": "...", "result": "ok | rolled_back | failed", "detail": "...", "at": 1730000000}
}
```

- The manager closes support sessions the instance no longer has, re-installs missing licenses, asks again for the result of finished commands it has no result for, and records the outcome of the last update.

Steps:

- [x] Agent: collect the state. Manager: `reconcile(instance_id, state)` (`manager/agents/reconcile.py`) right after every connection. `update` is added with Phase 1.

### 5.8 Close codes

| Code | Meaning | Agent |
|---|---|---|
| 4400 | malformed frame, wrong major | reconnect with backoff |
| 4401 | revoked | stop, remove support access, wait for a new enrollment (unchanged) |
| 4403 | suspended | keep everything, retry every 15 minutes |
| 4409 | superseded | reconnect (unchanged) |
| 4429 | try later; the reason carries the seconds | reconnect after that delay |

- [x] Add 4403 and 4429 on both sides; instance status `suspended` on the manager (Sospendi / Riattiva, superuser). The manager does not send 4429 yet: the agent behaviour is what is frozen.

### 5.9 Moving the manager and rotating its CA (G10)

- Command `manager.relocate {"url": "https://host:port"}`: the agent checks that the new address presents a certificate valid for that host under the **pinned CA**, connects there, and only after a successful `hello_ack` writes the new address to `state.json`. If it fails, it stays on the old address. The CA is the trust anchor, so a relocation cannot hand the instance to someone else.
- CA rotation: the response of `/agent/renew` may carry `ca_bundle` (PEM, several certificates). The agent accepts a new CA certificate only if it is signed by a CA it already trusts (cross-signed), and keeps both until the old one expires. Agent certificates are 90 days, so a rotation reaches the whole fleet within one renewal period.
- The CA lifetime (`CA_DAYS` in `pki.py`) is checked and documented, with a reminder in the manager dashboard two years before the expiry.

Steps:

- [x] `manager.relocate` command with the verify-then-commit sequence (`POST /api/instances/{id}/relocate`, `POST /api/instances/relocate` for every active instance; "Cambia indirizzo" in the instance page).
- [x] `ca_bundle` in `hello_ack` and in the renew response; agent trust store with several CAs (cross-signed only); `python -m manager.pki rotate-ca status|prepare|activate|retire`.

### 5.10 Identity facts (G5)

Added to `facts`: `version` (semver, replaces `madmin_version`), `build` (git commit, 12 hex), `release_id` (`<version>+<build>`), `layout` (integer, the on-disk layout revision), `updater` (version of the updater), `rescue` (version of the rescue unit). They are read from the release manifest written at build time (Phase 1), never typed by hand. In development (no manifest) they are `dev`.

- [x] Agent facts `version`, `build`, `release_id`, `layout` from `manifest.json` (written by `setup-madmin.sh` until Phase 1 writes it in the release build); manager columns `build` (indexed) and `layout` filled by `apply_facts`. `updater` and `rescue` are added with Phase 1 (additive).

### 5.11 Support duration

`support.ui.open` and `support.ssh.grant` accept `minutes` 5–1440 (was 5–480): a support session lasts one day at most (10.4). Changed now because the range is validated on the instance and a later change would need a command version bump.

- [x] Agent argument models, manager validation and UI, `docs/PROTOCOL.md`.

### 5.12 Phase 0 exit criteria

- [x] `docs/PROTOCOL.md` rewritten for the frozen v1, with a section "Compatibility rules" that states 5.2 as normative.
- [x] `protocol.py` identical in both repositories.
- [x] A compatibility test on the test server: `scripts/agent-compat-check.py` stands in for a newer manager and sends unknown hello_ack fields, an unknown frame type, an unknown command, an unknown payload field, an unknown argument and an unknown close code; the agent stays connected, answers `unsupported` / `invalid_args` and comes back (passed 2026-11-11).
- [x] The Phase 0 agent is tagged (`agent-v1-baseline` in the MADMIN repository): every later manager version is tested against it.

Tested on the test server on 2026-11-11, besides the above: install of manager and instance from the branches, enrollment with a token, refresh, stats, backup and restore (with progress), UI support (1000 minutes) through the tunnel with a single-use ticket, SSH support (900 minutes) with a certificate, error codes, agent settings pushed by the manager, suspension (4403, reconnection after exactly 15 minutes), reconciliation of a lost SSH grant and of a deleted license, relocation (refused addresses, move to another name, back), a complete CA rotation (prepare, activate, renewal, retire) without losing the instance.

## 6. Phase 1 — Releases, updater, rescue

This phase is the real gate. Nothing is deployed until an instance can be updated and can roll back by itself.

### 6.1 Versions and releases

- Semantic version of MADMIN in one place; each module keeps its `version` in its manifest. A change in a module bumps the module version **and** the MADMIN version (minor, or patch for a fix).
- A release is one tarball `madmin-<version>+<build>.tar.zst` with:
  - `backend/`, `frontend/`, `scripts/` (installer, updater, rescue, units);
  - `wheels/<os>/` (for example `wheels/ubuntu-24.04/`): every Python dependency of `requirements.lock` as a wheel, so an update never depends on PyPI being reachable or unchanged. One directory per supported OS from the start, because the compiled wheels (asyncpg, cryptography, bcrypt) are tied to the Python version of the OS: a release that supports two Ubuntu versions carries two sets, and the updater picks the one of the running OS;
  - `manifest.json`:

```json
{
  "format": 1,
  "version": "1.3.0",
  "build": "a80bb4054265",
  "created": "2026-12-01T10:00:00Z",
  "min_from": "1.2.0",
  "layout": 1,
  "schema": {"core": 7, "modules": {"wireguard": 3, "dns": 2}},
  "modules": {"wireguard": "1.4.0", "dns": "1.1.0"},
  "os": ["ubuntu-24.04"],
  "apt": ["..."],
  "allow_downgrade_from": [],
  "files_sha256": "<sha256 of the sorted list 'sha256  path' of every file>"
}
```

- Signature: detached Ed25519 over the manifest bytes (`manifest.json.sig`), made with an **offline maintainer key**. The tarball content is bound by `files_sha256`.
- Two public keys are shipped in the MADMIN repository (`backend/core/manager/release_keys.py`): a primary and a reserve kept in a different place. Either is accepted. A key is replaced by a release signed with the other one.
- The manager is only a distributor. It stores releases uploaded by a superuser, verifies the signature on upload to refuse garbage early, and serves them to instances over mTLS. A compromised manager can choose among validly signed releases, never forge one.
- Downgrade protection on the instance: a release older than the installed one is refused unless the installed version is listed in `allow_downgrade_from` of the (signed) manifest.

Steps:

- [x] `scripts/build-release.sh` in MADMIN: `git archive HEAD` → wheelhouse (core and module dependencies, `-c requirements.lock`) → manifest → `.unsigned.tar`. The `.release` is a tar of `manifest.json`, `manifest.json.sig` and `payload.tar.gz` (the manifest carries the payload sha256), so nothing is unpacked before signature and hash are checked.
- [x] `scripts/sign-release.sh` and `scripts/release-key.sh` (openssl only, offline machine); verification in `madmin-update verify` (stdlib + openssl), run by the agent before starting the update and again by the updater.
- [ ] Key ceremony: generate primary and reserve keys and commit their public halves in `scripts/release-keys/` (procedure in MADMIN `docs/RELEASING.md`). **Until then only keys placed by root in `/etc/madmin/release-keys.d/` are trusted.**
- [x] Manager: `Release` table, upload in the UI (signature checked when release keys are set in the settings), channels candidate/stable, `GET /agent/releases/<release_id>`. Not done: download resume, retention.
- [x] Version and build reported from `manifest.json` (`config.build_info`).

### 6.2 Installation layout (G6)

```
/opt/madmin/
  releases/<version>+<build>/   backend/ frontend/ venv/ manifest.json   (read-only after install)
  current -> releases/<...>     the running release (atomic symlink swap)
  previous -> releases/<...>    the one to roll back to
  data/                         DATA_DIR, never inside a release
  etc/madmin.env                the former backend/.env
  updater/                      updater + rescue, outside the releases
  state/                        update journal, DB snapshots, downloaded tarballs
```

- `madmin.service` uses `WorkingDirectory=/opt/madmin/current/backend`, `EnvironmentFile=/opt/madmin/etc/madmin.env`, `ExecStart=/opt/madmin/current/venv/bin/uvicorn ...`.
- nginx serves the frontend from `/opt/madmin/current/frontend`.
- Two releases are kept (current and previous); older ones are deleted after a committed update.
- `setup-madmin.sh` installs **from a release tarball** into this layout (and can still build one from a checkout for development). The installer and the updater share the same "install a release" code, so the update path is exercised by every fresh install.

Steps:

- [x] `setup-madmin.sh` installs through `madmin-update bootstrap --from-checkout` (same layout as an update) and refuses to run over an existing installation.
- [x] Settings in `etc/madmin.env`, modules next to the code of the release, firewall boot unit on `current/`.
- [x] `uninstall-madmin.sh` updated.

### 6.3 Database migrations in MADMIN (G7)

- Table `schema_version (component, version, applied_at)`; `component` is `core` or a module id.
- Migrations are numbered Python files (`core/migrations/0007_<name>.py`, `modules/<id>/migrations/0003_<name>.py`), each with one `async def upgrade(conn)`. Forward only, each in its own transaction, idempotent where the DDL allows it.
- At startup: `create_all` (new tables), then the pending migrations in order, then the existing one-shot data fixes (which become numbered migrations). A fresh install records the latest version without running anything.
- There is no `downgrade`. A rollback restores the `pg_dump` taken by the updater just before the migration. That is acceptable because the window between the dump and the commit of the update is a few minutes and the service is stopped for most of it; what is lost on rollback is only what changed after the new release started (documented, and the audit log is forwarded to syslog anyway).
- The backup restore keeps its tolerance for older archives: it remains the path between instances, the migrations are the path in place.
- Rule for developers, added to MADMIN's `CLAUDE.md`: a change of an existing column or table needs a migration and a bump of `schema` in the manifest; the release build fails if models and migrations disagree (check: build an empty DB with `create_all`, build another from the 1.2.0 schema plus all migrations, compare the two schemas).

Steps:

- [x] Runner and `schema_version` (`core.migrations`): 1.2.0 databases start at 0, fresh ones record the latest step. Not done: the schema comparison check in the release build.
- [ ] Existing one-shot fixes in `main.py` converted (kept as they are: idempotent).
- [ ] The same mechanism for the manager itself (see 10.5).

### 6.4 Updater

A single file, standard library only, in `/opt/madmin/updater/madmin-update`, never run from inside a release. Started by the agent with `systemd-run --unit=madmin-update-<id> --collect` so it survives the restart of MADMIN, and usable by hand as root (`madmin-update install <tarball>`, `madmin-update rollback`, `madmin-update status`).

Command: `madmin.update {"release_id": "...", "sha256": "..."}` (long command, `persist_result`, progress frames). The manager names a release, never a URL: the agent downloads only from `/agent/releases/<release_id>` of its own manager.

Sequence, each step written to `state/update.json` before it starts so an interrupted run is resumed or rolled back at the next boot (a `madmin-update-recover.service` runs before `madmin.service`):

1. **Download** to `state/`, check the sha256, check the free space (3× the tarball).
2. **Verify** the signature, `min_from`, `os`, `layout`, the downgrade rule.
3. **Unpack** into `releases/<id>.new/`, check `files_sha256`.
4. **Build** the venv from `wheels/<os>/` only (`pip install --no-index --find-links`), install the `apt` packages the manifest adds. The same step is available alone as `madmin-update rebuild-venv`, which rebuilds the venv of the current release for the OS now running (needed after an OS release upgrade, 9.2).
5. **Preflight** with the new code, service still running: import the application, load the configuration, check that the pending migrations are known. A failure here ends the update with nothing changed.
6. **Snapshot**: stop `madmin.service`, `pg_dump -Fc` to `state/`, copy of `etc/` and of the small state files in `data/`. (The firewall rules stay loaded in the kernel while MADMIN is stopped: traffic is not interrupted.)
7. **Switch**: rename `<id>.new` → `<id>`, `previous` → old, `current` → new (atomic rename of a temporary symlink), refresh the units if they changed, `daemon-reload`.
8. **Start**: `systemctl start madmin.service`; the migrations run at startup.
9. **Health gate**, within a deadline (default 5 minutes):
   - systemd `READY=1` and the unit stays active;
   - the local health endpoint answers;
   - **the agent is connected to the manager and the manager confirmed the update**: the `hello` after the restart carries `state.update = {release_id, result: "verifying"}`, the manager answers with `hello_ack.update_confirm = <release_id>`. This is the check that catches a release that starts but breaks the network, the firewall or the agent.
   - If the instance was not connected to the manager when the update started (manual run), the third check is skipped.
10. **Commit**: write the result, delete the snapshot after 7 days, delete releases older than `previous`. Then, last and separately, replace the updater and the rescue with the ones shipped in the new release (a broken new updater can therefore never prevent the rollback of the update that brought it).
11. **Rollback** on any failure after step 6: stop, `current` → previous release, restore the dump (drop and recreate the database), restore `etc/`, start, and check health again. The result (`rolled_back` and the reason, with the last lines of the journal) is reported in the next `hello`.

If the rollback itself does not come up, the rescue unit (6.5) is what is left.

Manager side:

- [x] `madmin.update` in the UI of an instance (Aggiorna), with the progress and the result; version and build per instance.
- [x] `hello_ack.update_confirm`; the result shown is the updater's journal (`ok` only after the commit).
- [x] Audit of who started which update (the command's operator, manager audit log).

Steps on the MADMIN side:

- [x] `madmin-update` (verify, install, rollback, status, recover, rebuild-venv, bootstrap), `madmin-update-recover.service` (`recover --boot`).
- [x] Agent command with progress (download, verify, started). Not done: download resume.
- [x] `state.update` in `hello`, `update.status` event.

### 6.5 Rescue unit (G8)

`madmin-rescue.timer` runs `/opt/madmin/updater/madmin-rescue` (standard library only: `ssl`, `http.client`, `subprocess`) every 5 minutes. It does nothing while `status.json` of the agent says it was connected in the last 15 minutes. Otherwise:

- if an update is half done, it calls `madmin-update recover`;
- it calls `POST /agent/rescue` with the client certificate: unit state, the last 200 lines of the journal, release ids of `current` and `previous`, disk space;
- the manager answers with at most one action from a closed list: `none`, `restart` (restart `madmin.service`), `rollback` (`madmin-update rollback`), `install {release_id, sha256}` (a signed release, the same verification as an update). The action is chosen by a superuser in the UI ("Istanza in rescue"), never automatically.

The rescue never opens a shell, a tunnel or support access: with MADMIN down there is no audit log to record it. It is the last resort before the hypervisor console, and it is small on purpose.

Steps:

- [x] `madmin-rescue`, timer and service units, installed by the installer.
- [x] Manager: `/agent/rescue`, rescue panel with the journal tail and the three actions. Not done: notification.

Bugs found by these tests and fixed (2026-11-11): the rollback restored an empty database (pg_restore could not read the root-only dump) and reported success; boot recovery deadlocked with madmin.service and then cancelled its start; build-release.sh lost its version when reading os-release.

### 6.6 Phase 1 exit criteria

On the test server, with a throwaway instance, each case repeated until it passes three times in a row:

- [x] Fresh install in the releases layout (from a checkout, as the installer does).
- [x] Update N → N+1 with a schema migration; data intact.
- [x] Update where the new release fails to import → nothing changed (preflight).
- [x] Update where the migration fails → rollback, data intact.
- [x] Update where MADMIN starts but the agent cannot reach the manager (firewall rule injected) → rollback after the deadline.
- [x] Updater killed during the venv step (recover cleans up) and during the health gate, then reboot (recovered at boot, MADMIN up again).
- [ ] Disk full during unpack and during the dump → clean failure (not tested yet).
- [x] Tampered payload, untrusted key, older version → refused; unsigned file refused by the manager.
- [x] MADMIN stopped by hand → rescue reports, `restart` and `install` from the manager work (`rollback` tested through `madmin-update rollback`).
- [x] Two consecutive updates, then rollback → returns to the middle release, schema back to the one before.
- [ ] The `agent-v1-baseline` agent still works against the current manager.

## 7. Phase 2 — First deployment

- [ ] Production manager installed (final host name, backups of `DATA_DIR/pki` and of the database, `SECRET_KEY` stored offline: losing it makes the PKI unreadable).
- [ ] Manager UI restricted to known source addresses, TOTP step-up and per-user SSH keys in place (10.4) before the first customer instance is enrolled.
- [ ] Release 1.2.x built, signed and uploaded as the first managed release.
- [ ] 2–3 internal instances reinstalled and enrolled; one update pushed to them through the manager.
- [ ] A canary group of customer instances reinstalled (the usual backup → new instance → restore, for the last time).
- [ ] Two weeks without a rescue event or an unexplained disconnection, then the remaining instances are reinstalled as their maintenance windows allow.
- [ ] `docs/OPERATIONS.md`: how to release, update a group, read a failed update, use the rescue, rotate keys.

## 8. Phase 3 — Inventory and vulnerabilities

Delivered to the instances as a normal update.

### 8.1 Facts

Heavy facts are sent by digest: `facts.sections = {"packages": "<sha256>", "python": "<sha256>"}`; when a digest changes the manager asks for the section with `inventory.get {"section": "..."}`.

| Section | Content | Source on the instance |
|---|---|---|
| `packages` | name, version, architecture, source package of every installed package | `dpkg-query -W` |
| `python` | name and version of every package in the venv | `importlib.metadata` |
| `os` (in the normal facts) | distribution id and version, running kernel, newest installed kernel, `reboot_required` and the packages that ask for it, number of pending updates and of pending security updates, state of unattended-upgrades, date of the last `apt update` | `/etc/os-release`, `/var/run/reboot-required*`, `apt-get -s upgrade` |

Steps:

- [ ] Agent: sections, digests, `inventory.get`.
- [ ] Manager: `InstancePackage` table (or a JSON column per section, to be decided on the size measured in the field), history of the changes.

### 8.2 Matching

- **Python packages**: every instance of a release has the same lock file, so the scan is per release, not per instance. The release build queries OSV for `requirements.lock` and refuses to build on a known critical vulnerability unless it is waived in writing; the manager repeats the query daily for every release that is installed somewhere, and shows the result on the release and on each instance that runs it.
- **OS packages**: the manager downloads the Ubuntu security data (OSV, ecosystem `Ubuntu:<release>`) daily and matches it against the `packages` section of each instance: CVE, severity, fixed version, whether a reboot is needed.
- The instance's own view (`pending security updates`) is shown next to it: when the two disagree, the instance's `apt` sources are probably stale.

Steps:

- [ ] Manager: feed downloader with a local cache (the manager may be the only machine with outbound access), matcher, tables `Advisory` and `InstanceFinding`.
- [ ] UI: fleet view by version, by CVE, by "reboot required"; per-instance tab; filters by group; export.
- [ ] Notifications (e-mail, and the UI badge of 10.2) for a new critical finding.
- [ ] Scope: findings are filtered like everything else (`hub/scope.py`): a partner sees only its subtree.

## 9. Phase 4 — OS actions

### 9.1 Upgrades, reboot, kernel

All of these are superuser only (`hub.manage`), in the UI and in the API.

The manager never names a package, a version or a command line: the actions are categories.

| Command | Arguments | Notes |
|---|---|---|
| `os.refresh` | – | `apt-get update`, then new facts |
| `os.upgrade` | `scope`: `security` \| `all` | long command; `security` uses only the security pocket; holds are respected; the result lists what changed and whether a reboot is required |
| `os.reboot` | `delay_minutes` 0–1440, `reason` | long command across the reboot: the result is the `hello` after it (new `boot_time`, running kernel) |
| `os.reboot.cancel` | – | cancels a scheduled reboot |

A router that reboots is an outage for the customer, and the firewall is fail-closed at boot: if MADMIN does not start after the reboot, the instance is reachable only from the hypervisor console. Therefore:

- A reboot is refused (`precondition`) while an update or a restore is running, and an OS upgrade never reboots by itself.
- **Kernel on trial**: after an upgrade that installed a new kernel, the reboot uses `grub-reboot` to boot the new kernel **once**, with the saved default still on the old one. When the agent is connected again and the manager confirms (same mechanism as the update confirmation), the agent makes the new kernel the default. If the instance does not come back within the deadline, a local timer (`madmin-boot-check.timer`, started at boot, 15 minutes) reboots again, which brings back the old kernel. This needs `GRUB_DEFAULT=saved`, set by the installer from Phase 1 on so that no reinstall is needed when this phase arrives.
- The previous kernel is never auto-removed while it is the fallback.

Steps:

- [x] `GRUB_DEFAULT=saved` in the installer (`/etc/default/grub.d/99-madmin.cfg`). The boot-check unit needs no installer change: units ship in the release (`scripts/systemd/`) and `madmin-update` installs them at the switch, restoring the old ones on rollback.
- [ ] The four commands, with progress.
- [ ] Manager: actions in the instance UI (superuser only), confirmation dialogs that state the outage.
- [ ] Tested on throwaway Ubuntu 24.04 instances, including a kernel that deliberately fails to boot.

### 9.2 From Ubuntu 24.04 to 26.04 (evaluation, not scheduled)

A remote upgrade through the manager is possible, in two ways. Neither needs anything on the instances beyond what Phases 0–1 already install, provided the points under "Kept open now" are respected.

**A. Replacement.** The flow used today, with the manager doing everything except the VM: `backup.run` → an operator creates a new 26.04 instance → it enrolls with a token whose `external_ref` is the old instance's (already supported: same identity, backups and licenses) → `backup.restore` → the old VM is kept switched off for a few days. The rollback is switching the old VM back on. It depends on the restore tolerating an archive of the previous release, which it already does, and on the provisioning system being able to create the VM with the same addresses. As a rollout it handles a whole group with a canary step.

**B. In place (`do-release-upgrade`).** Feasible as a later long command (`os.release_upgrade {"target": "26.04"}`, the target taken from a closed list), but it is the riskiest action in this document:

- It is not atomic and has no rollback of its own: the only way back is a hypervisor snapshot. The command would therefore require the operator to declare that a snapshot exists, and the manager cannot verify it unless the provisioning system exposes it.
- The system Python changes, so the venv of the running release stops working: the installed MADMIN release must already support both OS versions (a *bridge release* with `os: ["ubuntu-24.04", "ubuntu-26.04"]` and both wheel sets), and the venv is rebuilt right after the upgrade with `madmin-update rebuild-venv`.
- PostgreSQL moves to a new major version: the cluster must be upgraded (`pg_upgradecluster`) with the dump of the updater as the safety net.
- Configuration files that MADMIN and its modules write under `/etc` (nginx, sshd, netplan, iptables-persistent, strongSwan, OpenVPN, WireGuard, dnsmasq/DHCP) meet new package versions: each module needs to be tested on 26.04 first, and the upgrade must run with "keep the local version" for every prompt.
- It takes tens of minutes, ends with a reboot of a fail-closed router, and runs while MADMIN itself may be unable to start. The orchestration therefore belongs in the updater (outside the MADMIN process, journal on disk, resumed at boot), with the rescue unit as the only channel to the manager in the middle. Both are standard library only, which is what lets them survive the Python change.

Sequence for B: bridge release installed and committed → preflight (disk space, no held or foreign packages, snapshot declared) → DB dump → `do-release-upgrade` non-interactive → cluster upgrade → `rebuild-venv` → reboot on trial (as for a kernel) → health gate with the manager's confirmation → commit. A failure before the reboot is reported through the rescue; a failure after it needs the snapshot.

**Decision: path A.** It is the procedure already trusted and its rollback is trivial. Since the VM is created by an operator, the manager does not run it as an unattended rollout but as a guided procedure per instance ("Sostituisci istanza"), which removes the manual steps around the VM:

1. the manager runs `backup.run` and checks the archive arrived;
2. it issues a single-use re-enroll token tied to the instance and shows the install command for the new VM;
3. the operator creates the 26.04 VM, switches the old one off (same addresses) and runs the installer with the token;
4. when the new instance connects with the same identity, the manager runs `backup.restore` with the archive of step 1, re-installs the licenses and shows the result;
5. the operator deletes the old VM after a few days. Until then, the rollback is switching it back on (its certificate was revoked by the re-enrollment, so it also needs a re-enroll token: the procedure offers one).

The fleet view lists the instances still on the old OS, so the work can be planned by group. Path B is not built; it stays documented here in case replacement turns out to be impractical for some instance.

**Kept open now**, so that neither path needs a reinstall later:

- wheels per OS in the release format and `os` as a list in the manifest (6.1);
- `madmin-update rebuild-venv` (6.4);
- updater and rescue free of any dependency outside the standard library, and written for the oldest and the newest Python they may meet;
- `os` (distribution id and version) among the facts, so the manager offers a release only to instances whose OS it lists;
- no path in MADMIN that contains the Python version or the PostgreSQL major version.

## 10. Phase 5 — Manager-only features

None of these touches the agent. They can be done at any time, also in parallel with Phases 0–1.

### 10.1 Bulk operations and rollouts

- `Rollout`: an action (update to a release, OS upgrade, reboot, backup, license install) on a target set (group subtree, labels, version filter, or an explicit list), with a concurrency limit, an optional canary step (N instances first, then wait for a confirmation or a delay), a stop threshold (halt when more than X% fail), and an optional maintenance window per group.
- Each target is an ordinary persistent command: an offline instance receives it when it connects, within the rollout's deadline.
- Rollouts of updates, OS upgrades and reboots are superuser only. Backup rollouts follow the scope rules: they can only contain instances the user may manage, re-checked when each command is created.

- [ ] Tables `Rollout`, `RolloutTarget`; scheduler task; UI (progress, halt, resume, retry the failed ones).
- [ ] Maintenance windows on `InstanceGroup`.

### 10.2 Pending approval notification

- [ ] Badge on the Enrollment menu entry and a toast when a registration request arrives (the UI polls or uses its existing channel); optional e-mail to superusers.

### 10.3 LDAP users

- [ ] LDAP/AD as an authentication source: bind as the user, mapping of LDAP groups to `role`, `access` and `group_id`; users are created at the first login; local users keep working (at least one local superuser is always kept as a way in).
- [ ] TOTP stays enforced by the manager also for LDAP users.
- [ ] A user removed from LDAP or from the mapped group loses the sessions at the next check.

### 10.4 Support access hardening

Today a stolen superuser `rw` account can open a superuser UI session and root SSH on any instance. Decided measures (no hardware keys or tokens are used):

**Step-up at every opening.** Opening a support session (UI or SSH) asks for a fresh TOTP code, whatever the age of the login session. A code is accepted once: the last accepted time step is stored per user, so a code seen over the operator's shoulder or replayed from a stolen session is refused. A user without TOTP cannot open support.

- [x] `POST` of a support session takes `totp`; check and replay guard in `core/auth` (`require_step_up`); UI prompt. Backup codes are not accepted.
- [x] Failures count toward the existing lockout (5 → 2FA locked, sessions revoked).

**SSH only to the user's registered public key.** Each user stores SSH public keys (only the public half; several, each with a name and last use). A support SSH session signs the certificate for one of the user's **approved** keys; a key can no longer be pasted when the session is opened. The key id in the certificate names the user, so the instance's sshd log says who connected.

- A key that is added or replaced is `pending` and unusable until **another** superuser approves it (never the owner, never a superuser `ro`). The approver sees the fingerprint and the owner; the owner and all superusers are notified. Removing a key needs no approval.
- With a single superuser on the manager there is nobody to approve: the key is approved from the manager's root CLI (`python -m manager.keys approve <user> <fingerprint>`), like the other bootstrap operations.
- An approval is revoked when the user's role or group changes.

- [x] Table `UserSshKey` (user, name, public key, fingerprint, status pending | approved, approved_by, approved_at, last_used_at); UI on the Support page (own keys, approval list); CLI `python -m manager.keys list|approve`.
- [x] `support/service.py`: the SSH grant takes a key id, refuses anything not approved and not the caller's. The certificate key id is `<user> <fingerprint> <instance>` (in the instance's sshd log); the session stores the fingerprint.
- [x] Audit of add, approve, remove (audit middleware; the CLI writes its own entry), use (`last_used_at`, session row).
- [ ] Notification of a new key to the owner and the superusers: with 10.2 (for now, the badge on the Support page).

**Limits.** At most **4 open support sessions per user** at the same time (UI and SSH together, across all instances); a fifth is refused until one is closed or expires. No limit on how many are opened over time. Every session has the expiry chosen when it is opened, **1 day at most**.

- [x] Count of open sessions per user in `support/service.py` (409 with the list of the open ones; checked before the TOTP code, which is then not consumed; replacing one's own SSH session on the same instance does not count twice).
- [x] The duration range becomes 5–1440 minutes. `support.ui.open` and `support.ssh.grant` validate `minutes` on the instance (5–480 today), so the new range is set in **Phase 0**, before the protocol freeze (5.11).

**Source addresses.** The manager UI is reachable only from known source addresses. This is enforced in front of the application (nginx `allow`/`deny` on the UI server, written by the setup script from a list, plus the network firewall), not by the application, so a bug in the application cannot open it. The agent port stays open to the instances.

- [x] `setup-manager.sh --ui-allow <cidr,...>` (`/etc/nginx/snippets/madmin-manager-ui-allow.conf`; a reinstall without the option keeps it; edit + `systemctl reload nginx` to change it).
- [ ] Listed among the Phase 2 requirements for the production manager.

Not adopted for now: a separate permission for support, notification of every opening, approval by a second superuser for root SSH, consent on the instance side. The last one is the only measure that also holds against a fully compromised manager (which owns the SSH CA); it is additive on the agent and can be delivered later by an update.

### 10.5 Migrations and backup of the manager itself

- [x] The same numbered migrations as 6.3 for the manager database (`backend/core/migrations/`, component `manager` in `schema_version`). `CLAUDE.md` updated.
- [x] Backup and restore of the manager: `scripts/manager-backup.sh` (encrypted archive: database, `DATA_DIR`, `SECRET_KEY`) and `scripts/manager-restore.sh` (onto a freshly installed manager, through a staging database). Tested on the test manager: backup → uninstall → fresh install → restore (schema step 0001 applied to the old database) → the instance reconnected by itself. A restore onto a *second* machine is the same procedure with the same address.

## 11. Compatibility policy (from Phase 2 on)

- The manager is always updated **before** the instances and supports every agent since `agent-v1-baseline`.
- The protocol major (`v`) is not bumped. If it ever has to be, the manager speaks both majors for as long as one instance uses the old one.
- A new command, frame, fact, event, feature or config key is an addition and needs no coordination.
- A change of the arguments or of the result of an existing command bumps that command's version; the manager keeps handling the older versions.
- Nothing is removed from the protocol while an enrolled instance advertises it.
- Every release is tested against the oldest agent in the field before it is uploaded to the production manager.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Loss of both release signing keys | Two keys in two places; without them no update is possible and every instance must be reinstalled with new keys |
| Loss of the manager's `SECRET_KEY` or CA key | Offline copy; tested restore (10.5) |
| A release that passes the health gate but breaks a module | Canary step in rollouts; `madmin-update rollback` stays possible until the next update |
| Data written between the snapshot and a rollback is lost | Short window, documented; the audit log is forwarded to syslog |
| A reboot leaves a fail-closed instance unreachable | Kernel on trial with automatic fallback; console procedure in `docs/OPERATIONS.md` |
| The single-worker manager is a single point of failure | Instances keep working without it; a tested restore procedure; no agent state lives only in memory that the next `hello` does not rebuild |
| Scope creep before the first deployment | Only Phases 0 and 1 block it; everything else is delivered by update |

## 13. Open points

- Consent on the instance side for support access (10.4, not adopted for now).
