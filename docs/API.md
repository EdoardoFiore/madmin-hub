# MADMIN Manager — Provisioning API

This API is for the system that creates the instances, for example FAE/Fulcrum or another orchestrator. Every endpoint is under `https://<manager>/api/provisioning/` and is authenticated with an **API key**. A UI session cannot be used.

## Keys

Keys are created by a superuser in **Enrollment → API keys**. A key looks like `mhk_<id>_<secret>` and is shown only once. Send it on every call:

```
Authorization: Bearer mhk_3f9a1c2b4d5e_...
```

A key works only for the scopes it has been given, and only from the networks set on it. It also stops working when it expires or is revoked. The manager audit log records each call as `api:<id>`.

**Never put a key on an instance.** Only the provisioning system holds it. The system asks the manager for a single-use token and passes that token to the instance.

| Scope | Allows |
|---|---|
| `provisioning.enroll` | `POST /tokens` |
| `groups.create` | `create_groups: true` in `POST /tokens` |
| `instances.view` | `GET /instances`, `GET /instances/by-ref/{ref}`, `GET /groups` |
| `instances.lifecycle` | `POST /instances/by-ref/{ref}/decommission` |
| `backups.run` | `POST /instances/by-ref/{ref}/backup` |
| `licenses.manage` | `POST/DELETE /instances/by-ref/{ref}/licenses…` |

Errors:

- `401`: the key is not valid.
- `403`: the scope is missing or the network is not allowed.
- `429`: more than 120 requests per minute per key. Repeated failures from the same IP are also blocked.

## Groups

The manager has its own customers directly under it. It can also have partners, each with its own customers:

```
(manager) ── customer
      └─ partner ── customer
```

In the API, groups are given by name: `partner` and/or `customer`.

| `partner` | `customer` | Group used |
|---|---|---|
| given | — | the partner |
| — | given | a customer directly under the manager |
| given | given | the customer under that partner |

Missing groups are created only with `create_groups: true`, which needs the `groups.create` scope. Without it, an unknown name returns `400`.

## Creating a token

```
POST /api/provisioning/tokens
```

Every field is optional:

```json
{
  "name": "router-cliente-y-mi01",
  "partner": "Partner X",
  "customer": "Cliente Y",
  "create_groups": true,
  "labels": {"sito": "milano", "contratto": "C-1234"},
  "external_ref": "vm-8f2c41",
  "bind_ip": "203.0.113.17",
  "hours": 2,
  "description": "deploy 2026-11-02"
}
```

Response `201`:

```json
{
  "token": "MMGR1-eyJ1Ijoi...",
  "token_id": "a1b2c3d4e5f60718",
  "expires_at": "2026-11-02T12:00:00",
  "ca_fingerprint": "5c1e...",
  "reenroll_instance_id": null
}
```

- The token is **single-use**. It is valid for `hours` (1–24, default 2). With `bind_ip`, it is accepted only from that source IP.
- **The call is idempotent on `external_ref`.** If a live instance already has that `external_ref`, the token is a **re-enroll** for it (`reenroll_instance_id` is filled in). The reinstalled machine keeps its identity, backups and licenses, and its old certificate is revoked. This is how a reinstall (the upgrade path) needs no manual step.
- `name`, the group and `labels` are applied to the instance when it enrolls. When they are omitted, the name defaults to the hostname and the instance has no group.

Then on the instance:

```bash
MADMIN_MANAGER_TOKEN='MMGR1-...' sudo -E bash scripts/setup-madmin.sh -u admin ... 
# or: --manager-token-file /path/token.txt
```

## Instances

| Call | Result |
|---|---|
| `GET /instances?partner=&customer=&label=chiave=valore&status=` | List. A partner includes its customers. |
| `GET /instances/by-ref/{ref}` | One instance: `id`, `name`, `status`, `online`, `madmin_version`, `last_ip`, `last_seen_at`, `labels`, `external_ref`, `group_path`. |
| `POST /instances/by-ref/{ref}/decommission` | The machine was deleted. Its certificate is revoked and its support sessions are closed. Backups and history are kept. |
| `POST /instances/by-ref/{ref}/backup` | `202` `{command_id, status}`. The backup runs when the instance is online, within 1 hour. |
| `POST /instances/by-ref/{ref}/licenses` `{feature, valid_until?, notes?}` | Issues a license. Idempotent: if one is already active, the response is `created: false`. |
| `DELETE /instances/by-ref/{ref}/licenses/{feature}` | Revokes the license. |
| `GET /groups` | `[{id, name, kind, parent_id, path}]` |

## Without a token

The instance can also be installed with `--manager-url https://manager:8443 [--manager-ca-sha256 <fingerprint>]`. The request then waits in **Enrollment → In attesa**. When an operator approves it, they enter the same fields the token would have carried. This mode needs no API key.
