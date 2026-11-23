"""SQLite connection and schema (with lightweight migrations of existing databases)."""

import os
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    """Load ROOT/.env (KEY=VALUE) without overriding variables that are already set."""
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip("'\""))


_load_dotenv()
DB_PATH = Path(os.environ.get("KCAL_DB", ROOT / "data" / "kcal.db"))
GARMIN_DIR = DB_PATH.parent / "garmin"

# Columns added to users later on: name -> SQL definition
USER_COLUMNS = {
    "energy_source": "TEXT NOT NULL DEFAULT 'none'",  # none | strava | garmin
    "balance_goal": "INTEGER NOT NULL DEFAULT -500",   # target balance (eaten - burned)
    "sex": "TEXT",                                     # m | f, for the basal metabolic rate
    "birth_year": "INTEGER",
    "height_cm": "REAL",
    "weight_kg": "REAL",
    "life_factor": "REAL NOT NULL DEFAULT 1.2",        # daily activity excluding sport
    "protein_goal": "INTEGER",                         # effective g/day (computed by goals.apply_plan)
    "protein_mode": "TEXT NOT NULL DEFAULT 'auto'",    # auto | grams | per_kg
    "protein_value": "REAL",                           # g/day (grams) or g/kg (per_kg)
    "goal_type": "TEXT",                               # lose | maintain | gain (empty = no goal)
    "goal_weight": "REAL",                             # target weight (kg)
    "goal_date": "TEXT",                               # deadline (YYYY-MM-DD)
    "goal_start_weight": "REAL",
    "goal_start_date": "TEXT",
    "show_protein": "INTEGER NOT NULL DEFAULT 1",      # features shown (set per account)
    "show_weight": "INTEGER NOT NULL DEFAULT 1",       # weight goal, weigh-ins, chart
    "strava_athlete": "TEXT",
    "strava_access": "TEXT",
    "strava_refresh": "TEXT",
    "strava_expires": "INTEGER",
}


def garmin_token_dir(user_id: int) -> Path:
    return GARMIN_DIR / f"user_{int(user_id)}"


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}


def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            pw_hash TEXT NOT NULL,
            kcal_goal INTEGER NOT NULL DEFAULT 2000,
            water_goal INTEGER NOT NULL DEFAULT 2000,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            eaten_at TEXT NOT NULL,
            day TEXT NOT NULL,
            title TEXT NOT NULL,
            items TEXT NOT NULL,
            kcal REAL NOT NULL
        );
        """
    )
    cols = _columns(conn, "meals")
    if "water_ml" not in cols:
        conn.execute("ALTER TABLE meals ADD COLUMN water_ml REAL NOT NULL DEFAULT 0")
    if "user_id" not in cols:
        # meals from before accounts stay ownerless until the first account is created
        conn.execute("ALTER TABLE meals ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE")
    conn.execute("CREATE INDEX IF NOT EXISTS meals_user_day ON meals(user_id, day)")
    user_cols = _columns(conn, "users")
    for name, definition in USER_COLUMNS.items():
        if name not in user_cols:
            conn.execute(f"ALTER TABLE users ADD COLUMN {name} {definition}")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS energy_cache (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            day TEXT NOT NULL,
            source TEXT NOT NULL,
            data TEXT NOT NULL,
            fetched_at TEXT NOT NULL,
            PRIMARY KEY (user_id, day, source)
        );
        CREATE TABLE IF NOT EXISTS weights (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            day TEXT NOT NULL,
            kg REAL NOT NULL,
            PRIMARY KEY (user_id, day)
        );
        CREATE TABLE IF NOT EXISTS invites (
            code TEXT PRIMARY KEY,
            note TEXT NOT NULL,                -- pour qui (prénom)
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            used_at TEXT
        );
        CREATE TABLE IF NOT EXISTS strava_activity_kcal (
            activity_id INTEGER PRIMARY KEY,
            kcal REAL NOT NULL
        );
        """
    )
    return conn
