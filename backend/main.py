"""
MADMIN Hub — main application entry point.
"""
import asyncio
import logging
import os

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi import Request
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from config import HUB_VERSION, get_settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("MADMIN Hub starting up…")

    from core.database import async_session_maker, init_db
    from core.auth.service import init_core_permissions
    from core.auth.token_blacklist import token_blacklist

    # Init DB tables
    await init_db()

    async with async_session_maker() as session:
        await init_core_permissions(session)

    # Restore token blacklist from DB
    async with async_session_maker() as session:
        await token_blacklist.load_from_db(session)

    # Ensure default backup repo exists
    from hub.backups.service import ensure_default_local_repo
    async with async_session_maker() as session:
        await ensure_default_local_repo(session)

    # Start background tasks
    from hub.tasks import audit_cleanup_task, telemetry_retention_task, backup_scheduler_task

    tasks = [
        asyncio.create_task(telemetry_retention_task(interval_hours=6)),
        asyncio.create_task(audit_cleanup_task(interval_hours=24)),
        asyncio.create_task(backup_scheduler_task(interval_minutes=5)),
    ]

    logger.info("MADMIN Hub ready.")
    yield

    logger.info("MADMIN Hub shutting down…")
    for t in tasks:
        t.cancel()
    for t in tasks:
        try:
            await t
        except asyncio.CancelledError:
            pass


def create_app() -> FastAPI:
    app = FastAPI(
        title="MADMIN Hub",
        description="Centralized management panel for MADMIN fleet.",
        version=HUB_VERSION,
        lifespan=lifespan,
        docs_url="/api/docs" if settings.debug else None,
        redoc_url="/api/redoc" if settings.debug else None,
        openapi_url="/api/openapi.json" if settings.debug else None,
    )

    # Trust X-Forwarded-For from reverse proxy (nginx)
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
    app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")

    # CORS
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Audit middleware
    from core.audit.middleware import AuditLogMiddleware
    app.add_middleware(AuditLogMiddleware)

    # Routers
    from core.auth.router import router as auth_router
    from core.audit.router import router as audit_router
    from core.settings.router import router as settings_router
    from core.dashboard.router import router as dashboard_router
    from hub.instances.router import router as instances_router
    from hub.telemetry.router import router as telemetry_router
    from hub.ws.handler import router as ws_router
    from hub.ws.relay import router as relay_router
    from hub.ssh.router import router as ssh_router
    from hub.backups.router import router as backups_router

    app.include_router(auth_router)
    app.include_router(audit_router)
    app.include_router(settings_router)
    app.include_router(dashboard_router)
    app.include_router(instances_router)
    app.include_router(telemetry_router)
    app.include_router(ws_router)
    app.include_router(relay_router)
    app.include_router(ssh_router)
    app.include_router(backups_router)

    @app.get("/api/health", tags=["System"])
    async def health():
        from core.database import check_db_connection
        db_ok = await check_db_connection()
        return {
            "status": "healthy" if db_ok else "degraded",
            "database": "connected" if db_ok else "disconnected",
            "version": HUB_VERSION,
        }

    @app.get("/api/branding", tags=["System"])
    async def branding():
        """Public branding info (used by login page before auth)."""
        from core.database import async_session_maker
        from sqlalchemy import select
        from core.settings.models import SystemSettings
        async with async_session_maker() as session:
            res = await session.execute(select(SystemSettings).where(SystemSettings.id == 1))
            s = res.scalar_one_or_none()
        if not s:
            return {"company_name": "MADMIN Hub", "primary_color": "#206bc4",
                    "logo_url": None, "favicon_url": None, "default_language": "it"}
        return {
            "company_name": s.company_name,
            "primary_color": s.primary_color,
            "logo_url": s.logo_url,
            "favicon_url": s.favicon_url,
            "default_language": s.default_language,
        }

    @app.get("/install.sh", tags=["System"], response_class=PlainTextResponse)
    async def install_script(request: Request):
        """Serve agent enrollment shell script. Hub URL is embedded from SystemSettings (or request origin)."""
        from core.database import async_session_maker
        from sqlalchemy import select
        from core.settings.models import SystemSettings

        async with async_session_maker() as session:
            res = await session.execute(select(SystemSettings).where(SystemSettings.id == 1))
            s = res.scalar_one_or_none()

        # Prefer configured hub_url; fall back to request origin
        hub_url = (s.hub_url if s and s.hub_url else None) or str(request.base_url).rstrip("/")

        script = f"""#!/bin/bash
# MADMIN Agent enrollment script — generated by Hub at {hub_url}
set -euo pipefail

HUB_URL="{hub_url}"
HUB_TOKEN=""
INSTANCE_NAME=""
AUTO_ENROLL=true
MADMIN_PORT=8000

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)   HUB_TOKEN="$2";      shift 2 ;;
    --name)    INSTANCE_NAME="$2";  shift 2 ;;
    --port)    MADMIN_PORT="$2";    shift 2 ;;
    --no-auto) AUTO_ENROLL=false;   shift   ;;
    *)         shift ;;
  esac
done

if [[ -z "$HUB_TOKEN" ]]; then
  echo "Errore: --token <enrollment_token> richiesto." >&2
  exit 1
fi

BOOTSTRAP_URL="http://localhost:${{MADMIN_PORT}}/api/modules/agent/bootstrap"

echo "Configurazione agent MADMIN..."
echo "  Hub URL    : $HUB_URL"
echo "  MADMIN port: $MADMIN_PORT"

PAYLOAD=$(printf '{{"hub_url":"%s","enrollment_token":"%s","instance_name":"%s","auto_enroll":%s}}' \
  "$HUB_URL" "$HUB_TOKEN" "$INSTANCE_NAME" "$AUTO_ENROLL")

HTTP_CODE=$(curl -sf -o /tmp/madmin_bootstrap.json -w "%{{http_code}}" \\
  -X POST "$BOOTSTRAP_URL" \\
  -H "Content-Type: application/json" \\
  -d "$PAYLOAD" 2>/tmp/madmin_bootstrap.err) || true

RESP=$(cat /tmp/madmin_bootstrap.json 2>/dev/null || echo "")

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "Errore: impossibile contattare MADMIN su porta $MADMIN_PORT (HTTP $HTTP_CODE)." >&2
  echo "  Assicurati che MADMIN sia in esecuzione." >&2
  [[ -n "$RESP" ]] && echo "  Risposta: $RESP" >&2
  exit 1
fi

if echo "$RESP" | grep -q '"auto_enrolled": *true'; then
  echo "Enrollment completato con successo."
else
  echo "Configurazione salvata. Completa l'enrollment dall'interfaccia MADMIN su http://localhost:${{MADMIN_PORT}}."
fi
"""
        return PlainTextResponse(content=script, media_type="text/x-shellscript")

    # Static frontend
    frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
    if os.path.exists(frontend_dir):
        app.mount(
            "/assets",
            StaticFiles(directory=os.path.join(frontend_dir, "assets")),
            name="assets",
        )

        @app.get("/", include_in_schema=False)
        async def serve_index():
            return FileResponse(os.path.join(frontend_dir, "index.html"))

        @app.get("/login", include_in_schema=False)
        async def serve_login():
            return FileResponse(os.path.join(frontend_dir, "login.html"))

        # Catch-all for SPA client-side routing
        @app.get("/{full_path:path}", include_in_schema=False)
        async def serve_spa(full_path: str):
            if full_path.startswith("api/"):
                from fastapi import HTTPException
                raise HTTPException(status_code=404)
            return FileResponse(os.path.join(frontend_dir, "index.html"))

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=settings.debug)
