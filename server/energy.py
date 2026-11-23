"""Daily energy expenditure.

Two possible sources, chosen by each user:
- strava: basal metabolic rate (Mifflin-St Jeor) x lifestyle + calories from Strava activities
- garmin: Garmin Connect daily summary (resting + active = total), via the garminconnect library
"""

import json
import os
import secrets
import shutil
import time
from datetime import date, datetime, timedelta
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse

from pydantic import BaseModel, Field

from .auth import current_user, is_admin
from .db import ROOT, db, garmin_token_dir
from .metabolism import daily_base

router = APIRouter(prefix="/api")

STRAVA_API = "https://www.strava.com/api/v3"
STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token"
TODAY_TTL = timedelta(minutes=10)  # Strava/Garmin are queried again at most every 10 min

ACTIVITY_ICONS = {
    "run": "🏃", "trail": "🏃", "walk": "🚶", "hik": "🥾", "ride": "🚴", "cycl": "🚴", "bik": "🚴",
    "swim": "🏊", "ski": "⛷️", "row": "🚣", "strength": "🏋️", "weight": "🏋️", "yoga": "🧘",
}


def icon_for(kind: str) -> str:
    kind = (kind or "").lower()
    return next((ic for key, ic in ACTIVITY_ICONS.items() if key in kind), "💪")


# ---------- Cache ----------
def _cached(user_id: int, day: date, source: str):
    with db() as conn:
        row = conn.execute(
            "SELECT data, fetched_at FROM energy_cache WHERE user_id = ? AND day = ? AND source = ?",
            (user_id, day.isoformat(), source),
        ).fetchone()
    if not row:
        return None, False
    fetched = datetime.fromisoformat(row["fetched_at"])
    if day < date.today():
        fresh = fetched.date() > day  # fetched after the day ended: final
    else:
        fresh = datetime.now() - fetched < TODAY_TTL
    return json.loads(row["data"]), fresh


def _store(user_id: int, day: date, source: str, data) -> None:
    with db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO energy_cache (user_id, day, source, data, fetched_at) VALUES (?, ?, ?, ?, ?)",
            (user_id, day.isoformat(), source, json.dumps(data), datetime.now().isoformat()),
        )


def _with_cache(user_id: int, day: date, source: str, fetch):
    """Return (data, warning). Serves the cache if the remote service fails."""
    data, fresh = _cached(user_id, day, source)
    if fresh and any("url" not in a for a in data.get("activities", [])):
        fresh = False  # cache from before activity links existed: refresh it once
    if fresh:
        return data, None
    try:
        data = fetch()
    except Exception as exc:  # network, expired token, service down…
        if data is not None:
            return data, f"Données de {source.capitalize()} non actualisées ({exc})"
        raise
    _store(user_id, day, source, data)
    return data, None


# ---------- Strava ----------
_oauth_states: dict[str, tuple[int, float]] = {}  # state -> (user_id, expiry)


def _strava_creds() -> tuple[str, str]:
    cid, secret = os.environ.get("STRAVA_CLIENT_ID"), os.environ.get("STRAVA_CLIENT_SECRET")
    if not cid or not secret:
        raise HTTPException(503, "Strava n'est pas configuré sur le serveur (STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET)")
    return cid, secret


def _save_strava_tokens(user_id: int, tok: dict) -> None:
    with db() as conn:
        conn.execute(
            """UPDATE users SET strava_access = ?, strava_refresh = ?, strava_expires = ?,
               strava_athlete = COALESCE(?, strava_athlete) WHERE id = ?""",
            (tok["access_token"], tok["refresh_token"], tok["expires_at"],
             str(tok["athlete"]["id"]) if tok.get("athlete") else None, user_id),
        )


def _strava_access_token(user) -> str:
    if not user["strava_refresh"]:
        raise RuntimeError("Strava non connecté")
    if user["strava_access"] and (user["strava_expires"] or 0) > time.time() + 60:
        return user["strava_access"]
    cid, secret = _strava_creds()
    r = httpx.post(STRAVA_TOKEN_URL, data={
        "client_id": cid, "client_secret": secret,
        "grant_type": "refresh_token", "refresh_token": user["strava_refresh"],
    }, timeout=20)
    r.raise_for_status()
    tok = r.json()
    _save_strava_tokens(user["id"], tok)
    return tok["access_token"]


def _strava_day(user, day: date) -> dict:
    token = _strava_access_token(user)
    headers = {"Authorization": f"Bearer {token}"}
    start = datetime.combine(day, datetime.min.time()).astimezone()
    params = {"after": int(start.timestamp()), "before": int((start + timedelta(days=1)).timestamp()), "per_page": 50}
    with httpx.Client(timeout=20, headers=headers) as client:
        r = client.get(f"{STRAVA_API}/athlete/activities", params=params)
        r.raise_for_status()
        activities = []
        for a in r.json():
            activities.append({
                "name": a.get("name") or a.get("sport_type") or "Activité",
                "type": a.get("sport_type") or a.get("type") or "",
                "kcal": _strava_activity_kcal(client, a),
                "distance_km": round((a.get("distance") or 0) / 1000, 1),
                "minutes": round((a.get("moving_time") or 0) / 60),
                "start": a.get("start_date_local"),
                "url": f"https://www.strava.com/activities/{a['id']}" if a.get("id") else None,
            })
    return {"activities": activities}


def _strava_activity_kcal(client: httpx.Client, summary: dict) -> float:
    """Calories are only in an activity's details: cache them per activity."""
    aid = summary["id"]
    with db() as conn:
        row = conn.execute("SELECT kcal FROM strava_activity_kcal WHERE activity_id = ?", (aid,)).fetchone()
    if row:
        return row["kcal"]
    r = client.get(f"{STRAVA_API}/activities/{aid}")
    r.raise_for_status()
    detail = r.json()
    # without calories (no sensor), a ride's mechanical energy (kJ) ≈ kcal burned
    kcal = float(detail.get("calories") or detail.get("kilojoules") or 0)
    with db() as conn:
        conn.execute("INSERT OR REPLACE INTO strava_activity_kcal (activity_id, kcal) VALUES (?, ?)", (aid, kcal))
    return kcal


class StravaConfig(BaseModel):
    client_id: str = Field(pattern=r"^\d{1,12}$")
    client_secret: str = Field(pattern=r"^[0-9a-fA-F]{20,80}$")


def _write_env(values: dict[str, str]) -> None:
    """Update (or add) keys in ROOT/.env, a file readable by its owner only."""
    env = ROOT / ".env"
    lines = env.read_text().splitlines() if env.exists() else []
    remaining = dict(values)
    out = []
    for line in lines:
        key = line.split("=", 1)[0].strip()
        if key in remaining and not line.lstrip().startswith("#"):
            out.append(f"{key}={remaining.pop(key)}")
        else:
            out.append(line)
    out += [f"{k}={v}" for k, v in remaining.items()]
    env.touch(mode=0o600)
    env.chmod(0o600)
    env.write_text("\n".join(out) + "\n")
    os.environ.update(values)


@router.post("/strava/config")
def strava_config(body: StravaConfig, user=Depends(current_user)):
    if not is_admin(user):
        raise HTTPException(403, "Seul l'administrateur (premier compte créé) peut configurer Strava")
    _write_env({"STRAVA_CLIENT_ID": body.client_id, "STRAVA_CLIENT_SECRET": body.client_secret})
    return {"ok": True}


@router.get("/strava/connect")
def strava_connect(request: Request, force: bool = False, user=Depends(current_user)):
    # Strava shows a raw error page if the redirect address isn't on the "callback domain"
    # registered there: we remember the domain that worked and warn before sending the user.
    known = os.environ.get("STRAVA_CALLBACK_HOST")
    if known and request.url.hostname != known and not force:
        return RedirectResponse("/?strava=wronghost")
    try:
        cid, _ = _strava_creds()
    except HTTPException:
        return RedirectResponse("/?strava=notconfigured")
    now = time.time()
    for k in [k for k, (_, exp) in _oauth_states.items() if exp < now]:
        _oauth_states.pop(k, None)
    state = secrets.token_urlsafe(24)
    _oauth_states[state] = (user["id"], now + 600)
    redirect_uri = str(request.url_for("strava_callback"))
    query = urlencode({
        "client_id": cid, "redirect_uri": redirect_uri, "response_type": "code",
        "approval_prompt": "auto", "scope": "activity:read_all", "state": state,
    })
    return RedirectResponse(f"https://www.strava.com/oauth/authorize?{query}")


@router.get("/strava/callback", name="strava_callback")
def strava_callback(request: Request, state: str = "", code: str = "", error: str = "", scope: str = ""):
    owner = _oauth_states.pop(state, None)
    if not owner or owner[1] < time.time():
        return RedirectResponse("/?strava=expired")
    if error or not code:
        return RedirectResponse("/?strava=denied")
    if "activity:read" not in scope:
        return RedirectResponse("/?strava=scope")
    cid, secret = _strava_creds()
    r = httpx.post(STRAVA_TOKEN_URL, data={
        "client_id": cid, "client_secret": secret, "code": code, "grant_type": "authorization_code",
    }, timeout=20)
    if r.status_code != 200:
        return RedirectResponse("/?strava=error")
    _save_strava_tokens(owner[0], r.json())
    with db() as conn:
        conn.execute("UPDATE users SET energy_source = 'strava' WHERE id = ?", (owner[0],))
        conn.execute("DELETE FROM energy_cache WHERE user_id = ? AND source = 'strava'", (owner[0],))
    if request.url.hostname and os.environ.get("STRAVA_CALLBACK_HOST") != request.url.hostname:
        _write_env({"STRAVA_CALLBACK_HOST": request.url.hostname})  # domain accepted by Strava
    return RedirectResponse("/?strava=ok")


@router.post("/strava/disconnect")
def strava_disconnect(user=Depends(current_user)):
    if user["strava_access"]:
        try:  # also revokes access on Strava's side
            httpx.post("https://www.strava.com/oauth/deauthorize",
                       data={"access_token": user["strava_access"]}, timeout=10)
        except httpx.HTTPError:
            pass
    with db() as conn:
        conn.execute(
            """UPDATE users SET strava_access = NULL, strava_refresh = NULL, strava_expires = NULL,
               strava_athlete = NULL WHERE id = ?""", (user["id"],))
        conn.execute("DELETE FROM energy_cache WHERE user_id = ? AND source = 'strava'", (user["id"],))
    return {"ok": True}


# ---------- Garmin ----------
def _garmin_client(user_id: int):
    from garminconnect import Garmin  # late import: the library is heavy

    path = garmin_token_dir(user_id)
    if not (path / "garmin_tokens.json").exists():
        raise RuntimeError("Garmin non connecté")
    client = Garmin()
    client.login(tokenstore=str(path))
    return client, path


def _garmin_day(user, day: date) -> dict:
    client, path = _garmin_client(user["id"])
    d = day.isoformat()
    summary = client.get_user_summary(d) or {}
    activities = []
    for a in client.get_activities_by_date(d, d) or []:
        kind = (a.get("activityType") or {}).get("typeKey", "")
        activities.append({
            "name": a.get("activityName") or kind or "Activité",
            "type": kind,
            "kcal": float(a.get("calories") or 0),
            "distance_km": round((a.get("distance") or 0) / 1000, 1),
            "minutes": round((a.get("duration") or 0) / 60),
            "start": a.get("startTimeLocal"),
            "url": f"https://connect.garmin.com/modern/activity/{a['activityId']}" if a.get("activityId") else None,
        })
    try:  # keeps a token that may have been refreshed
        client.client.dump(str(path))
    except Exception:
        pass
    return {
        "total": summary.get("totalKilocalories"),
        "active": summary.get("activeKilocalories"),
        "resting": summary.get("bmrKilocalories"),
        "activities": activities,
    }


_garmin_mfa: dict[int, tuple[dict, float]] = {}  # user_id -> (login state waiting for the code, expiry)


class GarminLogin(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=1, max_length=200)


class GarminCode(BaseModel):
    code: str = Field(min_length=4, max_length=12)


def _garmin_error(exc: Exception) -> HTTPException:
    name = type(exc).__name__
    if "TooManyRequests" in name:
        return HTTPException(429, "Garmin bloque temporairement les connexions : réessaie dans quelques minutes")
    if "Authentication" in name:
        # 400, not 401: in the app, 401 means "Kcal session expired" and goes back to the login screen
        return HTTPException(400, "Garmin a refusé la connexion : vérifie l'e-mail, le mot de passe ou le code")
    return HTTPException(502, f"Garmin injoignable : {exc}")


def _garmin_save(user_id: int, client) -> None:
    path = garmin_token_dir(user_id)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)
    client.client.dump(str(path))
    with db() as conn:
        conn.execute(
            "UPDATE users SET energy_source = 'garmin' WHERE id = ? AND energy_source = 'none'", (user_id,))
        conn.execute("DELETE FROM energy_cache WHERE user_id = ? AND source = 'garmin'", (user_id,))


@router.post("/garmin/login")
def garmin_login(body: GarminLogin, user=Depends(current_user)):
    """The password is used for this login only: it is neither stored nor logged."""
    from garminconnect import Garmin

    client = Garmin(body.email.strip(), body.password, return_on_mfa=True)
    try:
        status, state = client.login()
    except Exception as exc:
        raise _garmin_error(exc) from None
    if status == "needs_mfa":
        _garmin_mfa[user["id"]] = (state, time.time() + 300)
        return {"mfa": True}
    _garmin_save(user["id"], client)
    return {"ok": True}


@router.post("/garmin/mfa")
def garmin_mfa(body: GarminCode, user=Depends(current_user)):
    from garminconnect import Garmin

    pending = _garmin_mfa.pop(user["id"], None)
    if not pending or pending[1] < time.time():
        raise HTTPException(410, "Le délai pour saisir le code est dépassé : recommence la connexion")
    client = Garmin()
    try:
        client.resume_login(pending[0], body.code.strip())
    except Exception as exc:
        raise _garmin_error(exc) from None
    _garmin_save(user["id"], client)
    return {"ok": True}


@router.post("/garmin/disconnect")
def garmin_disconnect(user=Depends(current_user)):
    shutil.rmtree(garmin_token_dir(user["id"]), ignore_errors=True)
    with db() as conn:
        conn.execute("DELETE FROM energy_cache WHERE user_id = ? AND source = 'garmin'", (user["id"],))
    return {"ok": True}


# ---------- Daily summary ----------
@router.get("/energy")
def energy(day: date | None = None, user=Depends(current_user)):
    day = day or date.today()
    source = user["energy_source"]
    out = {"source": source, "day": day.isoformat(), "partial": day == date.today(),
           "burned": None, "resting": None, "active": None, "activities": [], "warning": None, "error": None}
    if source == "none" or day > date.today():
        return out

    if source == "strava":
        base, out["calibration"] = daily_base(user)
        if base is not None:
            out["resting"] = round(base)
        try:
            data, out["warning"] = _with_cache(user["id"], day, "strava", lambda: _strava_day(user, day))
            out["activities"] = data["activities"]
        except Exception as exc:
            out["error"] = f"Strava : {exc}"
        out["active"] = round(sum(a["kcal"] for a in out["activities"]))
        if out["resting"] is None:
            out["error"] = "Complète ton profil (sexe, année de naissance, taille, poids) dans les réglages"
        else:
            out["burned"] = out["resting"] + out["active"]
            out["partial"] = False  # the basal rate counts for the whole day

    elif source == "garmin":
        try:
            data, out["warning"] = _with_cache(user["id"], day, "garmin", lambda: _garmin_day(user, day))
            out.update({k: data.get(k) for k in ("activities",)})
            out["resting"], out["active"], out["burned"] = data.get("resting"), data.get("active"), data.get("total")
        except Exception as exc:
            out["error"] = f"Garmin : {exc}"

    for a in out["activities"]:
        a["icon"] = icon_for(a["type"])
    for k in ("burned", "resting", "active"):
        if out[k] is not None:
            out[k] = round(out[k])
    return out
