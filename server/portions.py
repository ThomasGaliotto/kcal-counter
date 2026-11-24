"""Learned portions: the grams a user actually saves for a food replace the AI's guess.

Every saved meal logs its foods' grams. When an analysis proposes a food that the user has saved
at least twice, its portion becomes the median of their last 5, if it differs from the guess by more
than 15 %. The item keeps the AI's guess in `ai_grams` and is flagged `usual` for the review screen.
"""

import json
import re
import unicodedata
from datetime import datetime
from statistics import median

from .db import db

MIN_SEEN = 2
LAST = 5
TOLERANCE = 0.15

# a quantity in a typed description ("300 g de riz", "deux œufs") is the user's, never overridden
QUANTITY = re.compile(r"\d|\b(deux|trois|quatre|cinq|six|sept|huit|neuf|dix|douze|demie?|moitié|quart|tiers)\b", re.I)


# words the model adds or drops from one analysis to the next ("riz basmati cuit" = "riz basmati")
FILLER = {"de", "du", "des", "d", "la", "le", "les", "l", "a", "au", "aux", "en", "et", "un", "une", "avec",
          "cuit", "cuite", "cuits", "cuites", "nature", "frais", "fraiche", "fraiches", "maison", "portion"}


def food_key(name: str) -> str:
    """'Riz basmati cuit (Taureau Ailé)' -> 'riz basmati': lowercase, no accents, no brand in brackets,
    no filler words."""
    s = re.sub(r"\(.*?\)", " ", name or "").replace("œ", "oe").replace("Œ", "Oe").replace("æ", "ae")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    words = [w for w in re.split(r"[^a-z0-9]+", s) if w and w not in FILLER]
    return " ".join(words)[:80]


def record(conn, user_id: int, meal_id: int, items: list[dict], at: str | None = None) -> None:
    """Log a meal's portions (replaces the previous log of that meal when it's edited)."""
    conn.execute("DELETE FROM portion_log WHERE meal_id = ?", (meal_id,))
    now = at or datetime.now().isoformat()
    seen = set()
    for it in items:
        key = food_key(it.get("name", ""))
        if key and key not in seen and (it.get("grams") or 0) > 0:
            seen.add(key)
            conn.execute("INSERT INTO portion_log (user_id, meal_id, food, grams, at) VALUES (?, ?, ?, ?, ?)",
                         (user_id, meal_id, key, it["grams"], now))


def backfill(conn) -> None:
    """First start with this table: learn from the meals already saved."""
    for m in conn.execute("SELECT id, user_id, items, eaten_at FROM meals WHERE user_id IS NOT NULL").fetchall():
        record(conn, m["user_id"], m["id"], json.loads(m["items"]), m["eaten_at"])


def usual_grams(user_id: int, keys: set[str]) -> dict[str, float]:
    out = {}
    with db() as conn:
        for key in keys:
            rows = conn.execute("SELECT grams FROM portion_log WHERE user_id = ? AND food = ? ORDER BY at DESC LIMIT ?",
                                (user_id, key, LAST)).fetchall()
            if len(rows) >= MIN_SEEN:
                out[key] = median(r["grams"] for r in rows)
    return out


def apply(user_id: int, items: list[dict], asked: str | None = None) -> list[dict]:
    """Swap the AI's portion for the user's usual one where they differ clearly.
    asked: the name the user typed, tried first (the model may reword it)."""
    names = lambda it: [n for n in (asked, it.get("name", "")) if n]  # noqa: E731
    usual = usual_grams(user_id, {food_key(n) for it in items for n in names(it)} - {""})
    for it in items:
        g = next((usual[k] for k in map(food_key, names(it)) if k in usual), None)
        if not g or abs(g - it["grams"]) <= TOLERANCE * max(it["grams"], 1):
            continue
        it["ai_grams"], it["grams"], it["usual"] = it["grams"], round(g), True
        if it.get("drink_ml"):
            it["drink_ml"] = it["grams"]  # a drink weighs about its volume
    return items
