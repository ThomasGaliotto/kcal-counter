"""Comptes utilisateurs : inscription, connexion par e-mail + mot de passe, sessions par cookie."""

import asyncio
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from typing import Literal

from .db import db, garmin_token_dir

COOKIE = "kcal_session"
SESSION_DAYS = 180  # l'iPhone reste connecté ~6 mois
INVITE_CODE = os.environ.get("KCAL_INVITE_CODE", "")

router = APIRouter(prefix="/api")


# ---------- Mots de passe (scrypt, bibliothèque standard) ----------
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, salt, digest = stored.split("$")
    except ValueError:
        return False
    test = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1)
    return hmac.compare_digest(test.hex(), digest)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


PUBLIC_FIELDS = (
    "id", "email", "name", "kcal_goal", "water_goal", "energy_source", "balance_goal",
    "sex", "birth_year", "height_cm", "weight_kg", "life_factor", "protein_goal",
    "protein_mode", "protein_value",
)


def is_admin(user) -> bool:
    """L'administrateur est le premier compte créé (celui qui héberge l'app)."""
    with db() as conn:
        first = conn.execute("SELECT MIN(id) FROM users").fetchone()[0]
    return user["id"] == first


def _public(user) -> dict:
    data = {k: user[k] for k in PUBLIC_FIELDS}
    data["is_admin"] = is_admin(user)
    data["strava_connected"] = bool(user["strava_refresh"])
    data["strava_available"] = bool(os.environ.get("STRAVA_CLIENT_ID"))
    data["strava_host"] = os.environ.get("STRAVA_CALLBACK_HOST")  # adresse acceptée par Strava
    data["garmin_connected"] = (garmin_token_dir(user["id"]) / "garmin_tokens.json").exists()
    return data


def _start_session(request: Request, response: Response, user_id: int) -> None:
    token = secrets.token_urlsafe(32)
    expires = datetime.now() + timedelta(days=SESSION_DAYS)
    with db() as conn:
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (datetime.now().isoformat(),))
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (_token_hash(token), user_id, expires.isoformat()),
        )
    response.set_cookie(
        COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax",
        secure=request.url.scheme == "https",
    )


def current_user(request: Request):
    """Dépendance FastAPI : renvoie l'utilisateur connecté, sinon 401."""
    token = request.cookies.get(COOKIE)
    if token:
        with db() as conn:
            user = conn.execute(
                """SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
                   WHERE token_hash = ? AND expires_at > ?""",
                (_token_hash(token), datetime.now().isoformat()),
            ).fetchone()
        if user:
            return user
    raise HTTPException(401, "Non connecté")


# ---------- Routes ----------
class Register(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=8, max_length=200)
    name: str = Field(min_length=1, max_length=60)
    invite_code: str = ""


class Login(BaseModel):
    email: str
    password: str


class Profile(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=60)
    kcal_goal: int | None = Field(None, gt=0, le=20000)
    water_goal: int | None = Field(None, gt=0, le=20000)
    energy_source: Literal["none", "strava", "garmin"] | None = None
    balance_goal: int | None = Field(None, ge=-2000, le=2000)
    sex: Literal["m", "f"] | None = None
    birth_year: int | None = Field(None, ge=1900, le=2100)
    height_cm: float | None = Field(None, ge=50, le=260)
    weight_kg: float | None = Field(None, ge=20, le=400)
    life_factor: float | None = Field(None, ge=1.0, le=2.0)


class PasswordChange(BaseModel):
    current: str
    new: str = Field(min_length=8, max_length=200)


@router.get("/auth/config")
def auth_config():
    return {"invite_required": bool(INVITE_CODE)}


@router.post("/auth/register")
def register(body: Register, request: Request, response: Response):
    if INVITE_CODE and not hmac.compare_digest(body.invite_code.strip(), INVITE_CODE):
        raise HTTPException(403, "Code d'invitation incorrect")
    email = body.email.strip().lower()
    if "@" not in email:
        raise HTTPException(400, "Adresse e-mail invalide")
    with db() as conn:
        if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            raise HTTPException(409, "Un compte existe déjà avec cet e-mail")
        first = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
        cur = conn.execute(
            "INSERT INTO users (email, name, pw_hash, created_at) VALUES (?, ?, ?, ?)",
            (email, body.name.strip(), hash_password(body.password), datetime.now().isoformat()),
        )
        user_id = cur.lastrowid
        if first:  # le premier compte récupère l'historique d'avant les comptes
            conn.execute("UPDATE meals SET user_id = ? WHERE user_id IS NULL", (user_id,))
        user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    _start_session(request, response, user_id)
    return _public(user)


@router.post("/auth/login")
async def login(body: Login, request: Request, response: Response):
    with db() as conn:
        user = conn.execute("SELECT * FROM users WHERE email = ?", (body.email.strip().lower(),)).fetchone()
    if not user or not check_password(body.password, user["pw_hash"]):
        await asyncio.sleep(1)  # ralentit les essais de mots de passe en série
        raise HTTPException(401, "E-mail ou mot de passe incorrect")
    _start_session(request, response, user["id"])
    return _public(user)


@router.post("/auth/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        with db() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))
    response.delete_cookie(COOKIE)
    return {"ok": True}


@router.get("/me")
def me(user=Depends(current_user)):
    return _public(user)


@router.patch("/me")
def update_me(body: Profile, user=Depends(current_user)):
    changes = body.model_dump(exclude_none=True)
    if changes:
        sets = ", ".join(f"{k} = ?" for k in changes)
        with db() as conn:
            conn.execute(f"UPDATE users SET {sets} WHERE id = ?", (*changes.values(), user["id"]))
            user = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
        if {"weight_kg", "sex", "birth_year", "height_cm", "life_factor"} & changes.keys():
            from .goals import apply_plan  # import tardif : goals dépend de auth
            apply_plan(user["id"])
            with db() as conn:
                user = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    return _public(user)


@router.post("/me/password")
def change_password(body: PasswordChange, request: Request, user=Depends(current_user)):
    if not check_password(body.current, user["pw_hash"]):
        raise HTTPException(403, "Mot de passe actuel incorrect")
    keep = _token_hash(request.cookies.get(COOKIE, ""))
    with db() as conn:
        conn.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (hash_password(body.new), user["id"]))
        # déconnecte les autres appareils
        conn.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (user["id"], keep))
    return {"ok": True}
