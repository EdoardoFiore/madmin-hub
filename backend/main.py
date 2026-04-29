"""
MADMIN Hub — main application entry point.
"""
import asyncio
import logging
import os

from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
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

    # Start background tasks
    from hub.tasks import audit_cleanup_task, telemetry_retention_task

    tasks = [
        asyncio.create_task(telemetry_retention_task(interval_hours=6)),
        asyncio.create_task(audit_cleanup_task(interval_hours=24)),
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
    from hub.instances.router import router as instances_router
    from hub.telemetry.router import router as telemetry_router
    from hub.ws.handler import router as ws_router
    from hub.ws.relay import router as relay_router
    from hub.ssh.router import router as ssh_router

    app.include_router(auth_router)
    app.include_router(audit_router)
    app.include_router(settings_router)
    app.include_router(instances_router)
    app.include_router(telemetry_router)
    app.include_router(ws_router)
    app.include_router(relay_router)
    app.include_router(ssh_router)

    # Health + fleet summary
    @app.get("/api/health", tags=["System"])
    async def health():
        from core.database import check_db_connection
        db_ok = await check_db_connection()
        return {
            "status": "healthy" if db_ok else "degraded",
            "database": "connected" if db_ok else "disconnected",
            "version": HUB_VERSION,
        }

    @app.get("/api/dashboard/fleet", tags=["Dashboard"])
    async def fleet_dashboard(
        user=Depends(__import__("core.auth.dependencies", fromlist=["get_current_user"]).get_current_user),
    ):
        from core.database import async_session_maker
        from hub.instances.service import fleet_summary, list_instances, instance_to_dict
        from hub.ws.manager import ws_manager

        async with async_session_maker() as session:
            instances = await list_instances(session)
        summary = fleet_summary(instances)
        summary["ws_connected_ids"] = [str(i) for i in ws_manager.connected_ids()]
        return {
            "summary": summary,
            "instances": [instance_to_dict(i) for i in instances],
        }

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
