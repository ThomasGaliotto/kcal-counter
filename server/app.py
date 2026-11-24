"""kcal-counter API: photo -> Ollama (vision) -> foods + calories, SQLite history."""

import base64
import io
import json
import os
import re
from datetime import date, datetime

import httpx
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

from .auth import current_user
from .auth import router as auth_router
from .barcode import router as barcode_router
from .db import ROOT, db
from .energy import router as energy_router
from .limits import ai_limit
from .goals import router as goals_router
from .invites import router as invites_router
from .metabolism import router as metabolism_router
from .stats import router as stats_router
from .gaps import router as gaps_router
from . import portions

WEB_DIR = ROOT / "web"
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3.5:9b")
MAX_UPLOAD = 20 * 1024 * 1024  # uploaded photo: 20 MB max
MAX_SIDE = 1024  # the photo is downscaled: faster, and enough to recognise a dish

# Hydration: every non-alcoholic drink counts (the ~2 L/day guideline covers all drinks);
# water inside solid food (fruit, vegetables) is already part of the ~20 % that comes from food, alcohol dehydrates.
# Soups and broths are drunk more than eaten: they count for 90 % of their volume (see _clean_item).
# The model gives each drink's volume (drink_ml) and alcohol strength (abv); the server adds them up
# (see ask_model) and raises the day's water target for the alcohol (see list_meals).
DRINKS_RULE = """EAU ET BOISSONS:
- water_ml = eau pure uniquement (plate ou gazeuse), en millilitres. L'eau pure ne va PAS dans items. 0 si pas d'eau.
- Toute autre boisson va dans items avec ses calories (même ~0 pour un café noir ou un thé).
- drink_ml (pour chaque élément de items) = son volume en millilitres si c'est une boisson NON alcoolisée
  (café, thé, infusion, lait, boisson végétale, jus, soda…), sinon 0.
- drink_ml = 0 pour l'alcool (bière, vin, cidre, spiritueux, cocktail) et pour tout ce qui se mange
  (fruits, yaourts…). Pour une soupe ou un bouillon, mets aussi 0: c'est calculé à part.
- abv (pour chaque élément de items) = degré d'alcool en % vol. si c'est une boisson alcoolisée
  (bière ~5, vin ~12, cidre ~5, champagne ~12, spiritueux ~40, cocktail ~15), sinon 0."""

PROMPT = """Tu es un nutritionniste. Analyse la photo de ce repas.
Liste chaque aliment visible séparément (ex: "riz blanc cuit", "poulet rôti", "sauce tomate").
Pour chacun, estime:
- grams: la quantité en grammes, d'après la taille de l'assiette, des couverts et des portions habituelles
- kcal_100g, protein_100g, carbs_100g, fat_100g: valeurs nutritionnelles pour 100 g de l'aliment TEL QU'IL EST DANS L'ASSIETTE (cuit, avec matière grasse de cuisson si visible).
  Attention à ne pas utiliser les valeurs à l'état cru ou sec: les féculents cuits absorbent de l'eau.
  Repères (cuit): pâtes ~150 kcal, riz ~130, pommes de terre vapeur ~80, frites ~300, pain ~260, œuf au plat ~200, poulet rôti ~190, légumes verts 20-40.
Noms en français, courts et précis. Si la photo ne montre pas de nourriture, renvoie une liste vide.
Donne aussi un titre court pour le repas.

""" + DRINKS_RULE + """
Estime les volumes d'après le contenant et son niveau de remplissage (verre standard ~200-250 ml plein, grand verre ~330 ml,
tasse à café ~100 ml, expresso ~40 ml, mug ~300 ml, canette 330 ml, petite bouteille 500 ml, grande bouteille 1,5 L)."""

SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "water_ml": {"type": "number"},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "grams": {"type": "number"},
                    "kcal_100g": {"type": "number"},
                    "protein_100g": {"type": "number"},
                    "carbs_100g": {"type": "number"},
                    "fat_100g": {"type": "number"},
                    "drink_ml": {"type": "number"},
                    "abv": {"type": "number"},
                },
                "required": ["name", "grams", "kcal_100g", "protein_100g", "carbs_100g", "fat_100g", "drink_ml", "abv"],
            },
        },
    },
    "required": ["title", "water_ml", "items"],
}


def shrink(raw: bytes) -> str:
    try:
        img = Image.open(io.BytesIO(raw))
    except Exception as exc:
        raise HTTPException(400, "Image illisible") from exc
    img = ImageOps.exif_transpose(img).convert("RGB")  # iPhone photos: EXIF orientation
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


app = FastAPI(title="kcal-counter")
app.include_router(auth_router)
app.include_router(energy_router)
app.include_router(goals_router)
app.include_router(invites_router)
app.include_router(metabolism_router)
app.include_router(barcode_router)
app.include_router(stats_router)
app.include_router(gaps_router)


@app.middleware("http")
async def no_stale_files(request, call_next):
    # Otherwise Safari (especially as a home-screen app) keeps stale versions of app.js / style.css:
    # the browser must revalidate every time (fast 304 response if nothing changed).
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


TEXT_PROMPT = """Tu es un nutritionniste. L'utilisateur décrit en quelques mots ce qu'il a mangé ou bu.
Transforme sa description en liste d'aliments, un par élément cité (ex: "pomme", "yaourt nature").
Pour chacun, estime:
- grams: la quantité indiquée, sinon une portion habituelle (pomme moyenne ~150 g, banane ~120 g, tranche de pain ~35 g,
  yaourt ~125 g, œuf ~55 g, assiette de pâtes cuites ~250 g, café ~150 g, verre de jus ~200 g). Un nombre (« 2 œufs ») multiplie la portion.
- kcal_100g, protein_100g, carbs_100g, fat_100g: valeurs pour 100 g de l'aliment tel qu'il est consommé (cuit pour les féculents).
Noms en français, courts et précis. Si le texte ne parle pas de nourriture ni de boisson, renvoie une liste vide.
Donne aussi un titre court pour le repas.

""" + DRINKS_RULE + """
Sans volume précisé: verre ~250 ml, grand verre ~330 ml, café ~150 ml, expresso ~40 ml, thé ou mug ~250 ml,
canette 330 ml, petite bouteille 500 ml, grande bouteille 1,5 L.

Description de l'utilisateur:
"""


ITEM_SCHEMA = SCHEMA["properties"]["items"]["items"]


async def _chat(message: dict, schema: dict) -> dict:
    payload = {
        "model": OLLAMA_MODEL,
        "stream": False,
        "think": False,
        "format": schema,
        "options": {"temperature": 0.2},
        "messages": [message],
    }
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            r = await client.post(f"{OLLAMA_URL}/api/chat", json=payload)
            r.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Ollama injoignable: {exc}") from exc
    try:
        return json.loads(r.json()["message"]["content"])
    except (KeyError, json.JSONDecodeError) as exc:
        raise HTTPException(502, "Réponse du modèle invalide") from exc


ALCOHOL = re.compile(r"\b(bières?|vins?|cidre|champagne|prosecco|crémant|rosé|whisky|rhum|vodka|gin|tequila|pastis|"
                     r"apéritif|cocktail|spritz|sangria|liqueur|cognac|armagnac|calvados|kir|mojito|punch|porto|martini)\b", re.I)


# liquid dishes: ~90 % of their volume counts toward hydration (the rest is vegetables, cream, noodles…)
SOUP = re.compile(r"\b(soupes?|potages?|velout[ée]s?|bouillons?|gazpachos?|consomm[ée]s?|minestrone|bisques?|"
                  r"garbure|chorba|harira|salmorejo)\b", re.I)
SOUP_NOT = re.compile(r"cuill|c\. ?à ?s|cube", re.I)  # "1 cuillère à soupe d'huile", "bouillon cube"
SOUP_WATER = 0.9


def _clean_item(it: dict) -> dict:
    it["grams"] = max(0, round(it.get("grams") or 0))
    for k in ("kcal_100g", "protein_100g", "carbs_100g", "fat_100g"):
        it[k] = max(0.0, round(float(it.get(k) or 0), 1))
    it["drink_ml"] = max(0, round(float(it.get("drink_ml") or 0)))
    it["abv"] = min(80.0, max(0.0, round(float(it.get("abv") or 0), 1)))
    alcohol_free = re.search(r"sans alcool|0[,.]?0 ?%", it.get("name", ""), re.I)
    if alcohol_free:
        it["abv"] = 0.0
    name = it.get("name", "")
    if it["abv"] >= 1.2 or (ALCOHOL.search(name) and not alcohol_free):
        it["drink_ml"] = 0  # alcohol dehydrates: never counted, even if the model says so
    elif SOUP.search(name) and not SOUP_NOT.search(name):
        it["drink_ml"] = round(it["grams"] * SOUP_WATER)  # grams stay the soup's weight
    elif it["drink_ml"]:
        it["grams"] = it["drink_ml"]  # a drink weighs about its volume (the model sometimes gives the tea leaves)
    return it


PLAIN_WATER = re.compile(r"^(grand |petit )?(verre |bouteille |carafe )?(d'|d’)?eau( plate| gazeuse| pétillante| minérale| du robinet)?$", re.I)


async def ask_model(message: dict, learn_for: int | None = None) -> dict:
    """Analysis -> cleaned items, and water_ml = plain water + every non-alcoholic drink.
    learn_for: user id whose usual portions replace the model's guesses."""
    result = await _chat(message, SCHEMA)
    plain = max(0.0, float(result.get("water_ml") or 0))
    items = []
    for it in map(_clean_item, result.get("items", [])):
        if PLAIN_WATER.match(it["name"].strip()) and it["kcal_100g"] < 5:
            plain = plain or (it["drink_ml"] or it["grams"])  # water put in items by mistake
            continue
        items.append(it)
    if learn_for:
        portions.apply(learn_for, items)
    result["items"] = items
    result["water_ml"] = round((plain + sum(it["drink_ml"] for it in items)) / 10) * 10
    return result


@app.post("/api/analyze")
async def analyze(photo: UploadFile = File(...), user=Depends(current_user)):
    ai_limit.check(f"user:{user['id']}")
    raw = await photo.read(MAX_UPLOAD + 1)
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, "Photo trop lourde (20 Mo max)")
    image_b64 = shrink(raw)
    return await ask_model({"role": "user", "content": PROMPT, "images": [image_b64]}, learn_for=user["id"])


class MealText(BaseModel):
    text: str = Field(min_length=2, max_length=1000)


@app.post("/api/analyze-text")
async def analyze_text(body: MealText, user=Depends(current_user)):
    ai_limit.check(f"user:{user['id']}")
    """Repas décrit en texte (« une pomme et un verre d'eau »): même format que l'analyse photo."""
    text = body.text.strip()
    learn = None if portions.QUANTITY.search(text) else user["id"]  # a quantity typed by the user wins
    return await ask_model({"role": "user", "content": TEXT_PROMPT + text}, learn_for=learn)


class Item(BaseModel):
    name: str
    grams: float
    kcal_100g: float
    protein_100g: float = 0
    carbs_100g: float = 0
    fat_100g: float = 0
    drink_ml: float = 0  # volume counted toward hydration (non-alcoholic drinks)
    abv: float = 0  # alcohol strength (% vol), raises the day's water target


class Meal(BaseModel):
    title: str
    items: list[Item]
    water_ml: float = 0
    eaten_at: datetime | None = None


FIX_PROMPT = """Tu es un nutritionniste. Voici l'analyse actuelle d'un repas (JSON), puis la correction de l'utilisateur.
Applique sa correction: remplace, retire ou ajoute les aliments cités, change les quantités s'il en donne.
Garde tels quels les aliments qu'il ne mentionne pas (mêmes noms, grammes et valeurs).
Pour chaque aliment nouveau ou modifié, recalcule grams (portion habituelle si non précisée, ou la quantité de l'aliment remplacé)
et les valeurs pour 100 g tel que consommé: kcal_100g, protein_100g, carbs_100g, fat_100g (cuit pour les féculents).
Mets à jour le titre si le plat a changé.
""" + DRINKS_RULE.replace("{", "{{").replace("}", "}}") + """
Sans volume précisé: verre ~250 ml, grand verre ~330 ml, café ~150 ml, expresso ~40 ml, thé ou mug ~250 ml,
canette 330 ml, petite bouteille 500 ml, grande bouteille 1,5 L. Si la correction ajoute de l'eau, ajoute-la à water_ml.
Renvoie l'analyse complète corrigée.

Analyse actuelle:
{current}

Correction de l'utilisateur: {comment}"""

ITEM_PROMPT = """Tu es un nutritionniste. Donne les valeurs nutritionnelles de l'aliment « {name} » pour 100 g tel qu'il est consommé
(cuit pour les féculents et les viandes): kcal_100g, protein_100g, carbs_100g, fat_100g.
grams: {grams}
name: reprends le nom donné, corrigé si besoin (court, en français).
drink_ml: son volume en millilitres si c'est une boisson non alcoolisée (café, thé, lait, jus, soda…), sinon 0.
abv: degré d'alcool en % vol. si c'est une boisson alcoolisée (bière ~5, vin ~12, spiritueux ~40), sinon 0."""


class MealFix(BaseModel):
    title: str = ""
    items: list[Item] = []
    water_ml: float = 0
    comment: str = Field(min_length=2, max_length=1000)


@app.post("/api/analyze-fix")
async def analyze_fix(body: MealFix, user=Depends(current_user)):
    """Correct a meal from a comment ("no rice, it was pasta") and recompute everything."""
    ai_limit.check(f"user:{user['id']}")
    plain = max(0.0, body.water_ml - sum(i.drink_ml for i in body.items))  # drinks are counted per item
    current = json.dumps({"title": body.title, "water_ml": plain,
                          "items": [i.model_dump() for i in body.items]}, ensure_ascii=False)
    return await ask_model({"role": "user", "content": FIX_PROMPT.format(current=current, comment=body.comment.strip())})


class ItemQuery(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    grams: float | None = Field(None, gt=0, le=5000)


@app.post("/api/estimate-item")
async def estimate_item(body: ItemQuery, user=Depends(current_user)):
    """Nutrition values of a food added or renamed by hand."""
    ai_limit.check(f"user:{user['id']}")
    grams = (f"garde {round(body.grams)}" if body.grams
             else "la portion habituelle en grammes (ex: pomme 150, yaourt 125, assiette de pâtes cuites 250)")
    it = _clean_item(await _chat({"role": "user", "content": ITEM_PROMPT.format(name=body.name.strip(), grams=grams)},
                                 ITEM_SCHEMA))
    if body.grams:
        it["grams"] = round(body.grams)
    else:
        portions.apply(user["id"], [it], asked=body.name)
    return it


@app.post("/api/meals")
def save_meal(meal: Meal, user=Depends(current_user)):
    if not meal.items and meal.water_ml <= 0:
        raise HTTPException(400, "Rien à enregistrer")
    when = meal.eaten_at or datetime.now()
    kcal = sum(i.grams * i.kcal_100g / 100 for i in meal.items)
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO meals (user_id, eaten_at, day, title, items, kcal, water_ml) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user["id"], when.isoformat(), when.date().isoformat(), meal.title,
             json.dumps([i.model_dump() for i in meal.items]), kcal, max(0, meal.water_ml)),
        )
        portions.record(conn, user["id"], cur.lastrowid, [i.model_dump() for i in meal.items])
    return {"id": cur.lastrowid, "kcal": round(kcal)}


@app.get("/api/meals")
def list_meals(day: date | None = None, user=Depends(current_user)):
    day = day or date.today()
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM meals WHERE user_id = ? AND day = ? ORDER BY eaten_at",
            (user["id"], day.isoformat()),
        ).fetchall()
    meals = [{**dict(r), "items": json.loads(r["items"])} for r in rows]
    return {
        "day": day.isoformat(),
        "total_kcal": round(sum(m["kcal"] for m in meals)),
        "total_water_ml": round(sum(m["water_ml"] for m in meals)),
        **{f"total_{k}_g": round(sum(
            i.get("grams", 0) * (i.get(f"{k}_100g") or 0) / 100 for m in meals for i in m["items"]
        )) for k in ("protein", "carbs", "fat")},
        # grams of pure alcohol: volume × strength × ethanol density (0.789)
        "total_alcohol_g": round(sum(
            i.get("grams", 0) * (i.get("abv") or 0) / 100 * 0.789 for m in meals for i in m["items"]
        )),
        "meals": meals,
    }


@app.put("/api/meals/{meal_id}")
def update_meal(meal_id: int, meal: Meal, user=Depends(current_user)):
    """Edit a saved meal (title, foods, water). Keeps its time unless eaten_at is given."""
    if not meal.items and meal.water_ml <= 0:
        raise HTTPException(400, "Rien à enregistrer: supprime plutôt le repas")
    kcal = sum(i.grams * i.kcal_100g / 100 for i in meal.items)
    with db() as conn:
        row = conn.execute("SELECT eaten_at FROM meals WHERE id = ? AND user_id = ?", (meal_id, user["id"])).fetchone()
        if not row:
            raise HTTPException(404, "Repas introuvable")
        when = meal.eaten_at or datetime.fromisoformat(row["eaten_at"])
        conn.execute(
            "UPDATE meals SET eaten_at = ?, day = ?, title = ?, items = ?, kcal = ?, water_ml = ? WHERE id = ?",
            (when.isoformat(), when.date().isoformat(), meal.title,
             json.dumps([i.model_dump() for i in meal.items]), kcal, max(0, meal.water_ml), meal_id),
        )
        portions.record(conn, user["id"], meal_id, [i.model_dump() for i in meal.items])
    return {"id": meal_id, "kcal": round(kcal)}


@app.delete("/api/meals/{meal_id}")
def delete_meal(meal_id: int, user=Depends(current_user)):
    with db() as conn:
        conn.execute("DELETE FROM meals WHERE id = ? AND user_id = ?", (meal_id, user["id"]))
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


app.mount("/", StaticFiles(directory=WEB_DIR), name="web")
