"""
MADMIN Manager - central management of MADMIN instances.

One uvicorn process on 127.0.0.1:8000 behind nginx, which serves two sites:
- the UI (:443): /api/* for logged-in users, the SPA;
- the agent endpoint (:8443, client certificates): /agent/* only.

The live agent connections and the support listeners are in this process;
all durable state is in PostgreSQL.
"""
import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

from fastapi import Depends, FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from config import MANAGER_VERSION, get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("madmin_manager")

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("MADMIN Manager starting up...")
    from core import sdnotify
    from core.auth.rate_limiter import login_rate_limiter
    from core.concurrency import spawn_background
    from core.database import async_session_maker, init_db
    from manager import pki

    sdnotify.init()
    watchdog_task = asyncio.create_task(sdnotify.watchdog_loop(), name="systemd-watchdog")

    await init_db()
    async with async_session_maker() as session:
        await login_rate_limiter.load_from_db(session)
    if not pki.is_initialized():
        logger.error("PKI not initialized: run 'python -m manager.pki init --host <hostname>'")

    from manager.agents.dispatcher import expire_task
    from manager.backups.service import scheduler_task
    from manager.licenses.service import renew_task
    from manager.support.service import expiry_task, restore_listeners
    from manager.support.tunnels import stop_all
    from manager.inventory.osv import scan_task
    from manager.rollouts.service import rollout_task

    await restore_listeners()

    async def audit_cleanup_task():
        from core.audit.service import cleanup_old_logs
        while True:
            try:
                async with async_session_maker() as session:
                    await cleanup_old_logs(session)
                    await session.commit()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Audit cleanup error")
            await asyncio.sleep(24 * 3600)

    tasks = [
        spawn_background(expire_task(), "command-expiry"),
        spawn_background(scheduler_task(), "backup-scheduler"),
        spawn_background(renew_task(), "license-renewal"),
        spawn_background(expiry_task(), "support-expiry"),
        spawn_background(audit_cleanup_task(), "audit-cleanup"),
        spawn_background(scan_task(), "vulnerability-scan"),
        spawn_background(rollout_task(), "rollouts"),
    ]

    logger.info("MADMIN Manager ready")
    sdnotify.notify("READY=1")
    yield

    sdnotify.notify("STOPPING=1")
    watchdog_task.cancel()
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    stop_all()
    from core.audit.writer import audit_writer
    await audit_writer.stop()


class _SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response


def create_app() -> FastAPI:
    app = FastAPI(
        title="MADMIN Manager",
        version=MANAGER_VERSION,
        lifespan=lifespan,
        docs_url="/api/docs" if settings.debug else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if settings.debug else None,
    )

    @app.exception_handler(Exception)
    async def unhandled_exception(request: Request, exc: Exception):
        logger.error(f"Unhandled error on {request.method} {request.url.path}", exc_info=exc)
        return JSONResponse(status_code=500, content={"detail": "Errore interno del server"})

    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=False,
                       allow_methods=["*"], allow_headers=["*"])
    app.add_middleware(_SecurityHeadersMiddleware)
    from core.audit.middleware import AuditLogMiddleware
    app.add_middleware(AuditLogMiddleware)

    from core.audit.router import router as audit_router
    from core.auth.router import router as auth_router
    from core.settings.router import router as settings_router
    from manager.agents.router import router as agent_router
    from manager.apikeys.router import router as apikeys_router
    from manager.provisioning.router import router as provisioning_router
    from manager.backups.router import router as backups_router
    from manager.enrollment.router import router as enrollment_router
    from manager.instances.router import router as instances_router
    from manager.licenses.router import router as licenses_router
    from manager.support.router import router as support_router
    from manager.releases.router import router as releases_router
    from manager.keys.router import router as keys_router
    from manager.inventory.router import router as inventory_router
    from manager.osactions.router import router as osactions_router
    from manager.rollouts.router import router as rollouts_router

    for r in (auth_router, audit_router, settings_router, instances_router, enrollment_router,
              backups_router, licenses_router, support_router, releases_router, keys_router,
              inventory_router, osactions_router, rollouts_router, apikeys_router, provisioning_router,
              agent_router):
        app.include_router(r)

    from core.auth.dependencies import get_current_user
    from core.auth.models import User

    @app.get("/api/ui/menu", include_in_schema=False)
    async def menu(current_user: User = Depends(get_current_user)):
        return {
            "core": [
                # permission = capability (core.auth.models.CAPABILITIES)
                {"label": "menu.dashboard", "icon": "home", "route": "#dashboard", "permission": "scope.view"},
                {"label": "menu.instances", "icon": "server", "route": "#instances", "permission": "scope.view"},
                {"label": "menu.support", "icon": "lifebuoy", "route": "#support", "permission": "manager.view"},
                {"label": "menu.vulnerabilities", "icon": "shield-exclamation", "route": "#vulnerabilities", "permission": "scope.view"},
                {"label": "menu.licenses", "icon": "certificate", "route": "#licenses", "permission": "scope.view"},
                {"label": "menu.enrollment", "icon": "key", "route": "#enrollment", "permission": "manager.view"},
                {"label": "menu.releases", "icon": "package", "route": "#releases", "permission": "manager.view"},
                {"label": "menu.rollouts", "icon": "stack-push", "route": "#rollouts", "permission": "scope.manage"},
                {"label": "menu.users", "icon": "users", "route": "#users", "permission": "users.view"},
                {"label": "menu.logs", "icon": "file-text", "route": "#logs", "permission": "manager.view"},
                {"label": "menu.settings", "icon": "settings", "route": "#settings", "permission": "manager.view"},
            ],
            "modules": [],
        }

    @app.get("/api/ui/badges", include_in_schema=False)
    async def badges(current_user: User = Depends(get_current_user)):
        """Counts shown next to the menu entries: what waits for someone (ROADMAP 10.2)."""
        from sqlalchemy import func, select as sa_select
        from core.database import async_session_maker
        from manager import scope
        from manager.models import EnrollmentRequest, Finding, Instance, Rollout, UserSshKey
        out = {}
        async with async_session_maker() as session:
            if current_user.has_permission("manager.view"):
                out["enrollment"] = (await session.execute(sa_select(func.count()).select_from(EnrollmentRequest)
                                                           .where(EnrollmentRequest.status == "pending"))).scalar()
                out["support"] = (await session.execute(sa_select(func.count()).select_from(UserSshKey).where(
                    UserSshKey.status == "pending", UserSshKey.user_id != current_user.id))).scalar()
            ids = await scope.group_ids(session, current_user)
            q = scope.filter_instances(sa_select(func.count(func.distinct(Finding.advisory_id))).select_from(Finding)
                                       .join(Instance, Instance.id == Finding.instance_id)
                                       .where(Finding.severity == "critical", Instance.status == "active"), ids)
            out["vulnerabilities"] = (await session.execute(q)).scalar()
            if current_user.has_permission("scope.manage"):
                out["rollouts"] = (await session.execute(sa_select(func.count()).select_from(Rollout).where(
                    Rollout.status.in_(("halted", "waiting"))))).scalar()
        return {k: v for k, v in out.items() if v}

    @app.get("/api/health")
    async def health():
        from core.database import check_db_connection
        ok = await check_db_connection()
        return JSONResponse(status_code=200 if ok else 503,
                            content={"status": "healthy" if ok else "degraded"})

    frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
    if os.path.exists(frontend_dir):
        @app.get("/", include_in_schema=False)
        async def serve_index():
            return FileResponse(os.path.join(frontend_dir, "index.html"))

        @app.get("/login", include_in_schema=False)
        async def serve_login():
            return FileResponse(os.path.join(frontend_dir, "login.html"))

    return app


app = create_app()
