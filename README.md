# kcal-counter

Snap a photo of your meal: a local AI (Ollama) recognises the foods and estimates grams and calories.
You fix anything that's off, save it, and the app keeps your daily total.

It tracks hydration too: plain water and every non-alcoholic drink (coffee, tea, milk, juice, soda…) fill the blue gauge.
Alcohol and water contained in food (soup, fruit) don't count: the ~2 L/day guideline is for drinks, food already
provides about 20 % of daily water.

- `server/app.py`: FastAPI API (photo and text analysis via Ollama, meals, water)
- `server/auth.py`: accounts (e-mail + password), cookie sessions
- `server/invites.py`: single-use invitation links, created by the admin
- `server/goals.py`: weight goal, weigh-ins, protein target
- `server/energy.py`: energy expenditure from Strava or Garmin
- `server/limits.py`: rate limits (login attempts, AI analyses)
- `server/db.py`: SQLite database `data/kcal.db` and migrations
- `server/backup.py`: nightly database backup
- `web/`: the web app (PWA) for the iPhone

> The app's interface is in French.

## Adding meals

- **Photo**: take or pick a picture; the model lists each food with grams, kcal/100 g and protein/100 g.
- **Text**: "✍️ Ajouter un repas en texte" under the meal list, e.g. *"an apple, 2 hard-boiled eggs and a large glass of water"*.
- **Review before saving**: every ingredient can be edited. Renaming an ingredient or adding a new one
  re-estimates its values automatically.
- **Correct the whole dish** with a comment, e.g. *"no rice, it was fries"*: the model recalculates every item.
- Saved meals can be edited (✏️) or deleted (🗑) later.

## Accounts and invitations

Each person creates their own account in the app (first name, e-mail, password of at least 8 characters).
Everyone has their own log and goals, stored on the server.

- The **first account created** is the administrator. It doesn't need an invitation, and it takes over
  any meals saved before accounts existed.
- Everyone else needs an **invitation**: account menu → **✉️ Inviter quelqu'un** → create a link for a person
  and share it. Each link works **once** and **expires after 7 days**. Opening it shows the sign-up form
  with the code already filled in. The admin can see which links were used and revoke pending ones.
- Optional: `KCAL_INVITE_CODE` sets a shared, reusable code accepted in addition to invitations;
  `KCAL_OPEN_SIGNUP=1` turns invitations off entirely (anyone can sign up).
- Passwords are stored hashed (scrypt). A session lasts 180 days.

### Protection

- 10 login or sign-up attempts per IP address every 15 minutes.
- 60 AI analyses per account per hour (photo, text, correction, ingredient), to keep the GPU available.
- Uploaded photos are limited to 20 MB.

## Goal (weight loss, maintenance, muscle gain)

Account → **🎯 Mon objectif** (or the "Définir un objectif" card). Pick the type, the target weight and a deadline;
the app derives the daily calorie balance and protein target, and updates them on every weigh-in ("⚖️ Se peser").

| Goal | Target balance per day | Protein |
|---|---|---|
| Weight loss | (current − target weight) × 7,700 kcal ÷ days left, capped at 1 % of body weight/week and −1,000 kcal | 2.0 g/kg |
| Maintenance | 0 | 1.6 g/kg |
| Muscle gain | same formula, capped at +500 kcal (+300 without a target weight) | 1.8 g/kg |

If the deadline is too short, the pace is capped and the app shows a realistic date.
Without an expenditure source (Strava/Garmin), the kcal goal = basal metabolic rate × daily activity + target balance
(sex, birth year and height are needed in the profile).

**Protein**: tap the protein card to override the target, either in **grams per day** or in **g/kg**
(recomputed from each new weigh-in). "Auto" goes back to the goal's value.

**📈 Évolution du poids** (account menu) shows the weight curve over 1 month, 3 months or everything,
with the goal's trajectory, and lists weigh-ins (which can be deleted).

## Energy expenditure (Strava or Garmin)

In the app: account button (top right) → **Dépense énergétique**. Three modes:

| Mode | Daily expenditure | Goal |
|---|---|---|
| None | — | fixed kcal goal |
| **Strava** | basal metabolic rate (Mifflin-St Jeor, from sex, age, height, weight) × daily activity + calories from Strava activities | expenditure + target balance |
| **Garmin** | the day's total measured by the watch (resting + active), growing through the day | expenditure + target balance |

The **target balance** is for example −500 kcal/day to lose about 0.5 kg per week.

Activity cards link to the activity on Strava or Garmin Connect.

### Connections

At the top of the **Dépense énergétique** screen, the **Connexions** section shows Strava and Garmin with their status
(✓ Connecté / Non connecté). Tapping a service that isn't connected explains what to do.

**Strava**
- The very first time, the administrator (first account) registers the application with Strava:
  the app shows the steps (create the application at strava.com/settings/api with website `http://localhost`
  and the callback domain shown), then fields to paste the *Client ID* and *Client Secret*.
  They are saved in `.env` (not versioned, readable only by you).
- Then each person taps Strava → "Continuer vers Strava" and authorises Kcal.
- Strava accepts a single callback domain. The app remembers the address used for the first successful
  connection (`STRAVA_CALLBACK_HOST`) and, if you connect from another address, explains where to go instead
  of showing Strava's error page.
- A new Strava application is limited to one athlete until Strava reviews it.

**Garmin**
- Tap Garmin → Garmin e-mail and password (then the verification code if Garmin sends one).
- **The password is never stored**: only the access tokens are kept in `data/garmin/`
  (readable only by you). "Déconnecter Garmin" deletes them.
- It travels over the network: over plain HTTP on Wi-Fi it isn't encrypted. Do it from the PC (`localhost`) or over HTTPS.
- Command-line alternative: `.venv/bin/python -m server.garmin_login your-kcal-email@example.com`

Garmin has no API open to individuals: the app uses the open-source `garminconnect` library.

Strava/Garmin data is cached for 10 minutes for the current day, and permanently for past days.

## Running

```bash
uv venv && uv pip install -r pyproject.toml
.venv/bin/uvicorn server.app:app --host 0.0.0.0 --port 8420 --proxy-headers
```

Settings are read from the environment or from `.env`:

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server |
| `OLLAMA_MODEL` | `qwen3.5:9b` | vision model used for analyses |
| `KCAL_DB` | `data/kcal.db` | database path |
| `KCAL_INVITE_CODE` | — | optional shared sign-up code |
| `KCAL_OPEN_SIGNUP` | — | `1` = sign-up without invitation |
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` | — | filled in from the app |
| `STRAVA_CALLBACK_HOST` | — | saved automatically after the first Strava connection |

### As a permanent service (starts with the PC)

User systemd service: `~/.config/systemd/user/kcal.service`
(with `loginctl enable-linger $USER`, it starts at boot even without an open session).

```bash
systemctl --user status kcal      # status
systemctl --user restart kcal     # after updating the code or .env
journalctl --user -u kcal -f      # logs
```

### Backups

A systemd timer copies the database every night at 3:30 to `data/backups/kcal-YYYY-MM-DD.db`
and keeps the last 14 copies. Install it once:

```bash
ln -sf "$PWD/deploy/kcal-backup.service" "$PWD/deploy/kcal-backup.timer" ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now kcal-backup.timer
```

Manual backup: `.venv/bin/python -m server.backup`. To restore, stop the service and copy a backup over `data/kcal.db`.

## On the iPhone

**At home (same Wi-Fi)**: open `http://<PC-IP>:8420` in Safari.

**Anywhere, on your own devices**: install [Tailscale](https://tailscale.com) on the PC and the iPhone, then on the PC:

```bash
sudo tailscale serve --bg 8420
```

The app is then available over HTTPS at `https://<pc-name>.<tailnet>.ts.net`, only from your devices.

Then in Safari: **Share → Add to Home Screen**. The app opens full screen like a native app.

## Known limitations

- Gram estimates from photos are approximate: check the quantities before saving.
- kcal/100 g values come from the model (with reference values in the prompt). Next step: align them with the Ciqual table (ANSES).
- Tap the goal ("/ 2000 kcal") or the water gauge to change them.
- No "forgot password" yet: it would require sending e-mails.
- No Google sign-in: it requires a domain name over HTTPS. It could later hook into these accounts via the e-mail address.
