"""API kcal-counter : photo -> Ollama (vision) -> aliments + calories, historique SQLite."""

import base64
import io
import json
import os
from datetime import date, datetime

import httpx
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel

from .auth import current_user
from .auth import router as auth_router
from .db import ROOT, db
from .energy import router as energy_router

WEB_DIR = ROOT / "web"
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3.5:9b")
MAX_SIDE = 1024  # on réduit la photo : plus rapide, et suffisant pour reconnaître un plat

PROMPT = """Tu es un nutritionniste. Analyse la photo de ce repas.
Liste chaque aliment visible séparément (ex : "riz blanc cuit", "poulet rôti", "sauce tomate").
Pour chacun, estime :
- grams : la quantité en grammes, d'après la taille de l'assiette, des couverts et des portions habituelles
- kcal_100g, protein_100g, carbs_100g, fat_100g : valeurs nutritionnelles pour 100 g de l'aliment TEL QU'IL EST DANS L'ASSIETTE (cuit, avec matière grasse de cuisson si visible).
  Attention à ne pas utiliser les valeurs à l'état cru ou sec : les féculents cuits absorbent de l'eau.
  Repères (cuit) : pâtes ~150 kcal, riz ~130, pommes de terre vapeur ~80, frites ~300, pain ~260, œuf au plat ~200, poulet rôti ~190, légumes verts 20-40.
Noms en français, courts et précis. Si la photo ne montre pas de nourriture, renvoie une liste vide.
Donne aussi un titre court pour le repas.

EAU : water_ml = volume d'eau (plate ou gazeuse, sans sucre) visible, en millilitres. Ne mets PAS l'eau dans items.
Estime le volume d'après le contenant et son niveau de remplissage (verre standard ~200-250 ml plein, grand verre ~330 ml,
mug ~300 ml, petite bouteille 500 ml, grande bouteille 1,5 L). 0 s'il n'y a pas d'eau.
Les autres boissons (soda, jus, lait, café sucré, alcool…) vont dans items avec leurs calories."""

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
                },
                "required": ["name", "grams", "kcal_100g", "protein_100g", "carbs_100g", "fat_100g"],
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
    img = ImageOps.exif_transpose(img).convert("RGB")  # photos iPhone : orientation EXIF
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


app = FastAPI(title="kcal-counter")
app.include_router(auth_router)
app.include_router(energy_router)


@app.middleware("http")
async def no_stale_files(request, call_next):
    # Safari (surtout en app écran d'accueil) garde sinon d'anciennes versions de app.js / style.css :
    # le navigateur doit revalider à chaque fois (réponse 304 rapide si rien n'a changé).
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


@app.post("/api/analyze")
async def analyze(photo: UploadFile = File(...), user=Depends(current_user)):
    image_b64 = shrink(await photo.read())
    payload = {
        "model": OLLAMA_MODEL,
        "stream": False,
        "think": False,
        "format": SCHEMA,
        "options": {"temperature": 0.2},
        "messages": [{"role": "user", "content": PROMPT, "images": [image_b64]}],
    }
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            r = await client.post(f"{OLLAMA_URL}/api/chat", json=payload)
            r.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Ollama injoignable : {exc}") from exc
    try:
        result = json.loads(r.json()["message"]["content"])
    except (KeyError, json.JSONDecodeError) as exc:
        raise HTTPException(502, "Réponse du modèle invalide") from exc
    for it in result.get("items", []):
        it["grams"] = max(0, round(it["grams"]))
    result["water_ml"] = max(0, round(result.get("water_ml", 0) / 10) * 10)
    return result


class Item(BaseModel):
    name: str
    grams: float
    kcal_100g: float
    protein_100g: float = 0
    carbs_100g: float = 0
    fat_100g: float = 0


class Meal(BaseModel):
    title: str
    items: list[Item]
    water_ml: float = 0
    eaten_at: datetime | None = None


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
        "total_protein_g": round(sum(
            i.get("grams", 0) * (i.get("protein_100g") or 0) / 100 for m in meals for i in m["items"]
        )),
        "meals": meals,
    }


@app.delete("/api/meals/{meal_id}")
def delete_meal(meal_id: int, user=Depends(current_user)):
    with db() as conn:
        conn.execute("DELETE FROM meals WHERE id = ? AND user_id = ?", (meal_id, user["id"]))
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


app.mount("/", StaticFiles(directory=WEB_DIR), name="web")
