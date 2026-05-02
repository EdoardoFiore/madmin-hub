# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

MADMIN Hub is a centralized management panel for a distributed fleet of MADMIN agents. Agents connect via WebSocket; the hub tracks metrics, relays commands, manages SSH keys, and gates everything behind RBAC + audit logging.

## Running Locally

```bash
# Start PostgreSQL only
docker-compose -f docker/docker-compose.yml up -d db

# Install deps
pip install -r backend/requirements.txt

# Start API with hot-reload (set DEBUG=true in .env)
cd backend && python main.py
```

Frontend is static — open `frontend/index.html` directly or serve via nginx. No build step.

**Full Docker:**
```bash
docker-compose -f docker/docker-compose.yml up -d
# Hub on :8000, Postgres on :5432
```

**Bare-metal (Ubuntu 24.04):**
```bash
sudo bash scripts/setup-hub.sh [-u admin_username] [-p admin_password]
```

## Environment Config

All config lives in `backend/config.py` (Pydantic Settings, reads from `.env`). Key vars:

| Var | Default | Notes |
|-----|---------|-------|
| `DATABASE_URL` | — | Required, async postgres DSN |
| `SECRET_KEY` | — | Required, >32 chars |
| `DEBUG` | false | Enables /api/docs, /api/redoc, hot-reload |
| `TELEMETRY_RETENTION_DAYS` | 30 | 1–365 |
| `HEARTBEAT_INTERVAL_SECONDS` | 60 | |
| `ENROLLMENT_TOKEN_TTL_MINUTES` | 15 | |
| `COMMAND_TIMEOUT_SECONDS` | 30 | |

## Architecture

### Backend (`backend/`)

`main.py` is the FastAPI app factory: registers CORS + audit middleware, imports all routers, starts background tasks (`telemetry_retention_task`, `audit_cleanup_task`) in the lifespan hook, and serves the frontend SPA via a catch-all route.

**`core/`** — cross-cutting concerns:
- `database.py` — async SQLAlchemy engine + session factory; all models must be imported here at startup so `SQLModel.metadata` is populated before `create_all`
- `auth/` — JWT (HS256), bcrypt, TOTP (Fernet), RevokedToken blacklist for logout, 9-permission RBAC (slugs: `users.*`, `permissions.manage`, `settings.*`, `logs.view`, `hub.*`)
- `audit/` — request/response middleware that logs every call to `AuditLog` (method, path, status, duration_ms, user, request body, response summary)
- `settings/` — `SystemSettings` persisted in DB (SMTP, enterprise flags)

**`hub/`** — fleet-specific modules:
- `instances/` — `ManagedInstance` (fingerprint + argon2 agent token), `InstanceGroup`, `Tag`/`InstanceTag` (relational, migrated from JSON), `EnrollmentToken` (time-limited, hashed, one-use)
- `ws/` — WebSocket endpoint at `/api/agents/ws`; frame types: `HEARTBEAT`, `PING/PONG`, `EVENT`, `COMMAND_RESULT`, `TELEMETRY_BATCH`; `manager.py` tracks live connections; `dispatcher.py` routes hub→agent commands via async queues
- `telemetry/` — `InstanceTelemetry` (time-series snapshots: CPU, RAM, disk, network, services JSON) + `InstanceCommand` (queue with `queued/sent/done/failed/timeout` lifecycle)
- `ssh/` — `SSHKey` + `SSHKeyAssignment`; keys pushed to agents via dispatcher

### Frontend (`frontend/`)

Vanilla JS SPA, hash-based routing, no framework, no build step. Stack: Tabler 1.4 + Bootstrap 5.3 + ApexCharts from CDN.

**Shell architecture:**
- `index.html` — CSS Grid shell: sidebar + topbar + main content + right-side drawer slots
- `assets/css/design.css` — CSS custom properties (colors, radii, shadows, dark mode)
- `assets/css/shell.css` — sidebar (collapsible, grouped nav sections) + topbar layout
- `assets/css/drawer.css` — right-side slide-in drawer (cubic-bezier animation)
- `assets/css/components.css` — StatCard, FilterBar, DataTable, Tabs, badges, toasts, etc.

**JS modules:**
- `assets/js/app.js` — boot: `getCurrentUser → applyTheme → loadBranding → buildSidebar → buildTopbar → initDrawer → router.start()`
- `assets/js/router.js` — hash router; drawer-aware (e.g. `#instances/:id` keeps page mounted, opens drawer)
- `assets/js/branding.js` — fetches `/api/settings/system`, applies `--hub-primary` CSS var + title + favicon + logo
- `assets/js/shell/drawer.js` — generic right-side drawer host; views call `openDrawer({title, render, closeHash})`
- `assets/js/api.js` — `fetch` wrapper with JWT `Authorization` header; all API calls go through here
- `assets/js/i18n.js` + `locales/en.js` + `locales/it.js` — key-based i18n, Italian is default
- `assets/js/utils.js` — toast, debounce, escapeHtml, relativeTime, statusBadge, httpMethodToAction, actionLabel, renderTable, modal helpers

**Views (one file per page, dynamically loaded by router):**
- `dashboard.js` — stat cards, fleet donut chart, recent activity feed, alerts panel, quick actions
- `instances.js` — stat strip + filter bar + data table; row click → `instance_drawer.js`
- `instance_drawer.js` — tabs Info/Actions/SSH/Audit inside the right-side drawer
- `groups.js` — split layout: left group list, right tabs (Instances/SSH Keys)
- `inventory.js` — tabs Tags / SSH Keys (replaces old ssh_keys.js)
- `enrollment.js` — token table + create modal with encrypted token command preview; disabled if `hub_url` not set
- `users.js` — user table + invite modal + user drawer (General/Permissions tabs)
- `audit.js` — instant-filter table with debounce; colored action labels (CREATE/UPDATE/DELETE/READ)
- `settings.js` — 5 tabs: General / SMTP / Branding / Retention / Security

**Key patterns:**
- Drawer routes (`#instances/:id`, `#users/:username`) keep parent page mounted; closing drawer pops URL back
- `#instance/:id` (singular) aliases to `#instances/:id` for back-compat
- Branding re-applied on every `loadBranding()` call; Branding tab save triggers immediate re-apply
- Enrollment token create gate: disabled with tooltip when `SystemSettings.hub_url` is empty
- Enrollment tokens use Fernet-encrypted self-contained payload (id + secret + hub_url + group + tags + ttl)
- Alerts bell in topbar polls `/api/dashboard/alerts` every 60s (paused when `document.hidden`)

### Data Flow: Agent → Hub

1. Agent enrolls via `POST /api/instances/enroll` with enrollment token → receives `agent_token`
2. Agent opens WS at `/api/agents/ws` with `agent_token` in Authorization header
3. `ws/handler.py` verifies token (argon2 hash check against DB), marks instance `ws_connected=true`
4. Agent sends `TELEMETRY_BATCH` frames → `telemetry/ingest.py` persists to `InstanceTelemetry`
5. Hub sends commands via `dispatcher.py` → agent executes → returns `COMMAND_RESULT` frame
6. On disconnect: instance marked `ws_connected=false`

### Permission Check Pattern

All routers use `Depends(get_current_user)` + explicit permission slug checks. Super-admins bypass slug checks. Protected users cannot be deleted/demoted.

## Key Conventions

- **Models** use `SQLModel` (SQLAlchemy + Pydantic merged). UUID PKs everywhere except `InstanceTelemetry` (int PK for time-series performance).
- **Async everywhere** — use `async def` + `await` for all DB operations and WS handlers.
- **Tags** are being migrated from JSON columns on `ManagedInstance` to the relational `Tag`/`InstanceTag` tables — check both when querying tags.
- **i18n** — user-facing strings in frontend use i18n keys; backend error messages are in Italian.
- **No test suite yet** — `pytest` and `pytest-asyncio` are in requirements but no tests exist.
