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

async function api(path, opts) {
  const r = await fetch(path, opts);
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
    throw new Error(msg);
  }
  return r.json();
}

// ---------- Daily log ----------
async function loadDay() {
  $("day-label").textContent = dayLabel(day);
  $("next").disabled = day >= todayISO();
  const { water_goal } = me;
  const shownDay = day;
  const [data, energy] = await Promise.all([
    api(`/api/meals?day=${day}`),
    me.energy_source === "none" ? null : api(`/api/energy?day=${day}`).catch((err) => ({ error: err.message, activities: [] })),
  ]);
  if (shownDay !== day) return; // the user switched to another day meanwhile

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

  // ----- Protein
  const pGoal = proteinGoal();
  $("protein-total").textContent = fmt(data.total_protein_g ?? 0);
  $("protein-goal").textContent = fmt(pGoal);
  $("protein-fill").style.width = Math.min(100, ((data.total_protein_g ?? 0) / pGoal) * 100) + "%";

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

  facts = { kcal_goal, model, sportMin, sportWater, alcoholG, alcoholWater, pGoal };

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
    el.className = "meal";
    const time = new Date(m.eaten_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
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
    el.querySelector(".remove").onclick = async () => {
      if (!(await confirmBox(`Supprimer « ${m.title} » ?`, { title: "Supprimer le repas" }))) return;
      await api(`/api/meals/${m.id}`, { method: "DELETE" });
      loadDay();
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
const INFO_TITLES = { eaten: "Objectif de calories", burned: "Dépense du jour", projection: "Projection", protein: "Protéines",
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
  analyze(() => api("/api/analyze", { method: "POST", body: form }), { image: URL.createObjectURL(file) });
}

// Meal described in text: "an apple and a glass of water"
$("text-btn").onclick = () => ask({
  title: "✍️ Ajouter en texte",
  submit: "Analyser",
  fields: [{ key: "text", type: "textarea", label: "Qu'as-tu mangé ou bu ?",
             placeholder: "ex : une pomme, un yaourt et un verre d'eau" }],
  onSubmit: ({ text }) => {
    analyze(() => api("/api/analyze-text", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
    }), { text });
  },
});

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

async function analyze(request, { image, text }) {
  draft = null;
  $("review").hidden = false;
  document.body.classList.add("reviewing");
  $("empty").hidden = true;
  $("preview").hidden = !image;
  if (image) $("preview").src = image;
  $("review-text").hidden = !text;
  $("review-text").textContent = text ? `« ${text} »` : "";
  $("analyzing").hidden = false;
  $("result").hidden = true;
  $("error").hidden = true;
  $("fix-status").hidden = true;
  $("fix-text").value = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
  try {
    const res = await request();
    draft = { title: res.title || "Repas", items: res.items || [], water_ml: res.water_ml || 0 };
    if (!draft.items.length && !draft.water_ml) {
      throw new Error(text ? "Rien de reconnu. Précise ta description ou ajoute-le à la main."
                           : "Rien de reconnu. Ajoute-le à la main ou reprends la photo.");
    }
    renderDraft();
  } catch (err) {
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
    const p100 = row.querySelector(".p100");
    p100.value = Math.round((it.protein_100g || 0) * 10) / 10;
    p100.oninput = () => (it.protein_100g = Number(p100.value) || 0);
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
        // a non-alcoholic drink also counts toward hydration
        draft.water_ml = Math.max(0, (draft.water_ml || 0) + (est.drink_ml || 0) - (it.drink_ml || 0));
        it.drink_ml = est.drink_ml || 0;
        renderDraftWater();
        if (it.fresh) it.grams = est.grams || it.grams;
        it.fresh = false;
        if (!row.isConnected) return renderDraft(); // list redrawn during the estimate
        grams.value = Math.round(it.grams);
        k100.value = Math.round(it.kcal_100g);
        p100.value = Math.round((it.protein_100g || 0) * 10) / 10;
      } catch (err) {
        it.estimatedFor = null;
        $("fix-status").textContent = `Calcul impossible pour « ${n} » : ${err.message}`;
        $("fix-status").hidden = false;
      }
      refresh();
    };
    grams.oninput = () => { it.grams = Number(grams.value) || 0; refresh(); };
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
$("cancel").onclick = closeReview;
$("save").onclick = async () => {
  const items = draft.items.filter((it) => it.name.trim());
  const water_ml = draft.water_ml || 0;
  if (!items.length && !water_ml) return notice("Ajoute au moins un aliment ou de l'eau.");
  $("save").disabled = true;
  try {
    // The meal is filed under the displayed day (handy to catch up on yesterday)
    const eaten_at = draft.id || day === todayISO() ? null : `${day}T12:00:00`;
    await api(draft.id ? `/api/meals/${draft.id}` : "/api/meals", {
      method: draft.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: draft.title || (items.length ? "Repas" : "Eau"), items, water_ml, eaten_at }),
    });
    closeReview();
  } catch (err) {
    notice(err.message, "Erreur");
  } finally {
    $("save").disabled = false;
  }
};

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
  $("feat-weight").checked = me.show_weight;
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

// Body widths (half-widths from the centre line x = 50) per level 1 (very lean) … 5 (heavy)
const SHAPES = {
  m: {
    shoulder: [15.5, 18.5, 17, 18, 19.5], chest: [12.5, 15.5, 14.5, 16.5, 19],
    waist: [10, 11.5, 12.5, 16, 20], belly: [10, 11.5, 13, 17.5, 22], hip: [11.5, 12.5, 13.2, 15.5, 18.5],
    thigh: [6.2, 7.6, 7.6, 9, 10.6], calf: [4.4, 5.4, 5.2, 6, 7], arm: [3.4, 4.6, 4.2, 5, 6], neck: [3.6, 4.4, 4.1, 4.5, 5.2],
  },
  f: {
    shoulder: [13.5, 14.5, 14.5, 15.5, 17], chest: [12, 13, 13.5, 15.5, 18],
    waist: [8.6, 9.6, 10.8, 13.8, 17], belly: [9.5, 10.5, 12, 15.5, 19], hip: [13.5, 14.5, 15.8, 18, 21],
    thigh: [6.4, 7.4, 8, 9.4, 11.2], calf: [4.2, 4.9, 5.1, 5.9, 6.9], arm: [3, 3.6, 3.7, 4.4, 5.4], neck: [3.2, 3.5, 3.5, 3.9, 4.5],
  },
};

// Outline of a limb around its axis: [x, y, halfWidth] stations, returns a closed smooth path
function limb(axis) {
  const L = [], R = [];
  for (let k = 0; k < axis.length; k++) {
    const [x, y, w] = axis[k];
    const [nx0, ny0] = axis[Math.max(0, k - 1)], [nx1, ny1] = axis[Math.min(axis.length - 1, k + 1)];
    let dx = nx1 - nx0, dy = ny1 - ny0; const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    L.push([x - dy * w * -1, y + dx * w * -1]); R.push([x + dy * w * -1, y - dx * w * -1]);
  }
  return spline([...L, ...R.reverse()], true);
}

// Front-view silhouette for a body shape level (1 = very lean … 5 = heavy)
function silhouetteSVG(sex, level) {
  const s = SHAPES[sex], i = level - 1, g = (k) => s[k][i];
  const cx = 50;
  const sh = g("shoulder"), ch = g("chest"), wa = g("waist"), be = g("belly"), hi = g("hip");
  const th = g("thigh"), ca = g("calf"), ar = g("arm"), ne = g("neck");
  // Torso (shoulders to hips), mirrored
  const half = [
    [ne * 0.9, 13], [ne, 18.5], [ne + 1.2, 21.6], [ne + 4, 23.2], [sh - 1.6, 25], [sh, 28.5],
    [ch, 35], [(ch + wa) / 2 + 0.6, 43], [wa, 50], [be, 57.5], [hi, 65.5], [hi - 0.3, 72], [hi * 0.62, 77.5],
  ];
  const torso = spline([...half.map(([x, y]) => [cx + x, y]), [cx, 78.5], ...half.slice().reverse().map(([x, y]) => [cx - x, y])], true);
  // Legs: built from the inner edge (gap between the legs) and the half-width at each height
  const thigh = Math.min(th, (hi - 0.4) / 2);
  const calf = Math.min(ca, thigh * 0.58);
  const leg = (side) => limb([
    [0.4, 70, (hi - 0.4) / 2], [0.7, 79, thigh * 0.93], [1.1, 86, (thigh * 0.93 + calf * 0.9) / 2], [1.4, 92.5, calf * 0.88], [1.6, 100.5, calf],
    [2.9, 113.5, calf * 0.52], [3.1, 118.5, calf * 0.58],
  ].map(([inner, y, hw]) => [cx + side * (inner + hw), y, hw]));
  // Feet
  const foot = (side) => `<ellipse cx="${cx + side * 6.2}" cy="120" rx="2.9" ry="1.6"/>`;
  // Arms hang just outside the widest point of the waist / hips
  const wide = Math.max(wa, be, hi);
  const arm = (side) => limb([
    [cx + side * (sh - ar * 0.85), 29, ar * 0.7], [cx + side * (sh + ar * 0.12), 32, ar * 0.64],
    [cx + side * (Math.max(sh, wide) + ar * 0.5 + 0.8), 45, ar * 0.48],
    [cx + side * (wide + ar * 0.4 + 1.6), 58, ar * 0.38], [cx + side * (wide + ar * 0.35 + 1.8), 65, ar * 0.42], [cx + side * (wide + ar * 0.3 + 1.8), 68.5, ar * 0.3],
  ]);
  // Fox head, front view: big pointed ears, cheek fluff, snout
  const X = (dx) => (cx + dx).toFixed(2);
  const head = `<path d="M${X(0)},17.8 Q${X(-3)},16.2 ${X(-4.6)},13.6 L${X(-8.4)},12.4 Q${X(-7.6)},8.6 ${X(-6.6)},6.4
    L${X(-8.6)},-3 L${X(-2.6)},3.4 Q${X(0)},2.6 ${X(2.6)},3.4 L${X(8.6)},-3 L${X(6.6)},6.4
    Q${X(7.6)},8.6 ${X(8.4)},12.4 L${X(4.6)},13.6 Q${X(3)},16.2 ${X(0)},17.8 Z"/>`;
  const face = `<g class="cut">
    <path d="M${X(-7.2)},-0.4 L${X(-3.6)},3.6 L${X(-6.2)},5.4 Z"/><path d="M${X(7.2)},-0.4 L${X(3.6)},3.6 L${X(6.2)},5.4 Z"/>
    <ellipse cx="${X(-2.9)}" cy="9" rx="1.1" ry="1.4"/><ellipse cx="${X(2.9)}" cy="9" rx="1.1" ry="1.4"/>
    <ellipse cx="${X(0)}" cy="15.6" rx="1.3" ry="0.9"/></g>`;
  // Female version: a bow on the right ear
  const bow = sex === "f"
    ? `<path class="bow" d="M${X(5.2)},2.4 L${X(2.6)},0 L${X(2.4)},4.4 Z M${X(5.2)},2.4 L${X(7.8)},4.2 L${X(7)},-0.2 Z"/><circle class="bow" cx="${X(5.2)}" cy="2.4" r="0.9"/>`
    : "";
  // Bushy tail behind the right hip, curling up, with a white tip
  const tx = cx + wide;
  const tail = spline([[tx - 4, 72], [tx + 4, 79.5], [tx + 12, 73.5], [tx + 14.6, 60], [tx + 11.2, 46.5], [tx + 8.2, 50.5], [tx + 7.4, 61], [tx + 2.8, 69]], true);
  const tip = spline([[tx + 11.1, 46.6], [tx + 14.2, 53.5], [tx + 14.3, 58], [tx + 11, 55.6], [tx + 8.5, 50.4]], true);
  return `<svg viewBox="15 -4 72 127" aria-hidden="true">` +
    `<path d="${tail}"/><path class="tip" d="${tip}"/>${head}` +
    `<path d="${torso}"/><path d="${leg(1)}"/><path d="${leg(-1)}"/>${foot(1)}${foot(-1)}<path d="${arm(1)}"/><path d="${arm(-1)}"/>` +
    `${face}${bow}</svg>`;
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
  $("protein-card").closest(".card-wrap").hidden = !me.show_protein;
  $("protein-card").closest(".minis").classList.toggle("two", me.show_protein);
  document.querySelectorAll(".when-weight").forEach((el) => (el.hidden = !me.show_weight));
  renderGoalCard();
}
$("feat-protein").onchange = async (e) => {
  try { me = await api("/api/me", jsonPatch({ show_protein: e.target.checked })); applyFeatures(); }
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
  if ($("weights-dialog").open) renderWeights();
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
$("weights-close").onclick = () => $("weights-dialog").close();
$("weights-add").onclick = () => $("weigh-btn").onclick();
$("chart-btn").onclick = openWeights;
$("open-weights").onclick = openWeights;

async function startApp() {
  handleOAuthReturn();
  $("account-btn").textContent = (me.name || "?").trim().charAt(0).toUpperCase();
  day = todayISO();
  try { await refreshGoal(); } catch {} // no goal or offline: carry on
  applyFeatures();
  loadDay().catch(showError);
}
function showError(err) {
  if (!$("auth").hidden) return; // the login screen is already shown
  $("empty").hidden = false;
  $("empty").textContent = "Serveur injoignable : " + err.message;
}

api("/api/me")
  .then((user) => { me = user; startApp(); })
  .catch(showError);
