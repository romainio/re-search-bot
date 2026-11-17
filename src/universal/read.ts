import { runJson } from "../ai/run";
import { canSpend } from "../ai/budget";
import {
  UNIVERSAL_BROWSER_MIN_EVERY,
  UNIVERSAL_BROWSER_TIMEOUT_MS,
  UNIVERSAL_CONVERT_TIMEOUT_MS,
  UNIVERSAL_ESTIMATE_NEURONS,
  UNIVERSAL_HTML_MAX_BYTES,
  UNIVERSAL_MAX_LISTINGS,
  UNIVERSAL_MAX_TOKENS,
  UNIVERSAL_MIN_EVERY,
  UNIVERSAL_MODEL,
  UNIVERSAL_RECHECK_DAYS,
  UNIVERSAL_TIMEOUT_MS,
  UNIVERSAL_UNCHANGED_MIN_CHARS,
} from "../config/universal";
import { fetchSource } from "../fetch-source";
import type { Env, Listing, SourceDef } from "../types";
import { fingerprint, loadState, saveState } from "./fingerprint";
import { EMPTY_STATE, reduceMarkdown } from "./reduce";
import { validateExtraction } from "./schema";
import type { ExtractContext } from "./schema";
import { withTimeout } from "../timeout";
import { DAY_MS } from "../time";

/**
 * Résultat d'une lecture universelle. ok : `unchanged` si l'empreinte est celle de la dernière lecture réussie (annonces de cette
 * lecture, `savedNeurons` évités), sinon `neurons` dépensés. fail : passage en échec. skipped : lecture non tentée sans faute de
 * la source (fonction éteinte, budget épuisé), qui ne doit pas passer « en panne » faute de neurons.
 */
export type UniversalResult =
  | { status: "ok"; listings: Listing[]; unchanged?: true; savedNeurons?: number; neurons?: number }
  | { status: "fail"; reason: string }
  | { status: "skipped"; reason: string };

const FAIL_BROWSER = "rendu navigateur indisponible";

export const universalOn = (env: Env): boolean => env.UNIVERSAL_READER === "true";

/** Consigne du modèle : extraction littérale, jamais d'invention (le schéma strict refuse le reste). */
export function buildMessages(text: string): { role: string; content: string }[] {
  const system = [
    "Tu extrais des annonces de LOCATION immobilière d'un texte Markdown de page web ou de mail.",
    'Réponds UNIQUEMENT par un objet JSON : {"listings":[...],"empty":false}.',
    "Chaque annonce a exactement ces champs, null quand l'information n'est pas écrite dans le texte : url (lien de l'annonce, recopié tel quel), title, price (loyer mensuel en euros, nombre), price_kind (\"CC\" seulement si le texte dit charges comprises, \"HC\" seulement s'il dit hors charges, sinon null), charges (nombre, seulement si écrit), surface (m², nombre), rooms (pièces, entier), floor (étage, nombre), address, postal_code (5 chiffres), district, photo (URL https recopiée), property_type.",
    "N'invente rien : ne déduis pas un champ, ne calcule pas, ne complète pas. Ignore les ventes, parkings, bureaux et publicités. Un nombre absent du texte est null.",
    "\"empty\" vaut true seulement si la page dit explicitement qu'aucun bien n'est disponible.",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: text },
  ];
}

/** Extraction d'un Markdown : réduction, budget, appel du modèle, validation stricte ; partagée avec les alertes par mail. */
export async function extractListings(
  env: Env,
  markdown: string,
  ctx: Omit<ExtractContext, "text" | "max"> & { max?: number },
  feature = "universal",
): Promise<UniversalResult> {
  return extractReduced(env, markdown, reduceMarkdown(markdown), ctx, feature);
}

/** extractListings sur un texte déjà réduit : la réduction n'est faite qu'une fois par lecture. */
async function extractReduced(
  env: Env,
  markdown: string,
  text: string,
  ctx: Omit<ExtractContext, "text" | "max"> & { max?: number },
  feature: string,
): Promise<UniversalResult> {
  if (!text)
    return EMPTY_STATE.test(markdown)
      ? { status: "ok", listings: [] }
      : { status: "fail", reason: "aucune annonce dans la page" };
  if (!env.AI) return { status: "skipped", reason: "IA indisponible" };
  if (!(await canSpend(env.DB, feature, UNIVERSAL_ESTIMATE_NEURONS)))
    return { status: "skipped", reason: "budget IA épuisé" };
  const full: ExtractContext = { ...ctx, text, max: ctx.max ?? UNIVERSAL_MAX_LISTINGS };
  let neurons: number | undefined;
  const r = await runJson(env, {
    feature,
    model: UNIVERSAL_MODEL,
    estimate: UNIVERSAL_ESTIMATE_NEURONS,
    timeoutMs: UNIVERSAL_TIMEOUT_MS,
    input: { messages: buildMessages(text), max_tokens: UNIVERSAL_MAX_TOKENS, temperature: 0 },
    validate: (json) => validateExtraction(json, full),
    onSpent: (n) => {
      neurons = n;
    },
  });
  if (!r) return { status: "fail", reason: "réponse du modèle refusée" };
  if (r.listings.length > 0)
    return { status: "ok", listings: r.listings, ...(neurons ? { neurons: Math.round(neurons * 10) / 10 } : {}) };
  // Zéro annonce valide : une erreur de source, sauf état vide explicite (annoncé par le modèle ET écrit dans la page).
  return r.empty && EMPTY_STATE.test(markdown)
    ? { status: "ok", listings: [] }
    : { status: "fail", reason: "aucune annonce valide" };
}

/** HTML -> Markdown par Workers AI (gratuit pour le HTML) ; null sur tout échec. */
export async function htmlToMarkdown(env: Env, html: string, hostname: string): Promise<string | null> {
  if (!env.AI?.toMarkdown) return null;
  try {
    const out = await withTimeout(
      env.AI.toMarkdown(
        { name: "page.html", blob: new Blob([html], { type: "text/html" }) },
        { conversionOptions: { html: { hostname } } },
      ),
      UNIVERSAL_CONVERT_TIMEOUT_MS,
    );
    const r = (Array.isArray(out) ? out[0] : out) as { format?: unknown; data?: unknown } | undefined;
    return r && r.format !== "error" && typeof r.data === "string" ? r.data : null;
  } catch {
    return null;
  }
}

/** Page rendue par Browser Run (quick action « markdown », binding BROWSER) : une session par appel. null sur tout échec. */
async function browserMarkdown(env: Env, url: string): Promise<string | null> {
  try {
    const res = await withTimeout(
      env.BROWSER!.quickAction("markdown", {
        url,
        gotoOptions: { waitUntil: "networkidle2", timeout: UNIVERSAL_BROWSER_TIMEOUT_MS },
      }),
      UNIVERSAL_BROWSER_TIMEOUT_MS,
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const j = (await res.json()) as { success?: unknown; result?: unknown } | null;
    return j?.success !== false && typeof j?.result === "string" ? j.result : null;
  } catch {
    return null;
  }
}

export interface ReadOptions {
  /** Instant de la lecture (tests) ; défaut : maintenant. */
  now?: Date;
  /** Mémoriser une lecture réussie (défaut : oui ; non pour /test, qui n'écrit rien). */
  persist?: boolean;
  /** Ignorer l'empreinte mémorisée : relire par le modèle (/test?force=1). */
  force?: boolean;
}

/**
 * Lecture d'une source universelle : interrupteur, cadence, budget, page (ou rendu navigateur), Markdown, réduction, empreinte,
 * extraction. Page inchangée : aucun appel du modèle, les annonces mémorisées sont rendues (ni disparition ni alerte). Jamais
 * « inchangée » : texte trop court, lecture précédente vide, ou plus vieille que UNIVERSAL_RECHECK_DAYS.
 */
export async function readUniversal(env: Env, src: SourceDef, opts: ReadOptions = {}): Promise<UniversalResult> {
  if (!universalOn(env)) return { status: "skipped", reason: "lecteur universel éteint" };
  if (!src.every || src.every < UNIVERSAL_MIN_EVERY)
    return { status: "fail", reason: `cadence universelle inférieure à ${UNIVERSAL_MIN_EVERY} min` };
  if (src.render === "browser" && src.every < UNIVERSAL_BROWSER_MIN_EVERY)
    return { status: "fail", reason: `cadence du rendu navigateur inférieure à ${UNIVERSAL_BROWSER_MIN_EVERY} min` };
  if (!env.AI) return { status: "skipped", reason: "IA indisponible" };
  const now = opts.now ?? new Date();
  const prev = opts.force ? null : await loadState(env.DB, src.id);
  // Sans lecture mémorisée, le modèle sera appelé : sans budget, inutile de télécharger. Avec elle, la page peut être inchangée
  // et ne rien coûter : le budget n'est testé qu'à l'extraction.
  if (!prev && !(await canSpend(env.DB, "universal", UNIVERSAL_ESTIMATE_NEURONS)))
    return { status: "skipped", reason: "budget IA épuisé" };

  let markdown: string | null;
  if (src.render === "browser") {
    if (env.BROWSER_RENDER !== "true" || typeof env.BROWSER?.quickAction !== "function")
      return { status: "fail", reason: FAIL_BROWSER };
    markdown = await browserMarkdown(env, src.url);
    if (markdown === null) return { status: "fail", reason: "rendu navigateur en échec" };
  } else {
    const res = await fetchSource({ ...src, maxBytes: src.maxBytes ?? UNIVERSAL_HTML_MAX_BYTES });
    if (!res.ok) return { status: "fail", reason: res.reason };
    markdown = await htmlToMarkdown(env, res.body, new URL(src.url).hostname);
    if (markdown === null) return { status: "fail", reason: "conversion Markdown indisponible" };
  }
  const text = reduceMarkdown(markdown);
  const fp = text ? await fingerprint(text) : null;
  if (
    prev &&
    fp === prev.fingerprint &&
    prev.count > 0 &&
    text.length >= UNIVERSAL_UNCHANGED_MIN_CHARS &&
    now.getTime() - Date.parse(prev.readAt) < UNIVERSAL_RECHECK_DAYS * DAY_MS
  ) {
    return { status: "ok", listings: prev.listings, unchanged: true, savedNeurons: Math.round(prev.neurons * 10) / 10 };
  }
  const r = await extractReduced(
    env,
    markdown,
    text,
    { source: src.id, agency: src.name, phone: src.phone, baseUrl: src.url, keepQuery: true },
    "universal",
  );
  if ((opts.persist ?? true) && fp && r.status === "ok" && r.listings.length > 0)
    await saveState(env.DB, src.id, fp, r.listings, r.neurons ?? 0, now);
  return r;
}
