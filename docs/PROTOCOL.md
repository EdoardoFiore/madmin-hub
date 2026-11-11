# MADMIN ↔ MADMIN Manager protocol (v1)

`protocol.py` is identical in both repositories:
`madmin/backend/core/manager/protocol.py` and `madmin-manager/backend/manager/agents/protocol.py`.
Any change updates this document and is copied to the other side in the same change. `PROTOCOL_VERSION` is bumped only for incompatible changes (frame shape, existing commands): every frame carries it and a mismatch drops the connection. A new command is additive and needs no bump: the manager sends it only to agents that list it in `hello.capabilities`.

## Transport and identity

| Endpoint (manager, agent port 8443) | Client certificate | Purpose |
|---|---|---|
| `GET /agent/ca.pem` | no | manager CA; the instance accepts it only if its sha256 matches the token |
| `POST /agent/enroll` | no | token + CSR → certificate (rate limited) |
| `POST /agent/register` | no | CSR + facts (+ `ca_pinned`) → `request_id`, `request_secret`, `key_fingerprint`, `poll_interval` |
| `GET /agent/register/{id}` | no (`X-Request-Secret`) | `status` pending \| approved \| rejected \| expired; when approved, the same fields as the enroll response |
| `POST /agent/renew` | yes | CSR → new certificate (at 2/3 of the lifetime) |
| `POST /agent/unenroll` | yes | instance decommissioned |
| `WSS /agent/ws` | yes | control channel |
| `WSS /agent/tunnel/{conn_id}` | yes | one support tunnel (binary frames) |
| `POST /agent/backups` | yes | backup upload (`X-Content-SHA256`, `X-Command-Id`, `X-Archive-Name`) |
| `GET /agent/backups/{id}` | yes | backup download (only this instance's, `X-Content-SHA256`) |

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
| `hello` | agent → manager (first frame) | `protocol`, `instance_id`, `capabilities` [command names], `facts` |
| `hello_ack` | manager → agent | `instance_id`, `server_time` |
| `heartbeat` | agent → manager (60 s) | `stats` {cpu_percent, mem_percent, disk_percent}, `facts` only when they changed |
| `cmd` | manager → agent | `name`, `args`, `operator`, `exp` (unix) |
| `cmd_result` | agent → manager, same `id` as the cmd | `ok`, `data` or `error` |
| `event` | agent → manager | `name`, `data` |

`facts` contains:

- `madmin_version`, `hostname`, `machine_id`, `os`, `kernel`, `boot_time`
- `interfaces` [{name, mac, is_up, ipv4 ["a.b.c.d/mask"], ipv6}]
- `ssh_ports`
- `modules` [{id, version, enabled}]

## Close codes

| code | meaning | agent behaviour |
|---|---|---|
| 4400 | malformed frame / wrong version | reconnects with backoff |
| 4401 | certificate unknown/revoked, instance not active | **stops**, marks itself revoked, removes the support access (accounts, SSH grant, sshd CA), waits for a new enrollment |
| 4409 | replaced by a newer connection of the same instance | reconnects |

The newest connection wins: the manager closes the old one with 4409 and never refuses the new one.

## Commands

The manager persists commands with these states: queued → sent → done | failed | expired. It re-sends unanswered commands after every reconnect. The agent deduplicates by `id` and answers a repeat with the cached result. Commands that restart MADMIN keep their result on disk. Every command runs on the instance under an allowlist and Pydantic validation (unknown fields are rejected). Each command is written to the local audit log as `manager:<operator>`, method `MANAGER`, path `manager://<name>`.

| name | args | result |
|---|---|---|
| `agent.ping` | – | `pong` |
| `inventory.refresh` | – | `facts` |
| `backup.run` | – | `backup_id`, `size`, `sha256` (upload to `/agent/backups`) |
| `backup.restore` | `backup_id` | `users_imported`, `warnings`, `restart` (persistent result) |
| `support.ui.open` | `minutes` 5–480, `username`? (new ticket) | `username`, `ticket`, `ticket_ttl`, `expires_at`, `login_path` |
| `support.ui.close` | `username`? | `closed` [usernames] |
| `support.ssh.grant` | `minutes` 5–480 | `user`, `principal`, `expires_at` |
| `support.ssh.revoke` | – | – |
| `tunnel.open` | `conn_id`, `target` `ui`\|`ssh` | – (not persisted, not audited) |
| `license.install` | `token` | `license_id`, `feature`, `exp` |
| `license.revoke` | `license_id` | `removed` |
| `stats.history` | `hours` 1–24 | `hours`, `system` {`t`, `cpu`, `ram`, `disk` (%), `ram_total`, `disk_total`}, `network` {iface: {`t`, `rx`, `tx` (bytes/s)}}; at most 240 points per series (averaged) — not persisted, not audited |

Events: `support.expired` {`ui`: [usernames]} | {`ssh`: true}.

## Support tunnels

1. The operator connects to `manager:<session port>`. Only the IP given when the session was opened is accepted.
2. The manager sends `tunnel.open {conn_id, target}`.
3. The agent dials the local endpoint: `ui` → `127.0.0.1:7443`, `ssh` → `127.0.0.1:<sshd port>`. A target is served only while the matching access is open.
4. The agent opens `WSS /agent/tunnel/{conn_id}`. The `conn_id` is single-use, valid for 20 s and bound to the certificate's instance.
5. Bytes are copied both ways. The manager never terminates TLS or SSH.

- UI access: a hidden temporary superuser, entered with a one-time ticket (`/login.html#manager-ticket=…` → `POST /api/auth/token/manager-ticket`).
- SSH access: an OpenSSH user certificate from the manager SSH CA with principal `madmin-support-<instance_id>`, `source-address=127.0.0.1` and validity equal to the session. The instance lists the principal for root only while the grant is open (`expiry-time`, `from="127.0.0.1"`).

## Licenses

The token is `base64url(payload).base64url(ed25519 signature of the first part)`, with payload `{lid, iid, feature, iat, nbf, exp}` (exp = license_validity_days, by default 30). The manager renews it at 2/3 of its lifetime while the license is active. On the instance, a module whose manifest has `"license": {"feature": "..."}` is activated and loaded only with a valid token. An expired token never deactivates a module.
