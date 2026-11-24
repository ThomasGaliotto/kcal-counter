"""Database backup: consistent copy into data/backups/, keeps the last 14.

Run every night by deploy/kcal-backup.timer:  python -m server.backup
"""

import sqlite3
from datetime import datetime

from .db import DB_PATH

KEEP = 14


def main() -> None:
    folder = DB_PATH.parent / "backups"
    folder.mkdir(exist_ok=True)
    target = folder / f"kcal-{datetime.now():%Y-%m-%d}.db"
    with sqlite3.connect(DB_PATH) as src, sqlite3.connect(target) as dst:
        src.backup(dst)  # safe copy even while the app is writing
    for old in sorted(folder.glob("kcal-*.db"))[:-KEEP]:
        old.unlink()
    print(f"Sauvegarde: {target}")


if __name__ == "__main__":
    main()
