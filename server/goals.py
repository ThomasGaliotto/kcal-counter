"""Objectif de poids avec horizon : calcule le bilan calorique et les protéines visés.

Repères utilisés :
- 1 kg de masse corporelle ≈ 7 700 kcal
- perte : rythme plafonné à 1 % du poids par semaine et à 1 000 kcal/jour de déficit
- prise de muscle : surplus plafonné à +500 kcal/jour (au-delà, surtout du gras), +300 par défaut
- protéines : 2,0 g/kg en perte (préserver le muscle), 1,8 g/kg en prise de muscle, 1,6 g/kg en maintien
  (sauf réglage à la main, en grammes ou en g/kg : voir PUT /api/protein)
"""

from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .auth import _public, current_user
from .db import db
from .energy import bmr

router = APIRouter(prefix="/api")

KCAL_PER_KG = 7700
PROTEIN_PER_KG = {"lose": 2.0, "maintain": 1.6, "gain": 1.8}
DEFAULT_BALANCE = {"lose": -500, "maintain": 0, "gain": 300}
MAX_GAIN_SURPLUS = 500
MAX_LOSS_DEFICIT = 1000
LABELS = {"lose": "Perte de poids", "maintain": "Maintien", "gain": "Prise de muscle"}


def current_weight(user_id: int, fallback: float | None) -> float | None:
    with db() as conn:
        row = conn.execute(
            "SELECT kg FROM weights WHERE user_id = ? ORDER BY day DESC LIMIT 1", (user_id,)
        ).fetchone()
    return row["kg"] if row else fallback


def compute_plan(goal_type: str, weight: float | None, target: float | None,
                 target_date: date | None, today: date | None = None) -> dict:
    """Plan quotidien pour un objectif. Fonction pure : testable sans base de données."""
    today = today or date.today()
    plan = {
        "type": goal_type, "label": LABELS[goal_type], "balance_goal": DEFAULT_BALANCE[goal_type],
        "protein_per_kg": PROTEIN_PER_KG[goal_type], "protein_goal": None,
        "weekly_change_kg": round(DEFAULT_BALANCE[goal_type] * 7 / KCAL_PER_KG, 2),
        "days_left": None, "eta_date": None, "capped": False, "message": None,
    }
    if weight:
        plan["protein_goal"] = round(weight * PROTEIN_PER_KG[goal_type])
    if goal_type == "maintain" or not (weight and target and target_date):
        return plan

    days = (target_date - today).days
    delta = target - weight  # négatif = à perdre
    plan["days_left"] = max(days, 0)
    if (goal_type == "lose" and delta >= 0) or (goal_type == "gain" and delta <= 0):
        plan["message"] = "Poids visé atteint 🎉" if days >= 0 else None
        plan["balance_goal"] = 0 if goal_type == "lose" else DEFAULT_BALANCE["gain"]
        plan["weekly_change_kg"] = round(plan["balance_goal"] * 7 / KCAL_PER_KG, 2)
        return plan
    if days <= 0:
        plan["message"] = "L'horizon est dépassé : choisis une nouvelle date."
        return plan

    needed = delta * KCAL_PER_KG / days  # kcal/jour
    if goal_type == "lose":
        cap = -min(MAX_LOSS_DEFICIT, weight * 0.01 * KCAL_PER_KG / 7)
        balance = max(needed, cap)
    else:
        cap = MAX_GAIN_SURPLUS
        balance = min(needed, cap)
    balance = round(balance / 10) * 10
    plan["balance_goal"] = int(balance)
    plan["weekly_change_kg"] = round(balance * 7 / KCAL_PER_KG, 2)
    if balance != round(needed / 10) * 10:
        plan["capped"] = True
        realistic_days = abs(delta) * KCAL_PER_KG / abs(balance)
        plan["eta_date"] = (today + timedelta(days=round(realistic_days))).isoformat()
        plan["message"] = (f"Horizon trop court pour rester raisonnable : au rythme conseillé, "
                           f"objectif atteint vers le {(today + timedelta(days=round(realistic_days))).strftime('%d/%m/%Y')}.")
    else:
        plan["eta_date"] = target_date.isoformat()
    return plan


def protein_target(user, weight: float | None, plan: dict | None) -> dict:
    """Objectif de protéines : réglage à la main (g ou g/kg) sinon celui de l'objectif, sinon 1,6 g/kg."""
    if plan and plan["protein_goal"]:
        auto = {"protein_goal": plan["protein_goal"], "protein_per_kg": plan["protein_per_kg"]}
    elif weight:
        auto = {"protein_goal": round(weight * 1.6), "protein_per_kg": 1.6}
    else:
        auto = {"protein_goal": 100, "protein_per_kg": None}
    result = {**auto, "protein_manual": False,
              "protein_auto_goal": auto["protein_goal"], "protein_auto_per_kg": auto["protein_per_kg"]}
    mode, value = user["protein_mode"] or "auto", user["protein_value"]
    if mode == "grams" and value:
        result.update(protein_goal=round(value), protein_manual=True,
                      protein_per_kg=round(value / weight, 2) if weight else None)
    elif mode == "per_kg" and value and weight:
        result.update(protein_goal=round(value * weight), protein_per_kg=value, protein_manual=True)
    return result


def plan_for(user) -> dict | None:
    if not user["goal_type"]:
        return None
    weight = current_weight(user["id"], user["weight_kg"])
    target_date = date.fromisoformat(user["goal_date"]) if user["goal_date"] else None
    plan = compute_plan(user["goal_type"], weight, user["goal_weight"], target_date)
    plan.update({
        "current_weight": weight, "target_weight": user["goal_weight"], "target_date": user["goal_date"],
        "start_weight": user["goal_start_weight"], "start_date": user["goal_start_date"],
    })
    start, target = user["goal_start_weight"], user["goal_weight"]
    if start and target and weight and start != target:
        plan["progress"] = max(0.0, min(1.0, (start - weight) / (start - target)))
    else:
        plan["progress"] = None
    plan.update(protein_target(user, weight, plan))
    # objectif kcal en mode « sans dépense mesurée » : métabolisme × vie quotidienne + bilan visé
    base = bmr({**dict(user), "weight_kg": weight or user["weight_kg"]})
    plan["kcal_goal"] = round(base * (user["life_factor"] or 1.2) + plan["balance_goal"]) if base else None
    return plan


def apply_plan(user_id: int) -> None:
    """Recopie le plan dans les objectifs utilisés par l'écran (bilan, protéines, kcal)."""
    with db() as conn:
        user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    plan = plan_for(user)
    if not plan:  # sans objectif, seules les protéines suivent le poids / le réglage
        protein = protein_target(user, current_weight(user_id, user["weight_kg"]), None)
        with db() as conn:
            conn.execute("UPDATE users SET protein_goal = ? WHERE id = ?", (protein["protein_goal"], user_id))
        return
    sets = {"balance_goal": plan["balance_goal"], "protein_goal": plan["protein_goal"]}
    if plan["kcal_goal"]:
        sets["kcal_goal"] = max(1000, plan["kcal_goal"])
    with db() as conn:
        conn.execute(f"UPDATE users SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?",
                     (*sets.values(), user_id))


# ---------- Routes ----------
class Goal(BaseModel):
    type: Literal["lose", "maintain", "gain"]
    current_weight: float | None = Field(None, ge=20, le=400)
    target_weight: float | None = Field(None, ge=20, le=400)
    target_date: date | None = None


def _validate(body: Goal):
    if body.target_date and body.target_date <= date.today():
        raise HTTPException(400, "L'horizon doit être dans le futur")
    if body.type != "maintain" and body.target_weight and body.current_weight:
        if body.type == "lose" and body.target_weight >= body.current_weight:
            raise HTTPException(400, "Pour perdre du poids, le poids visé doit être inférieur au poids actuel")
        if body.type == "gain" and body.target_weight <= body.current_weight:
            raise HTTPException(400, "Pour prendre du muscle, le poids visé doit être supérieur au poids actuel")


@router.post("/goal/preview")
def preview_goal(body: Goal, user=Depends(current_user)):
    _validate(body)
    weight = body.current_weight or current_weight(user["id"], user["weight_kg"])
    target = body.target_weight if body.type != "maintain" else None
    plan = compute_plan(body.type, weight, target, body.target_date if target else None)
    plan.update(protein_target(user, weight, plan))  # un réglage à la main reste prioritaire
    return plan


@router.put("/goal")
def set_goal(body: Goal, user=Depends(current_user)):
    _validate(body)
    weight = body.current_weight or current_weight(user["id"], user["weight_kg"])
    if weight:
        _record_weight(user["id"], weight)
    maintain = body.type == "maintain"
    with db() as conn:
        conn.execute(
            """UPDATE users SET goal_type = ?, goal_weight = ?, goal_date = ?,
               goal_start_weight = ?, goal_start_date = ? WHERE id = ?""",
            (body.type, None if maintain else body.target_weight,
             None if maintain or not body.target_date else body.target_date.isoformat(),
             weight, date.today().isoformat(), user["id"]),
        )
    apply_plan(user["id"])
    return _me_with_plan(user["id"])


@router.delete("/goal")
def clear_goal(user=Depends(current_user)):
    with db() as conn:
        conn.execute("UPDATE users SET goal_type = NULL, goal_weight = NULL, goal_date = NULL, "
                     "goal_start_weight = NULL, goal_start_date = NULL WHERE id = ?", (user["id"],))
    apply_plan(user["id"])
    return _me_with_plan(user["id"])


class Protein(BaseModel):
    mode: Literal["auto", "grams", "per_kg"]
    value: float | None = None


@router.put("/protein")
def set_protein(body: Protein, user=Depends(current_user)):
    """Objectif de protéines réglé à la main : en grammes par jour ou en g par kg de poids."""
    if body.mode == "grams" and not (body.value and 20 <= body.value <= 500):
        raise HTTPException(400, "Indique un objectif entre 20 et 500 g par jour")
    if body.mode == "per_kg":
        if not (body.value and 0.5 <= body.value <= 4):
            raise HTTPException(400, "Indique un objectif entre 0,5 et 4 g par kg")
        if not current_weight(user["id"], user["weight_kg"]):
            raise HTTPException(400, "Renseigne d'abord ton poids pour un objectif en g/kg")
    value = None if body.mode == "auto" else round(body.value, 2)
    with db() as conn:
        conn.execute("UPDATE users SET protein_mode = ?, protein_value = ? WHERE id = ?",
                     (body.mode, value, user["id"]))
    apply_plan(user["id"])
    return _me_with_plan(user["id"])


class Weight(BaseModel):
    kg: float = Field(ge=20, le=400)
    day: date | None = None


def _record_weight(user_id: int, kg: float, day: date | None = None) -> None:
    day = day or date.today()
    with db() as conn:
        conn.execute("INSERT OR REPLACE INTO weights (user_id, day, kg) VALUES (?, ?, ?)",
                     (user_id, day.isoformat(), kg))
        latest = conn.execute("SELECT kg FROM weights WHERE user_id = ? ORDER BY day DESC LIMIT 1",
                              (user_id,)).fetchone()
        conn.execute("UPDATE users SET weight_kg = ? WHERE id = ?", (latest["kg"], user_id))


@router.post("/weights")
def add_weight(body: Weight, user=Depends(current_user)):
    _record_weight(user["id"], body.kg, body.day)
    apply_plan(user["id"])
    return _me_with_plan(user["id"])


@router.delete("/weights/{day}")
def delete_weight(day: date, user=Depends(current_user)):
    with db() as conn:
        conn.execute("DELETE FROM weights WHERE user_id = ? AND day = ?", (user["id"], day.isoformat()))
        latest = conn.execute("SELECT kg FROM weights WHERE user_id = ? ORDER BY day DESC LIMIT 1",
                              (user["id"],)).fetchone()
        if latest:
            conn.execute("UPDATE users SET weight_kg = ? WHERE id = ?", (latest["kg"], user["id"]))
    apply_plan(user["id"])
    return _me_with_plan(user["id"])


@router.get("/weights")
def list_weights(days: int = 180, user=Depends(current_user)):
    since = (date.today() - timedelta(days=max(1, min(days, 3650)))).isoformat()
    with db() as conn:
        rows = conn.execute("SELECT day, kg FROM weights WHERE user_id = ? AND day >= ? ORDER BY day",
                            (user["id"], since)).fetchall()
    return [dict(r) for r in rows]


def _me_with_plan(user_id: int) -> dict:
    with db() as conn:
        user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return {**_public(user), "plan": plan_for(user)}


@router.get("/goal")
def get_goal(user=Depends(current_user)):
    apply_plan(user["id"])  # le déficit à tenir évolue avec les jours qui passent
    return _me_with_plan(user["id"])
