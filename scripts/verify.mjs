#!/usr/bin/env node
// Vérification post-installation de RE-SEARCH (sans dépendance, Node 24 ou plus, comme package.json).
//
//   node scripts/verify.mjs <URL du Worker> <ADMIN_KEY> [--setup]
//   RESEARCH_URL=https://... ADMIN_KEY=... node scripts/verify.mjs
//
// Appels : GET /?k= (tableau de bord), GET /health sans clé (doit être refusé), GET /health et GET /status (lecture seule). La clé
// part dans l'en-tête « Authorization: Bearer », sauf pour le tableau de bord (route de navigateur). Avec --setup seulement,
// GET /telegram/setup installe le webhook (une écriture côté Telegram) et affiche le code de liaison à envoyer au bot.
// Sortie : 0 si tout est sain, 1 s'il reste un problème, 2 si le Worker est injoignable ou la clé refusée. La clé n'est jamais affichée.

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [urlArg, keyArg] = args.filter((a) => !a.startsWith("--"));
const base = (urlArg ?? process.env.RESEARCH_URL ?? "").replace(/\/+$/, "");
const key = keyArg ?? process.env.ADMIN_KEY ?? "";

if (!/^https?:\/\//.test(base) || !key) {
  console.error(
    "Usage : node scripts/verify.mjs <URL du Worker, ex. https://re-search.mon-compte.workers.dev> <ADMIN_KEY> [--setup]",
  );
  process.exit(2);
}

const TIMEOUT_MS = 20_000;
/** auth : "header" (Authorization: Bearer), "query" (?k=, tableau de bord seulement) ou "none". */
async function call(path, { auth = "header" } = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${base}${path}${auth === "query" ? `${sep}k=${encodeURIComponent(key)}` : ""}`;
  const headers = auth === "header" ? { authorization: `Bearer ${key}` } : {};
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* pas du JSON */
    }
    return { status: res.status, type: res.headers.get("content-type") ?? "", text, json };
  } catch (e) {
    return { status: 0, type: "", text: "", json: null, error: e instanceof Error ? e.message : String(e) };
  }
}

const problems = [];
const warnings = [];
const line = (ok, label, detail = "") => console.log(`  ${ok ? "OK " : "KO "} ${label}${detail ? ` : ${detail}` : ""}`);

console.log(`Vérification de ${base}\n`);

// 1. Tableau de bord (privé par défaut : avec la clé en ?k=, le Worker répond par une redirection qui pose un cookie).
console.log("Tableau de bord (GET /)");
const home = await call("/", { auth: "query" });
if (home.status === 0) {
  line(false, "Worker injoignable", home.error);
  console.log(
    "\nSi le Worker vient d'être déployé, attendre une minute. Sinon : adresse https://<nom>.<sous-domaine>.workers.dev, `wrangler deploy` réussi ?",
  );
  process.exit(2);
}
// Privé (défaut) : 302 vers la même page avec un cookie ; public (DASHBOARD_PUBLIC="true") : 200 et du HTML.
const homeOk =
  home.status === 302 || (home.status === 200 && home.type.includes("text/html") && home.text.length > 500);
line(homeOk, home.status === 302 ? "tableau de bord privé, clé acceptée" : "page HTML servie", `HTTP ${home.status}`);
if (!homeOk) problems.push("le tableau de bord ne répond pas correctement (GET /)");

// 2. Les routes d'administration refusent sans clé.
console.log("\nProtection des routes d'administration");
const anon = await call("/health", { auth: "none" });
line(anon.status === 403, "GET /health sans clé refusé", `HTTP ${anon.status}`);
if (anon.status !== 403) problems.push("GET /health sans clé n'est pas refusé (403 attendu)");

// 3. /health.
console.log("\nRapport d'installation (GET /health)");
const hr = await call("/health");
if (hr.status === 403) {
  line(false, "clé refusée", "ADMIN_KEY différente du secret du Worker (secret à reposer : docs/playbook.md, étape 5)");
  process.exit(2);
}
if (hr.status === 404) {
  line(false, "route absente", "le Worker déployé est antérieur à la route /health : redéployer le dépôt à jour");
  process.exit(2);
}
const h = hr.json;
if (hr.status !== 200 || !h || typeof h !== "object") {
  line(false, "réponse inattendue", `HTTP ${hr.status}`);
  process.exit(2);
}
line(true, "réponse reçue", h.now);
console.log(
  `  Zones : ${h.zones.join(", ")}   Loyer : ${h.criteria.rentMin}-${h.criteria.rentMax} EUR   Surface min : ${h.criteria.surfaceMin} m2   Pièces min : ${h.criteria.roomsMin}`,
);

console.log("\nSecrets (présence seulement)");
for (const [name, set] of Object.entries(h.secrets)) {
  const optional = ["TELEGRAM_WEBHOOK_SECRET", "CALLMEBOT_PHONE", "CALLMEBOT_APIKEY"].includes(name);
  // TELEGRAM_CHAT_ID : « OK » = une conversation est liée (par /start <code> ou par ce secret).
  const label = name === "TELEGRAM_CHAT_ID" ? "conversation Telegram liée" : name;
  const missing =
    name === "TELEGRAM_CHAT_ID"
      ? " (pas encore liée : /telegram/setup donne le code, puis /start <code> au bot)"
      : " (absent)";
  console.log(`  ${set ? "OK " : optional ? "-- " : "KO "} ${label}${set ? "" : optional ? " (facultatif)" : missing}`);
}

console.log("\nBindings");
for (const [name, set] of Object.entries(h.bindings)) {
  const optional = ["AI", "SELF", "VECTORIZE", "BROWSER"].includes(name);
  console.log(
    `  ${set ? "OK " : optional ? "-- " : "KO "} ${name}${set ? "" : name === "SELF" ? " (inutile : le Worker s'appelle par ctx.exports)" : optional ? " (non déclaré)" : " (absent)"}`,
  );
}

console.log("\nMigrations D1");
if (h.migrations)
  line(h.migrations.count > 0, `${h.migrations.count} appliquée(s)`, `dernière : ${h.migrations.last ?? "aucune"}`);
else
  line(
    false,
    "table d1_migrations illisible (le Worker applique ses migrations au premier cron ou à la première requête : réessayer après une minute)",
  );

console.log("\nFonctions optionnelles");
const on = h.switches.filter((s) => s.on);
const off = h.switches.filter((s) => !s.on);
for (const s of on)
  console.log(
    `  ${s.missing.length ? "KO " : "ON "} ${s.name}${s.missing.length ? ` (manque : ${s.missing.join(", ")})` : ""}  -> ${s.doc}`,
  );
for (const s of off) console.log(`  OFF ${s.name}  -> ${s.doc}`);
if (!on.length)
  console.log("  (toutes éteintes : installation de base, voir docs/fonctions.md pour les activer une par une)");

console.log("\nBudget Workers AI du jour (UTC)");
if (h.ai) {
  console.log(`  ${h.ai.spent} / ${h.ai.cap} neurons (plan gratuit : 10 000)`);
  for (const [f, v] of Object.entries(h.ai.byFeature))
    console.log(`    ${f} : ${v.spent}${v.cap ? ` / ${v.cap}` : ""}`);
} else console.log("  illisible (table ai_usage absente : migrations non appliquées ?)");

console.log("\nSources");
if (h.sources) {
  console.log(
    `  ${h.sources.readable} lues par le cron sur ${h.sources.registry} au registre ; ${h.sources.neverRun} jamais passée(s)`,
  );
  for (const b of h.sources.broken) console.log(`  KO  ${b.id} en panne : ${b.error ?? "?"}`);
  for (const s of h.sources.stale) console.log(`  !!  ${s.id} sans passage depuis ${s.minutes} min`);
  if (h.sources.neverRun > 0)
    warnings.push(
      "des sources n'ont encore jamais passé (normal juste après le déploiement : attendre quelques minutes dans la fenêtre horaire)",
    );
} else console.log("  illisibles (table source_state absente : migrations non appliquées ?)");

// 4. /status.
console.log("\nÉtat des sources (GET /status)");
const st = await call("/status");
const stOk = st.status === 200 && Array.isArray(st.json);
line(stOk, "réponse lue", stOk ? `${st.json.length} ligne(s)` : `HTTP ${st.status}`);
if (!stOk) problems.push("GET /status ne répond pas correctement");

// 5. Webhook Telegram (écriture côté Telegram : seulement sur demande).
console.log("\nWebhook Telegram (GET /telegram/setup)");
if (flags.has("--setup")) {
  const su = await call("/telegram/setup");
  if (su.status === 404) line(true, "TELEGRAM_INTERACTIVE éteint : route absente (normal)");
  else {
    const ok = su.status === 200 && su.json?.setWebhook?.ok === true;
    line(ok, "webhook installé", `HTTP ${su.status}`);
    if (ok && su.json?.link?.code)
      console.log(`  Conversation non liée : envoyer à votre bot Telegram  /start ${su.json.link.code}`);
    if (!ok) problems.push(`/telegram/setup a échoué (HTTP ${su.status}) : ${su.text.slice(0, 200)}`);
  }
} else {
  console.log(
    "  non appelé (cette route installe le webhook chez Telegram) ; relancer avec --setup pour l'installer et obtenir le code de liaison",
  );
}

for (const p of h.problems) problems.push(p);

console.log(`\n${"=".repeat(60)}`);
if (!problems.length) {
  console.log("BILAN : installation saine.");
  for (const w of warnings) console.log(`  note : ${w}`);
  process.exit(0);
}
console.log(`BILAN : ${problems.length} problème(s) à traiter`);
for (const p of problems) console.log(`  - ${p}`);
for (const w of warnings) console.log(`  note : ${w}`);
process.exit(1);
