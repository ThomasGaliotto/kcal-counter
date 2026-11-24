"""Weekly summary and logging streaks.

- A day counts as "logged" when it has at least one meal with calories (water alone doesn't count).
- Streak: consecutive logged days up to today; today not logged yet doesn't break it.
- Day on target: compared with that day's calorie goal (fixed goal, or expenditure + target balance),
  in the goal's direction: under it when losing, above it when gaining, within ±10 % when maintaining.
"""

import calendar
import json
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException

from .auth import current_user
from .db import db
from .energy import _cached, energy
from .metabolism import daily_base

router = APIRouter(prefix="/api")

MILESTONES = (3, 7, 14, 30, 60, 100, 200, 365)


def logged_days(user_id: int) -> list[date]:
    with db() as conn:
        rows = conn.execute(
            "SELECT DISTINCT day FROM meals WHERE user_id = ? AND kcal > 0 ORDER BY day", (user_id,)
        ).fetchall()
    return [date.fromisoformat(r["day"]) for r in rows]


def streak_of(days: list[date], today: date | None = None) -> dict:
    today = today or date.today()
    done = set(days)
    cur, d = 0, today if today in done else today - timedelta(days=1)
    while d in done:
        cur += 1
        d -= timedelta(days=1)
    best = run = 0
    prev = None
    for d in days:
        run = run + 1 if prev and d - prev == timedelta(days=1) else 1
        best = max(best, run)
        prev = d
    return {"current": cur, "best": best, "today_logged": today in done,
            "next_milestone": next((m for m in MILESTONES if m > cur), None)}


@router.get("/streak")
def streak(user=Depends(current_user)):
    return streak_of(logged_days(user["id"]))


def _direction(user) -> str:
    if user["goal_type"] in ("lose", "maintain", "gain"):
        return user["goal_type"]
    bal = user["balance_goal"] if user["energy_source"] != "none" else -1
    return "lose" if bal < 0 else "gain" if bal > 0 else "maintain"


def on_target(kcal: float, goal: float, direction: str) -> bool:
    if direction == "gain":
        return kcal >= goal * 0.95
    if direction == "maintain":
        return abs(kcal - goal) <= goal * 0.10
    return kcal <= goal * 1.05


def _totals(user_id: int, start: date, end: date) -> dict[str, dict]:
    with db() as conn:
        rows = conn.execute(
            "SELECT day, items, kcal, water_ml FROM meals WHERE user_id = ? AND day BETWEEN ? AND ?",
            (user_id, start.isoformat(), end.isoformat()),
        ).fetchall()
    out: dict[str, dict] = {}
    for r in rows:
        t = out.setdefault(r["day"], {"kcal": 0.0, "protein": 0.0, "carbs": 0.0, "fat": 0.0, "water": 0.0})
        t["kcal"] += r["kcal"]
        t["water"] += r["water_ml"] or 0
        for i in json.loads(r["items"]):
            for k in ("protein", "carbs", "fat"):
                t[k] += i.get("grams", 0) * (i.get(f"{k}_100g") or 0) / 100
    return out


EMPTY = {"kcal": 0, "protein": 0, "carbs": 0, "fat": 0, "water": 0}


def _cached_burned(user, d: date) -> float | None:
    """A day's expenditure from the cache only (the month view must not call Strava/Garmin 31 times)."""
    data, _ = _cached(user["id"], d, user["energy_source"])
    if data is None:
        return None
    if user["energy_source"] == "garmin":
        return data.get("total")
    base, _ = daily_base(user)
    return base + sum(a["kcal"] for a in data.get("activities", [])) if base is not None else None


def _day_goal(user, d: date, cache_only: bool = False) -> float | None:
    if user["energy_source"] == "none":
        return user["kcal_goal"]
    burned = _cached_burned(user, d) if cache_only else energy(day=d, user=user).get("burned")
    return burned + user["balance_goal"] if burned is not None else None


@router.get("/week")
def week(end: date | None = None, user=Depends(current_user)):
    """The 7 days ending on `end` (default today): per-day totals and goals, averages, weight, streak."""
    today = date.today()
    end = min(end or today, today)
    start = end - timedelta(days=6)
    totals = _totals(user["id"], start - timedelta(days=7), end)  # also the week before, to compare
    direction = _direction(user)

    days = []
    for k in range(7):
        d = start + timedelta(days=k)
        t = totals.get(d.isoformat(), EMPTY)
        goal = _day_goal(user, d)
        logged = t["kcal"] > 0
        days.append({
            "day": d.isoformat(), "kcal": round(t["kcal"]), "protein_g": round(t["protein"]),
            "carbs_g": round(t["carbs"]), "fat_g": round(t["fat"]), "water_ml": round(t["water"]), "logged": logged, "goal": round(goal) if goal else None,
            # today isn't over: it's shown, but not judged
            "on_target": on_target(t["kcal"], goal, direction) if logged and goal and d < today else None,
        })

    logged = [d for d in days if d["logged"]]
    avg = lambda key, rows: round(sum(r[key] for r in rows) / len(rows)) if rows else None  # noqa: E731
    prev = [v for k, v in totals.items() if date.fromisoformat(k) < start and v["kcal"] > 0]

    with db() as conn:
        w = conn.execute(
            "SELECT day, kg FROM weights WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day",
            (user["id"], start.isoformat(), end.isoformat()),
        ).fetchall()
        before = conn.execute(
            "SELECT day, kg FROM weights WHERE user_id = ? AND day < ? ORDER BY day DESC LIMIT 1",
            (user["id"], start.isoformat()),
        ).fetchone()
    first = before or (w[0] if w else None)
    last = w[-1] if w else None
    weight = None
    if first and last and first["day"] != last["day"]:
        weight = {"from": first["kg"], "to": last["kg"], "from_day": first["day"], "to_day": last["day"],
                  "change": round(last["kg"] - first["kg"], 1)}

    judged = [d for d in days if d["on_target"] is not None]
    return {
        "start": start.isoformat(), "end": end.isoformat(), "direction": direction,
        "days": days,
        "logged_days": len(logged),
        "on_target_days": sum(1 for d in judged if d["on_target"]), "judged_days": len(judged),
        "avg_kcal": avg("kcal", logged),
        "avg_goal": avg("goal", [d for d in logged if d["goal"]]),
        "prev_avg_kcal": round(sum(v["kcal"] for v in prev) / len(prev)) if prev else None,
        "avg_protein_g": avg("protein_g", logged),
        "avg_carbs_g": avg("carbs_g", logged),
        "avg_fat_g": avg("fat_g", logged),
        "avg_water_ml": avg("water_ml", [d for d in days if d["water_ml"] > 0]),
        "weight": weight,
        "streak": streak_of(logged_days(user["id"]), today),
    }


@router.get("/month")
def month(month: str | None = None, user=Depends(current_user)):
    """Calendar of a month (YYYY-MM, default this one): per day, logged or not and on target or not."""
    today = date.today()
    try:
        y, m = map(int, (month or today.strftime("%Y-%m")).split("-"))
        start = date(y, m, 1)
    except ValueError as exc:
        raise HTTPException(400, "Mois invalide (AAAA-MM)") from exc
    end = date(y, m, calendar.monthrange(y, m)[1])
    totals = _totals(user["id"], start, min(end, today))
    direction = _direction(user)
    days = []
    for k in range((end - start).days + 1):
        d = start + timedelta(days=k)
        t = totals.get(d.isoformat(), EMPTY)
        logged = t["kcal"] > 0
        goal = _day_goal(user, d, cache_only=True) if logged else None
        days.append({"day": d.isoformat(), "kcal": round(t["kcal"]), "logged": logged,
                     "goal": round(goal) if goal else None,
                     "on_target": on_target(t["kcal"], goal, direction) if logged and goal and d < today else None})
    judged = [d for d in days if d["on_target"] is not None]
    first = logged_days(user["id"])
    return {"month": start.strftime("%Y-%m"), "direction": direction, "days": days,
            "logged_days": sum(d["logged"] for d in days),
            "on_target_days": sum(1 for d in judged if d["on_target"]), "judged_days": len(judged),
            "first_month": first[0].strftime("%Y-%m") if first else today.strftime("%Y-%m")}
