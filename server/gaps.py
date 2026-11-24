"""Forgotten meals: usual meal slots, the ones missing on a day, and incomplete days.

- A meal belongs to a slot by its time (breakfast, lunch, snack, dinner).
- A slot is "usual" when the user logged a meal in it on at least half of their logged days over the last
  4 weeks (with at least 7 logged days, otherwise nothing is flagged).
- A usual slot with nothing logged on a day is a gap, unless the user said they skipped that meal.
  Today's slots only count once they're over.
- A logged day with a gap is incomplete: it's left out of the averages, the on-target count and the calibration.
"""

import json
from datetime import date, datetime, timedelta
from statistics import median

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .auth import current_user
from .db import db

router = APIRouter(prefix="/api")

# key, label, from hour, to hour (meals after midnight count as dinner), default time
SLOTS = [
    ("breakfast", "petit-déjeuner", 5.0, 10.5, "08:00"),
    ("lunch", "déjeuner", 10.5, 15.0, "12:30"),
    ("snack", "goûter", 15.0, 18.0, "16:30"),
    ("dinner", "dîner", 18.0, 29.0, "20:00"),
]
SLOT_KEYS = [s[0] for s in SLOTS]
HABIT_DAYS = 28
HABIT_MIN_LOGGED = 7
HABIT_RATE = 0.5


def slot_of(eaten_at: str) -> str:
    t = datetime.fromisoformat(eaten_at)
    h = t.hour + t.minute / 60
    if h < 5:
        h += 24
    return next(key for key, _, lo, hi, _ in SLOTS if lo <= h < hi)


def _meals(conn, user_id: int, start: date, end: date):
    return conn.execute(
        "SELECT day, eaten_at, title, items, kcal, water_ml FROM meals "
        "WHERE user_id = ? AND day BETWEEN ? AND ? AND kcal > 0",
        (user_id, start.isoformat(), end.isoformat()),
    ).fetchall()


def habits(user_id: int, today: date | None = None) -> dict[str, dict]:
    """Usual slots over the last 4 weeks: {slot: {"rate", "usual": typical meal}}."""
    today = today or date.today()
    with db() as conn:
        rows = _meals(conn, user_id, today - timedelta(days=HABIT_DAYS), today - timedelta(days=1))
    logged = {r["day"] for r in rows}
    if len(logged) < HABIT_MIN_LOGGED:
        return {}
    out = {}
    for key in SLOT_KEYS:
        meals = [r for r in rows if slot_of(r["eaten_at"]) == key]
        days = {r["day"] for r in meals}
        rate = len(days) / len(logged)
        if rate < HABIT_RATE:
            continue
        # typical meal: the one closest to the median calories of that slot per day
        per_day = {}
        for r in meals:
            per_day[r["day"]] = per_day.get(r["day"], 0) + r["kcal"]
        mid = median(per_day.values())
        with_items = [r for r in meals if json.loads(r["items"])]
        if with_items:
            typical = min(with_items, key=lambda r: abs(r["kcal"] - mid))
            usual = {"title": typical["title"], "items": json.loads(typical["items"]),
                     "water_ml": typical["water_ml"] or 0, "kcal": round(typical["kcal"])}
        else:  # no detail to reuse: one line with the usual calories
            label = next(lbl for k, lbl, *_ in SLOTS if k == key)
            usual = {"title": label.capitalize(), "water_ml": 0, "kcal": round(mid),
                     "items": [{"name": f"{label.capitalize()} (estimation)", "grams": 100, "kcal_100g": round(mid),
                                "protein_100g": 0, "carbs_100g": 0, "fat_100g": 0}]}
        out[key] = {"rate": round(rate, 2), "kcal": round(mid), "usual": usual}
    return out


def day_status(user_id: int, start: date, end: date, now: datetime | None = None,
               habit: dict | None = None) -> dict[str, dict]:
    """Per day: {"logged", "missing": [slots], "complete": True/False (None when nothing logged)}."""
    now = now or datetime.now()
    today = now.date()
    habit = habits(user_id, today) if habit is None else habit
    with db() as conn:
        rows = _meals(conn, user_id, start, end)
        marks = conn.execute("SELECT day, slot FROM skipped_meals WHERE user_id = ? AND day BETWEEN ? AND ?",
                             (user_id, start.isoformat(), end.isoformat())).fetchall()
    present: dict[str, set] = {}
    for r in rows:
        present.setdefault(r["day"], set()).add(slot_of(r["eaten_at"]))
    skipped: dict[str, set] = {}
    for m in marks:
        skipped.setdefault(m["day"], set()).add(m["slot"])
    hour = now.hour + now.minute / 60
    out = {}
    for k in range((end - start).days + 1):
        d = start + timedelta(days=k)
        iso = d.isoformat()
        if d > today:
            continue
        missing = [key for key, _, _, hi, _ in SLOTS
                   if key in habit and key not in present.get(iso, set()) and key not in skipped.get(iso, set())
                   and (d < today or hour >= (hi if hi <= 24 else 24))]
        logged = iso in present
        out[iso] = {"logged": logged, "missing": missing, "complete": (not missing) if logged else None}
    return out


def incomplete_days(user_id: int, start: date, end: date) -> set[str]:
    return {d for d, s in day_status(user_id, start, end).items() if s["complete"] is False}


@router.get("/gaps")
def gaps(day: date | None = None, user=Depends(current_user)):
    """Usual meals not logged on a day, each with a typical meal to add in one tap."""
    day = day or date.today()
    habit = habits(user["id"])
    st = day_status(user["id"], day, day, habit=habit).get(day.isoformat(),
                                                           {"logged": False, "missing": [], "complete": None})
    labels = {key: (label, time) for key, label, _, _, time in SLOTS}
    return {
        "day": day.isoformat(), "logged": st["logged"], "complete": st["complete"],
        "missing": [{"slot": key, "label": labels[key][0], "time": labels[key][1],
                     "usual_kcal": habit[key]["kcal"], "usual": habit[key]["usual"]} for key in st["missing"]],
    }


class Skip(BaseModel):
    day: date
    slot: str


@router.post("/gaps/skip")
def skip_meal(body: Skip, user=Depends(current_user)):
    """The user skipped that meal: not a gap any more."""
    if body.slot not in SLOT_KEYS:
        raise HTTPException(400, "Repas inconnu")
    with db() as conn:
        conn.execute("INSERT OR IGNORE INTO skipped_meals (user_id, day, slot) VALUES (?, ?, ?)",
                     (user["id"], body.day.isoformat(), body.slot))
    return {"ok": True}
