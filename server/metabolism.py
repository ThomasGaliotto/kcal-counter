"""Basal metabolic rate and personal calibration from weigh-ins.

BMR:
- with a body fat % (measured, or estimated from the chosen silhouette): Katch-McArdle,
  370 + 21.6 × lean mass (kg) — it accounts for muscle, which burns more than fat;
- otherwise: Mifflin-St Jeor, from sex, age, height and weight.

Calibration: over the last 4 weeks, what was eaten and how the weight moved give the real
expenditure (1 kg ≈ 7,700 kcal). Compared with the formula, it yields a personal factor
(e.g. 0.92 = the body burns 8 % less than predicted), capped at ±20 %.
"""

import json
from datetime import date, timedelta

from fastapi import APIRouter, Depends

from .auth import current_user
from .db import db

router = APIRouter(prefix="/api")

KCAL_PER_KG = 7700

# Visual body fat estimate per silhouette (1 = very lean … 5 = heavy), like the usual reference charts.
# Kept in sync with MORPHOLOGY in web/app.js.
BODY_FAT = {"m": {1: 10, 2: 15, 3: 20, 4: 26, 5: 33}, "f": {1: 18, 2: 23, 3: 28, 4: 34, 5: 41}}

CALIB_DAYS = 28        # window looked at
CALIB_MIN_LOGGED = 14  # days with meals logged (≥ MIN_DAY_KCAL) needed
CALIB_MIN_SPAN = 14    # days between first and last weigh-in in the window
MIN_DAY_KCAL = 800     # below that, the day was probably not fully logged
CALIB_LIMIT = 0.20     # correction capped at ±20 %


def body_fat(user) -> tuple[float | None, str | None]:
    """(% body fat, where it comes from: 'measured' | 'silhouette'), or (None, None)."""
    if user["body_fat_pct"]:
        return user["body_fat_pct"], "measured"
    if user["morphology"] and user["sex"] in BODY_FAT:
        return BODY_FAT[user["sex"]].get(int(user["morphology"])), "silhouette"
    return None, None


def bmr(user) -> float | None:
    """Basal metabolic rate (kcal/day). None if the profile is incomplete."""
    weight = user["weight_kg"]
    fat, _ = body_fat(user)
    if weight and fat is not None:
        return 370 + 21.6 * weight * (1 - fat / 100)
    if not all(user[k] for k in ("sex", "birth_year", "height_cm", "weight_kg")):
        return None
    age = date.today().year - user["birth_year"]
    base = 10 * weight + 6.25 * user["height_cm"] - 5 * age
    return base + (5 if user["sex"] == "m" else -161)


def _slope(points: list[tuple[float, float]]) -> float:
    """Least-squares slope of (x, y) points: weight trend in kg per day, robust to day-to-day noise."""
    n = len(points)
    mx = sum(x for x, _ in points) / n
    my = sum(y for _, y in points) / n
    den = sum((x - mx) ** 2 for x, _ in points)
    return sum((x - mx) * (y - my) for x, y in points) / den if den else 0.0


def calibration(user) -> dict:
    """Personal expenditure factor from the last 4 weeks of meals and weigh-ins."""
    out = {"enabled": bool(user["calibrate"]), "factor": 1.0, "status": "waiting",
           "days_logged": 0, "weighins": 0, "span_days": 0, "needed_days": CALIB_MIN_LOGGED}
    if user["energy_source"] == "garmin":
        out["status"] = "garmin"  # expenditure measured by the watch, nothing to calibrate
        return out
    base = bmr(user)
    if base is None:
        out["status"] = "no_profile"
        return out
    end = date.today() - timedelta(days=1)  # today isn't finished
    start = end - timedelta(days=CALIB_DAYS - 1)
    with db() as conn:
        rows = conn.execute(
            "SELECT day, SUM(kcal) AS kcal FROM meals WHERE user_id = ? AND day BETWEEN ? AND ? GROUP BY day",
            (user["id"], start.isoformat(), end.isoformat()),
        ).fetchall()
        weights = conn.execute(
            "SELECT day, kg FROM weights WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day",
            (user["id"], start.isoformat(), end.isoformat()),
        ).fetchall()
        cache = conn.execute(
            "SELECT day, data FROM energy_cache WHERE user_id = ? AND source = 'strava' AND day BETWEEN ? AND ?",
            (user["id"], start.isoformat(), end.isoformat()),
        ).fetchall() if user["energy_source"] == "strava" else []
    logged = {r["day"]: r["kcal"] for r in rows if r["kcal"] >= MIN_DAY_KCAL}
    out["days_logged"], out["weighins"] = len(logged), len(weights)
    if weights:
        out["span_days"] = (date.fromisoformat(weights[-1]["day"]) - date.fromisoformat(weights[0]["day"])).days
    if len(logged) < CALIB_MIN_LOGGED or len(weights) < 3 or out["span_days"] < CALIB_MIN_SPAN:
        return out

    active = {r["day"]: sum(a.get("kcal", 0) for a in json.loads(r["data"]).get("activities", [])) for r in cache}
    mean_intake = sum(logged.values()) / len(logged)
    mean_active = sum(active.get(d, 0) for d in logged) / len(logged)
    slope = _slope([((date.fromisoformat(w["day"]) - start).days, w["kg"]) for w in weights])
    real = mean_intake - slope * KCAL_PER_KG  # eating more than you burn makes the weight go up
    model_base = base * (user["life_factor"] or 1.2)
    raw = (real - mean_active) / model_base
    factor = min(1 + CALIB_LIMIT, max(1 - CALIB_LIMIT, raw))
    out.update({
        "status": "ok", "raw_factor": round(raw, 3), "capped": factor != raw,
        "mean_intake": round(mean_intake), "weekly_change_kg": round(slope * 7, 2),
        "real_expenditure": round(real), "model_expenditure": round(model_base + mean_active),
    })
    if out["enabled"]:
        out["factor"] = round(factor, 3)
    out["suggested_factor"] = round(factor, 3)
    return out


def daily_base(user) -> tuple[float | None, dict]:
    """Expenditure outside sport: BMR × daily activity × personal factor; and the calibration details."""
    base = bmr(user)
    calib = calibration(user)
    if base is None:
        return None, calib
    return base * (user["life_factor"] or 1.2) * calib["factor"], calib


@router.get("/metabolism")
def metabolism(user=Depends(current_user)):
    """What the expenditure is based on: formula, body fat, daily activity, calibration."""
    fat, fat_source = body_fat(user)
    base = bmr(user)
    daily, calib = daily_base(user)
    return {
        "bmr": round(base) if base else None,
        "formula": "katch" if fat is not None and user["weight_kg"] else "mifflin" if base else None,
        "body_fat_pct": fat, "body_fat_source": fat_source,
        "life_factor": user["life_factor"] or 1.2,
        "daily": round(daily) if daily else None,
        "calibration": calib,
    }
