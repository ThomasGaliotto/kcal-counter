"""Single-use invitations, created by the administrator to open an account."""

import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .auth import current_user, is_admin
from .db import db

INVITE_DAYS = 7

router = APIRouter(prefix="/api/invites")


def admin_user(user=Depends(current_user)):
    if not is_admin(user):
        raise HTTPException(403, "Réservé à l'administrateur")
    return user


def _link(request: Request, code: str) -> str:
    return f"{str(request.base_url).rstrip('/')}/?invite={code}"


def _row(request: Request, r) -> dict:
    now = datetime.now().isoformat()
    status = "used" if r["used_at"] else "expired" if r["expires_at"] <= now else "pending"
    return {
        "code": r["code"], "note": r["note"], "created_at": r["created_at"], "expires_at": r["expires_at"],
        "used_at": r["used_at"], "status": status,
        "link": _link(request, r["code"]) if status == "pending" else None,
    }


def _list(request: Request) -> list[dict]:
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM invites ORDER BY created_at DESC LIMIT 50"
        ).fetchall()
    return [_row(request, r) for r in rows]


class NewInvite(BaseModel):
    note: str = Field(min_length=1, max_length=60)


@router.get("")
def list_invites(request: Request, user=Depends(admin_user)):
    return _list(request)


@router.post("")
def create_invite(body: NewInvite, request: Request, user=Depends(admin_user)):
    code = secrets.token_urlsafe(12)
    now = datetime.now()
    with db() as conn:
        conn.execute(
            "INSERT INTO invites (code, note, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
            (code, body.note.strip(), user["id"], now.isoformat(), (now + timedelta(days=INVITE_DAYS)).isoformat()),
        )
    return {"invite": next(i for i in _list(request) if i["code"] == code), "invites": _list(request)}


@router.delete("/{code}")
def delete_invite(code: str, request: Request, user=Depends(admin_user)):
    with db() as conn:
        conn.execute("DELETE FROM invites WHERE code = ?", (code,))
    return _list(request)
