# kcal-counter

Prends ton repas en photo, l'IA locale (Ollama) reconnaît les aliments et estime grammes et calories.
Tu corriges si besoin, tu enregistres, et l'app tient le total du jour.

Elle compte aussi l'eau : une photo de verre ou de bouteille estime le volume et remplit la jauge bleue.

- `server/app.py` : API FastAPI (analyse photo via Ollama, repas, eau)
- `server/auth.py` : comptes (e-mail + mot de passe), sessions par cookie
- `server/db.py` : base SQLite `data/kcal.db` et migrations
- `web/` : la web app (PWA) pour l'iPhone

## Comptes

Chaque personne crée son compte dans l'app (prénom, e-mail, mot de passe de 8 caractères minimum).
Chacun a son propre journal et ses objectifs (kcal et eau), enregistrés sur le serveur.

- Le **premier compte créé** récupère les repas enregistrés avant l'ajout des comptes.
- Pour éviter que n'importe qui sur le réseau crée un compte, définis un **code d'invitation** :
  `KCAL_INVITE_CODE=un-code-secret` au lancement. Il sera demandé à l'inscription.
- Les mots de passe sont stockés hachés (scrypt). Une session dure 180 jours.

## Dépense énergétique (Strava ou Garmin)

Dans l'app : bouton du compte (en haut à droite) → **Dépense énergétique**. Trois modes au choix :

| Mode | Dépense du jour | Objectif |
|---|---|---|
| Aucune | — | objectif fixe en kcal |
| **Strava** | métabolisme de base (formule Mifflin-St Jeor, d'après sexe, âge, taille, poids) × vie quotidienne + calories des activités Strava | dépense + bilan visé |
| **Garmin** | total de la journée mesuré par la montre (repos + actif), qui augmente au fil de la journée | dépense + bilan visé |

Le **bilan visé** vaut par exemple −500 kcal/jour pour perdre environ 0,5 kg par semaine.

### Connexions

En haut de l'écran **Dépense énergétique**, la section **Connexions** montre Strava et Garmin avec leur état
(✓ Connecté / Non connecté). Toucher un service non connecté affiche ce qu'il faut faire.

**Strava**
- La toute première fois, l'administrateur (le premier compte créé) déclare l'application chez Strava :
  l'app affiche les étapes (créer l'application sur strava.com/settings/api avec le site `http://localhost`
  et le domaine de rappel indiqué), puis des champs pour coller le *Client ID* et le *Client Secret*.
  Ils sont enregistrés dans `.env` (non versionné, lisible par toi seul).
- Ensuite, chacun touche Strava → « Continuer vers Strava » et autorise Kcal.
- La connexion doit se faire depuis l'adresse déclarée comme domaine de rappel (ex. `http://localhost:8420` sur le PC).
  `localhost` est toujours accepté par Strava ; avec Tailscale, déclare plutôt ton adresse `.ts.net`.
- Une nouvelle application Strava est limitée à un seul athlète tant que Strava ne l'a pas validée.

**Garmin**
- Toucher Garmin → e-mail et mot de passe Garmin (puis le code de vérification si Garmin en envoie un).
- **Le mot de passe n'est jamais enregistré** : seuls les jetons d'accès sont gardés dans `data/garmin/`
  (lisibles par toi seul). « Déconnecter Garmin » les supprime.
- Il passe par le réseau : sur le Wi-Fi en HTTP il n'est pas chiffré. Fais-le depuis le PC (`localhost`) ou via Tailscale.
- Alternative en ligne de commande : `.venv/bin/python -m server.garmin_login ton-email-kcal@exemple.fr`

Garmin n'a pas d'API ouverte aux particuliers : on utilise la bibliothèque open source `garminconnect`.

Les données Strava/Garmin sont mises en cache 10 minutes pour la journée en cours, et définitivement pour les jours passés.

## Lancer

```bash
uv venv && uv pip install -r pyproject.toml
.venv/bin/uvicorn server.app:app --host 0.0.0.0 --port 8420
```

Variables optionnelles : `KCAL_INVITE_CODE` (code exigé à l'inscription), `OLLAMA_URL` (défaut `http://localhost:11434`),
`OLLAMA_MODEL` (défaut `qwen3.5:9b`), `KCAL_DB`.

### En service permanent (démarre avec le PC)

Service systemd utilisateur : `~/.config/systemd/user/kcal.service`
(avec `loginctl enable-linger $USER`, il démarre au boot même sans session ouverte).

```bash
systemctl --user status kcal      # état
systemctl --user restart kcal     # après une mise à jour du code ou du .env
journalctl --user -u kcal -f      # journaux
```

## Sur l'iPhone

**À la maison (même Wi-Fi)** : ouvre `http://<IP-du-PC>:8420` dans Safari.

**Partout** : installe [Tailscale](https://tailscale.com) sur le PC et l'iPhone, puis sur le PC :

```bash
sudo tailscale serve --bg 8420
```

L'app est alors accessible en HTTPS via `https://<nom-du-pc>.<tailnet>.ts.net`, uniquement depuis tes appareils.

Puis dans Safari : **Partager → Sur l'écran d'accueil**. L'app s'ouvre en plein écran comme une vraie app.

## Limites connues

- L'estimation des grammes sur photo reste approximative : vérifie les quantités avant d'enregistrer.
- Les valeurs kcal/100 g viennent du modèle (avec des repères dans le prompt). Étape suivante : les recaler sur la table Ciqual (ANSES).
- Toucher l'objectif (« / 2000 kcal ») ou la jauge d'eau permet de les changer.
- Pas encore de « mot de passe oublié » : il faudrait un envoi d'e-mails.
- Pas de connexion Google : elle exige un nom de domaine en HTTPS. Elle pourra se brancher sur ces comptes via l'e-mail.
