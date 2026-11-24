"""One-time Garmin Connect login, to run in a terminal on the server.

    .venv/bin/python -m server.garmin_login your-kcal-email@example.com

Your Garmin password is asked for here, used once, and never saved:
only the access tokens are stored (in a file readable by you only) in data/garmin/.
"""

import getpass
import sys

from .db import db, garmin_token_dir


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("Usage: python -m server.garmin_login <email de ton compte Kcal>")
    with db() as conn:
        user = conn.execute("SELECT id, name FROM users WHERE email = ?", (sys.argv[1].strip().lower(),)).fetchone()
    if not user:
        sys.exit("Aucun compte Kcal avec cet e-mail. Crée-le d'abord dans l'app.")

    from garminconnect import Garmin

    print(f"Connexion Garmin pour le compte Kcal de {user['name']}")
    email = input("E-mail Garmin: ").strip()
    password = getpass.getpass("Mot de passe Garmin (non affiché, non enregistré): ")
    path = garmin_token_dir(user["id"])
    path.mkdir(parents=True, exist_ok=True, mode=0o700)

    client = Garmin(email, password, prompt_mfa=lambda: input("Code de vérification Garmin: ").strip())
    client.login(tokenstore=str(path))
    client.client.dump(str(path))
    del password

    with db() as conn:
        conn.execute("UPDATE users SET energy_source = 'garmin' WHERE id = ?", (user["id"],))
    print(f"✅ Garmin connecté ({client.get_full_name() or email}). Ouvre l'app et recharge la page.")


if __name__ == "__main__":
    main()
