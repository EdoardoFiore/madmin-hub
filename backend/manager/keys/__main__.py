"""
Root CLI for the SSH keys, for when no other superuser can approve:

    python -m manager.keys list [--pending]
    python -m manager.keys approve <username> <fingerprint>

Run as the service user from the backend directory, like manager.pki.
"""
import argparse
import asyncio
import sys
from datetime import datetime

from sqlmodel import select

from core.audit.models import AuditLog
from core.auth.models import User
from core.database import async_session_maker
from manager.models import UserSshKey
from . import approve, list_all


async def _list(pending: bool) -> None:
    async with async_session_maker() as session:
        for key, owner in await list_all(session, "pending" if pending else None):
            print(f"{owner:20} {key.status:9} {key.fingerprint}  {key.name}")


async def _approve(username: str, fingerprint: str) -> None:
    async with async_session_maker() as session:
        row = (await session.execute(
            select(UserSshKey, User).join(User, User.id == UserSshKey.user_id)
            .where(User.username == username, UserSshKey.fingerprint == fingerprint)
        )).first()
        if row is None:
            sys.exit("ERRORE: chiave non trovata (python -m manager.keys list --pending)")
        key, _ = row
        if key.status == "approved":
            print("Chiave già approvata")
            return
        await approve(session, key, "root-cli")
        session.add(AuditLog(timestamp=datetime.utcnow(), username="root-cli", method="CLI",
                             path=f"manager.keys approve {username} {fingerprint}", status_code=200,
                             duration_ms=0, category="write"))
        await session.commit()
        print(f"Chiave {fingerprint} di {username} approvata")


def _main() -> None:
    parser = argparse.ArgumentParser(prog="python -m manager.keys")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("list")
    p.add_argument("--pending", action="store_true")
    p = sub.add_parser("approve")
    p.add_argument("username")
    p.add_argument("fingerprint")
    args = parser.parse_args()
    if args.cmd == "list":
        asyncio.run(_list(args.pending))
    else:
        asyncio.run(_approve(args.username, args.fingerprint))


if __name__ == "__main__":
    _main()
