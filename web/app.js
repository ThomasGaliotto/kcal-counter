const $ = (id) => document.getElementById(id);
let me = null; // signed-in user: { id, email, name, kcal_goal, water_goal }
let day = todayISO();
let draft = null; // meal being reviewed

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

class OfflineError extends Error {}
async function api(path, opts) {
  let r;
  try {
    r = await fetch(path, opts);
  } catch {
    throw new OfflineError("Pas de connexion au serveur");
  }
  if (r.status === 401 && !path.startsWith("/api/auth/")) {
    showAuth(); // session expired or never signed in
    throw new Error("Connecte-toi pour continuer");
  }
  if (!r.ok) {
    let msg = `Erreur ${r.status}`;
    try {
      const detail = (await r.json()).detail;
      msg = typeof detail === "string" ? detail : detail ? "Une valeur est invalide ou hors limites." : msg;
    } catch {}
    throw Object.assign(new Error(msg), { status: r.status });
  }
  return r.json();
}

// ---------- Daily log ----------
async function loadDay() {
  if (tab === "day") $("day-label").textContent = dayLabel(day);
  $("next").disabled = day >= todayISO();
  const { water_goal } = me;
  const shownDay = day;
  const [data, energy] = await Promise.all([
    api(`/api/meals?day=${day}`),
    me.energy_source === "none" ? null : api(`/api/energy?day=${day}`).catch((err) => ({ error: err.message, activities: [] })),
  ]);
  if (shownDay !== day) return; // the user switched to another day meanwhile
  // meals saved offline, not sent yet: shown and counted, marked as pending
  for (const q of (await queueAll()).filter((q) => q.kind === "meal" && q.body.eaten_at.slice(0, 10) === shownDay)) {
    const m = { ...q.body, pending: q.id, kcal: q.body.items.reduce((s, it) => s + kcalOf(it), 0) };
    data.meals.push(m);
    data.total_kcal += Math.round(m.kcal);
    data.total_water_ml += m.water_ml || 0;
    for (const k of ["protein", "carbs", "fat"]) data[`total_${k}_g`] = (data[`total_${k}_g`] || 0) + macro(m.items, `${k}_100g`);
  }
  data.meals.sort((a, b) => a.eaten_at.localeCompare(b.eaten_at));
  if (shownDay !== day) return;

  const eaten = data.total_kcal;
  const model = energyModel(energy);
  const energyMode = me.energy_source !== "none";

  // ----- "Eaten" card: fixed goal, or burned projected at midnight + target balance
  const kcal_goal = model ? Math.max(0, Math.round(model.projected + me.balance_goal)) : me.kcal_goal;
  $("goal").textContent = fmt(kcal_goal);
  $("total").textContent = fmt(eaten);
  const fill = $("bar-fill");
  fill.style.width = Math.min(100, (eaten / kcal_goal) * 100) + "%";
  fill.classList.toggle("over", eaten > kcal_goal);

  // ----- "Burned" card and projection
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
  renderStreak();

  // ----- Protein
  const pGoal = proteinGoal();
  $("protein-total").textContent = fmt(data.total_protein_g ?? 0);
  $("protein-goal").textContent = fmt(pGoal);
  $("protein-fill").style.width = Math.min(100, ((data.total_protein_g ?? 0) / pGoal) * 100) + "%";

  // ----- Carbs and fat
  const mg = macroGoals(kcal_goal, pGoal);
  for (const k of ["carbs", "fat"]) {
    const total = data[`total_${k}_g`] ?? 0;
    $(`${k}-total`).textContent = fmt(total);
    $(`${k}-goal`).textContent = fmt(mg[k]);
    $(`${k}-fill`).style.width = Math.min(100, mg[k] ? (total / mg[k]) * 100 : 0) + "%";
  }

  // ----- Water
  // Sport: +500 ml per hour of recorded activity (Strava/Garmin), rounded to 50 ml
  const sportMin = (energy?.activities || []).reduce((s, a) => s + (a.minutes || 0), 0);
  const sportWater = Math.round((sportMin / 60) * 500 / 50) * 50;
  // Alcohol: ~10 ml of extra urine per gram of alcohol, to drink back
  const alcoholG = data.total_alcohol_g || 0;
  const alcoholWater = Math.round(alcoholG * 10 / 10) * 10;
  const waterTarget = water_goal + sportWater + alcoholWater;
  $("water-goal").textContent = fmt(waterTarget);
  const extras = [sportWater && `+${fmt(sportWater)} ml sport`, alcoholWater && `+${fmt(alcoholWater)} ml alcool`].filter(Boolean);
  $("water-sport").hidden = !extras.length;
  $("water-sport").textContent = `dont ${extras.join(" · ")}`;
  $("water-total").textContent = fmt(data.total_water_ml);
  $("water-fill").style.width = Math.min(100, (data.total_water_ml / waterTarget) * 100) + "%";

  facts = { kcal_goal, model, sportMin, sportWater, alcoholG, alcoholWater, pGoal, mg };

  // ----- Columns: meals on the left, activities on the right (in expenditure mode)
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
    // clickable card: opens the activity on Strava / Garmin Connect
    const el = document.createElement(a.url ? "a" : "div");
    el.className = "meal activity";
    if (a.url) {
      el.href = a.url;
      el.target = "_blank";
      el.rel = "noopener";
      el.setAttribute("aria-label", `${a.name}, ouvrir sur ${energy.source === "garmin" ? "Garmin Connect" : "Strava"}`);
    }
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
    if (a.url) bits.push("Voir ↗");
    el.querySelector(".meal-items").textContent = bits.join(" · ");
    actList.appendChild(el);
  }

  const list = $("meals");
  list.innerHTML = "";
  for (const m of data.meals.slice().reverse()) {
    const el = document.createElement("div");
    el.className = m.pending ? "meal pending" : "meal";
    const time = (m.pending ? "⏳ en attente d'envoi · " : "") +
      new Date(m.eaten_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    el.innerHTML = `
      <div class="meal-main">
        <div class="meal-head"><span></span><span>${Math.round(m.kcal)} kcal</span></div>
        <div class="meal-time">${time}</div>
        <div class="meal-items"></div>
        <div class="meal-macros">P ${macro(m.items, "protein_100g")} g · G ${macro(m.items, "carbs_100g")} g · L ${macro(m.items, "fat_100g")} g</div>
      </div>
      <div class="meal-actions">
        <button class="edit" aria-label="Modifier">✏️</button>
        <button class="remove" aria-label="Supprimer">🗑</button>
      </div>`;
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
      // "water only" entry: no kcal or macros to show
      el.querySelector(".meal-head span:last-child").textContent = "";
      el.querySelector(".meal-macros").remove();
    }
    el.querySelector(".edit").onclick = () => editMeal(m);
    if (m.pending) el.querySelector(".edit").remove(); // edited once sent
    el.querySelector(".remove").onclick = async () => {
      if (!(await confirmBox(`Supprimer « ${m.title} » ?`, { title: "Supprimer le repas" }))) return;
      if (m.pending) await queueDel(m.pending);
      else await api(`/api/meals/${m.id}`, { method: "DELETE" });
      loadDay();
      renderPending();
    };
    list.appendChild(el);
  }
}

const fmt = (n) => Number(n).toLocaleString("fr-FR");
const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmt(Math.abs(Math.round(n)));

// Elapsed share of the displayed day: 1 for a past day, current time / 24 h for today
function dayFraction(iso) {
  const today = todayISO();
  if (iso < today) return 1;
  if (iso > today) return 0;
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return (now - midnight) / 86400000;
}

/* Today's expenditure, scaled to the present moment and projected to midnight.
   - Strava: `resting` = whole-day baseline (BMR × daily activity), `active` = activities.
     Burned now = baseline × elapsed fraction + activities; projected at midnight = full baseline + activities done.
   - Garmin: `burned` = total measured so far, `resting` = the day's basal metabolic rate.
     Projected at midnight = current total + share of BMR left until midnight. */
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
  const live = model.f < 1; // today: projection; past day: final values
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

// ---------- "i" buttons: how each number is computed ----------
let facts = {}; // values from the last loadDay, used by the explanations
const INFO = {
  eaten() {
    const { kcal_goal, model } = facts;
    if (model) {
      return ["Objectif = dépense prévue à minuit + bilan visé",
        `= ${fmt(Math.round(model.projected))} ${signed(me.balance_goal)} = ${fmt(kcal_goal)} kcal.`,
        "",
        "Il bouge pendant la journée : chaque activité enregistrée augmente la dépense prévue, donc ce que tu peux manger.",
        me.balance_goal < 0 ? "Bilan visé négatif : tu manges moins que tu ne dépenses, c'est ce qui fait perdre du poids." : ""].join("\n");
    }
    if (plan) {
      return [`Calculé à partir de ton objectif « ${plan.label} » :`,
        `dépense hors sport + bilan visé (${signed(plan.balance_goal)} kcal) = ${fmt(kcal_goal)} kcal.`,
        "", metabolismText()].join("\n");
    }
    return [`Ton objectif est fixe : ${fmt(kcal_goal)} kcal par jour. Touche « sur … visés » pour le changer.`,
      "", "Pour un objectif qui suit ta dépense réelle, branche Strava ou Garmin (menu du compte → Dépense énergétique)."].join("\n");
  },
  burned() {
    const m = facts.model;
    if (!m) return "La dépense du jour n'est pas disponible pour l'instant (Strava ou Garmin injoignable).";
    if (me.energy_source === "garmin") {
      return ["Total mesuré par ta montre Garmin jusqu'à maintenant (repos + activité).",
        "", `Métabolisme : la part « repos » prévue sur la journée, ${fmt(Math.round(m.resting))} kcal. La barre avance avec l'heure.`].join("\n");
    }
    return [`Métabolisme : ce que ton corps dépense au repos et dans la vie quotidienne, ${fmt(Math.round(m.resting))} kcal sur la journée.`,
      "La barre avance avec l'heure.",
      "", metabolismText(),
      "", "Activités : les calories de tes activités Strava du jour.",
      "", "Brûlé = métabolisme écoulé jusqu'à maintenant + activités."].join("\n");
  },
  projection() {
    return ["Brûlé prévu : ce que tu auras dépensé à minuit si tu ne fais plus de sport.",
      "Bilan : mangé − brûlé prévu. Négatif = tu manges moins que tu ne dépenses.",
      `Encore possible : ce que tu peux encore manger en tenant ton bilan visé (${signed(me.balance_goal)} kcal).`].join("\n");
  },
  protein() {
    const w = plan?.current_weight || me.weight_kg;
    const mode = me.protein_mode || "auto";
    const how = mode === "grams" ? `Objectif réglé à la main : ${fmt(facts.pGoal)} g par jour.`
      : mode === "per_kg" ? `${fmtNum(me.protein_value)} g par kg × ${fmtKg(w)} kg = ${fmt(facts.pGoal)} g, recalculé à chaque pesée.`
      : plan ? `Selon ton objectif « ${plan.label} » : ${fmtNum(plan.protein_auto_per_kg)} g par kg de poids = ${fmt(facts.pGoal)} g.`
      : w ? `Par défaut : 1,6 g par kg de poids = ${fmt(facts.pGoal)} g.` : "Par défaut 100 g (renseigne ton poids pour un calcul en g/kg).";
    return [how, "", "Le total additionne les protéines de chaque aliment (grammes × protéines pour 100 g).",
      "Touche la carte pour changer l'objectif."].join("\n");
  },
  water() {
    const { sportMin, sportWater, alcoholG, alcoholWater } = facts;
    const target = [`Objectif de base : ${fmt(me.water_goal)} ml (touche la carte pour le changer).`];
    if (sportWater) target.push(`+${fmt(sportWater)} ml pour ${sportMin} min de sport (500 ml par heure).`);
    if (alcoholWater) target.push(`+${fmt(alcoholWater)} ml pour ${alcoholG} g d'alcool : l'alcool fait uriner davantage (environ 10 ml par gramme), il faut compenser.`);
    return [...target, "",
      "Ce qui compte : l'eau et toutes les boissons sans alcool (café, thé, lait, jus, soda…).",
      "L'alcool ne compte pas, ni l'eau contenue dans les aliments (soupe, fruits) : elle est déjà prévue dans le repère des 2 L, dont environ 20 % vient de la nourriture.",
    ].join("\n");
  },
  goal() {
    return ["Bilan visé = (poids actuel − poids visé) × 7 700 kcal ÷ jours restants : 1 kg de masse corporelle ≈ 7 700 kcal.",
      "", "Pour rester raisonnable, le rythme est plafonné à 1 % du poids par semaine et à −1 000 kcal par jour (+500 en prise de muscle).",
      "", "Protéines : 2 g/kg en perte de poids (pour préserver le muscle), 1,8 g/kg en prise de muscle, 1,6 g/kg en maintien.",
      "", "Tout est recalculé à chaque pesée."].join("\n");
  },
};
// How the expenditure outside sport is computed, from /api/metabolism
function metabolismText() {
  const m = metabolismInfo;
  if (!m || !m.bmr) return "Renseigne ton profil (menu du compte → Dépense énergétique) pour calculer ton métabolisme.";
  const formula = m.formula === "katch"
    ? `Métabolisme de base : ${fmt(m.bmr)} kcal, d'après ta masse maigre (${fmtNum(m.body_fat_pct)} % de graisse ${m.body_fat_source === "measured" ? "mesuré" : "estimé d'après ta silhouette"}, formule de Katch-McArdle) : le muscle brûle plus que la graisse.`
    : `Métabolisme de base : ${fmt(m.bmr)} kcal, d'après ton sexe, ton âge, ta taille et ton poids (formule de Mifflin-St Jeor).`;
  const c = m.calibration;
  const calib = c.status === "ok" && c.enabled && c.factor !== 1
    ? ` × ${fmtNum(c.factor)} (calibrage d'après tes pesées : ton corps dépense ${Math.round(Math.abs(c.factor - 1) * 100)} % de ${c.factor > 1 ? "plus" : "moins"} que la formule)`
    : "";
  return [formula, `Dépense hors sport = ${fmt(m.bmr)} × ${fmtNum(m.life_factor)} (vie quotidienne)${calib} = ${fmt(m.daily)} kcal.`].join("\n");
}
INFO.carbs = () => [me.carbs_goal ? `Objectif réglé à la main : ${fmt(me.carbs_goal)} g par jour.`
  : `Objectif auto : ce qui reste de ton objectif de calories (${fmt(facts.kcal_goal)} kcal) une fois les protéines (${fmt(facts.pGoal)} g × 4 kcal) et les lipides (${fmt(facts.mg.fat)} g × 9 kcal) comptés, divisé par 4 kcal par gramme = ${fmt(facts.mg.carbs)} g.`,
  "", "Il suit l'objectif de calories du jour. Touche la carte pour fixer un objectif en grammes."].join("\n");
INFO.fat = () => [me.fat_goal ? `Objectif réglé à la main : ${fmt(me.fat_goal)} g par jour.`
  : `Objectif auto : ${Math.round(FAT_SHARE * 100)} % de ton objectif de calories (${fmt(facts.kcal_goal)} kcal), à 9 kcal par gramme = ${fmt(facts.mg.fat)} g.`,
  "", "Les repères courants vont de 20 à 35 % des calories. Touche la carte pour fixer un objectif en grammes."].join("\n");
const INFO_TITLES = { eaten: "Objectif de calories", burned: "Dépense du jour", projection: "Projection", protein: "Protéines",
  carbs: "Glucides", fat: "Lipides",
  water: "Eau", goal: "Ton objectif" };
document.querySelectorAll(".info").forEach((b) => {
  b.onclick = async (e) => {
    e.stopPropagation();
    if (["eaten", "burned"].includes(b.dataset.info)) metabolismInfo = await api("/api/metabolism").catch(() => metabolismInfo);
    notice(INFO[b.dataset.info](), INFO_TITLES[b.dataset.info]);
  };
});

// ---------- Photo -> analysis ----------
document.querySelectorAll(".photo-input").forEach((input) => input.addEventListener("change", onPhoto));

async function onPhoto(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const form = new FormData();
  form.append("photo", file);
  analyze(() => api("/api/analyze", { method: "POST", body: form }), { image: URL.createObjectURL(file), queue: { kind: "photo", blob: file } });
}

// Meal described in text: "an apple and a glass of water"
$("text-btn").onclick = () => ask({
  title: "✍️ Ajouter en texte",
  submit: "Analyser",
  fields: [{ key: "text", type: "textarea", label: "Qu'as-tu mangé ou bu ?", voice: true,
             placeholder: "ex : une pomme, un yaourt et un verre d'eau" }],
  onSubmit: ({ text }) => {
    analyze(() => api("/api/analyze-text", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
    }), { text, queue: { kind: "text", text } });
  },
});

// ---------- Dictation (Web Speech API; on iPhone the keyboard's 🎤 key also works) ----------
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

function micButton(input) {
  if (!SpeechRec) {
    return Object.assign(document.createElement("p"), {
      className: "hint", textContent: "Astuce : la touche 🎤 du clavier permet de dicter.",
    });
  }
  const btn = Object.assign(document.createElement("button"), { type: "button", className: "mic-btn", textContent: "🎤 Dicter" });
  btn.onclick = () => (recognition ? recognition.stop() : dictate(input, btn));
  return btn;
}

function dictate(input, btn) {
  const rec = new SpeechRec();
  rec.lang = "fr-FR";
  rec.interimResults = true;
  const before = input.value.trim() ? input.value.trim() + " " : "";
  rec.onresult = (e) => {
    input.value = before + Array.from(e.results, (r) => r[0].transcript).join("");
    input.dispatchEvent(new Event("input"));
  };
  rec.onerror = (e) => showAskError(
    e.error === "no-speech" ? "Je n'ai rien entendu, réessaie."
    : e.error === "not-allowed" || e.error === "service-not-allowed" ? "Micro refusé : autorise-le, ou utilise la touche 🎤 du clavier."
    : "Dictée indisponible ici : utilise la touche 🎤 du clavier.");
  rec.onend = () => {
    recognition = null;
    btn.classList.remove("listening");
    btn.textContent = "🎤 Dicter";
  };
  recognition = rec;
  btn.classList.add("listening");
  btn.textContent = "⏹ Arrêter";
  $("ask-error").hidden = true;
  rec.start();
}
function stopDictation() { recognition?.abort(); }

// ---------- Barcode -> Open Food Facts ----------
let scanReader = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = Object.assign(document.createElement("script"), { src, onload: resolve });
    el.onerror = () => reject(new Error("lecteur de code-barres introuvable"));
    document.head.append(el);
  });
}

const scanStatus = (msg) => ($("scan-status").textContent = msg);

$("scan-btn").onclick = async () => {
  $("scan-code").value = "";
  scanStatus("Vise le code-barres du produit.");
  $("scan-dialog").showModal();
  if (!navigator.mediaDevices?.getUserMedia) {
    return scanStatus("Caméra indisponible ici (il faut passer par HTTPS) : tape les chiffres du code.");
  }
  try {
    if (!window.ZXing) await loadScript("vendor/zxing.min.js");
    if (!$("scan-dialog").open) return;
    const Z = window.ZXing;
    const hints = new Map([[Z.DecodeHintType.POSSIBLE_FORMATS,
      [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]]]);
    scanReader = new Z.BrowserMultiFormatReader(hints, 300);
    await scanReader.decodeFromConstraints({ video: { facingMode: "environment" } }, $("scan-video"), (result) => {
      if (result && scanReader) lookupBarcode(result.getText());
    });
  } catch (err) {
    stopScanner();
    scanStatus(err.name === "NotAllowedError" ? "Caméra refusée : autorise-la dans les réglages, ou tape les chiffres du code."
               : `Caméra indisponible (${err.message}) : tape les chiffres du code.`);
  }
};
function stopScanner() {
  scanReader?.reset();
  scanReader = null;
}
$("scan-close").onclick = () => $("scan-dialog").close();
$("scan-dialog").addEventListener("close", stopScanner);
$("scan-form").onsubmit = (e) => {
  e.preventDefault();
  const code = $("scan-code").value.replace(/\D/g, "");
  if (code.length < 8 || code.length > 14) return scanStatus("Un code-barres a 8 à 14 chiffres.");
  lookupBarcode(code);
};

function lookupBarcode(code) {
  navigator.vibrate?.(40);
  stopScanner();
  $("scan-dialog").close();
  analyze(async () => {
    try {
      const { item, quantity } = await api(`/api/barcode/${code}`);
      $("review-text").textContent = `📦 ${item.name}${quantity ? ` (${quantity})` : ""} — ajuste la quantité`;
      return { title: item.name, items: [item], water_ml: item.drink_ml || 0 };
    } catch (err) {
      throw new Error(`${err.message}. Ajoute-le avec « + Aliment » ou décris-le en texte.`);
    }
  }, { caption: `📦 Code-barres ${code}` });
}

// ---------- Streak ----------
const MILESTONES = [3, 7, 14, 30, 60, 100, 200, 365];
const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;

async function renderStreak() {
  const st = await api("/api/streak").catch(() => null);
  if (!st) return null;
  $("streak-badge").hidden = st.current < 2;
  $("streak-badge").textContent = `🔥 ${st.current} j`;
  $("streak-badge").title = `${plural(st.current, "jour")} de suite`;
  return st;
}

// After saving a meal: celebrate each milestone once
async function celebrateStreak() {
  const st = await renderStreak();
  if (!st || !st.today_logged || !MILESTONES.includes(st.current)) return;
  const key = `kcal-streak-${me.id}`;
  try {
    if (localStorage.getItem(key) === `${todayISO()}:${st.current}`) return;
    localStorage.setItem(key, `${todayISO()}:${st.current}`);
  } catch {}
  const record = st.current >= st.best ? " C'est ton record." : "";
  const next = st.next_milestone ? `\nProchain palier : ${st.next_milestone} jours.` : "";
  notice(`${plural(st.current, "jour")} de suite à tout noter, bravo !${record}${next}`, "🔥 Série en cours");
}

// ---------- Weekly summary ----------
let weekEnd = null;
let weekData = null;
const WEEKDAY = ["D", "L", "M", "M", "J", "V", "S"];
const longDay = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "short" });
const liters = (ml) => fmt(Math.round(ml / 100) / 10);

// ---------- Tabs: the day / the recap (weight, week, month) ----------
let tab = "day";
function setTab(next) {
  tab = next;
  for (const t of ["day", "recap"]) {
    $(`${t}-view`).hidden = t !== next;
    $(`tab-${t}`).classList.toggle("active", t === next);
    $(`tab-${t}`).setAttribute("aria-selected", t === next);
  }
  document.body.classList.toggle("on-recap", next === "recap");
  $("day-label").textContent = next === "recap" ? "Récap" : dayLabel(day);
  window.scrollTo({ top: 0 });
  if (next === "recap") renderRecap();
}
$("tab-day").onclick = () => setTab("day");
$("tab-recap").onclick = () => { if (tab !== "recap") setTab("recap"); };

function renderRecap() {
  weekEnd ||= todayISO();
  monthOf ||= todayISO().slice(0, 7);
  $("recap-weight").hidden = !me.show_weight;
  if (me.show_weight) renderWeights().catch(() => {});
  if ($("month-view").hidden) renderWeek(); else renderMonth();
}
function showView(view) {
  for (const v of ["week", "month"]) {
    $(`${v}-view`).hidden = v !== view;
    $(`tab-${v}`).classList.toggle("active", v === view);
    $(`tab-${v}`).setAttribute("aria-selected", v === view);
  }
  if (view === "month") renderMonth();
}
$("tab-week").onclick = () => showView("week");
$("tab-month").onclick = () => showView("month");

// ---------- Month calendar ----------
let monthOf = null; // "YYYY-MM"
let firstMonth = null;
function shiftMonth(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
$("month-prev").onclick = () => { monthOf = shiftMonth(monthOf, -1); renderMonth(); };
$("month-next").onclick = () => { monthOf = shiftMonth(monthOf, 1); renderMonth(); };

async function renderMonth() {
  const ym = monthOf;
  const [y, m] = ym.split("-").map(Number);
  $("month-label").textContent = new Date(y, m - 1, 15).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  $("month-next").disabled = ym >= todayISO().slice(0, 7);
  $("month-prev").disabled = firstMonth != null && ym <= firstMonth;
  $("month-summary").textContent = "Chargement…";
  let res;
  try {
    res = await api(`/api/month?month=${ym}`);
  } catch (err) {
    $("month-summary").textContent = err.message;
    return;
  }
  if (ym !== monthOf) return;
  firstMonth = res.first_month;
  $("month-prev").disabled = ym <= firstMonth;
  const grid = $("month-grid");
  grid.innerHTML = ["L", "M", "M", "J", "V", "S", "D"].map((d) => `<span class="wd">${d}</span>`).join("");
  const offset = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday first
  for (let i = 0; i < offset; i++) grid.append(document.createElement("span"));
  const today = todayISO();
  for (const d of res.days) {
    const b = document.createElement("button");
    b.type = "button";
    const n = Number(d.day.slice(8));
    b.textContent = n;
    const state = d.on_target === true ? "ok" : d.on_target === false ? "off" : d.logged ? "logged" : "";
    b.className = `mday ${state}${d.day === today ? " today" : ""}`;
    b.disabled = d.day > today;
    const what = !d.logged ? "rien de noté" : `${fmt(d.kcal)} kcal${d.goal ? ` sur ${fmt(d.goal)} visées` : ""}` +
      (state === "ok" ? ", dans l'objectif" : state === "off" ? ", hors objectif" : "");
    b.setAttribute("aria-label", `${longDay(d.day)} : ${what}`);
    b.title = what;
    b.onclick = () => { day = d.day; setTab("day"); loadDay(); };
    grid.append(b);
  }
  const verdict = { lose: "sous l'objectif", gain: "objectif atteint", maintain: "à ±10 % près" }[res.direction];
  $("month-summary").innerHTML = res.logged_days
    ? `<b>${plural(res.logged_days, "jour")} noté${res.logged_days > 1 ? "s" : ""}</b>` +
      (res.judged_days ? ` · <b>${res.on_target_days} / ${res.judged_days}</b> dans l'objectif (${verdict})` : "")
    : "Rien de noté ce mois-ci.";
}
$("week-prev").onclick = () => { weekEnd = shiftDay(weekEnd, -7); renderWeek(); };
$("week-next").onclick = () => { if (weekEnd < todayISO()) { weekEnd = shiftDay(weekEnd, 7); renderWeek(); } };

async function renderWeek() {
  const end = weekEnd;
  $("week-range").textContent = `${fmtShort(shiftDay(end, -6) + "T12:00:00")} – ${fmtShort(end + "T12:00:00")}`;
  $("week-next").disabled = end >= todayISO();
  $("week-detail").textContent = "Chargement…";
  let w;
  try {
    w = await api(`/api/week?end=${end}`);
  } catch (err) {
    $("week-detail").textContent = err.message;
    return;
  }
  if (end !== weekEnd) return; // moved to another week meanwhile
  weekData = w;

  const st = w.streak;
  $("week-streak").innerHTML = st.current
    ? `🔥 <b>${plural(st.current, "jour")} de suite</b><small>Record : ${plural(st.best, "jour")}` +
      `${st.next_milestone ? ` · prochain palier à ${st.next_milestone}` : ""}` +
      `${st.today_logged ? "" : " · note un repas aujourd'hui pour la prolonger"}</small>`
    : `Pas de série en cours<small>Note tes repas chaque jour pour en lancer une` +
      `${st.best ? ` (record : ${plural(st.best, "jour")})` : ""}.</small>`;

  drawWeekChart(w);
  const last = [...w.days].reverse().find((d) => d.logged);
  selectWeekDay(last ? w.days.indexOf(last) : 6);

  const tiles = [];
  const tile = (label, value, sub = "") => tiles.push(`<div><small>${label}</small><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`);
  tile("Moyenne", w.avg_kcal != null ? `${fmt(w.avg_kcal)} kcal` : "—", w.avg_goal ? `/ jour · visé ~${fmt(w.avg_goal)}` : "par jour noté");
  tile("Jours notés", `${w.logged_days} / 7`);
  tile("Dans l'objectif", w.judged_days ? `${w.on_target_days} / ${w.judged_days}` : "—",
       { lose: "sous l'objectif", gain: "objectif atteint", maintain: "à ±10 % près" }[w.direction]);
  if (w.avg_kcal != null && w.prev_avg_kcal != null) tile("vs semaine d'avant", `${signed(w.avg_kcal - w.prev_avg_kcal)} kcal`, "par jour");
  if (me.show_protein && w.avg_protein_g != null) tile("Protéines", `${fmt(w.avg_protein_g)} g`, `/ jour · visé ${fmt(proteinGoal())}`);
  if (me.show_macros && w.avg_carbs_g != null) tile("Glucides", `${fmt(w.avg_carbs_g)} g`, "par jour");
  if (me.show_macros && w.avg_fat_g != null) tile("Lipides", `${fmt(w.avg_fat_g)} g`, "par jour");
  if (w.avg_water_ml != null) tile("Eau", `${liters(w.avg_water_ml)} L`, "par jour");
  if (me.show_weight && w.weight) {
    const c = w.weight.change;
    tile("Poids", `${c > 0 ? "+" : c < 0 ? "−" : ""}${fmtKg(Math.abs(c))} kg`, `${fmtKg(w.weight.from)} → ${fmtKg(w.weight.to)}`);
  }
  $("week-stats").innerHTML = tiles.join("");
}

function drawWeekChart(w) {
  const svg = $("week-chart");
  const W = 320, H = 150, top = 14, base = 124, slot = W / 7, bw = 20, r = 4;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = "";
  const max = Math.max(1, ...w.days.map((d) => Math.max(d.kcal, d.goal || 0))) * 1.08;
  const y = (v) => base - (v / max) * (base - top);
  const today = todayISO();
  w.days.forEach((d, i) => {
    const cx = slot * i + slot / 2, x0 = cx - bw / 2, x1 = cx + bw / 2;
    svgEl("rect", { class: "sel-bg", x: cx - slot / 2 + 2, y: 2, width: slot - 4, height: H - 4, rx: 10, opacity: 0, "data-i": i }, svg);
    if (d.logged) {
      // rounded top, square base on the baseline
      const yt = Math.min(y(d.kcal), base - r);
      svgEl("path", {
        class: `wbar${d.on_target === false ? " over" : ""}${d.day === today ? " today" : ""}`,
        d: `M${x0},${base} V${yt + r} Q${x0},${yt} ${x0 + r},${yt} H${x1 - r} Q${x1},${yt} ${x1},${yt + r} V${base} Z`,
      }, svg);
    } else {
      svgEl("rect", { class: "wnone", x: x0, y: base - 2, width: bw, height: 2, rx: 1 }, svg);
    }
    if (d.goal) svgEl("line", { class: "wgoal", x1: x0 - 5, x2: x1 + 5, y1: y(d.goal), y2: y(d.goal) }, svg);
    const label = svgEl("text", { class: "wday", x: cx, y: base + 18, "data-i": i }, svg);
    label.textContent = WEEKDAY[new Date(d.day + "T12:00:00").getDay()];
    const hit = svgEl("rect", { class: "bar-hit", x: cx - slot / 2, y: 0, width: slot, height: H }, svg);
    hit.onclick = () => selectWeekDay(i);
    hit.onmouseenter = () => selectWeekDay(i);
  });
}

function selectWeekDay(i) {
  const d = weekData?.days[i];
  if (!d) return;
  $("week-chart").querySelectorAll(".sel-bg").forEach((el) => el.setAttribute("opacity", Number(el.dataset.i) === i ? 1 : 0));
  $("week-chart").querySelectorAll(".wday").forEach((el) => el.classList.toggle("sel", Number(el.dataset.i) === i));
  const name = longDay(d.day);
  if (!d.logged) {
    $("week-detail").innerHTML = `<b>${name}</b><br>Rien de noté.`;
    return;
  }
  const verdict = d.on_target === true ? " · dans l'objectif ✓"
    : d.on_target === false ? " · hors objectif" : d.day === todayISO() ? " · journée en cours" : "";
  const bits = [`<b>${fmt(d.kcal)} kcal</b>${d.goal ? ` / ${fmt(d.goal)} visés` : ""}${verdict}`];
  if (me.show_protein) bits.push(`${fmt(d.protein_g)} g de protéines`);
  if (me.show_macros) bits.push(`${fmt(d.carbs_g)} g de glucides · ${fmt(d.fat_g)} g de lipides`);
  if (d.water_ml) bits.push(`💧 ${liters(d.water_ml)} L`);
  $("week-detail").innerHTML = `<b>${name}</b><br>${bits.join(" · ")}`;
}

// Edit a saved meal: same screen as the review after analysis
function editMeal(m) {
  draft = { id: m.id, title: m.title, items: m.items.map((it) => ({ ...it })), water_ml: m.water_ml || 0 };
  $("review").hidden = false;
  document.body.classList.add("reviewing");
  $("preview").hidden = true;
  $("review-text").hidden = true;
  $("analyzing").hidden = true;
  $("error").hidden = true;
  $("fix-status").hidden = true;
  $("fix-text").value = "";
  renderDraft();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function analyze(request, { image, text, caption, queue, pending }) {
  draft = null;
  $("review").hidden = false;
  document.body.classList.add("reviewing");
  $("empty").hidden = true;
  $("preview").hidden = !image;
  if (image) $("preview").src = image;
  $("review-text").hidden = !(text || caption);
  $("review-text").textContent = caption || (text ? `« ${text} »` : "");
  $("analyzing").hidden = false;
  $("result").hidden = true;
  $("error").hidden = true;
  $("fix-status").hidden = true;
  $("fix-text").value = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
  try {
    const res = await request();
    draft = { title: res.title || "Repas", items: res.items || [], water_ml: res.water_ml || 0 };
    if (pending) Object.assign(draft, { queued: pending.id, eaten_at: pending.eaten_at });
    if (!draft.items.length && !draft.water_ml) {
      throw new Error(text ? "Rien de reconnu. Précise ta description ou ajoute-le à la main."
                           : "Rien de reconnu. Ajoute-le à la main ou reprends la photo.");
    }
    renderDraft();
  } catch (err) {
    if (err instanceof OfflineError && (queue || pending)) {
      // no connection: keep the photo / text and analyze it once back online
      if (queue) await queueAdd({ ...queue, eaten_at: mealTime() });
      closeReview();
      renderPending();
      return notice(queue ? "Pas de connexion : c'est gardé sur ton téléphone. Tu pourras l'analyser au retour du réseau (bandeau « en attente »)."
                          : "Toujours pas de connexion. Réessaie plus tard.", "Hors connexion");
    }
    $("analyzing").hidden = true;
    $("error").textContent = err.message;
    $("error").hidden = false;
    draft = draft || { title: "Repas", items: [], water_ml: 0 };
    renderDraft();
  }
}

function renderDraftWater() {
  $("water-row").hidden = !(draft.water_ml > 0);
  $("add-water").hidden = draft.water_ml > 0;
  $("water-ml").value = draft.water_ml || "";
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
    const p100 = row.querySelector(".p100"), c100 = row.querySelector(".c100"), f100 = row.querySelector(".f100");
    const showMacros = () => {
      for (const [el, key] of [[p100, "protein_100g"], [c100, "carbs_100g"], [f100, "fat_100g"]]) {
        el.value = Math.round((it[key] || 0) * 10) / 10;
        el.oninput = () => (it[key] = Number(el.value) || 0);
      }
    };
    showMacros();
    // portion taken from what the user usually saves for this food: show it, and allow going back
    const usual = row.querySelector(".usual");
    const showUsual = () => {
      usual.hidden = !it.usual;
      usual.innerHTML = it.usual ? `↺ <b>Ta portion habituelle</b> · l'IA proposait ${fmt(it.ai_grams)} g` : "";
    };
    showUsual();
    usual.onclick = () => {
      const g = it.ai_grams;
      if (it.drink_ml) { draft.water_ml = Math.max(0, (draft.water_ml || 0) + g - it.drink_ml); it.drink_ml = g; renderDraftWater(); }
      it.grams = g;
      it.usual = false;
      grams.value = g;
      showUsual();
      refresh();
    };
    name.value = it.name;
    if (it.estimatedFor === undefined) it.estimatedFor = it.name;
    grams.value = Math.round(it.grams);
    k100.value = Math.round(it.kcal_100g);
    const refresh = () => { row.querySelector(".kcal").textContent = Math.round(kcalOf(it)) + " kcal"; updateDraftTotal(); };
    name.oninput = () => (it.name = name.value);
    // food added or renamed: the AI recomputes its values (and its portion if just added)
    name.onchange = async () => {
      const n = name.value.trim();
      if (!n || n === it.estimatedFor) return;
      it.estimatedFor = n;
      row.querySelector(".kcal").textContent = "calcul…";
      try {
        const est = await api("/api/estimate-item", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: n, grams: it.fresh ? null : it.grams || null }),
        });
        if (it.estimatedFor !== n) return; // renamed meanwhile
        Object.assign(it, { kcal_100g: est.kcal_100g, protein_100g: est.protein_100g, carbs_100g: est.carbs_100g, fat_100g: est.fat_100g, abv: est.abv || 0 });
        if (it.fresh && est.usual) Object.assign(it, { usual: true, ai_grams: est.ai_grams });
        // a non-alcoholic drink also counts toward hydration
        draft.water_ml = Math.max(0, (draft.water_ml || 0) + (est.drink_ml || 0) - (it.drink_ml || 0));
        it.drink_ml = est.drink_ml || 0;
        renderDraftWater();
        if (it.fresh) it.grams = est.grams || it.grams;
        it.fresh = false;
        if (!row.isConnected) return renderDraft(); // list redrawn during the estimate
        grams.value = Math.round(it.grams);
        k100.value = Math.round(it.kcal_100g);
        showMacros();
        showUsual();
      } catch (err) {
        it.estimatedFor = null;
        $("fix-status").textContent = `Calcul impossible pour « ${n} » : ${err.message}`;
        $("fix-status").hidden = false;
      }
      refresh();
    };
    grams.oninput = () => {
      it.grams = Number(grams.value) || 0;
      if (it.usual) { it.usual = false; showUsual(); }
      refresh();
    };
    k100.oninput = () => { it.kcal_100g = Number(k100.value) || 0; refresh(); };
    row.querySelector(".remove").onclick = () => {
      draft.water_ml = Math.max(0, (draft.water_ml || 0) - (it.drink_ml || 0));
      draft.items.splice(idx, 1);
      renderDraft();
    };
    refresh();
    box.appendChild(row);
  });
  renderDraftWater();
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
  draft.items.push({ name: "", grams: 100, kcal_100g: 0, protein_100g: 0, carbs_100g: 0, fat_100g: 0, fresh: true });
  renderDraft();
  const names = document.querySelectorAll("#items .name");
  names[names.length - 1].focus();
};
$("meal-title").oninput = (e) => (draft.title = e.target.value);

// Correct the dish with a comment: the AI redoes the whole analysis (foods, grams, kcal, macros, water)
$("fix-form").onsubmit = async (e) => {
  e.preventDefault();
  const comment = $("fix-text").value.trim();
  if (comment.length < 2 || !draft) return;
  const btn = $("fix-btn");
  btn.disabled = true;
  btn.textContent = "Calcul…";
  $("fix-status").hidden = true;
  try {
    const res = await api("/api/analyze-fix", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: draft.title, water_ml: draft.water_ml || 0, comment,
        items: draft.items.filter((it) => it.name.trim()).map(({ name, grams, kcal_100g, protein_100g, carbs_100g, fat_100g, drink_ml, abv }) =>
          ({ name, grams, kcal_100g, protein_100g: protein_100g || 0, carbs_100g: carbs_100g || 0, fat_100g: fat_100g || 0,
             drink_ml: drink_ml || 0, abv: abv || 0 })),
      }),
    });
    draft.title = res.title || draft.title;
    draft.items = res.items || [];
    draft.water_ml = res.water_ml || 0;
    $("fix-text").value = "";
    renderDraft();
    $("fix-status").textContent = "Corrigé ✓ — vérifie puis enregistre.";
    $("fix-status").hidden = false;
  } catch (err) {
    $("fix-status").textContent = err.message;
    $("fix-status").hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Corriger";
  }
};

function closeReview() {
  draft = null;
  $("review").hidden = true;
  document.body.classList.remove("reviewing");
  loadDay();
}
$("cancel").onclick = async () => {
  if (draft?.queued && await confirmBox("Ne pas garder ce repas en attente ?", { title: "Repas en attente", ok: "Le supprimer" })) {
    await queueDel(draft.queued);
  }
  closeReview();
  renderPending();
};
$("save").onclick = async () => {
  const items = draft.items.filter((it) => it.name.trim());
  const water_ml = draft.water_ml || 0;
  if (!items.length && !water_ml) return notice("Ajoute au moins un aliment ou de l'eau.");
  $("save").disabled = true;
  try {
    // The meal is filed under the displayed day (handy to catch up on yesterday)
    const eaten_at = draft.eaten_at || (draft.id || day === todayISO() ? null : `${day}T12:00:00`);
    const body = { title: draft.title || (items.length ? "Repas" : "Eau"), items: items.map(cleanItem), water_ml, eaten_at };
    try {
      await api(draft.id ? `/api/meals/${draft.id}` : "/api/meals", {
        method: draft.id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    } catch (err) {
      if (!(err instanceof OfflineError) || draft.id) throw err;
      // no connection: keep the meal on the phone, sent automatically once back online
      await queueAdd({ kind: "meal", body: { ...body, eaten_at: eaten_at || mealTime() } });
      if (draft.queued) await queueDel(draft.queued);
      closeReview();
      renderPending();
      return notice("Pas de connexion : le repas est gardé sur ton téléphone et sera envoyé tout seul au retour du réseau.", "Hors connexion");
    }
    if (draft.queued) await queueDel(draft.queued);
    const isNew = !draft.id && items.length;
    closeReview();
    renderPending();
    if (isNew) celebrateStreak();
  } catch (err) {
    notice(err.message, "Erreur");
  } finally {
    $("save").disabled = false;
  }
};

// ---------- Offline: meals saved, photos and texts kept until the connection is back ----------
// IndexedDB (a photo is too big for localStorage). Entries: { id, user, kind: meal | photo | text, eaten_at… }
let idb = null;
function idbStore(mode) {
  idb ||= new Promise((resolve, reject) => {
    const r = indexedDB.open("kcal", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("queue", { keyPath: "id", autoIncrement: true });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return idb.then((db) => db.transaction("queue", mode).objectStore("queue"));
}
const idbDo = (mode, fn) => idbStore(mode).then((st) => new Promise((resolve, reject) => {
  const r = fn(st);
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
}));
const queueAll = () => idbDo("readonly", (st) => st.getAll()).then((all) => all.filter((q) => q.user === me?.id)).catch(() => []);
const queueAdd = (entry) => idbDo("readwrite", (st) => st.add({ ...entry, user: me.id, created: Date.now() }));
const queueDel = (id) => idbDo("readwrite", (st) => st.delete(id));

// time of a meal being saved: now, or noon on the day shown when catching up on a past day
function mealTime() {
  if (day !== todayISO()) return `${day}T12:00:00`;
  const d = new Date();
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}
const cleanItem = ({ name, grams, kcal_100g, protein_100g, carbs_100g, fat_100g, drink_ml, abv }) =>
  ({ name, grams, kcal_100g, protein_100g: protein_100g || 0, carbs_100g: carbs_100g || 0, fat_100g: fat_100g || 0,
     drink_ml: drink_ml || 0, abv: abv || 0 });

let flushing = false;
async function flushQueue() {
  if (flushing || !me) return;
  flushing = true;
  let sent = 0;
  try {
    for (const q of (await queueAll()).filter((q) => q.kind === "meal")) {
      try {
        await api("/api/meals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(q.body) });
      } catch (err) {
        // refused for good (invalid meal): dropped, so it isn't retried forever; otherwise retried later
        if ([400, 413, 422].includes(err.status)) { await queueDel(q.id); continue; }
        break;
      }
      await queueDel(q.id);
      sent++;
    }
  } finally {
    flushing = false;
  }
  if (sent) { loadDay().catch(() => {}); renderStreak(); }
  renderPending();
}

async function renderPending() {
  const all = await queueAll();
  const meals = all.filter((q) => q.kind === "meal").length;
  const toAnalyze = all.filter((q) => q.kind !== "meal");
  const bar = $("pending-bar");
  bar.hidden = !all.length;
  if (!all.length) return;
  const parts = [];
  if (meals) parts.push(`${plural(meals, "repas")} en attente d'envoi`);
  if (toAnalyze.length) parts.push(`${toAnalyze.length} repas à analyser`);
  bar.innerHTML = `⏳ ${parts.join(" · ")}<small>${toAnalyze.length ? "Touche pour analyser" : "Envoi automatique au retour du réseau · touche pour réessayer"}</small>`;
  bar.onclick = async () => {
    await flushQueue();
    const next = (await queueAll()).find((q) => q.kind !== "meal");
    if (!next) return;
    const when = new Date(next.eaten_at).toLocaleString("fr-FR", { weekday: "long", hour: "2-digit", minute: "2-digit" });
    if (next.kind === "photo") {
      const form = new FormData();
      form.append("photo", next.blob, "repas.jpg");
      analyze(() => api("/api/analyze", { method: "POST", body: form }),
        { image: URL.createObjectURL(next.blob), caption: `📷 Photo prise ${when}`, pending: next });
    } else {
      analyze(() => api("/api/analyze-text", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: next.text }) }), { text: next.text, caption: `« ${next.text} » · ${when}`, pending: next });
    }
  };
}
window.addEventListener("online", flushQueue);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flushQueue(); });

// ---------- Navigation ----------
$("prev").onclick = () => { day = shiftDay(day, -1); loadDay(); };
$("next").onclick = () => { if (day < todayISO()) { day = shiftDay(day, 1); loadDay(); } };
/* In-app input dialog (prompt() isn't available in every embedded browser).
   fields: [{ key, label, type, value, unit, step, min, max }]
     type: number, text, password, textarea, choice (chips), note (help text).
   onSubmit(values): async; throwing keeps the dialog open with the message.
   onChange(ui) is called when a value changes; ui[key] = { label, text, input, unit, get() }. */
function ask({ title, fields, submit = "Valider", onSubmit, onChange }) {
  const dlg = $("ask");
  $("ask-title").textContent = title;
  $("ask-submit").textContent = submit;
  $("ask-error").hidden = true;
  const box = $("ask-fields");
  box.innerHTML = "";
  const ui = {};
  const changed = () => onChange?.(ui);
  for (const f of fields) {
    if (f.type === "note") {
      const p = Object.assign(document.createElement("p"), { className: "hint ask-note", textContent: f.label || "" });
      ui[f.key] = { label: p, text: p };
      box.append(p);
      continue;
    }
    const label = document.createElement(f.type === "choice" ? "div" : "label");
    label.className = "field";
    const text = document.createTextNode(f.label);
    label.append(text);
    ui[f.key] = { label, text };
    if (f.type === "choice") {
      let current = f.value;
      const group = Object.assign(document.createElement("div"), { className: "chips" });
      group.setAttribute("role", "group");
      for (const o of f.options) {
        const b = Object.assign(document.createElement("button"), { type: "button", className: "chip", textContent: o.label });
        const sync = () => { b.classList.toggle("active", o.value === current); b.setAttribute("aria-pressed", o.value === current); };
        b.sync = sync;
        b.onclick = () => { current = o.value; group.querySelectorAll(".chip").forEach((c) => c.sync()); changed(); };
        sync();
        group.append(b);
      }
      ui[f.key].get = () => current;
      label.append(group);
      box.append(label);
      continue;
    }
    const input = document.createElement(f.type === "textarea" ? "textarea" : "input");
    if (f.type === "textarea") {
      input.rows = 3;
      input.placeholder = f.placeholder || "";
      if (f.voice) label.dataset.voice = "1";
    } else {
      input.type = f.type === "number" ? "text" : f.type || "text";
    }
    if (f.type === "number") input.inputMode = f.step && f.step < 1 ? "decimal" : "numeric";
    if (f.type === "password") input.autocomplete = f.key === "current" ? "current-password" : "new-password";
    input.value = f.value ?? "";
    input.required = true;
    input.oninput = changed;
    ui[f.key].input = input;
    ui[f.key].get = () => input.value;
    if (f.unit) {
      const wrap = document.createElement("span");
      wrap.className = "input-unit";
      const unit = document.createTextNode(" " + f.unit);
      wrap.append(input, unit);
      ui[f.key].unit = unit;
      label.append(wrap);
    } else {
      label.append(input);
    }
    box.append(label);
    if (label.dataset.voice) box.append(micButton(input));
  }
  $("ask-form").onsubmit = async (e) => {
    e.preventDefault();
    const values = {};
    for (const f of fields) {
      if (f.type === "note") continue;
      const u = ui[f.key];
      if (u.label.hidden) continue; // hidden field: skipped
      if (f.type === "choice") { values[f.key] = u.get(); continue; }
      const raw = u.input.value.trim();
      if (f.type === "number") {
        const n = Number(raw.replace(",", "."));
        if (raw === "" || !Number.isFinite(n) || (f.min != null && n < f.min) || (f.max != null && n > f.max)) {
          return showAskError(`${f.label || "Valeur"} : entre ${fmtNum(f.min) ?? "…"} et ${fmtNum(f.max) ?? "…"}${f.unit ? " " + f.unit : ""}.`);
        }
        values[f.key] = n;
      } else {
        if (!raw) return showAskError("Ce champ ne peut pas être vide.");
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
  dlg.addEventListener("close", stopDictation, { once: true });
  changed();
  dlg.showModal();
  const first = Object.values(ui).find((u) => u.input && !u.label.hidden)?.input;
  if (first) { first.focus(); first.select(); }
}
// confirm() and alert() don't show in every embedded browser: in-app versions
function confirmBox(message, { title = "Confirmer", ok = "Supprimer", danger = true } = {}) {
  return new Promise((resolve) => {
    let done = false;
    ask({ title, submit: ok, fields: [{ key: "msg", type: "note", label: message }],
          onSubmit: () => { done = true; resolve(true); } });
    $("ask-submit").classList.toggle("danger", danger);
    $("ask").addEventListener("close", () => {
      $("ask-submit").classList.remove("danger");
      if (!done) resolve(false);
    }, { once: true });
  });
}
function notice(message, title = "Kcal") {
  ask({ title, submit: "OK", fields: [{ key: "msg", type: "note", label: message }], onSubmit: () => {} });
}
const fmtNum = (n) => (n == null ? null : String(n).replace(".", ","));
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
// Carbs and fat: set by hand in grams, else from the day's kcal goal
// (fat 30 % of the calories, carbs the rest once protein and fat are counted)
const FAT_SHARE = 0.3;
function macroGoals(kcal, pGoal) {
  const fatAuto = Math.round((kcal * FAT_SHARE) / 9);
  const fat = me.fat_goal || fatAuto;
  const carbsAuto = Math.max(0, Math.round((kcal - pGoal * 4 - fat * 9) / 4));
  return { carbs: me.carbs_goal || carbsAuto, fat, carbsAuto, fatAuto };
}
const MACRO_LABELS = { carbs: ["🍞", "glucides", 1500], fat: ["🥑", "lipides", 500] };
for (const k of ["carbs", "fat"]) {
  $(`${k}-card`).onclick = () => {
    const [icon, name, max] = MACRO_LABELS[k];
    const auto = facts.mg?.[`${k}Auto`] ?? 0;
    ask({
      title: `${icon} Objectif de ${name}`,
      fields: [
        { key: "mode", type: "choice", label: "Calcul", value: me[`${k}_goal`] ? "grams" : "auto", options: [
          { value: "auto", label: "Auto" }, { value: "grams", label: "En grammes" }] },
        { key: "v", type: "number", label: "Objectif par jour", unit: "g", min: 1, max, step: 1, value: me[`${k}_goal`] || auto },
        { key: "note", type: "note" },
      ],
      onChange(ui) {
        const mode = ui.mode.get();
        ui.v.label.hidden = mode === "auto";
        ui.note.text.textContent = mode !== "auto" ? "Fixe, quel que soit ton objectif de calories du jour."
          : k === "fat" ? `${Math.round(FAT_SHARE * 100)} % de tes calories du jour : ${fmt(auto)} g aujourd'hui (1 g = 9 kcal).`
          : `Le reste de tes calories une fois protéines et lipides comptés : ${fmt(auto)} g aujourd'hui (1 g = 4 kcal).`;
      },
      onSubmit: async ({ mode, v }) => {
        me = await api("/api/me", jsonPatch({ [`${k}_goal`]: mode === "auto" ? 0 : Math.round(v) }));
        loadDay();
      },
    });
  };
}

// Protein target: computed by the server (weight goal, or set manually in g or g/kg)
const proteinGoal = () => me.protein_goal || 100;
$("protein-card").onclick = () => {
  const weight = plan?.current_weight || me.weight_kg;
  const autoG = plan?.protein_auto_goal ?? (weight ? Math.round(weight * 1.6) : 100);
  const autoKg = plan ? plan.protein_auto_per_kg : weight ? 1.6 : null;
  const mode0 = me.protein_mode || "auto";
  const defaults = {
    grams: mode0 === "grams" ? me.protein_value : proteinGoal(),
    per_kg: mode0 === "per_kg" ? me.protein_value : weight ? Math.round((proteinGoal() / weight) * 10) / 10 : 1.6,
  };
  const fields = [
    { key: "mode", type: "choice", label: "Calcul", value: mode0, options: [
      { value: "auto", label: "Auto" }, { value: "grams", label: "En grammes" }, { value: "per_kg", label: "En g/kg" }] },
    { key: "v", type: "number", label: "Objectif par jour", unit: "g" },
    { key: "note", type: "note" },
  ];
  let shown = null;
  ask({
    title: "💪 Objectif de protéines",
    fields,
    onChange(ui) {
      const mode = ui.mode.get();
      ui.v.label.hidden = mode === "auto";
      if (mode !== shown) { // mode changed: reset to that mode's default value
        if (mode !== "auto") ui.v.input.value = fmtNum(defaults[mode]);
        shown = mode;
      }
      const f = fields[1];
      if (mode === "per_kg") Object.assign(f, { label: "Par kg de poids", min: 0.5, max: 4, step: 0.1 });
      else Object.assign(f, { label: "Objectif par jour", min: 20, max: 500, step: 1 });
      ui.v.text.textContent = f.label;
      ui.v.unit && (ui.v.unit.textContent = mode === "per_kg" ? " g/kg" : " g");
      ui.v.input.inputMode = mode === "per_kg" ? "decimal" : "numeric";
      const n = Number(String(ui.v.input.value).replace(",", "."));
      let note = "";
      if (mode === "auto") {
        note = plan
          ? `Selon ton objectif « ${plan.label} » : ${autoG} g par jour (${fmtNum(autoKg)} g/kg).`
          : weight ? `${autoG} g par jour (1,6 g par kg de poids).` : "100 g par jour (renseigne ton poids pour un calcul en g/kg).";
      } else if (mode === "per_kg") {
        note = weight ? (n > 0 ? `= ${Math.round(n * weight)} g par jour avec ${fmtKg(weight)} kg, recalculé à chaque pesée.` : "")
          : "Renseigne d'abord ton poids (bouton Se peser).";
      } else if (weight && n > 0) {
        note = `= ${fmtNum(Math.round((n / weight) * 10) / 10)} g/kg avec ${fmtKg(weight)} kg. Fixe, même si ton poids change.`;
      }
      ui.note.text.textContent = note;
    },
    onSubmit: async ({ mode, v }) => {
      const res = await api("/api/protein", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, value: mode === "auto" ? null : v }),
      });
      const { plan: p, ...user } = res;
      me = user;
      plan = p;
      renderGoalCard();
      loadDay();
    },
  });
};

// ---------- Accounts ----------
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

// Invitation link (?invite=…): opens "Create account" directly with the code filled in
const inviteParam = new URLSearchParams(location.search).get("invite");
if (inviteParam) {
  $("auth-invite").value = inviteParam;
  authMode = "register";
  history.replaceState(null, "", location.pathname);
}

// ---------- Invitations (administrator) ----------
const fmtShort = (iso) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

async function shareInvite(inv) {
  const text = `${inv.note}, voici ton invitation pour Kcal (valable jusqu'au ${fmtShort(inv.expires_at)})`;
  if (navigator.share) {
    try { return await navigator.share({ title: "Invitation Kcal", text, url: inv.link }); }
    catch (err) { if (err.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(inv.link);
    notice("Le lien est copié : colle-le dans un message.", "Lien copié");
  } catch {
    // clipboard unavailable (http, embedded browser): link preselected for copying
    ask({ title: "Copie ce lien", submit: "OK", fields: [{ key: "link", label: "Lien d'invitation", value: inv.link }], onSubmit: () => {} });
  }
}

function renderInvites(list) {
  const box = $("invite-list");
  box.innerHTML = "";
  if (!list.length) {
    box.append(Object.assign(document.createElement("p"), { className: "hint", textContent: "Aucune invitation pour l'instant." }));
  }
  for (const inv of list) {
    const row = document.createElement("div");
    row.className = "invite-row";
    row.innerHTML = '<div class="invite-info"><b></b><small></small></div>';
    row.querySelector("b").textContent = inv.note;
    row.querySelector("small").textContent =
      inv.status === "used" ? `✅ Compte créé${inv.used_name ? " par " + inv.used_name : ""} le ${fmtShort(inv.used_at)}`
      : inv.status === "expired" ? `Expirée le ${fmtShort(inv.expires_at)}`
      : `En attente · expire le ${fmtShort(inv.expires_at)}`;
    if (inv.status === "pending") {
      const share = Object.assign(document.createElement("button"), { type: "button", className: "chip", textContent: "Partager" });
      share.onclick = () => shareInvite(inv);
      row.append(share);
    }
    if (inv.status !== "used") {
      const del = Object.assign(document.createElement("button"), { type: "button", className: "invite-del", textContent: "🗑" });
      del.setAttribute("aria-label", "Supprimer l'invitation");
      del.onclick = async () => {
        if (!(await confirmBox(`Supprimer l'invitation de ${inv.note} ? Le lien ne marchera plus.`))) return;
        renderInvites(await api(`/api/invites/${encodeURIComponent(inv.code)}`, { method: "DELETE" }));
      };
      row.append(del);
    }
    box.append(row);
  }
}

$("open-invites").onclick = async () => {
  $("account").close();
  $("invites-dialog").showModal();
  try { renderInvites(await api("/api/invites")); } catch (err) { notice(err.message, "Erreur"); }
};
$("invites-close").onclick = () => $("invites-dialog").close();
$("invite-new").onclick = () => ask({
  title: "Nouvelle invitation",
  submit: "Créer le lien",
  fields: [{ key: "note", label: "Prénom de la personne", value: "" }],
  onSubmit: async ({ note }) => {
    const res = await api("/api/invites", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }),
    });
    renderInvites(res.invites); // the new invitation is at the top, with "Partager"
  },
});

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
  $("open-invites").hidden = !me.is_admin;
  $("feat-protein").checked = me.show_protein;
  $("feat-macros").checked = me.show_macros;
  $("feat-weight").checked = me.show_weight;
  $("account").showModal();
};
$("account-close").onclick = () => $("account").close();
$("logout").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  await window.caches?.delete("kcal-data-v1").catch(() => {});
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
      setTimeout(() => notice("Mot de passe changé. Tes autres appareils ont été déconnectés."), 100);
    },
  });
};

// ---------- Settings: energy expenditure ----------
const sourceValue = () => ($("settings-form").querySelector("input[name=source]:checked") || {}).value || "none";

// Silhouettes 1 (very lean) … 5 (heavy) with their visual body fat estimate.
// Kept in sync with BODY_FAT in server/metabolism.py.
const MORPHOLOGY = {
  m: { fat: [10, 15, 20, 26, 33], label: ["Très sec", "Athlétique", "Moyen", "Enrobé", "Fort"] },
  f: { fat: [18, 23, 28, 34, 41], label: ["Très sèche", "Athlétique", "Moyenne", "Enrobée", "Forte"] },
};
let morphoLevel = 0; // 0 = not chosen
let metabolismInfo = null; // last /api/metabolism answer (calibration details)

// Smooth path through points (Catmull-Rom -> cubic Bézier), for the silhouettes
function spline(pts, closed) {
  const n = pts.length, P = (i) => pts[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];
  let d = `M${P(0)[0].toFixed(2)},${P(0)[1].toFixed(2)}`;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2), t = 6;
    const c1 = [p1[0] + (p2[0] - p0[0]) / t, p1[1] + (p2[1] - p0[1]) / t];
    const c2 = [p2[0] - (p3[0] - p1[0]) / t, p2[1] - (p3[1] - p1[1]) / t];
    d += ` C${c1.map((v) => v.toFixed(2))} ${c2.map((v) => v.toFixed(2))} ${p2.map((v) => v.toFixed(2))}`;
  }
  return d + (closed ? " Z" : "");
}
// Side view (facing right). Offsets from the body axis x = 50: positive = front, negative = back.
// Level 1 = very lean … 5 = heavy; "def" = how visible the muscle lines are.
const PROFILE = {
  m: {
    chest: [8.4, 12.4, 8.6, 9.8, 11], belly: [5.2, 6.4, 8.2, 12.5, 16.5], back: [-7.8, -11, -7.8, -8.8, -10],
    waist: [-4.8, -5.8, -5.8, -6.8, -8.2], glute: [-7.8, -10.6, -8.6, -10.4, -12.4],
    quad: [6.2, 9, 6.6, 7.9, 9.4], ham: [-5.2, -7.2, -5.9, -7.2, -8.8], calf: [-4.2, -6.2, -4.6, -5, -5.8],
    delt: [3.9, 6.2, 4.1, 4.5, 5.1], bicep: [3, 5, 3.1, 3.4, 3.9], fore: [2.2, 3.2, 2.3, 2.5, 2.9],
    def: [1, 1, 0.55, 0.2, 0],
  },
  f: {
    chest: [8.2, 9.4, 9.6, 11.2, 13.2], belly: [4.8, 5.4, 7.2, 10.8, 14.6], back: [-6.8, -8.2, -7, -8, -9.6],
    waist: [-4.6, -5.2, -5.4, -6.4, -8], glute: [-9.4, -11.2, -10.4, -12, -14],
    quad: [6.2, 7.8, 6.6, 8, 9.8], ham: [-5.4, -6.8, -6.2, -7.6, -9.4], calf: [-4.2, -5.2, -4.4, -5, -6],
    delt: [3.3, 4.4, 3.4, 3.9, 4.7], bicep: [2.5, 3.4, 2.6, 3, 3.7], fore: [1.8, 2.3, 1.9, 2.3, 2.7],
    def: [0.9, 0.95, 0.45, 0.15, 0],
  },
};

function silhouetteSVG(sex, level) {
  const p = PROFILE[sex], i = level - 1, g = (k) => p[k][i];
  const ax = 50, X = (v) => ax + v;
  const ch = g("chest"), be = g("belly"), bk = g("back"), wb = g("waist"), gl = g("glute");
  const qu = g("quad"), hm = g("ham"), ca = g("calf"), def = g("def");
  const f = sex === "f";
  // Body: down the front, along the sole, up the back
  const body = spline([
    [X(3.6), 19], [X(4.8), 23.5], [X(ch * 0.85), 28], [X(ch), 33], [X(ch - (f ? 0.6 : 1.6)), 38.5],
    [X((ch + be) / 2 - 1.2), 45], [X(be), 54], [X(be * 0.82 + 0.6), 62], [X(qu * 0.85), 69],
    [X(qu), 78], [X(qu * 0.55 + 1.6), 91], [X(3.3), 99], [X(2.6), 112], [X(3.4), 117.5], [X(9.5), 119.6], [X(9.4), 121.6],
    [X(-3.4), 121.6], [X(-4), 118.6], [X(-2.5), 111.5], [X(ca), 100], [X(hm * 0.55), 91.5],
    [X(hm), 81], [X(gl), 70.5], [X(wb * 0.82), 61], [X(wb), 50], [X(bk), 35], [X(bk * 0.72), 26], [X(-4.2), 19],
  ], true);
  // Arm hanging along the side, slightly forward
  const sx = X(ch * 0.12);
  const d = g("delt"), bi = g("bicep"), fo = g("fore");
  const arm = spline([
    [sx - d * 0.3, 24.6], [sx + d * 0.55, 25.4], [sx + d * 0.95, 28.6], [sx + d * 0.78, 32.6], [sx + bi + 0.2, 37],
    [sx + bi * 0.72, 43.6], [sx + fo * 1.1 + 0.6, 48.6], [sx + fo * 0.7 + 1.7, 59.5], [sx + fo * 0.9 + 2.3, 64.2], [sx + 2.8, 69],
    [sx + 0.8, 68.6], [sx - fo * 0.45 + 1.3, 63.8], [sx - fo * 0.5 + 0.9, 59], [sx - fo * 0.95, 48.8],
    [sx - bi * 0.85, 43], [sx - bi * 1.05, 36], [sx - d * 0.85, 29.4], [sx - d * 0.62, 25.8],
  ], true);
  // Faceted fox head in profile (low-poly style), with a neck that blends into the torso
  const pt = ([x, y]) => `${X(x).toFixed(2)},${y}`;
  const poly = (pts, cls) => `<polygon${cls ? ` class="${cls}"` : ""} points="${pts.map(pt).join(" ")}"/>`;
  const seg = (pts) => `M${pts.map(pt).join(" L")}`;
  const head = poly([[-6.4, 9], [-5.2, 4], [-4.2, 3], [-2.2, -7], [2, 2.4], [4.6, 4.2], [8.2, 7.4], [13.4, 11.2],
    [12.8, 12.8], [7, 14.4], [3.6, 16.6], [4.2, 20.5], [4.6, 24], [-3.8, 24], [-4.4, 19.5], [-6.6, 13.4]]);
  const face = poly([[9.2, 11.4], [12.8, 12.8], [7, 14.4], [3.6, 16.6], [1, 14.2]], "tip") +
    `<g class="cut">${poly([[-3.4, 2.4], [-2.2, -4.2], [0.4, 2]])}${poly([[2.6, 6.8], [4.6, 7.4], [3, 8.4]])}` +
    `<circle cx="${X(13)}" cy="11.9" r="0.9"/></g>` +
    `<path class="facet" d="${seg([[2, 2.4], [3, 9], [8.2, 7.4]])} ${seg([[3, 9], [9.2, 11.4], [13.4, 11.2]])} ` +
    `${seg([[3, 9], [1, 14.2], [-6.6, 13.4]])} ${seg([[1, 14.2], [-1.2, 9.4], [-5.2, 4]])} ${seg([[-1.2, 9.4], [3, 9]])} ` +
    `${seg([[3.6, 16.6], [-1.6, 18.6], [-4.4, 19.5]])}"/>`;
  const bow = f ? `<path class="bow" d="M${X(-0.6)},1.6 L${X(-3.6)},-1 L${X(-3.4)},3.8 Z M${X(-0.6)},1.6 L${X(2.4)},3.8 L${X(1.6)},-0.6 Z"/><circle class="bow" cx="${X(-0.6)}" cy="1.6" r="0.9"/>` : "";
  // Bushy tail from the lower back, curling up behind
  const tx = X(gl + 1.5);
  const tail = spline([[tx + 3, 63], [tx - 3, 71], [tx - 11, 69.5], [tx - 15, 58], [tx - 12.5, 45], [tx - 9.4, 48.5], [tx - 9.2, 57.5], [tx - 4, 63.5]], true);
  const tip = spline([[tx - 12.4, 45.1], [tx - 15.2, 52.5], [tx - 14.6, 56.5], [tx - 11.6, 53.6], [tx - 9.5, 48.4]], true);
  // Muscle definition, stronger when lean: light on the volumes, dark lines between muscles
  const facet = (cx, cy, rx, ry, rot = 0) => {
    const r = (rot * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
    const pts = [[-rx, -ry * 0.2], [rx * 0.15, -ry], [rx, ry * 0.1], [-rx * 0.1, ry]]
      .map(([x, y]) => `${(cx + x * c - y * sn).toFixed(2)},${(cy + x * sn + y * c).toFixed(2)}`);
    return `<polygon points="${pts.join(" ")}"/>`;
  };
  const hl = def ? `<g class="hl" style="opacity:${(0.4 * def).toFixed(2)}">
    ${facet(X(ch * 0.6), 32.4, (ch * 0.32), 2.6, -12)}
    ${facet(X(qu * 0.55), 77, (qu * 0.3), 5.4, -8)}
    ${facet(X(gl * 0.62), 70, (-gl * 0.26), 3.6)}
    ${facet(X(ca * 0.55), 100, (-ca * 0.28), 3.6)}
    ${facet(X(bk * 0.55), 36, (-bk * 0.22), 4.2)}
  </g>` : "";
  const abs = f ? "" : [43.2, 47.6, 52, 56.2].map((y, k) =>
    `M${X(be - 0.6 - k * 0.1)},${y} L${X(be - 2.6)},${y + 0.3}`).join(" ");
  const lines = def ? `<g class="muscle" style="opacity:${def}">
    <path d="M${X(ch - 1.2)},38.2 Q${X(ch * 0.55)},40 ${X(ch * 0.12)},37.4"/>
    ${abs ? `<path d="${abs} M${X(be - 2.6)},42.6 L${X(be - 2.9)},57"/>` : ""}
    <path d="M${X(ch * 0.5)},41.2 l1.4,0.9 M${X(ch * 0.45)},44.2 l1.3,0.9 M${X(ch * 0.42)},47.2 l1.2,0.8"/>
    <path d="M${X(qu - 1.6)},71.5 Q${X(qu * 0.6)},79 ${X(qu * 0.42)},87"/>
    <path d="M${X(qu * 0.65)},84.5 Q${X(qu * 0.9)},88 ${X(qu * 0.55 + 1.3)},91.2"/>
    <path d="M${X(gl + 2.4)},75.2 Q${X(gl * 0.5)},77.6 ${X(gl * 0.18)},76.6"/>
    <path d="M${X(hm * 0.65)},80 Q${X(hm * 0.55)},86 ${X(hm * 0.4)},90"/>
    <path d="M${X(ca + 1.2)},96 Q${X(ca * 0.5)},100 ${X(ca * 0.3)},105"/>
    <path d="M${X(-2.6)},21.8 Q${X(bk * 0.45)},25.4 ${X(bk * 0.62)},29"/>
  </g>` : "";
  const armHl = def ? `<g class="hl" style="opacity:${(0.42 * def).toFixed(2)}">
    ${facet(sx + d * 0.25, 29, (d * 0.48), 2.8)}
    ${facet(sx + bi * 0.45, 38, (bi * 0.38), 3)}
    ${facet(sx + fo * 0.4 + 0.6, 50.5, (fo * 0.4), 3.2)}
  </g>` : "";
  const armLines = def ? `<g class="muscle" style="opacity:${def}">
    <path d="M${sx - d * 0.78},33.2 Q${sx},35.8 ${sx + d * 0.72},32.8"/>
    <path d="M${sx - d * 0.1},26.2 Q${sx + 0.2},29.6 ${sx - 0.1},33.8"/>
    <path d="M${sx - 0.1},37 L${sx - 0.5},43"/>
    <path d="M${sx + fo * 0.2},46 Q${sx + fo * 0.5 + 0.6},51 ${sx + 1.4},57"/>
  </g>` : "";
  return `<svg viewBox="17 -8 52 131" aria-hidden="true">` +
    `<g class="far"><path d="${tail}"/></g><path d="${body}"/><path class="tip" d="${tip}"/>${head}${face}${bow}` +
    `${hl}${lines}<path class="arm" d="${arm}"/>${armHl}${armLines}</svg>`;
}

function renderMorpho() {
  const sex = $("set-sex").value || "m";
  const box = $("morpho");
  box.innerHTML = "";
  MORPHOLOGY[sex].fat.forEach((fat, i) => {
    const level = i + 1;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "morpho-opt";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(level === morphoLevel));
    b.innerHTML = `${silhouetteSVG(sex, level)}<b></b><small>~${fat} %</small>`;
    b.querySelector("b").textContent = MORPHOLOGY[sex].label[i];
    b.onclick = () => { morphoLevel = morphoLevel === level ? 0 : level; renderMorpho(); renderSettingsVisibility(); };
    box.append(b);
  });
}

const lifeValue = () => Number(($("settings-form").querySelector("input[name=life]:checked") || {}).value || 1.2);

// Same formulas as server/metabolism.py, on the values being edited
function bmrPreview() {
  const sex = $("set-sex").value, by = +$("set-birth").value, h = +$("set-height").value, w = +$("set-weight").value;
  const measured = Number($("set-fat").value) || 0;
  const fat = measured || (morphoLevel && sex ? MORPHOLOGY[sex].fat[morphoLevel - 1] : 0);
  let bmr, how;
  if (w && fat) {
    bmr = 370 + 21.6 * w * (1 - fat / 100);
    how = `formule de Katch-McArdle, avec ${fmtNum(fat)} % de graisse ${measured ? "mesuré" : "estimé d'après ta silhouette"}`;
  } else if (sex && by && h && w) {
    bmr = 10 * w + 6.25 * h - 5 * (new Date().getFullYear() - by) + (sex === "m" ? 5 : -161);
    how = "formule de Mifflin-St Jeor (choisis une silhouette ou ton % de graisse pour tenir compte de ta morphologie)";
  } else {
    return "Renseigne ton profil pour calculer ton métabolisme de base.";
  }
  const c = metabolismInfo?.calibration;
  const factor = $("set-calib").checked && c?.status === "ok" ? c.suggested_factor : 1;
  const daily = bmr * lifeValue() * factor;
  return `Métabolisme de base : ${fmt(Math.round(bmr))} kcal/jour (${how}).\n` +
    `Dépense hors sport : ${fmt(Math.round(daily))} kcal/jour` +
    (factor !== 1 ? ` (calibrage ${signed(Math.round((factor - 1) * 100))} % compris)` : "") +
    (sourceValue() === "strava" ? ", + tes activités Strava." : ".");
}

function calibrationText(c) {
  if (!c) return "";
  if (c.status === "no_profile") return "Renseigne ton profil pour activer le calibrage.";
  if (c.status === "ok") {
    const pct = Math.round((c.suggested_factor - 1) * 100);
    const trend = `${c.weekly_change_kg > 0 ? "+" : c.weekly_change_kg < 0 ? "−" : ""}${fmtKg(Math.abs(c.weekly_change_kg))} kg/semaine`;
    return `Sur 4 semaines : ${fmt(c.mean_intake)} kcal mangées par jour en moyenne et ${trend}. ` +
      `Ta dépense réelle est donc d'environ ${fmt(c.real_expenditure)} kcal/jour, contre ${fmt(c.model_expenditure)} prévues par la formule ` +
      `: ${pct === 0 ? "la formule tombe juste" : `correction de ${signed(pct)} %`}${c.capped ? " (plafonnée à ±20 %)" : ""}.` +
      (c.enabled ? "" : " Désactivé : la formule seule est utilisée.");
  }
  return `Il faut 3 semaines de données : au moins ${c.needed_days} jours de repas notés et 3 pesées étalées sur 2 semaines. ` +
    `Pour l'instant : ${c.days_logged} jours notés, ${c.weighins} pesée${c.weighins > 1 ? "s" : ""}.`;
}

function renderSettingsVisibility() {
  const src = sourceValue();
  document.querySelector(".when-energy").hidden = src === "none";
  document.querySelector(".when-profile").hidden = src === "garmin"; // the watch measures it
  $("bmr-preview").textContent = bmrPreview();
  $("life-hint").textContent = src === "strava"
    ? "Hors sport : tes activités Strava s'ajoutent à part."
    : "Si tu fais du sport sans l'enregistrer sur Strava, choisis un niveau au-dessus.";
  $("calib-status").textContent = calibrationText(metabolismInfo?.calibration);
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

// ----- Strava / Garmin connections -----
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
// Enter in a panel field = its main button (not saving the settings)
function bindEnter(panel, action) {
  panel.querySelectorAll("input").forEach((i) => i.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); action(); }
  }));
}

function disconnectPanel(panel, label, url) {
  panel.innerHTML = `<p>${label} est connecté à ton compte Kcal.</p>
    <button type="button" class="btn danger">Déconnecter ${label}</button>`;
  panel.querySelector("button").onclick = async () => {
    if (!(await confirmBox(`Déconnecter ${label} ?`, { title: "Déconnexion", ok: "Déconnecter" }))) return;
    try {
      await api(url, { method: "POST" });
      me = await api("/api/me");
      renderConnections(); renderSettingsVisibility();
      panel.hidden = true;
    } catch (err) { panelError(panel, err.message); }
  };
}

async function goToStrava() {
  // save the current settings first so they aren't lost during the Strava round trip
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
  // First time: the administrator registers the Strava application
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
  $("set-balance").disabled = !!plan; // set by the goal
  $("set-balance").closest(".when-energy").querySelector(".hint").textContent = plan
    ? `Calculé à partir de ton objectif (${plan.label.toLowerCase()}). Modifie l'objectif pour le changer.`
    : "Mangé − brûlé. Négatif pour perdre (−500 ≈ −0,5 kg/semaine), 0 pour stabiliser.";
  $("set-sex").value = me.sex || "";
  $("set-birth").value = me.birth_year || "";
  $("set-height").value = me.height_cm || "";
  $("set-weight").value = me.weight_kg || "";
  const lifeInputs = [...f.querySelectorAll("input[name=life]")];
  const life = me.life_factor ?? 1.2; // closest profile (older accounts may have 1.0)
  lifeInputs.reduce((a, b) => (Math.abs(b.value - life) < Math.abs(a.value - life) ? b : a)).checked = true;
  morphoLevel = me.morphology || 0;
  $("set-fat").value = me.body_fat_pct || "";
  $("set-calib").checked = me.calibrate;
  renderMorpho();
  metabolismInfo = null;
  api("/api/metabolism").then((m) => { metabolismInfo = m; renderSettingsVisibility(); }).catch(() => {});
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
    life_factor: lifeValue(),
    morphology: morphoLevel,
    body_fat_pct: Number($("set-fat").value) || 0,
    calibrate: $("set-calib").checked,
  };
  if (body.body_fat_pct && (body.body_fat_pct < 3 || body.body_fat_pct > 70)) {
    $("settings-error").textContent = "Le % de graisse doit être entre 3 et 70.";
    $("settings-error").hidden = false;
    return false;
  }
  if (!plan) body.balance_goal = num("set-balance") ?? me.balance_goal;
  // only send the profile if filled in (empty fields don't erase it)
  if ($("set-sex").value) body.sex = $("set-sex").value;
  for (const [id, key] of [["set-birth", "birth_year"], ["set-height", "height_cm"], ["set-weight", "weight_kg"]]) {
    if (num(id) != null) body[key] = num(id);
  }
  try {
    me = await api("/api/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (close) {
      $("settings").close();
      try { await refreshGoal(); } catch {} // the profile changes the goal's calorie target
      loadDay();
    }
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
$("set-sex").addEventListener("change", renderMorpho);
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
    notconfigured: "Strava n'est pas encore configuré sur le serveur (Client ID et secret).",
  }[status];
  if (status === "wronghost" && me?.strava_host) return setTimeout(wrongStravaHost, 300);
  if (msg) setTimeout(() => notice(msg, "Strava"), 300);
}
// Connection started from an address other than the one registered with Strava (else: Strava error page)
function wrongStravaHost() {
  const host = me.strava_host;
  ask({
    title: "Strava",
    submit: "Ouvrir la bonne adresse",
    fields: [{ key: "m", type: "note", label: `Strava n'accepte la connexion que depuis ${host}, l'adresse déclarée dans tes réglages Strava. `
      + "Ouvre Kcal depuis cette adresse (il faudra peut-être te reconnecter), puis relance la connexion." }],
    onSubmit: () => { location.href = `https://${host}/`; },
  });
  const force = Object.assign(document.createElement("a"), {
    href: "/api/strava/connect?force=1", className: "hint",
    textContent: "J'ai changé ce domaine chez Strava : essayer quand même",
  });
  force.style.display = "block";
  $("ask-fields").append(force);
}

// ---------- Goal (weight loss, maintenance, muscle) ----------
let plan = null; // plan computed by the server from the goal
const fmtKg = (n) => Number(n).toLocaleString("fr-FR", { maximumFractionDigits: 1 });
const fmtDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
const goalType = () => ($("goal-form").querySelector("input[name=goal-type]:checked") || {}).value;

async function refreshGoal() {
  const res = await api("/api/goal");
  plan = res.plan;
  delete res.plan;
  me = res;
}

// Features that can be turned off per account (account menu)
function applyFeatures() {
  $("recap-weight").hidden = !me.show_weight;
  $("macro-cards").hidden = !me.show_macros;
  document.body.classList.toggle("show-macros", !!me.show_macros);
  $("protein-card").closest(".card-wrap").hidden = !me.show_protein;
  $("protein-card").closest(".minis").classList.toggle("two", me.show_protein);
  document.querySelectorAll(".when-weight").forEach((el) => (el.hidden = !me.show_weight));
  renderGoalCard();
}
$("feat-protein").onchange = async (e) => {
  try { me = await api("/api/me", jsonPatch({ show_protein: e.target.checked })); applyFeatures(); }
  catch (err) { e.target.checked = !e.target.checked; notice(err.message, "Erreur"); }
};
$("feat-macros").onchange = async (e) => {
  try { me = await api("/api/me", jsonPatch({ show_macros: e.target.checked })); applyFeatures(); loadDay(); }
  catch (err) { e.target.checked = !e.target.checked; notice(err.message, "Erreur"); }
};
$("feat-weight").onchange = async (e) => {
  const on = e.target.checked;
  if (!on && plan) {
    const ok = await confirmBox("Ton objectif en cours sera supprimé. Tes pesées sont gardées, tu les retrouveras en réactivant.",
      { title: "Désactiver l'objectif ?", ok: "Désactiver" });
    if (!ok) { e.target.checked = true; return; }
  }
  try {
    if (!on && plan) await api("/api/goal", { method: "DELETE" });
    me = await api("/api/me", jsonPatch({ show_weight: on }));
    await refreshGoal();
    applyFeatures();
    loadDay();
  } catch (err) { e.target.checked = !on; notice(err.message, "Erreur"); }
};
const jsonPatch = (body) => ({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function renderGoalCard() {
  const showGoal = me?.show_weight !== false;
  $("goal-card").hidden = !plan || !showGoal;
  $("goal-empty").hidden = !!plan || !showGoal;
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
  const prot = me.show_protein ? ` · ${plan.protein_goal ?? "?"} g prot.${plan.protein_manual ? " (réglé à la main)" : ""}` : "";
  $("goal-rate").textContent = `${rate}bilan ${signed(plan.balance_goal)} kcal/j${prot}`;
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
    box.innerHTML = `Bilan visé : <b></b> par jour<span class="r"></span><br>Protéines : <b></b> par jour (${p.protein_manual ? "réglé à la main" : fmtKg(p.protein_per_kg) + " g/kg"})`;
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
  if (!(await confirmBox("Les objectifs actuels de kcal et de protéines restent en place.", { title: "Retirer ton objectif ?", ok: "Retirer" }))) return;
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
  if (tab === "recap") renderRecap();
}

// ---------- Weight history ----------
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

// Path set by the goal: from the start weight to the target weight, at the plan's pace
function goalLine() {
  if (!plan || !plan.start_weight || !plan.target_weight || !plan.start_date) return null;
  const end = plan.eta_date || plan.target_date;
  if (!end) return null;
  return { t0: toTime(plan.start_date), w0: plan.start_weight, t1: toTime(end), w1: plan.target_weight };
}
const goalAt = (g, t) => g.w0 + (g.w1 - g.w0) * Math.min(1, Math.max(0, (t - g.t0) / (g.t1 - g.t0)));

async function renderWeights() {
  weightsCache = await api("/api/weights?days=3650");
  $("weights-add").hidden = !!plan; // the goal card already has "Se peser"
  $("weight-list-title").textContent = `Pesées (${weightsCache.length})`;
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
    const ahead = plan.type === "gain" ? last - expected : expected - last; // > 0: ahead
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

  // Displayed period; "Tout" extends to the goal's deadline
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

  // Vertical scale: weigh-ins + goal path over the period
  const ys = pts.map((p) => p.kg);
  if (g) ys.push(goalAt(g, Math.max(t0, g.t0)), goalAt(g, Math.min(t1, g.t1)));
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi - lo < 2) { const m = (hi + lo) / 2; lo = m - 1; hi = m + 1; }
  const step = niceStep(hi - lo);
  lo = Math.floor((lo - step * 0.3) / step) * step;
  hi = Math.ceil((hi + step * 0.3) / step) * step;
  const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (kg) => pad.t + ((hi - kg) / (hi - lo)) * (H - pad.t - pad.b);

  // Grid and axes, kept subtle
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

  // Goal path (dashed) + end point
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

  // Weigh-in line
  if (pts.length > 1) {
    svgEl("polyline", { points: pts.map((p) => `${x(p.t)},${y(p.kg)}`).join(" "), class: "line" }, svg);
  }
  for (const p of pts) svgEl("circle", { cx: x(p.t), cy: y(p.kg), r: 4, class: "dot" }, svg);
  if (pts.length) { // direct label on the last value only, on the side away from the goal
    const p = pts[pts.length - 1];
    const below = g && p.t >= g.t0 && goalAt(g, p.t) > p.kg && y(p.kg) + 20 < H - pad.b;
    svgEl("text", { x: x(p.t) - (x(p.t) > W - 50 ? 6 : 0), y: below ? y(p.kg) + 18 : y(p.kg) - 10,
      "text-anchor": x(p.t) > W - 50 ? "end" : "middle" }, svg).textContent = `${fmtKg(p.kg)} kg`;
  }

  // Legend (two series: the line and the goal)
  $("chart-key").innerHTML = g ? `<span>Poids</span><span class="ref">Objectif (${plan.label.toLowerCase()})</span>` : "";

  // Hover / touch: vertical guide + tooltip on the nearest weigh-in
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

// Weigh-in table (accessible view of the chart), most recent first
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
      if (!(await confirmBox(`Supprimer la pesée du ${row.children[0].textContent} (${fmtKg(w.kg)} kg) ?`, { title: "Supprimer la pesée" }))) return;
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
$("weights-add").onclick = () => $("weigh-btn").onclick();

// ---------- Onboarding: first-run setup, one question per screen ----------
let ob = null; // answers being collected
let obStep = 0;
const OB_LIFE = [
  ["1.2", "Sédentaire", "Bureau, télétravail, peu de marche"],
  ["1.375", "Un peu actif", "Debout une partie de la journée : enseignant, vendeur, commercial"],
  ["1.55", "Actif", "Debout et en mouvement : infirmier, serveur, artisan"],
  ["1.725", "Très actif", "Métier physique : maçon, déménageur, agriculteur"],
];
const obEl = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d; };
const obChoices = (name, options, current) => `<fieldset class="choices">${options.map(([v, t, sub]) =>
  `<label><input type="radio" name="${name}" value="${v}"${String(current) === v ? " checked" : ""}>
   <span><b>${t}</b>${sub ? `<small>${sub}</small>` : ""}</span></label>`).join("")}</fieldset>`;
const obPick = (name) => ($("ob-body").querySelector(`input[name=${name}]:checked`) || {}).value;
const obNum = (id) => { const v = $(id)?.value.trim().replace(",", "."); return v ? Number(v) : null; };

const OB_STEPS = [
  { // 1. Welcome
    next: "C'est parti",
    render: () => obEl(`<div class="ob-hero">${silhouetteSVG(ob.sex || "m", 2)}</div>
      <h2>Bienvenue sur Kcal, ${me.name} !</h2>
      <p>📸 Prends ton repas en photo, l'IA estime les aliments et les calories.</p>
      <p>✍️ Ou décris-le en texte : « une pomme et un café ».</p>
      <p>💧 L'eau et les boissons remplissent ta jauge d'hydratation.</p>
      <p class="hint">Quelques questions pour calculer tes objectifs : 2 minutes. Tout reste modifiable plus tard.</p>`),
  },
  { // 2. Profile
    render: () => obEl(`<h2>Parle-nous de toi</h2>
      <p class="hint">Pour calculer ce que ton corps dépense chaque jour.</p>
      ${obChoices("ob-sex", [["m", "Homme"], ["f", "Femme"]], ob.sex)}
      <div class="grid2">
        <label class="field">Année de naissance<input id="ob-birth" type="number" inputmode="numeric" value="${ob.birth_year ?? ""}"></label>
        <label class="field">Taille<span class="input-unit"><input id="ob-height" type="number" inputmode="decimal" value="${ob.height_cm ?? ""}"> cm</span></label>
        <label class="field">Poids<span class="input-unit"><input id="ob-weight" type="number" inputmode="decimal" step="0.1" value="${ob.weight_kg ?? ""}"> kg</span></label>
      </div>`),
    save() {
      ob.sex = obPick("ob-sex") || ob.sex;
      ob.birth_year = obNum("#ob-birth".slice(1)) ?? ob.birth_year;
      const by = obNum("ob-birth"), h = obNum("ob-height"), w = obNum("ob-weight");
      if (by != null && (by < 1900 || by > new Date().getFullYear() - 10)) return "Année de naissance invalide.";
      if (h != null && (h < 50 || h > 260)) return "Taille entre 50 et 260 cm.";
      if (w != null && (w < 20 || w > 400)) return "Poids entre 20 et 400 kg.";
      Object.assign(ob, { birth_year: by, height_cm: h, weight_kg: w });
    },
  },
  { // 3. Body shape
    render() {
      const sex = ob.sex || "m";
      const d = obEl(`<h2>Ta morphologie</h2>
        <p class="hint">Choisis le renard qui te ressemble le plus : il estime ton % de graisse, et donc ta masse musculaire.</p>
        <div class="morpho" id="ob-morpho"></div>
        <label class="field">Ou ton % de graisse mesuré (balance, mesure)
          <span class="input-unit"><input id="ob-fat" type="number" inputmode="decimal" step="0.5" placeholder="—" value="${ob.body_fat_pct || ""}"> %</span></label>`);
      const box = d.querySelector("#ob-morpho");
      MORPHOLOGY[sex].fat.forEach((fat, i) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "morpho-opt"; b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(ob.morphology === i + 1));
        b.innerHTML = `${silhouetteSVG(sex, i + 1)}<b></b><small>~${fat} %</small>`;
        b.querySelector("b").textContent = MORPHOLOGY[sex].label[i];
        b.onclick = () => {
          ob.morphology = ob.morphology === i + 1 ? 0 : i + 1;
          box.querySelectorAll(".morpho-opt").forEach((o, k) => o.setAttribute("aria-checked", String(ob.morphology === k + 1)));
        };
        box.append(b);
      });
      return d;
    },
    save() {
      const fat = obNum("ob-fat");
      if (fat != null && (fat < 3 || fat > 70)) return "Le % de graisse doit être entre 3 et 70.";
      ob.body_fat_pct = fat || 0;
    },
  },
  { // 4. Daily activity
    render: () => obEl(`<h2>Ton quotidien</h2>
      <p class="hint">Hors sport : ton métier et tes déplacements.</p>${obChoices("ob-life", OB_LIFE, ob.life_factor)}`),
    save() { ob.life_factor = Number(obPick("ob-life") || ob.life_factor || 1.2); },
  },
  { // 5. Expenditure source
    render: () => obEl(`<h2>Ton sport</h2>
      <p class="hint">Kcal peut ajouter les calories de tes activités à ton objectif du jour.</p>
      ${obChoices("ob-src", [
        ["strava", "Strava", "Tes activités enregistrées sur Strava s'ajoutent (connexion à la fin)"],
        ["garmin", "Montre Garmin", "Ta dépense mesurée par la montre (connexion à la fin)"],
        ["none", "Rien pour l'instant", "Un objectif calculé d'après ton profil"],
      ], ob.energy_source)}`),
    save() { ob.energy_source = obPick("ob-src") || ob.energy_source || "none"; },
  },
  { // 6. Goal
    render() {
      const d = obEl(`<h2>Ton objectif</h2>
        ${obChoices("ob-goal", [["lose", "📉 Perdre du poids"], ["maintain", "⚖️ Garder mon poids"], ["gain", "💪 Prendre du muscle"], ["", "Pas d'objectif pour l'instant"]], ob.goal ?? "")}
        <div id="ob-goal-more" class="grid2">
          <label class="field">Poids visé<span class="input-unit"><input id="ob-target" type="number" inputmode="decimal" step="0.1" value="${ob.target_weight ?? ""}"> kg</span></label>
          <label class="field">D'ici le<input id="ob-date" type="date" value="${ob.target_date ?? ""}"></label>
        </div>
        <p class="hint">Kcal en déduit le bilan calorique et les protéines de chaque jour, et les ajuste à chaque pesée.</p>`);
      const sync = () => { d.querySelector("#ob-goal-more").hidden = !["lose", "gain"].includes(obPick("ob-goal")); };
      d.addEventListener("change", sync);
      setTimeout(sync);
      return d;
    },
    save() {
      ob.goal = obPick("ob-goal") ?? "";
      ob.target_weight = obNum("ob-target");
      ob.target_date = $("ob-date")?.value || null;
      if (ob.goal && !ob.weight_kg) return "Indique ton poids (étape « Parle-nous de toi ») pour définir un objectif.";
      if (ob.goal === "lose" && ob.target_weight && ob.target_weight >= ob.weight_kg) return "Le poids visé doit être inférieur à ton poids actuel.";
    },
  },
  { // 7. Features, then save everything
    next: "Terminer",
    render: () => obEl(`<h2>Ce que tu veux suivre</h2>
      <div class="features">
        <label class="switch-row"><span>💪 Protéines</span><input id="ob-prot" type="checkbox" role="switch"${ob.show_protein ? " checked" : ""}></label>
        <label class="switch-row"><span>🎯 Objectif de poids et pesées</span><input id="ob-weightfeat" type="checkbox" role="switch"${ob.show_weight ? " checked" : ""}></label>
      </div>
      <p class="hint">Modifiable à tout moment dans le menu du compte.</p>`),
    async save() {
      ob.show_protein = $("ob-prot").checked;
      ob.show_weight = $("ob-weightfeat").checked;
      return finishOnboarding();
    },
  },
  { // 8. Summary
    next: "Commencer",
    back: false,
    render() {
      const d = obEl(`<div class="ob-hero">${silhouetteSVG(ob.sex || "m", ob.morphology || 2)}</div><h2>Tout est prêt !</h2><div id="ob-recap" class="ob-recap">Calcul…</div>`);
      Promise.all([api("/api/metabolism").catch(() => null)]).then(([m]) => {
        const lines = [];
        if (plan?.kcal_goal || me.energy_source === "none") lines.push(["🔥 Calories", `${fmt(plan?.kcal_goal || me.kcal_goal)} kcal / jour`]);
        else lines.push(["🔥 Calories", "ta dépense du jour " + signed(me.balance_goal) + " kcal"]);
        if (me.show_protein) lines.push(["💪 Protéines", `${fmt(me.protein_goal || 100)} g / jour`]);
        lines.push(["💧 Eau", `${fmt(me.water_goal)} ml / jour`]);
        if (m?.bmr) lines.push(["⚙️ Métabolisme de base", `${fmt(m.bmr)} kcal`]);
        const box = d.querySelector("#ob-recap");
        box.innerHTML = "";
        for (const [k, v] of lines) box.append(obEl(`<span></span><b></b>`)), box.lastChild.firstChild.textContent = k, box.lastChild.lastChild.textContent = v;
        box.append(obEl(`<p class="hint">Astuce : note tes repas et pèse-toi environ une fois par semaine. Après 3 semaines, Kcal calibre tes objectifs sur tes vrais résultats.</p>`));
        if (me.energy_source !== "none" && !(me.strava_connected || me.garmin_connected)) {
          box.append(obEl(`<p class="hint">Il reste à connecter ${me.energy_source === "strava" ? "Strava" : "ta montre Garmin"} : on t'y emmène en touchant « Commencer ».</p>`));
        }
      });
      return d;
    },
    async save() {
      $("onboard").close();
      if (me.energy_source === "strava" && !me.strava_connected) return void (location.href = "/api/strava/connect");
      if (me.energy_source === "garmin" && !me.garmin_connected) openSettings();
    },
  },
];

async function finishOnboarding(skipped = false) {
  const body = { onboarded: true };
  if (!skipped) {
    for (const k of ["sex", "birth_year", "height_cm", "weight_kg", "life_factor", "energy_source", "show_protein", "show_weight"]) {
      if (ob[k] != null && ob[k] !== "") body[k] = ob[k];
    }
    body.morphology = ob.morphology || 0;
    body.body_fat_pct = ob.body_fat_pct || 0;
  }
  me = await api("/api/me", jsonPatch(body));
  if (!skipped && ob.goal) {
    await api("/api/goal", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      type: ob.goal, current_weight: ob.weight_kg,
      target_weight: ob.goal === "maintain" ? null : ob.target_weight, target_date: ob.goal === "maintain" ? null : ob.target_date,
    }) });
  }
  try { await refreshGoal(); } catch {}
  me = await api("/api/me");
  applyFeatures();
  loadDay();
}

function renderOnboardStep() {
  const step = OB_STEPS[obStep];
  $("ob-bar").style.width = `${((obStep + 1) / OB_STEPS.length) * 100}%`;
  $("ob-error").hidden = true;
  $("ob-body").replaceChildren(step.render());
  $("ob-body").scrollTop = 0;
  $("ob-back").hidden = obStep === 0 || step.back === false;
  $("ob-skip-all").hidden = obStep === OB_STEPS.length - 1;
  $("ob-next").textContent = step.next || "Continuer";
}

function openOnboarding() {
  if ($("account").open) $("account").close();
  ob = {
    sex: me.sex, birth_year: me.birth_year, height_cm: me.height_cm, weight_kg: me.weight_kg,
    morphology: me.morphology || 0, body_fat_pct: me.body_fat_pct, life_factor: me.life_factor ?? 1.2,
    energy_source: me.energy_source, goal: plan?.type ?? "", target_weight: plan?.target_weight, target_date: plan?.target_date,
    show_protein: me.show_protein, show_weight: me.show_weight,
  };
  obStep = 0;
  renderOnboardStep();
  $("onboard").showModal();
}

$("ob-next").onclick = async () => {
  $("ob-next").disabled = true;
  try {
    const err = await OB_STEPS[obStep].save?.();
    if (err) { $("ob-error").textContent = err; $("ob-error").hidden = false; return; }
    if (obStep < OB_STEPS.length - 1) { obStep++; renderOnboardStep(); }
  } catch (e) {
    $("ob-error").textContent = e.message; $("ob-error").hidden = false;
  } finally { $("ob-next").disabled = false; }
};
$("ob-back").onclick = () => { OB_STEPS[obStep].save?.(); obStep = Math.max(0, obStep - 1); renderOnboardStep(); };
$("ob-skip-all").onclick = async () => {
  $("onboard").close();
  if (!me.onboarded) await finishOnboarding(true).catch(() => {});
};
$("onboard").addEventListener("cancel", (e) => e.preventDefault()); // Escape doesn't dismiss half-way
$("open-onboard").onclick = openOnboarding;

async function startApp() {
  handleOAuthReturn();
  $("account-btn").textContent = (me.name || "?").trim().charAt(0).toUpperCase();
  day = todayISO();
  try { await refreshGoal(); } catch {} // no goal or offline: carry on
  applyFeatures();
  if (!me.onboarded) openOnboarding();
  loadDay().catch(showError);
  flushQueue();
}
function showError(err) {
  if (!$("auth").hidden) return; // the login screen is already shown
  $("empty").hidden = false;
  $("empty").textContent = "Serveur injoignable : " + err.message;
}

api("/api/me")
  .then((user) => { me = user; startApp(); })
  .catch(showError);
// opens without a connection, with the last data seen (sw.js)
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
