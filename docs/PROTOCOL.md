# MADMIN ↔ MADMIN Manager protocol (v1)

`protocol.py` is identical in both repositories:
`madmin/backend/core/manager/protocol.py` and `madmin-manager/backend/manager/agents/protocol.py`.
Any change updates this document and is copied to the other side in the same change.

## Compatibility rules (normative)

Instances are updated after the manager and can stay on an older release for a long time. These rules let any manager talk to any agent released since protocol v1 was frozen, and they apply to both sides.

- `v` in every frame is the **major** version of the envelope (`PROTOCOL_VERSION`). It is never bumped; a frame with a different `v` is refused (close 4400).
- Each side speaks a range of **revisions** (`PROTOCOL_REVISION_MIN`..`PROTOCOL_REVISION`). `hello` carries the agent's range, `hello_ack.revision` the highest revision both speak. With no common revision the manager closes with 4400.
- An unknown **frame type** is ignored (logged), never a reason to close.
- An unknown **field** in a frame, a payload, `hello_ack.config` or the facts is ignored.
- An unknown **event** is logged by the manager and otherwise ignored.
- An unknown **close code** means: reconnect with backoff.
- **Commands are versioned one by one.** `hello.capabilities` maps every command the agent implements to its version (`{"backup.run": 1, ...}`). A command's version is bumped when its arguments or its result change; the manager keeps the older shapes and never sends an argument the agent's version does not know. Command arguments stay strict on the agent (unknown fields are rejected): a silently dropped argument could change the meaning of a privileged action.
- **Features** are abilities that are not commands. The agent lists its own in `hello.features`, the manager in `hello_ack.features`; a side uses a feature only if the other announced it.
- Nothing is removed while an enrolled instance still advertises it.

## Transport and identity

| Endpoint (manager, agent port 8443) | Client certificate | Purpose |
|---|---|---|
| `GET /agent/ca.pem` | no | manager CA; the instance accepts it only if its sha256 matches the token |
| `POST /agent/enroll` | no | token + CSR → certificate (rate limited) |
| `POST /agent/register` | no | CSR + facts (+ `ca_pinned`) → `request_id`, `request_secret`, `key_fingerprint`, `poll_interval` |
| `GET /agent/register/{id}` | no (`X-Request-Secret`) | `status` pending \| approved \| rejected \| expired; when approved, the same fields as the enroll response |
| `POST /agent/renew` | yes (a suspended instance too) | CSR → `cert_pem` (at 2/3 of the lifetime), `ca_bundle`? during a CA rotation |
| `POST /agent/unenroll` | yes | instance decommissioned |
| `WSS /agent/ws` | yes | control channel |
| `WSS /agent/tunnel/{conn_id}` | yes | one support tunnel (binary frames) |
| `POST /agent/backups` | yes | backup upload (`X-Content-SHA256`, `X-Command-Id`, `X-Archive-Name`) |
| `GET /agent/backups/{id}` | yes | backup download (only this instance's, `X-Content-SHA256`) |
| `GET /agent/releases/{release_id}` | yes | a `.release` file the manager holds (`madmin.update`) |
| `POST /agent/rescue` | yes | report of `madmin-rescue` (MADMIN down or not connected) → `{"action": null \| {id, action: restart \| rollback \| install, release_id?, sha256?}}` |

- Identity: X.509 client certificate issued by the manager CA, CN = `instance_id`, 90 days. The private key (ECDSA P-256) never leaves the instance.
- nginx verifies the chain (`ssl_verify_client optional`) and passes `X-SSL-Client-Verify` and `X-SSL-Client-Cert`. The manager looks up the sha256 fingerprint: unknown or revoked certificate, or instance not `active`, means refusal.
- The instance trusts only the manager CA (pinned at enrollment) and checks the hostname.

## Enrollment token

`MMGR1-` + base64url(JSON) with these fields:

- `u`: agent URL (`https://host:8443`)
- `f`: sha256 of the manager CA (DER, hex)
- `i`: token id
- `s`: secret

The manager stores only `sha256(s)`. A token can be single-use or multi-use. It has an expiry, an optional group, and it can be revoked. A *re-enroll* token is tied to an existing `instance_id`: the instance keeps its identity, backups and licenses, and its old certificates are revoked.

Enrollment response: `instance_id`, `cert_pem`, `ssh_ca_pub` (OpenSSH), `license_pub` (Ed25519 raw, base64), `backup_passphrase`.

A token can carry optional fields that are applied to the instance when it enrolls: `name`, group, `labels`, `external_ref`. It can also have a `bind_ip`. When a token has an `external_ref` that already belongs to a live instance, it re-enrolls that instance. See `docs/API.md`.

## Registration without a token

1. The instance runs `register --url` with an optional `--ca-sha256`. Without the fingerprint, the CA is trusted on first use, and `ca_pinned=false` tells the manager so.
2. The instance sends its CSR and its facts.
3. It keeps `pending_key.pem` and `pending.json` (request id, secret).
4. It polls every `poll_interval`.
5. The operator compares the key fingerprint with the one printed on the instance, then either:
   - approves the request, giving the token fields, or optionally an existing instance to re-enroll; or
   - rejects it.
6. Once approved, the instance downloads its identity, which stays available for 1 day after the first download, and connects.
7. If the request is rejected or expires, the agent stops polling.

The manager side has these limits:

- the feature can be turned on or off;
- source networks can be restricted;
- the number of pending requests is capped;
- each request expires (14 days by default);
- the rate limit is per source IP and is reset by every accepted call.

## Frames (control channel, JSON text)

```json
{"v": 1, "id": "<uuid>", "type": "...", "ts": 1730000000, "payload": {}}
```

The maximum frame size is 1 MB.

| type | direction | payload |
|---|---|---|
| `hello` | agent → manager (first frame) | `protocol` (major), `revision_min`, `revision_max`, `instance_id`, `capabilities` {command: version}, `features` [names], `facts`, `state` |
| `hello_ack` | manager → agent | `instance_id`, `server_time`, `revision`, `features` [names], `config` {key: value}, `manager_version`, `ca_bundle`? (PEM, during a CA rotation), `update_confirm`? (release id), `kernel_confirm`? (kernel release) |
| `heartbeat` | agent → manager (every `heartbeat_interval`) | `stats` {cpu_percent, mem_percent, disk_percent}, `facts` only when they changed |
| `cmd` | manager → agent | `name`, `args`, `operator`, `exp` (unix), `timeout`? (seconds) |
| `cmd_progress` | agent → manager, same `id` as the cmd | `state` (`running`), `step`?, `percent`? (0–100), `message`? |
| `cmd_result` | agent → manager, same `id` as the cmd | `ok`, then `data` or `error` {`code`, `message`} |
| `event` | agent → manager | `name`, `data` |

`hello.state` is what the manager must not lose track of. Events are best effort (one sent while the instance is offline is lost); the manager reconciles with this state right after every connection:

```json
"state": {
  "support": {"ui": ["mgr-..."], "ssh": {"open": true, "expires_at": 1730000000}},
  "licenses": ["<license id>"],
  "commands": {"running": ["<cmd id>"], "finished": ["<cmd id>"]},
  "ca": ["<sha256 of a trusted CA>"],
  "update": {"update_id": "...", "release_id": "1.3.0+abc", "from_release": "1.2.0+def", "step": "health",
             "result": "running | verifying | ok | rolled_back | failed", "detail": "...", "updated_at": "...",
             "log_tail": "... (rolled_back / failed only)"}
}
```

- `support`: open sessions the instance no longer has are closed as expired.
- `licenses`: the licenses installed and valid now; an active license missing there gets a fresh token (unless an install is already pending).
- `ca`: the CAs the agent trusts, stored by the manager (readiness of a CA rotation).
- `kernel`: the kernel trial (`/opt/madmin/state/kernel-trial.json`): `kernel`, `previous`, `result` (`pending` | `confirmed` | `failed`), `detail`, `started_at`, `confirmed_at`, `failed_at`, `reason`. When `result` is `pending` and `facts.kernel` is the trial kernel, the manager answers `hello_ack.kernel_confirm` with it: the agent makes it the GRUB default (`madmin-update kernel-confirm`). Without a confirmation within 15 minutes of the boot, `madmin-boot-check.timer` reboots into the previous kernel.
- `update`: the journal of the updater (`/opt/madmin/state/update.json`). When `result` is `verifying` the manager answers `hello_ack.update_confirm` with the `release_id`: the agent writes it to `state/update-confirm` and the updater's health gate can pass. A new release that cannot reach the manager is therefore rolled back.
- `commands`: the ones running are marked running; `finished` are those whose result the agent still has (it answers them when they are re-sent).
- A missing section means "unknown": the manager does nothing for it. Later sections (the outcome of an update, Phase 1) are additions.

`hello_ack.config` tunes the agent. The values come from the manager settings; the agent clamps each one to its range (`protocol.CONFIG_LIMITS`) and keeps it until the next `hello_ack` or a restart of MADMIN:

| key | range (s) | default | meaning |
|---|---|---|---|
| `heartbeat_interval` | 30–600 | 60 | seconds between heartbeats |
| `facts_interval` | 60–3600 | 300 | seconds between facts checks (facts are sent only when changed) |
| `backoff_max` | 30–900 | 60 | longest wait between two reconnects, and between two registration polls after an error |

`facts` contains:

- `version` (semver), `build` (git commit, `-dirty` with local changes, `dev` without a manifest), `release_id` (`<version>+<build>`), `layout` (on-disk layout: 0 = flat install without the updater), read from `manifest.json` next to `backend/`
- `hostname`, `machine_id`, `os`, `kernel`, `boot_time`
- `interfaces` [{name, mac, is_up, ipv4 ["a.b.c.d/mask"], ipv6}]
- `ssh_ports`
- `modules` [{id, version, enabled}]
- `os_id` (`ubuntu-24.04`), `os_status` {`running_kernel`, `newest_kernel`, `kernels` [installed], `reboot_required`, `reboot_packages`, `unattended_upgrades`, `apt_updated_at` (epoch of the last `apt-get update`), `pending_updates`, `pending_security`}
- `sections` {`packages`: sha256, `python`: sha256}: digests of the heavy sections. When one differs from the copy it holds, the manager asks for the section with `inventory.get` (persistent, re-sent until answered; a newer digest arriving meanwhile is fetched after it).

## Close codes

| code | meaning | agent behaviour |
|---|---|---|
| 4400 | malformed frame, wrong major, no common revision | reconnects with backoff |
| 4401 | certificate unknown/revoked, instance not active | **stops**, marks itself revoked, removes the support access (accounts, SSH grant, sshd CA), waits for a new enrollment |
| 4403 | instance suspended by the manager | keeps everything (identity, support access, licenses) and tries again every 15 minutes; certificate renewal and unenroll keep working |
| 4409 | replaced by a newer connection of the same instance | reconnects |
| 4429 | manager busy; the close reason is the number of seconds to wait | waits that long (5–3600 s, 60 if unreadable), then reconnects |
| any other | – | reconnects with backoff |

The newest connection wins: the manager closes the old one with 4409 and never refuses the new one.

## Commands

The manager persists commands with these states: queued → sent → [running →] done | failed | expired. It re-sends unanswered commands after every reconnect.

- `exp` is the delivery deadline: the agent does not start a command after it (`expired`), and the manager marks a command not started by then as expired.
- `timeout` is how long the execution may take. The agent lowers it to its own limit for that command, never raises it; without it the agent's limit applies.
- A long command (`backup.run`, `backup.restore`) sends `cmd_progress {"state": "running"}` when it starts, then its steps. From then on `exp` no longer applies: the manager waits for the result until the execution timeout plus 5 minutes (1 hour plus 5 minutes without a timeout), then fails it with `timeout`. A running command re-sent after a reconnect is answered with a new `cmd_progress` (or its cached result), never started twice. The agent deduplicates by `id` and answers a repeat with the cached result. Commands that restart MADMIN keep their result on disk. Every command runs on the instance under an allowlist and Pydantic validation (unknown fields are rejected). Each command is written to the local audit log as `manager:<operator>`, method `MANAGER`, path `manager://<name>`.

All the commands below are at version 1.

| name | args | result |
|---|---|---|
| `agent.ping` | – | `pong` |
| `inventory.refresh` | – | `facts` |
| `backup.run` | – | `backup_id`, `size`, `sha256` (upload to `/agent/backups`) |
| `backup.restore` | `backup_id` | `users_imported`, `warnings`, `restart` (persistent result) |
| `support.ui.open` | `minutes` 5–1440, `username`? (new ticket) | `username`, `ticket`, `ticket_ttl`, `expires_at`, `login_path` |
| `support.ui.close` | `username`? | `closed` [usernames] |
| `support.ssh.grant` | `minutes` 5–1440 | `user`, `principal`, `expires_at` |
| `support.ssh.revoke` | – | – |
| `tunnel.open` | `conn_id`, `target` `ui`\|`ssh` | – (not persisted, not audited) |
| `license.install` | `token` | `license_id`, `feature`, `exp` |
| `license.revoke` | `license_id` | `removed` |
| `stats.history` | `hours` 1–24 | `hours`, `system` {`t`, `cpu`, `ram`, `disk` (%), `ram_total`, `disk_total`}, `network` {iface: {`t`, `rx`, `tx` (bytes/s)}}; at most 240 points per series (averaged) — not persisted, not audited |
| `manager.relocate` | `url` (https://host:port) | `url`, `changed` |
| `madmin.update` | `release_id`, `sha256` (of the .release file), `deadline`? 60–3600 s | `release_id`, `unit`, `started` (persistent result; the outcome is `state.update` / `update.status`) |
| `os.refresh` | – | `os_status` (`apt-get update`; long command) |
| `os.upgrade` | `scope` `security`\|`all` | `scope`, `changed`, `changes` [{name, from, to}], `new_kernels`, `reboot_required`, `reboot_packages`, `started_at`, `finished_at` (long command, persistent result) |
| `os.reboot` | `delay_minutes` 0–1440, `reason` | `delay_minutes`, `at` (epoch), `kernel_trial` (kernel booted on trial, or null), `kernel` (running now) — persistent result |
| `os.reboot.cancel` | – | `cancelled` |
| `inventory.get` | `section` `packages`\|`python` | `section`, `digest`, `items`: packages [{name, version, arch, source, source_version}] (installed only, `source` = Debian source package), python [{name, version}] (the venv MADMIN runs in) — not audited |

`manager.relocate` moves the instance to another address of the same manager. The agent checks that the address presents a certificate under the CA it already trusts and serves `/agent/ca.pem`, saves it as `manager_url_next` and answers. It then connects there: a `hello_ack` from the new address makes it the `manager_url`; any failure before that drops it and the agent stays where it was. The old address must stay reachable until the move is confirmed.

The OS actions name a category, never a package or a command line, and need the updater (layout 1, else `precondition`). `os.upgrade` runs `madmin-update os-upgrade` in a transient systemd unit (a package upgrade may restart MADMIN, the upgrade goes on) and follows its job file `state/os-<command id>.json`; a re-sent command attaches to it. `security` runs `unattended-upgrade` (the security pocket, as configured on the instance), `all` runs `apt-get upgrade --with-new-pkgs` (held packages untouched, local configuration files kept). It takes the updater's lock: `busy` while a MADMIN update runs, and vice versa. `os.reboot` is refused (`precondition`) while an update or a restore runs. With a kernel newer than the running one installed it boots once on trial (`grub-reboot`, the running kernel stays the default with `grub-set-default`), see `state.kernel`. The instance's facts carry `os_status.reboot_scheduled_at` and `os_status.kernel_trial`.

`madmin.update` is refused (`precondition`) on an installation without the updater (layout 0) and when the release is already installed, (`busy`) while an update runs. The agent downloads `/agent/releases/<release_id>` from its own manager, checks the sha256 and runs `madmin-update verify` (signature by a key the instance trusts, OS, layout, `min_from`, no downgrade, schema), then starts `madmin-update install` in a transient systemd unit and answers. See the MADMIN repository, `scripts/madmin-update` and `docs/RELEASING.md`.

Events: `support.expired` {`ui`: [usernames]} | {`ssh`: true}; `update.status` (same payload as `state.update`) when the updater's journal changes after the hello; `ca.updated` {`ca`: [fingerprints]} when the trusted CAs change after the hello (a bundle accepted from `hello_ack` or at a renewal).

### Errors

A failed command answers `{"ok": false, "error": {"code": "...", "message": "..."}}`. The manager acts on the code only; the message is for the operator (in Italian) and is stored with the command.

| code | meaning | manager HTTP status (synchronous calls) |
|---|---|---|
| `unsupported` | the agent does not implement the command | 409 |
| `invalid_args` | the arguments were refused by the command's model | 502 |
| `expired` | received after its `exp` | 504 |
| `busy` | a limit is reached (for example too many tunnels): retry later | 409 |
| `timeout` | the execution took longer than the command allows | 504 |
| `precondition` | the instance is not in a state where the command makes sense (not enrolled, no open support access, …) | 409 |
| `failed` | attempted and did not succeed (see the message) | 502 |
| `internal` | unexpected error on the agent | 502 |

An unknown code is treated as `failed`.

## Support tunnels

1. The operator connects to `manager:<session port>`. Only the IP given when the session was opened is accepted.
2. The manager sends `tunnel.open {conn_id, target}`.
3. The agent dials the local endpoint: `ui` → `127.0.0.1:7443`, `ssh` → `127.0.0.1:<sshd port>`. A target is served only while the matching access is open.
4. The agent opens `WSS /agent/tunnel/{conn_id}`. The `conn_id` is single-use, valid for 20 s and bound to the certificate's instance.
5. Bytes are copied both ways. The manager never terminates TLS or SSH.

- UI access: a hidden temporary superuser, entered with a one-time ticket (`/login.html#manager-ticket=…` → `POST /api/auth/token/manager-ticket`).
- SSH access: an OpenSSH user certificate from the manager SSH CA with principal `madmin-support-<instance_id>`, `source-address=127.0.0.1` and validity equal to the session. The instance lists the principal for root only while the grant is open (`expiry-time`, `from="127.0.0.1"`).

## Rescue

`madmin-rescue` (MADMIN repository, `scripts/madmin-rescue`, standard library only) runs every 5 minutes from `/opt/madmin/updater/`. While MADMIN runs and its agent is connected it does nothing. Otherwise it recovers an interrupted update, then posts to `/agent/rescue` (client certificate): unit state, the last 200 journal lines of `madmin.service`, current and previous release, the update journal, free disk, the outcome of its last action. The answer carries at most one action, queued by a superuser on the instance page and sent once: `restart`, `rollback` (`madmin-update rollback`) or `install` (a release the manager holds, downloaded from `/agent/releases/` and installed by `madmin-update` like any update). The rescue never opens a shell, a tunnel or support access.

## CA rotation

The agent trusts every CA in its `ca.pem`: usually one, two during a rotation. It adds a CA only from a `ca_bundle` (in `hello_ack` or in the renewal answer) that holds the new CA, self-signed, together with a cross certificate for the same subject and key issued by a CA it already trusts. A manager therefore cannot make an instance trust a CA the current one did not vouch for. Expired CAs are dropped, never the last valid one. The agent reports its CAs in `hello.state.ca`.

On the manager, `python -m manager.pki rotate-ca`:

1. `prepare`: the next CA and its cross certificate are created and offered in every `hello_ack`. Nothing else changes.
2. `status`: the instances that do not report the next CA yet.
3. `activate` (refused while some instance is not ready, unless `--force`): the next CA signs new agent certificates, the server certificate and the tokens; nginx keeps accepting client certificates of the previous CA (`ca_trust.pem`). The bundle stays offered for latecomers.
4. `retire` (refused while a valid agent certificate of the previous CA exists, at most 90 days): the previous CA goes.

After `activate` and `retire`: `systemctl reload nginx && systemctl restart madmin-manager`.

## Licenses

The token is `base64url(payload).base64url(ed25519 signature of the first part)`, with payload `{lid, iid, feature, iat, nbf, exp}` (exp = license_validity_days, by default 30). The manager renews it at 2/3 of its lifetime while the license is active. On the instance, a module whose manifest has `"license": {"feature": "..."}` is activated and loaded only with a valid token. An expired token never deactivates a module.
