const $ = (id) => document.getElementById(id);
let me = null; // utilisateur connecté : { id, email, name, kcal_goal, water_goal }
let day = todayISO();
let draft = null; // repas en cours de vérification

function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function shiftDay(iso, n) {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function dayLabel(iso) {
  if (iso === todayISO()) return "Aujourd'hui";
  if (iso === shiftDay(todayISO(), -1)) return "Hier";
  return new Date(iso + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
}
const kcalOf = (it) => (Number(it.grams) || 0) * (Number(it.kcal_100g) || 0) / 100;
const macro = (items, key) => Math.round(items.reduce((s, it) => s + it.grams * (it[key] || 0) / 100, 0));

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401 && !path.startsWith("/api/auth/")) {
    showAuth(); // session expirée ou jamais connecté
    throw new Error("Connecte-toi pour continuer");
  }
  if (!r.ok) {
    let msg = `Erreur ${r.status}`;
    try {
      const detail = (await r.json()).detail;
      msg = typeof detail === "string" ? detail : detail ? "Une valeur est invalide ou hors limites." : msg;
    } catch {}
    throw new Error(msg);
  }
  return r.json();
}

// ---------- Journal du jour ----------
async function loadDay() {
  $("day-label").textContent = dayLabel(day);
  $("next").disabled = day >= todayISO();
  const { water_goal } = me;
  const shownDay = day;
  const [data, energy] = await Promise.all([
    api(`/api/meals?day=${day}`),
    me.energy_source === "none" ? null : api(`/api/energy?day=${day}`).catch((err) => ({ error: err.message, activities: [] })),
  ]);
  if (shownDay !== day) return; // l'utilisateur a changé de jour entre-temps

  const eaten = data.total_kcal;
  const model = energyModel(energy);
  const energyMode = me.energy_source !== "none";

  // ----- Carte « Mangé » : objectif fixe, ou brûlé prévu à minuit + bilan visé
  const kcal_goal = model ? Math.max(0, Math.round(model.projected + me.balance_goal)) : me.kcal_goal;
  $("goal").textContent = fmt(kcal_goal);
  $("total").textContent = fmt(eaten);
  const fill = $("bar-fill");
  fill.style.width = Math.min(100, (eaten / kcal_goal) * 100) + "%";
  fill.classList.toggle("over", eaten > kcal_goal);

  // ----- Carte « Brûlé » et projection
  $("cards").classList.toggle("two", energyMode);
  $("card-burned").hidden = !energyMode;
  $("projection").hidden = !model;
  if (energyMode) renderBurned(model);
  if (model) renderProjection(model, eaten);
  const warn = energy && (energy.burned == null ? (energy.error || "Dépense indisponible") + " — objectif fixe utilisé"
    : energy.warning || energy.error);
  $("energy-warn").hidden = !warn;
  $("energy-warn").textContent = warn ? "⚠️ " + warn : "";

  renderGoalCard();

  // ----- Protéines
  const pGoal = proteinGoal();
  $("protein-total").textContent = fmt(data.total_protein_g ?? 0);
  $("protein-goal").textContent = fmt(pGoal);
  $("protein-fill").style.width = Math.min(100, ((data.total_protein_g ?? 0) / pGoal) * 100) + "%";

  // ----- Eau
  // Sport : +500 ml par heure d'activité enregistrée (Strava/Garmin), arrondi à 50 ml
  const sportMin = (energy?.activities || []).reduce((s, a) => s + (a.minutes || 0), 0);
  const sportWater = Math.round((sportMin / 60) * 500 / 50) * 50;
  const waterTarget = water_goal + sportWater;
  $("water-goal").textContent = fmt(waterTarget);
  $("water-goal").title = sportWater ? `${fmt(water_goal)} ml + ${fmt(sportWater)} ml pour ${sportMin} min de sport` : "";
  $("water-sport").hidden = !sportWater;
  $("water-sport").textContent = `dont +${fmt(sportWater)} ml sport`;
  $("water-total").textContent = fmt(data.total_water_ml);
  $("water-fill").style.width = Math.min(100, (data.total_water_ml / waterTarget) * 100) + "%";

  // ----- Colonnes : repas à gauche, activités à droite (en mode dépense)
  const activities = energy ? energy.activities || [] : [];
  $("columns").classList.toggle("two", energyMode);
  $("activities-col").hidden = !energyMode;
  $("meals-title").hidden = !energyMode;
  $("no-activity").hidden = activities.length > 0;
  $("empty").hidden = data.meals.length > 0 || !$("review").hidden;
  $("empty").textContent = energyMode ? "Aucun repas." : "Aucun repas ce jour-là.";
  const actList = $("activities");
  actList.innerHTML = "";
  for (const a of activities) {
    const el = document.createElement("div");
    el.className = "meal activity";
    el.innerHTML = `<div class="meal-main">
        <div class="meal-head"><span></span></div>
        <div class="act-kcal"></div>
        <div class="meal-items"></div></div>`;
    el.querySelector(".meal-head span").textContent = `${a.icon} ${a.name}`;
    el.querySelector(".act-kcal").textContent = `−${fmt(Math.round(a.kcal))} kcal`;
    const bits = [];
    if (a.distance_km) bits.push(`${fmt(a.distance_km)} km`);
    if (a.minutes) bits.push(a.minutes >= 60 ? `${Math.floor(a.minutes / 60)} h ${String(a.minutes % 60).padStart(2, "0")}` : `${a.minutes} min`);
    bits.push(energy.source === "garmin" ? "Garmin" : "Strava");
    el.querySelector(".meal-items").textContent = bits.join(" · ");
    actList.appendChild(el);
  }

  const list = $("meals");
  list.innerHTML = "";
  for (const m of data.meals.slice().reverse()) {
    const el = document.createElement("div");
    el.className = "meal";
    const time = new Date(m.eaten_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    el.innerHTML = `
      <div class="meal-main">
        <div class="meal-head"><span></span><span>${Math.round(m.kcal)} kcal</span></div>
        <div class="meal-time">${time}</div>
        <div class="meal-items"></div>
        <div class="meal-macros">P ${macro(m.items, "protein_100g")} g · G ${macro(m.items, "carbs_100g")} g · L ${macro(m.items, "fat_100g")} g</div>
      </div>
      <button class="remove" aria-label="Supprimer">🗑</button>`;
    el.querySelector(".meal-head span").textContent = m.title;
    el.querySelector(".meal-items").textContent = m.items.map((i) => `${i.name} (${Math.round(i.grams)} g)`).join(", ");
    if (m.water_ml > 0) {
      const w = document.createElement("span");
      w.className = "meal-water";
      w.textContent = `💧 ${Math.round(m.water_ml)} ml`;
      if (m.items.length) el.querySelector(".meal-items").append(" · ");
      el.querySelector(".meal-items").append(w);
    }
    if (!m.items.length) {
      // entrée « eau seule » : pas de kcal ni de macros à afficher
      el.querySelector(".meal-head span:last-child").textContent = "";
      el.querySelector(".meal-macros").remove();
    }
    el.querySelector(".remove").onclick = async () => {
      if (!confirm(`Supprimer « ${m.title} » ?`)) return;
      await api(`/api/meals/${m.id}`, { method: "DELETE" });
      loadDay();
    };
    list.appendChild(el);
  }
}

const fmt = (n) => Number(n).toLocaleString("fr-FR");
const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmt(Math.abs(Math.round(n)));

// Part de la journée affichée déjà écoulée : 1 pour un jour passé, l'heure actuelle / 24 h pour aujourd'hui
function dayFraction(iso) {
  const today = todayISO();
  if (iso < today) return 1;
  if (iso > today) return 0;
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return (now - midnight) / 86400000;
}

/* Dépense du jour ramenée à l'instant présent et projetée à minuit.
   - Strava : `resting` = base de la journée entière (métabolisme × vie quotidienne), `active` = activités.
     Brûlé maintenant = base × fraction écoulée + activités ; prévu à minuit = base entière + activités faites.
   - Garmin : `burned` = total mesuré jusqu'ici, `resting` = métabolisme de base de la journée.
     Prévu à minuit = total actuel + part du métabolisme restant jusqu'à minuit. */
function energyModel(energy) {
  if (!energy || energy.burned == null) return null;
  const f = dayFraction(day);
  const resting = energy.resting ?? 0;
  const active = energy.active ?? 0;
  const metabNow = resting * f;
  if (energy.source === "garmin") {
    return { f, resting, metabNow, active, burnedNow: energy.burned, projected: energy.burned + resting * (1 - f) };
  }
  return { f, resting, metabNow, active, burnedNow: metabNow + active, projected: resting + active };
}

function renderBurned(model) {
  if (!model) {
    $("burned").textContent = "—";
    $("metab-fill").style.width = "0%";
    $("metab-text").textContent = "Dépense indisponible";
    $("act-total").textContent = "—";
    return;
  }
  $("burned").textContent = fmt(Math.round(model.burnedNow));
  $("metab-fill").style.width = Math.min(100, model.f * 100) + "%";
  $("metab-text").textContent = model.f < 1
    ? `${fmt(Math.round(model.metabNow))} / ${fmt(Math.round(model.resting))} · ${Math.round(model.f * 100)} %`
    : `${fmt(Math.round(model.resting))} kcal`;
  $("act-total").textContent = fmt(Math.round(model.active));
}

function renderProjection(model, eaten) {
  const left = model.projected + me.balance_goal - eaten;
  $("projection").querySelector(".card-label").textContent = model.f < 1 ? "Projection à minuit" : "Bilan de la journée";
  const live = model.f < 1; // aujourd'hui : projection ; jour passé : valeurs définitives
  $("proj-burned").textContent = `${fmt(Math.round(model.projected))} kcal`;
  $("proj-burned").previousElementSibling.textContent = live ? "Brûlé prévu" : "Brûlé";
  $("proj-balance").textContent = `${signed(eaten - model.projected)} kcal`;
  $("proj-balance").previousElementSibling.textContent = live ? "Bilan si tu ne manges plus" : "Bilan";
  $("proj-left-label").textContent = live
    ? (left >= 0 ? "Encore possible" : "Dépassement")
    : (left >= 0 ? "Sous l'objectif de" : "Au-dessus de l'objectif de");
  $("proj-left").textContent = `${fmt(Math.abs(Math.round(left)))} kcal`;
  $("proj-left").classList.toggle("over", left < 0);
  $("proj-left").title = `objectif de bilan ${signed(me.balance_goal)} kcal`;
}

// ---------- Photo -> analyse ----------
document.querySelectorAll(".photo-input").forEach((input) => input.addEventListener("change", onPhoto));

async function onPhoto(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  draft = null;
  $("review").hidden = false;
  document.body.classList.add("reviewing");
  $("empty").hidden = true;
  $("preview").src = URL.createObjectURL(file);
  $("analyzing").hidden = false;
  $("result").hidden = true;
  $("error").hidden = true;
  window.scrollTo({ top: 0, behavior: "smooth" });

  const form = new FormData();
  form.append("photo", file);
  try {
    const res = await api("/api/analyze", { method: "POST", body: form });
    draft = { title: res.title || "Repas", items: res.items || [], water_ml: res.water_ml || 0 };
    if (!draft.items.length && !draft.water_ml) throw new Error("Rien de reconnu. Ajoute-le à la main ou reprends la photo.");
    renderDraft();
  } catch (err) {
    $("analyzing").hidden = true;
    $("error").textContent = err.message;
    $("error").hidden = false;
    draft = draft || { title: "Repas", items: [], water_ml: 0 };
    renderDraft();
  }
}

function renderDraft() {
  $("analyzing").hidden = true;
  $("result").hidden = false;
  $("meal-title").value = draft.title;
  const box = $("items");
  box.innerHTML = "";
  draft.items.forEach((it, idx) => {
    const row = $("item-tpl").content.firstElementChild.cloneNode(true);
    const name = row.querySelector(".name"), grams = row.querySelector(".grams"), k100 = row.querySelector(".k100");
    name.value = it.name;
    grams.value = Math.round(it.grams);
    k100.value = Math.round(it.kcal_100g);
    const refresh = () => { row.querySelector(".kcal").textContent = Math.round(kcalOf(it)) + " kcal"; updateDraftTotal(); };
    name.oninput = () => (it.name = name.value);
    grams.oninput = () => { it.grams = Number(grams.value) || 0; refresh(); };
    k100.oninput = () => { it.kcal_100g = Number(k100.value) || 0; refresh(); };
    row.querySelector(".remove").onclick = () => { draft.items.splice(idx, 1); renderDraft(); };
    refresh();
    box.appendChild(row);
  });
  $("water-row").hidden = !(draft.water_ml > 0);
  $("add-water").hidden = draft.water_ml > 0;
  $("water-ml").value = draft.water_ml || "";
  updateDraftTotal();
}
$("water-ml").oninput = (e) => (draft.water_ml = Number(e.target.value) || 0);
$("remove-water").onclick = () => { draft.water_ml = 0; renderDraft(); };
$("add-water").onclick = () => {
  draft.water_ml = 250;
  renderDraft();
  $("water-ml").select();
};
function updateDraftTotal() {
  $("result-kcal").textContent = Math.round(draft.items.reduce((s, it) => s + kcalOf(it), 0));
  $("result-kcal").parentElement.hidden = !draft.items.length;
}

$("add-item").onclick = () => {
  draft.items.push({ name: "", grams: 100, kcal_100g: 0, protein_100g: 0, carbs_100g: 0, fat_100g: 0 });
  renderDraft();
  const names = document.querySelectorAll("#items .name");
  names[names.length - 1].focus();
};
$("meal-title").oninput = (e) => (draft.title = e.target.value);

function closeReview() {
  draft = null;
  $("review").hidden = true;
  document.body.classList.remove("reviewing");
  loadDay();
}
$("cancel").onclick = closeReview;
$("save").onclick = async () => {
  const items = draft.items.filter((it) => it.name.trim());
  const water_ml = draft.water_ml || 0;
  if (!items.length && !water_ml) return alert("Ajoute au moins un aliment ou de l'eau.");
  $("save").disabled = true;
  try {
    // Le repas est rangé dans le jour affiché (pratique pour rattraper un oubli d'hier)
    const eaten_at = day === todayISO() ? null : `${day}T12:00:00`;
    await api("/api/meals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: draft.title || (items.length ? "Repas" : "Eau"), items, water_ml, eaten_at }),
    });
    closeReview();
  } catch (err) {
    alert(err.message);
  } finally {
    $("save").disabled = false;
  }
};

// ---------- Navigation ----------
$("prev").onclick = () => { day = shiftDay(day, -1); loadDay(); };
$("next").onclick = () => { if (day < todayISO()) { day = shiftDay(day, 1); loadDay(); } };
/* Fenêtre de saisie dans l'app (prompt() n'existe pas dans tous les navigateurs intégrés).
   fields : [{ key, label, type ("number" | "password" | "text"), value, unit, step, min, max }]
   onSubmit(values) : async ; lever une erreur laisse la fenêtre ouverte avec le message. */
function ask({ title, fields, submit = "Valider", onSubmit }) {
  const dlg = $("ask");
  $("ask-title").textContent = title;
  $("ask-submit").textContent = submit;
  $("ask-error").hidden = true;
  const box = $("ask-fields");
  box.innerHTML = "";
  const inputs = {};
  for (const f of fields) {
    const label = document.createElement("label");
    label.className = "field";
    label.textContent = f.label;
    const input = document.createElement("input");
    input.type = f.type === "number" ? "text" : f.type || "text";
    if (f.type === "number") input.inputMode = f.step && f.step < 1 ? "decimal" : "numeric";
    if (f.type === "password") input.autocomplete = f.key === "current" ? "current-password" : "new-password";
    input.value = f.value ?? "";
    input.required = true;
    inputs[f.key] = input;
    if (f.unit) {
      const wrap = document.createElement("span");
      wrap.className = "input-unit";
      wrap.append(input, " " + f.unit);
      label.append(wrap);
    } else {
      label.append(input);
    }
    box.append(label);
  }
  $("ask-form").onsubmit = async (e) => {
    e.preventDefault();
    const values = {};
    for (const f of fields) {
      const raw = inputs[f.key].value.trim();
      if (f.type === "number") {
        const n = Number(raw.replace(",", "."));
        if (raw === "" || !Number.isFinite(n) || (f.min != null && n < f.min) || (f.max != null && n > f.max)) {
          return showAskError(`${f.label} : valeur entre ${f.min ?? "…"} et ${f.max ?? "…"}${f.unit ? " " + f.unit : ""}.`);
        }
        values[f.key] = n;
      } else {
        values[f.key] = raw;
      }
    }
    $("ask-submit").disabled = true;
    try {
      await onSubmit(values);
      dlg.close();
    } catch (err) {
      showAskError(err.message);
    } finally {
      $("ask-submit").disabled = false;
    }
  };
  $("ask-close").onclick = () => dlg.close();
  dlg.showModal();
  const first = inputs[fields[0].key];
  first.focus();
  first.select();
}
function showAskError(msg) {
  $("ask-error").textContent = msg;
  $("ask-error").hidden = false;
}

async function patchMe(changes) {
  me = await api("/api/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) });
  loadDay();
}
function editGoal(field, label, unit, max) {
  ask({
    title: label,
    fields: [{ key: "v", label: "Objectif par jour", type: "number", value: me[field], unit, min: 1, max }],
    onSubmit: ({ v }) => patchMe({ [field]: Math.round(v) }),
  });
}
$("goal-btn").onclick = () => {
  if (me.energy_source === "none") editGoal("kcal_goal", "🔥 Objectif de calories", "kcal", 20000);
  else openSettings();
};
$("water-gauge").onclick = () => editGoal("water_goal", "💧 Objectif d'eau", "ml", 20000);
// Objectif de protéines : choisi, sinon 1,6 g par kg de poids, sinon 100 g
const proteinGoal = () => me.protein_goal || (me.weight_kg ? Math.round(me.weight_kg * 1.6) : 100);
$("protein-card").onclick = async () => {
  if (plan) return openGoal(); // avec un objectif, les protéines en découlent
  ask({
    title: "💪 Objectif de protéines",
    fields: [{ key: "v", label: "Objectif par jour", type: "number", value: proteinGoal(), unit: "g", min: 1, max: 500 }],
    onSubmit: ({ v }) => patchMe({ protein_goal: Math.round(v) }),
  });
};

// ---------- Comptes ----------
let authMode = "login";
let inviteRequired = false;

function setAuthMode(mode) {
  authMode = mode;
  $("tab-login").classList.toggle("active", mode === "login");
  $("tab-register").classList.toggle("active", mode === "register");
  document.querySelectorAll(".register-only").forEach((el) => {
    el.hidden = mode !== "register" || (el.classList.contains("invite-only") && !inviteRequired);
  });
  $("auth-name").required = mode === "register";
  $("auth-invite").required = mode === "register" && inviteRequired;
  $("auth-password").autocomplete = mode === "register" ? "new-password" : "current-password";
  $("auth-submit").textContent = mode === "register" ? "Créer mon compte" : "Se connecter";
  $("auth-error").hidden = true;
}
$("tab-login").onclick = () => setAuthMode("login");
$("tab-register").onclick = () => setAuthMode("register");

async function showAuth() {
  me = null;
  $("auth").hidden = false;
  try { inviteRequired = (await api("/api/auth/config")).invite_required; } catch {}
  setAuthMode(authMode);
}

$("auth-form").onsubmit = async (e) => {
  e.preventDefault();
  const body = { email: $("auth-email").value, password: $("auth-password").value };
  if (authMode === "register") {
    if (body.password.length < 8) return authError("Le mot de passe doit faire au moins 8 caractères.");
    body.name = $("auth-name").value;
    body.invite_code = $("auth-invite").value;
  }
  $("auth-submit").disabled = true;
  try {
    me = await api(`/api/auth/${authMode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    $("auth").hidden = true;
    $("auth-password").value = "";
    startApp();
  } catch (err) {
    authError(err.message);
  } finally {
    $("auth-submit").disabled = false;
  }
};
function authError(msg) {
  $("auth-error").textContent = msg;
  $("auth-error").hidden = false;
}

$("account-btn").onclick = () => {
  $("account-name").textContent = me.name;
  $("account-email").textContent = me.email;
  $("account").showModal();
};
$("account-close").onclick = () => $("account").close();
$("logout").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  $("account").close();
  $("meals").innerHTML = "";
  showAuth();
};
$("change-password").onclick = () => {
  $("account").close();
  ask({
    title: "Changer le mot de passe",
    submit: "Changer",
    fields: [
      { key: "current", label: "Mot de passe actuel", type: "password" },
      { key: "next", label: "Nouveau mot de passe (8 caractères minimum)", type: "password" },
    ],
    onSubmit: async ({ current, next }) => {
      if (next.length < 8) throw new Error("Le nouveau mot de passe doit faire au moins 8 caractères.");
      await api("/api/me/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current, new: next }),
      });
      setTimeout(() => alert("Mot de passe changé. Tes autres appareils ont été déconnectés."), 100);
    },
  });
};

// ---------- Réglages : dépense énergétique ----------
const sourceValue = () => ($("settings-form").querySelector("input[name=source]:checked") || {}).value || "none";

function bmrPreview() {
  const sex = $("set-sex").value, by = +$("set-birth").value, h = +$("set-height").value, w = +$("set-weight").value;
  if (!sex || !by || !h || !w) return "Renseigne ton profil pour calculer ton métabolisme de base.";
  const bmr = 10 * w + 6.25 * h - 5 * (new Date().getFullYear() - by) + (sex === "m" ? 5 : -161);
  const life = +$("set-life").value;
  return `Métabolisme de base : ${fmt(Math.round(bmr))} kcal/jour` +
    (life > 1 ? ` · avec la vie quotidienne : ${fmt(Math.round(bmr * life))} kcal/jour, + tes activités Strava.` : ", + tes activités Strava.");
}

function renderSettingsVisibility() {
  const src = sourceValue();
  document.querySelector(".when-energy").hidden = src === "none";
  document.querySelector(".when-strava").hidden = src !== "strava";
  $("bmr-preview").textContent = bmrPreview();
  const warn = $("source-warning");
  warn.hidden = true;
  if (src === "strava" && !me.strava_connected) {
    warn.textContent = "⚠️ Strava n'est pas connecté : seul ton métabolisme de base sera compté. Touche « Strava » ci-dessus.";
    warn.hidden = false;
  } else if (src === "garmin" && !me.garmin_connected) {
    warn.textContent = "⚠️ Garmin n'est pas connecté : touche « Garmin » ci-dessus pour le connecter.";
    warn.hidden = false;
  }
}

// ----- Connexions Strava / Garmin -----
const insecure = location.protocol === "http:" && !["localhost", "127.0.0.1"].includes(location.hostname);
const INSECURE_NOTE = `<p class="hint warn-text">⚠️ Tu es connecté en HTTP non chiffré sur le réseau.
  Pour saisir un mot de passe ou une clé, fais-le plutôt depuis le PC (http://localhost:8420) ou via Tailscale.</p>`;

function renderConnections() {
  for (const [key, connected] of [["strava", me.strava_connected], ["garmin", me.garmin_connected]]) {
    const state = document.querySelector(`#conn-${key} .conn-state`);
    state.textContent = connected ? "✓ Connecté" : "Non connecté";
    state.classList.toggle("ok", connected);
  }
}

function toggleConn(key) {
  const panel = document.querySelector(`#conn-${key} .conn-panel`);
  const opening = panel.hidden;
  document.querySelectorAll(".conn-panel").forEach((p) => (p.hidden = true));
  if (!opening) return;
  (key === "strava" ? renderStravaPanel : renderGarminPanel)(panel);
  panel.hidden = false;
}
document.querySelector("#conn-strava .conn-row").onclick = () => toggleConn("strava");
document.querySelector("#conn-garmin .conn-row").onclick = () => toggleConn("garmin");

function panelError(panel, msg) {
  let el = panel.querySelector(".error");
  if (!el) { el = document.createElement("p"); el.className = "error"; panel.prepend(el); }
  el.textContent = msg;
}
// Entrée dans un champ du panneau = son bouton principal (et non l'enregistrement des réglages)
function bindEnter(panel, action) {
  panel.querySelectorAll("input").forEach((i) => i.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); action(); }
  }));
}

function disconnectPanel(panel, label, url) {
  panel.innerHTML = `<p>${label} est connecté à ton compte Kcal.</p>
    <button type="button" class="btn danger">Déconnecter ${label}</button>`;
  panel.querySelector("button").onclick = async () => {
    if (!confirm(`Déconnecter ${label} ?`)) return;
    try {
      await api(url, { method: "POST" });
      me = await api("/api/me");
      renderConnections(); renderSettingsVisibility();
      panel.hidden = true;
    } catch (err) { panelError(panel, err.message); }
  };
}

async function goToStrava() {
  // enregistre d'abord les réglages en cours pour ne pas les perdre pendant le passage par Strava
  if (await saveSettings(false)) location.href = "/api/strava/connect";
}

function renderStravaPanel(panel) {
  if (me.strava_connected) return disconnectPanel(panel, "Strava", "/api/strava/disconnect");
  if (me.strava_available) {
    panel.innerHTML = `<p>Tu vas être redirigé vers Strava pour autoriser Kcal à lire tes activités, puis ramené ici.</p>
      <button type="button" class="btn strava">Continuer vers Strava</button>`;
    panel.querySelector("button").onclick = goToStrava;
    return;
  }
  if (!me.is_admin) {
    panel.innerHTML = `<p>Strava n'est pas encore activé sur ce serveur. Demande à la personne qui héberge Kcal de le configurer.</p>`;
    return;
  }
  // Première fois : l'administrateur déclare l'application Strava
  panel.innerHTML = `
    <p>Première fois : il faut déclarer Kcal chez Strava (une seule fois, environ 5 minutes).</p>
    <ol>
      <li>Ouvre <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener">strava.com/settings/api</a>
        et crée une application.</li>
      <li>Site web : <code>http://localhost</code><br>Domaine de rappel : <code class="cb"></code></li>
      <li>Ajoute une icône (n'importe quelle image), puis copie ici les deux identifiants affichés :</li>
    </ol>
    <input class="cid" inputmode="numeric" placeholder="Client ID (un nombre)" autocomplete="off">
    <input class="csecret" placeholder="Client Secret" autocomplete="off" autocapitalize="off" spellcheck="false">
    ${insecure ? INSECURE_NOTE : ""}
    <button type="button" class="btn strava">Enregistrer et connecter Strava</button>`;
  panel.querySelector(".cb").textContent = location.hostname;
  const submit = async () => {
    const client_id = panel.querySelector(".cid").value.trim();
    const client_secret = panel.querySelector(".csecret").value.trim();
    if (!/^\d+$/.test(client_id)) return panelError(panel, "Le Client ID est un nombre.");
    if (!/^[0-9a-f]{20,}$/i.test(client_secret)) return panelError(panel, "Le Client Secret est une longue suite de chiffres et de lettres (a à f).");
    try {
      await api("/api/strava/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id, client_secret }),
      });
      me.strava_available = true;
      goToStrava();
    } catch (err) { panelError(panel, err.message); }
  };
  panel.querySelector("button").onclick = submit;
  bindEnter(panel, submit);
}

function renderGarminPanel(panel) {
  if (me.garmin_connected) return disconnectPanel(panel, "Garmin", "/api/garmin/disconnect");
  panel.innerHTML = `
    <p>Connecte-toi avec ton compte Garmin Connect. Le mot de passe sert une seule fois et <b>n'est jamais enregistré</b> :
      Kcal ne garde qu'un jeton d'accès, révocable avec « Déconnecter ».</p>
    <input class="gemail" type="email" placeholder="E-mail Garmin" autocomplete="off" autocapitalize="off">
    <input class="gpass" type="password" placeholder="Mot de passe Garmin" autocomplete="off">
    <input class="gcode" inputmode="numeric" placeholder="Code reçu par e-mail ou SMS" autocomplete="one-time-code" hidden>
    ${insecure ? INSECURE_NOTE : ""}
    <button type="button" class="btn garmin">Connecter Garmin</button>`;
  const btn = panel.querySelector("button");
  let waitingCode = false;
  const done = async () => {
    me = await api("/api/me");
    const radio = $("settings-form").querySelector(`input[name=source][value=${me.energy_source}]`);
    if (radio) radio.checked = true;
    renderConnections(); renderSettingsVisibility();
    panel.innerHTML = `<p class="ok-text">✓ Garmin est connecté.</p>`;
  };
  const submit = async () => {
    btn.disabled = true;
    btn.textContent = "Connexion à Garmin…";
    try {
      if (!waitingCode) {
        const res = await api("/api/garmin/login", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: panel.querySelector(".gemail").value, password: panel.querySelector(".gpass").value }),
        });
        panel.querySelector(".gpass").value = "";
        if (res.mfa) {
          waitingCode = true;
          panel.querySelector(".gemail").hidden = panel.querySelector(".gpass").hidden = true;
          panel.querySelector(".gcode").hidden = false;
          panel.querySelector(".gcode").focus();
          panelError(panel, "");
          panel.querySelector("p").textContent = "Garmin t'a envoyé un code de vérification : saisis-le ci-dessous.";
          btn.textContent = "Valider le code";
          return;
        }
      } else {
        await api("/api/garmin/mfa", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: panel.querySelector(".gcode").value }),
        });
      }
      await done();
    } catch (err) {
      panelError(panel, err.message);
      if (waitingCode && /délai|recommence/.test(err.message)) renderGarminPanel(panel);
    } finally {
      btn.disabled = false;
      if (btn.textContent.endsWith("…")) btn.textContent = waitingCode ? "Valider le code" : "Connecter Garmin";
    }
  };
  btn.onclick = submit;
  bindEnter(panel, submit);
}

function openSettings() {
  $("account").close();
  const f = $("settings-form");
  (f.querySelector(`input[name=source][value=${me.energy_source}]`) || f.querySelector("input[name=source]")).checked = true;
  $("set-balance").value = me.balance_goal;
  $("set-balance").disabled = !!plan; // fixé par l'objectif
  $("set-balance").closest(".when-energy").querySelector(".hint").textContent = plan
    ? `Calculé à partir de ton objectif (${plan.label.toLowerCase()}). Modifie l'objectif pour le changer.`
    : "Mangé − brûlé. Négatif pour perdre (−500 ≈ −0,5 kg/semaine), 0 pour stabiliser.";
  $("set-sex").value = me.sex || "";
  $("set-birth").value = me.birth_year || "";
  $("set-height").value = me.height_cm || "";
  $("set-weight").value = me.weight_kg || "";
  $("set-life").value = String(me.life_factor ?? 1.2);
  if (!$("set-life").value) $("set-life").value = "1.2";
  $("settings-error").hidden = true;
  renderSettingsVisibility();
  renderConnections();
  document.querySelectorAll(".conn-panel").forEach((p) => (p.hidden = true));
  $("settings").showModal();
}

async function saveSettings(close = true) {
  const num = (id) => ($(id).value === "" ? null : Number($(id).value));
  const body = {
    energy_source: sourceValue(),
    life_factor: Number($("set-life").value),
  };
  if (!plan) body.balance_goal = num("set-balance") ?? me.balance_goal;
  // n'envoie le profil que s'il est renseigné (les champs vides ne l'effacent pas)
  if ($("set-sex").value) body.sex = $("set-sex").value;
  for (const [id, key] of [["set-birth", "birth_year"], ["set-height", "height_cm"], ["set-weight", "weight_kg"]]) {
    if (num(id) != null) body[key] = num(id);
  }
  try {
    me = await api("/api/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (close) { $("settings").close(); loadDay(); }
    return true;
  } catch (err) {
    $("settings-error").textContent = err.message;
    $("settings-error").hidden = false;
    return false;
  }
}

$("open-settings").onclick = openSettings;
$("settings-close").onclick = () => $("settings").close();
$("settings-form").addEventListener("input", renderSettingsVisibility);
$("settings-form").onsubmit = (e) => { e.preventDefault(); saveSettings(); };

function handleOAuthReturn() {
  const status = new URLSearchParams(location.search).get("strava");
  if (!status) return;
  history.replaceState(null, "", "/");
  const msg = {
    ok: "Strava est connecté ✓",
    denied: "Connexion Strava annulée.",
    scope: "Il faut cocher l'accès aux activités pour que Kcal puisse lire tes calories.",
    expired: "La demande a expiré, réessaie depuis les réglages.",
    error: "Strava a refusé la connexion. Vérifie la configuration (voir le README).",
  }[status];
  if (msg) setTimeout(() => alert(msg), 300);
}

// ---------- Objectif (perte de poids, maintien, muscle) ----------
let plan = null; // plan calculé par le serveur à partir de l'objectif
const fmtKg = (n) => Number(n).toLocaleString("fr-FR", { maximumFractionDigits: 1 });
const fmtDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
const goalType = () => ($("goal-form").querySelector("input[name=goal-type]:checked") || {}).value;

async function refreshGoal() {
  const res = await api("/api/goal");
  plan = res.plan;
  delete res.plan;
  me = res;
}

function renderGoalCard() {
  $("goal-card").hidden = !plan;
  $("goal-empty").hidden = !!plan;
  if (!plan) return;
  $("goal-title").textContent = { lose: "📉 ", maintain: "⚖️ ", gain: "💪 " }[plan.type] + plan.label;
  $("goal-days").textContent = plan.days_left != null ? `J−${plan.days_left}` : "";
  const w = $("goal-weights");
  w.textContent = "";
  if (plan.current_weight && plan.target_weight) {
    w.append(`${fmtKg(plan.current_weight)} → ${fmtKg(plan.target_weight)} kg`);
    const s = document.createElement("small");
    s.textContent = plan.target_date ? ` · d'ici le ${fmtDate(plan.target_date)}` : "";
    w.append(s);
  } else {
    w.append(plan.current_weight ? `${fmtKg(plan.current_weight)} kg` : "Poids non renseigné");
  }
  $("goal-fill").parentElement.hidden = plan.progress == null;
  $("goal-fill").style.width = Math.round((plan.progress || 0) * 100) + "%";
  const rate = plan.weekly_change_kg ? `${plan.weekly_change_kg > 0 ? "+" : "−"}${fmtKg(Math.abs(plan.weekly_change_kg))} kg/sem · ` : "";
  $("goal-rate").textContent = `${rate}bilan ${signed(plan.balance_goal)} kcal/j · ${plan.protein_goal ?? "?"} g prot.`;
  $("goal-msg").hidden = !plan.message;
  $("goal-msg").textContent = plan.message || "";
  $("goal-msg").classList.toggle("warn-text", !!plan.capped || /dépassé/.test(plan.message || ""));
}

function openGoal() {
  if ($("account").open) $("account").close();
  const f = $("goal-form");
  const type = plan?.type || "lose";
  f.querySelector(`input[name=goal-type][value=${type}]`).checked = true;
  $("goal-current").value = plan?.current_weight ?? me.weight_kg ?? "";
  $("goal-target").value = plan?.target_weight ?? "";
  $("goal-date").value = plan?.target_date ?? "";
  $("goal-date").min = shiftDay(todayISO(), 1);
  $("goal-clear").hidden = !plan;
  $("goal-error").hidden = true;
  renderGoalForm();
  $("goal-dialog").showModal();
}

function goalBody() {
  const num = (id) => ($(id).value === "" ? null : Number($(id).value));
  const body = { type: goalType(), current_weight: num("goal-current") };
  if (body.type !== "maintain") {
    body.target_weight = num("goal-target");
    body.target_date = $("goal-date").value || null;
  }
  return body;
}

let previewTimer = null;
function renderGoalForm() {
  const maintain = goalType() === "maintain";
  document.querySelectorAll("#goal-form .when-target").forEach((el) => (el.hidden = maintain));
  clearTimeout(previewTimer);
  previewTimer = setTimeout(previewGoal, 250);
}

async function previewGoal() {
  const box = $("goal-preview");
  const body = goalBody();
  if (!body.current_weight) { box.textContent = "Indique ton poids actuel pour calculer le plan."; return; }
  try {
    const p = await api("/api/goal/preview", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    $("goal-error").hidden = true;
    const rate = p.weekly_change_kg ? ` (${p.weekly_change_kg > 0 ? "+" : "−"}${fmtKg(Math.abs(p.weekly_change_kg))} kg/semaine)` : "";
    box.innerHTML = `Bilan visé : <b></b> par jour<span class="r"></span><br>Protéines : <b></b> par jour (${fmtKg(p.protein_per_kg)} g/kg)`;
    const [bal, prot] = box.querySelectorAll("b");
    bal.textContent = `${signed(p.balance_goal)} kcal`;
    prot.textContent = `${p.protein_goal} g`;
    box.querySelector(".r").textContent = rate;
    if (body.type !== "maintain" && !(body.target_weight && body.target_date)) {
      box.append(Object.assign(document.createElement("span"), {
        className: "hint", textContent: " Sans poids visé ni horizon, on applique un rythme standard.",
      }));
    }
    if (p.message) {
      box.append(Object.assign(document.createElement("span"), { className: p.capped ? "warn-text" : "hint", textContent: p.message }));
    }
  } catch (err) {
    box.textContent = "";
    $("goal-error").textContent = err.message;
    $("goal-error").hidden = false;
  }
}

$("goal-form").addEventListener("input", renderGoalForm);
document.querySelectorAll("#goal-form .chip").forEach((chip) => (chip.onclick = () => {
  const d = new Date();
  d.setMonth(d.getMonth() + Number(chip.dataset.months));
  $("goal-date").value = d.toISOString().slice(0, 10);
  renderGoalForm();
}));
$("goal-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/api/goal", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(goalBody()) });
    await refreshGoal();
    $("goal-dialog").close();
    loadDay();
  } catch (err) {
    $("goal-error").textContent = err.message;
    $("goal-error").hidden = false;
  }
};
$("goal-clear").onclick = async () => {
  if (!confirm("Retirer ton objectif ? Les objectifs actuels de kcal et de protéines restent en place.")) return;
  await api("/api/goal", { method: "DELETE" });
  await refreshGoal();
  $("goal-dialog").close();
  loadDay();
};
$("goal-close").onclick = () => $("goal-dialog").close();
$("open-goal").onclick = openGoal;
$("goal-empty").onclick = openGoal;
$("weigh-btn").onclick = () => {
  ask({
    title: "⚖️ Pesée du jour",
    submit: "Enregistrer",
    fields: [{ key: "kg", label: "Ton poids aujourd'hui", type: "number", step: 0.1,
      value: plan?.current_weight ?? me.weight_kg ?? "", unit: "kg", min: 20, max: 400 }],
    onSubmit: async ({ kg }) => {
      await api("/api/weights", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kg }) });
      await afterWeightChange();
    },
  });
};

async function afterWeightChange() {
  await refreshGoal();
  loadDay();
  if ($("weights-dialog").open) renderWeights();
}

// ---------- Évolution du poids ----------
let weightRange = "90";
let weightsCache = [];
const SVG_NS = "http://www.w3.org/2000/svg";
const DAY_MS = 86400000;
const toTime = (iso) => new Date(iso + "T12:00:00").getTime();
const shortDate = (t) => new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.append(el);
  return el;
}

// Trajectoire prévue par l'objectif : du poids de départ au poids visé, au rythme du plan
function goalLine() {
  if (!plan || !plan.start_weight || !plan.target_weight || !plan.start_date) return null;
  const end = plan.eta_date || plan.target_date;
  if (!end) return null;
  return { t0: toTime(plan.start_date), w0: plan.start_weight, t1: toTime(end), w1: plan.target_weight };
}
const goalAt = (g, t) => g.w0 + (g.w1 - g.w0) * Math.min(1, Math.max(0, (t - g.t0) / (g.t1 - g.t0)));

async function openWeights() {
  if ($("account").open) $("account").close();
  $("weights-dialog").showModal();
  await renderWeights();
}

async function renderWeights() {
  weightsCache = await api("/api/weights?days=3650");
  document.querySelectorAll(".range-chips .chip").forEach((c) => c.classList.toggle("active", c.dataset.range === weightRange));
  renderWeightStats();
  drawWeightChart();
  renderWeightList();
}

function renderWeightStats() {
  const box = $("weight-stats");
  box.innerHTML = "";
  if (!weightsCache.length) return;
  const first = plan?.start_weight ?? weightsCache[0].kg;
  const last = weightsCache[weightsCache.length - 1].kg;
  const delta = last - first;
  const cells = [["Départ", `${fmtKg(first)} kg`], ["Actuel", `${fmtKg(last)} kg`],
    ["Variation", `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${fmtKg(Math.abs(delta))} kg`]];
  for (const [label, value] of cells) {
    const d = document.createElement("div");
    d.innerHTML = "<small></small><b></b>";
    d.querySelector("small").textContent = label;
    d.querySelector("b").textContent = value;
    box.append(d);
  }
  const g = goalLine();
  if (g) {
    const expected = goalAt(g, toTime(weightsCache[weightsCache.length - 1].day));
    const ahead = plan.type === "gain" ? last - expected : expected - last; // > 0 : en avance
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = Math.abs(ahead) < 0.15 ? "Pile dans le rythme de ton objectif."
      : ahead > 0 ? `En avance de ${fmtKg(Math.abs(ahead))} kg sur le rythme de ton objectif 👍`
      : `En retard de ${fmtKg(Math.abs(ahead))} kg sur le rythme de ton objectif.`;
    box.append(note);
  }
}

function niceStep(span) {
  for (const s of [0.5, 1, 2, 5, 10, 20]) if (span / s <= 5) return s;
  return 50;
}

function drawWeightChart() {
  const svg = $("weight-chart");
  svg.innerHTML = "";
  $("chart-tip").hidden = true;
  const W = svg.clientWidth || 340, H = 220;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const pad = { l: 34, r: 14, t: 14, b: 24 };
  const g = goalLine();
  const today = toTime(todayISO());

  // Période affichée ; « Tout » va jusqu'à l'échéance de l'objectif
  let t0 = weightRange === "all"
    ? Math.min(...weightsCache.map((w) => toTime(w.day)), g ? g.t0 : today)
    : today - Number(weightRange) * DAY_MS;
  let t1 = weightRange === "all" && g ? Math.max(today, g.t1) : today;
  if (t1 - t0 < 7 * DAY_MS) t0 = t1 - 7 * DAY_MS;
  const pts = weightsCache.map((w) => ({ t: toTime(w.day), kg: w.kg, day: w.day })).filter((p) => p.t >= t0 && p.t <= t1);

  if (!pts.length && !g) {
    svgEl("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "empty" }, svg).textContent =
      weightsCache.length ? "Aucune pesée sur cette période" : "Pas encore de pesée : ajoute la première ci-dessous.";
    $("chart-key").innerHTML = "";
    return;
  }

  // Échelle verticale : pesées + trajectoire de l'objectif sur la période
  const ys = pts.map((p) => p.kg);
  if (g) ys.push(goalAt(g, Math.max(t0, g.t0)), goalAt(g, Math.min(t1, g.t1)));
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi - lo < 2) { const m = (hi + lo) / 2; lo = m - 1; hi = m + 1; }
  const step = niceStep(hi - lo);
  lo = Math.floor((lo - step * 0.3) / step) * step;
  hi = Math.ceil((hi + step * 0.3) / step) * step;
  const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (kg) => pad.t + ((hi - kg) / (hi - lo)) * (H - pad.t - pad.b);

  // Grille et axes, discrets
  for (let v = lo; v <= hi + 1e-9; v += step) {
    svgEl("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: "grid" }, svg);
    svgEl("text", { x: pad.l - 6, y: y(v) + 4, "text-anchor": "end" }, svg).textContent = fmtKg(v);
  }
  const nTicks = W < 360 ? 3 : 4;
  for (let i = 0; i < nTicks; i++) {
    const t = t0 + (i / (nTicks - 1)) * (t1 - t0);
    svgEl("text", { x: x(t), y: H - 6, "text-anchor": i === 0 ? "start" : i === nTicks - 1 ? "end" : "middle" }, svg)
      .textContent = shortDate(t);
  }

  // Trajectoire de l'objectif (pointillés) + point d'arrivée
  if (g) {
    const a = Math.max(t0, g.t0), b = Math.min(t1, g.t1);
    if (b > a) {
      svgEl("line", { x1: x(a), y1: y(goalAt(g, a)), x2: x(b), y2: y(goalAt(g, b)), class: "ref" }, svg);
    }
    if (g.t1 <= t1 && g.t1 >= t0) {
      svgEl("circle", { cx: x(g.t1), cy: y(g.w1), r: 4, class: "ref-dot" }, svg);
      svgEl("text", { x: x(g.t1) - 6, y: y(g.w1) - 9, "text-anchor": "end" }, svg).textContent = `${fmtKg(g.w1)} kg`;
    }
  }

  // Courbe des pesées
  if (pts.length > 1) {
    svgEl("polyline", { points: pts.map((p) => `${x(p.t)},${y(p.kg)}`).join(" "), class: "line" }, svg);
  }
  for (const p of pts) svgEl("circle", { cx: x(p.t), cy: y(p.kg), r: 4, class: "dot" }, svg);
  if (pts.length) { // étiquette directe sur la dernière valeur seulement, du côté opposé à l'objectif
    const p = pts[pts.length - 1];
    const below = g && p.t >= g.t0 && goalAt(g, p.t) > p.kg && y(p.kg) + 20 < H - pad.b;
    svgEl("text", { x: x(p.t) - (x(p.t) > W - 50 ? 6 : 0), y: below ? y(p.kg) + 18 : y(p.kg) - 10,
      "text-anchor": x(p.t) > W - 50 ? "end" : "middle" }, svg).textContent = `${fmtKg(p.kg)} kg`;
  }

  // Légende (deux tracés : la courbe et l'objectif)
  $("chart-key").innerHTML = g ? `<span>Poids</span><span class="ref">Objectif (${plan.label.toLowerCase()})</span>` : "";

  // Survol / toucher : repère vertical + info-bulle sur la pesée la plus proche
  const cross = svgEl("line", { y1: pad.t, y2: H - pad.b, class: "cross", visibility: "hidden" }, svg);
  const hit = svgEl("rect", { x: pad.l, y: 0, width: W - pad.l - pad.r, height: H, class: "hit" }, svg);
  const tip = $("chart-tip");
  const show = (e) => {
    if (!pts.length) return;
    const rect = svg.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    const p = pts.reduce((best, q) => (Math.abs(x(q.t) - mx) < Math.abs(x(best.t) - mx) ? q : best));
    cross.setAttribute("x1", x(p.t)); cross.setAttribute("x2", x(p.t));
    cross.setAttribute("visibility", "visible");
    tip.innerHTML = "<small></small><b></b>";
    tip.querySelector("small").textContent = new Date(p.t).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "long" });
    tip.querySelector("b").textContent = `${fmtKg(p.kg)} kg`;
    if (g && p.t >= g.t0) {
      const s = document.createElement("small");
      s.textContent = `objectif ce jour-là : ${fmtKg(goalAt(g, p.t))} kg`;
      tip.append(s);
    }
    tip.hidden = false;
    const px = (x(p.t) / W) * rect.width;
    tip.style.left = Math.min(Math.max(px - tip.offsetWidth / 2, 4), rect.width - tip.offsetWidth - 4) + "px";
  };
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerdown", show);
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; });
}

// Tableau des pesées (vue accessible du graphique), la plus récente en premier
function renderWeightList() {
  const box = $("weight-list");
  box.innerHTML = "";
  if (!weightsCache.length) {
    box.innerHTML = `<p class="hint">Aucune pesée pour l'instant.</p>`;
    return;
  }
  const rows = weightsCache.slice().reverse();
  rows.forEach((w, i) => {
    const prev = rows[i + 1];
    const row = document.createElement("div");
    row.className = "weight-row";
    row.innerHTML = `<span></span><span class="delta"></span><b></b><button type="button" aria-label="Supprimer cette pesée">×</button>`;
    row.children[0].textContent = new Date(toTime(w.day)).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    if (prev) {
      const d = w.kg - prev.kg;
      row.children[1].textContent = d ? `${d > 0 ? "+" : "−"}${fmtKg(Math.abs(d))}` : "=";
    }
    row.children[2].textContent = `${fmtKg(w.kg)} kg`;
    row.querySelector("button").onclick = async () => {
      if (!confirm(`Supprimer la pesée du ${row.children[0].textContent} (${fmtKg(w.kg)} kg) ?`)) return;
      await api(`/api/weights/${w.day}`, { method: "DELETE" });
      await afterWeightChange();
    };
    box.append(row);
  });
}

document.querySelectorAll(".range-chips .chip").forEach((chip) => (chip.onclick = () => {
  weightRange = chip.dataset.range;
  document.querySelectorAll(".range-chips .chip").forEach((c) => c.classList.toggle("active", c === chip));
  drawWeightChart();
}));
$("weights-close").onclick = () => $("weights-dialog").close();
$("weights-add").onclick = () => $("weigh-btn").onclick();
$("chart-btn").onclick = openWeights;
$("open-weights").onclick = openWeights;

async function startApp() {
  handleOAuthReturn();
  $("account-btn").textContent = (me.name || "?").trim().charAt(0).toUpperCase();
  day = todayISO();
  try { await refreshGoal(); } catch {} // sans objectif ou hors ligne : on continue
  loadDay().catch(showError);
}
function showError(err) {
  if (!$("auth").hidden) return; // l'écran de connexion est déjà affiché
  $("empty").hidden = false;
  $("empty").textContent = "Serveur injoignable : " + err.message;
}

api("/api/me")
  .then((user) => { me = user; startApp(); })
  .catch(showError);
