"""Packaged foods by barcode, from Open Food Facts (open database, no key needed).

Only the barcode is sent. Answers are cached for 30 days so a product scanned often
doesn't hit the service again.
"""

import json
import re
from datetime import datetime, timedelta

import httpx
from fastapi import APIRouter, Depends, HTTPException

from .auth import current_user
from .db import db
from .limits import RateLimit

router = APIRouter(prefix="/api")

OFF_URL = "https://world.openfoodfacts.org/api/v2/product/{code}.json"
FIELDS = ("product_name_fr,product_name,generic_name_fr,brands,quantity,product_quantity,serving_quantity,"
          "categories_tags,nutriments")
USER_AGENT = "Kcal/1.0 (self-hosted calorie counter)"  # Open Food Facts asks clients to identify themselves
CACHE_DAYS = 30

barcode_limit = RateLimit(120, 60 * 60, "Trop de scans en peu de temps, réessaie plus tard")


def _num(v) -> float:
    try:
        return max(0.0, float(v))
    except (TypeError, ValueError):
        return 0.0


def to_item(p: dict) -> dict:
    """Open Food Facts product -> item in the app's format (values per 100 g or 100 ml)."""
    n = p.get("nutriments") or {}
    kcal = _num(n.get("energy-kcal_100g")) or _num(n.get("energy_100g")) / 4.184  # energy_100g is in kJ
    name = (p.get("product_name_fr") or p.get("product_name") or p.get("generic_name_fr") or "").strip()
    brand = (p.get("brands") or "").split(",")[0].strip()
    if brand and brand.split()[0].lower() not in name.lower():
        name = f"{name} ({brand})" if name else brand
    tags = p.get("categories_tags") or []
    alcohol = _num(n.get("alcohol_100g")) or _num(n.get("alcohol"))
    alcoholic = alcohol >= 1.2 or "en:alcoholic-beverages" in tags
    drink = "en:beverages" in tags or "en:waters" in tags
    # Portion: one serving; else the whole pack if it's a single unit (can, yogurt, bar…);
    # else a glass for drinks and 100 g for food (to adjust)
    serving, pack = _num(p.get("serving_quantity")), _num(p.get("product_quantity"))
    if 0 < serving <= 1000:
        grams = serving
    elif 0 < pack <= (500 if drink else 250):
        grams = pack
    else:
        grams = 250 if drink else 100
    return {
        "name": name[:120] or "Produit",
        "grams": round(grams),
        "kcal_100g": round(kcal, 1),
        "protein_100g": round(_num(n.get("proteins_100g")), 1),
        "carbs_100g": round(_num(n.get("carbohydrates_100g")), 1),
        "fat_100g": round(_num(n.get("fat_100g")), 1),
        "drink_ml": round(grams) if drink and not alcoholic else 0,
        "abv": round(min(80.0, alcohol), 1) if alcoholic else 0,
    }


@router.get("/barcode/{code}")
def barcode(code: str, user=Depends(current_user)):
    """Nutrition of a packaged product from its EAN/UPC barcode."""
    if not re.fullmatch(r"\d{8,14}", code):
        raise HTTPException(400, "Code-barres invalide (8 à 14 chiffres)")
    barcode_limit.check(f"user:{user['id']}")
    since = (datetime.now() - timedelta(days=CACHE_DAYS)).isoformat()
    with db() as conn:
        row = conn.execute("SELECT data FROM barcode_cache WHERE code = ? AND fetched_at > ?", (code, since)).fetchone()
    if row:
        return {**json.loads(row["data"]), "code": code}
    try:
        r = httpx.get(OFF_URL.format(code=code), params={"fields": FIELDS},
                      headers={"User-Agent": USER_AGENT}, timeout=10)
    except httpx.HTTPError as exc:
        raise HTTPException(502, "Open Food Facts injoignable, réessaie plus tard") from exc
    if r.status_code == 404:
        raise HTTPException(404, "Produit inconnu d'Open Food Facts")
    if r.status_code != 200:
        raise HTTPException(502, f"Open Food Facts : erreur {r.status_code}")
    data = r.json()
    product = data.get("product") if data.get("status") == 1 else None
    if not product:
        raise HTTPException(404, "Produit inconnu d'Open Food Facts")
    item = to_item(product)
    if not item["kcal_100g"] and not item["drink_ml"]:
        raise HTTPException(404, "Produit trouvé, mais sans valeurs nutritionnelles")
    out = {"item": item, "quantity": product.get("quantity") or ""}
    with db() as conn:
        conn.execute("INSERT OR REPLACE INTO barcode_cache (code, data, fetched_at) VALUES (?, ?, ?)",
                     (code, json.dumps(out), datetime.now().isoformat()))
    return {**out, "code": code}
