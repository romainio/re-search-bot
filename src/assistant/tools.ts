import {
  ASSISTANT_ARGS_MAX,
  ASSISTANT_DAYS_RANGE,
  ASSISTANT_DESC_MAX,
  ASSISTANT_QUERY_MAX,
  ASSISTANT_RENT_RANGE,
  ASSISTANT_ROOMS_RANGE,
  ASSISTANT_SURFACE_RANGE,
  ASSISTANT_TITLE_MAX,
  ASSISTANT_TOOL_LIMIT_DEFAULT,
  ASSISTANT_TOOL_LIMIT_MAX,
} from "../config/assistant";
import { MARKET_MAX_ROOMS_BUCKET } from "../config/market";
import { GONE_SQL, NEIGHBORHOOD, ONLINE_SQL, orderBy, SORT_LABELS, viewFilters } from "../listings-query";
import type { SortKey } from "../listings-query";
import { settings } from "../derive";
import type { Instance } from "../instance";
import { lifeOf, lifeText, loadMarket, m2Of, ALL_BUCKET, dailySeries, trendOf } from "../market";
import { clip, num } from "../format";
import { safeUrl } from "../html";
import { semanticSearch } from "../search/search";
import { getFeedback } from "../telegram/feedback";
import { loadProfile } from "../telegram/profile";
import type { Env } from "../types";
import { DAY_MS } from "../time";

// Outils de l'assistant : le modèle choisit un outil et ses arguments, jamais de SQL. Schéma fermé (une valeur hors schéma est
// refusée, jamais corrigée en silence), lecture seule, résultat petit (LIMIT constant). Les valeurs validées passent en
// paramètres liés, jamais concaténées.

export type ToolName = "chercher_annonces" | "recherche_semantique" | "marche" | "profil" | "annonce";

type Field =
  | { kind: "enum"; values: readonly string[]; desc: string }
  | { kind: "num"; range: readonly [number, number]; int?: boolean; desc: string }
  | { kind: "str"; max: number; desc: string }
  | { kind: "enums"; values: readonly string[]; max: number; desc: string };

const SORTS = Object.keys(SORT_LABELS) as SortKey[];
const FOLLOWS = ["aime", "deteste", "appelee", "visite"] as const;
const STATUS = ["en_ligne", "disparue", "toutes"] as const;
const LIMIT: Field = {
  kind: "num",
  range: [1, ASSISTANT_TOOL_LIMIT_MAX],
  int: true,
  desc: `Nombre d'annonces (défaut ${ASSISTANT_TOOL_LIMIT_DEFAULT}).`,
};

export type ToolTable = Readonly<Record<ToolName, { description: string; fields: Readonly<Record<string, Field>> }>>;
export const TOOL_NAMES: readonly ToolName[] = [
  "chercher_annonces",
  "recherche_semantique",
  "marche",
  "profil",
  "annonce",
];

/** Schémas des outils d'une instance (Settings.assistantTools) : zones et critères photo dans les listes de valeurs. */
export function buildTools(i: Instance): ToolTable {
  const zoneCodes = [...i.zones.map((z) => z.postalCode), NEIGHBORHOOD];
  const zoneDesc = `Zone : ${i.zones.map((z) => `${z.postalCode} = ${z.label}`).join(", ")}, ${NEIGHBORHOOD} = quartier ${i.neighborhoodLabel}.`;
  return {
    chercher_annonces: {
      description:
        "Liste des annonces selon des filtres précis (zone, loyer, surface, pièces, période, photos, suivi). À utiliser pour toute question chiffrée ou structurée.",
      fields: {
        zone: { kind: "enum", values: zoneCodes, desc: zoneDesc },
        loyer_max: { kind: "num", range: ASSISTANT_RENT_RANGE, desc: "Loyer maximal en euros, charges comprises." },
        surface_min: { kind: "num", range: ASSISTANT_SURFACE_RANGE, desc: "Surface minimale en m²." },
        pieces_min: { kind: "num", range: ASSISTANT_ROOMS_RANGE, int: true, desc: "Nombre de pièces minimal." },
        pieces_max: { kind: "num", range: ASSISTANT_ROOMS_RANGE, int: true, desc: "Nombre de pièces maximal." },
        depuis_jours: {
          kind: "num",
          range: ASSISTANT_DAYS_RANGE,
          int: true,
          desc: "Détectées depuis N jours (« de la semaine » = 7).",
        },
        statut: { kind: "enum", values: STATUS, desc: "en_ligne (défaut), disparue ou toutes." },
        photo_oui: {
          kind: "enums",
          values: i.photoCriteria.map((c) => c.id),
          max: 4,
          desc: `Critères que les photos doivent montrer (« oui ») parmi : ${i.photoCriteria.map((c) => `${c.id} (${c.label})`).join(", ")}.`,
        },
        suivi: {
          kind: "enum",
          values: FOLLOWS,
          desc: "Annonces que l'utilisateur a marquées : aime (👍), deteste (👎), appelee (appelée), visite.",
        },
        tri: {
          kind: "enum",
          values: SORTS,
          desc: "recentes (défaut), prix (croissant), m2 (loyer au m² croissant), surface (décroissante).",
        },
        limite: LIMIT,
      },
    },
    recherche_semantique: {
      description:
        "Recherche par sens dans le texte des annonces (quartier, station, ambiance, équipement : « près de Brochant », « calme et lumineux »). Pour ce qui n'est pas un critère chiffré.",
      fields: {
        requete: { kind: "str", max: ASSISTANT_QUERY_MAX, desc: "La recherche en quelques mots." },
        zone: { kind: "enum", values: zoneCodes, desc: zoneDesc },
        loyer_max: { kind: "num", range: ASSISTANT_RENT_RANGE, desc: "Loyer maximal en euros." },
        surface_min: { kind: "num", range: ASSISTANT_SURFACE_RANGE, desc: "Surface minimale en m²." },
        statut: {
          kind: "enum",
          values: ["en_ligne", "toutes"],
          desc: "en_ligne (défaut) ou toutes (disparues comprises).",
        },
        limite: LIMIT,
      },
    },
    marche: {
      description:
        "Indicateurs de marché sur 30 jours : durée de vie médiane des annonces (« combien de temps restent… »), loyer médian au m², rythme des nouvelles annonces.",
      fields: {
        zone: { kind: "enum", values: zoneCodes.filter((z) => z !== NEIGHBORHOOD), desc: zoneDesc },
        pieces: {
          kind: "num",
          range: [1, MARKET_MAX_ROOMS_BUCKET],
          int: true,
          desc: `Nombre de pièces (${MARKET_MAX_ROOMS_BUCKET} = ${MARKET_MAX_ROOMS_BUCKET} et plus).`,
        },
      },
    },
    profil: {
      description: "Profil de recherche de l'utilisateur (critères indispensables, budget, surface, mots libres).",
      fields: {},
    },
    annonce: {
      description: "Détail d'une annonce à partir de son identifiant court (champ « id » des résultats).",
      fields: {
        id: { kind: "num", range: [1, 2_000_000_000], int: true, desc: "Identifiant court d'une annonce déjà listée." },
      },
    },
  };
}

/** Schémas au format « tools » de Workers AI (type function, paramètres en JSON Schema) ; `required` : champs obligatoires. */
const REQUIRED: Partial<Record<ToolName, string[]>> = { recherche_semantique: ["requete"], annonce: ["id"] };
export function toolSchemas(tools: ToolTable = settings().assistantTools): unknown[] {
  return TOOL_NAMES.map((name) => {
    const t = tools[name];
    const properties: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(t.fields)) {
      properties[k] =
        f.kind === "enum"
          ? { type: "string", enum: [...f.values], description: f.desc }
          : f.kind === "num"
            ? { type: f.int ? "integer" : "number", minimum: f.range[0], maximum: f.range[1], description: f.desc }
            : f.kind === "str"
              ? { type: "string", maxLength: f.max, description: f.desc }
              : { type: "array", items: { type: "string", enum: [...f.values] }, maxItems: f.max, description: f.desc };
    }
    return {
      type: "function",
      function: {
        name,
        description: t.description,
        parameters: { type: "object", properties, required: REQUIRED[name] ?? [] },
      },
    };
  });
}

export type Args = Record<string, string | number | string[]>;
export type Validated = { ok: true; args: Args } | { ok: false; error: string };

const isTool = (n: unknown): n is ToolName => typeof n === "string" && (TOOL_NAMES as readonly string[]).includes(n);
export const knownTool = isTool;

/** Nombre, ou texte purement numérique (« 1450 »), sinon NaN. */
const toNum = (v: unknown): number =>
  typeof v === "number" ? v : typeof v === "string" && /^\d{1,10}(\.\d{1,3})?$/.test(v.trim()) ? Number(v) : NaN;

/**
 * Valide les arguments bruts (objet ou JSON) : clés inconnues ignorées, null ou absent = non fourni, valeur hors schéma refusée
 * avec la raison.
 */
export function validateArgs(tool: ToolName, raw: unknown, tools: ToolTable = settings().assistantTools): Validated {
  let o: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > ASSISTANT_ARGS_MAX) return { ok: false, error: "arguments trop longs" };
    try {
      o = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return { ok: false, error: "arguments : JSON invalide" };
    }
  }
  if (o === undefined || o === null) o = {};
  if (typeof o !== "object" || Array.isArray(o)) return { ok: false, error: "arguments : un objet est attendu" };
  const src = o as Record<string, unknown>;
  const spec = tools[tool].fields;
  const args: Args = {};
  for (const [k, f] of Object.entries(spec)) {
    const v = Object.hasOwn(src, k) ? src[k] : undefined;
    if (v === undefined || v === null || v === "") continue;
    if (f.kind === "enum") {
      if (typeof v !== "string" || !f.values.includes(v))
        return { ok: false, error: `${k} : valeur hors liste (${f.values.join(", ")})` };
      args[k] = v;
    } else if (f.kind === "num") {
      const n = toNum(v);
      if (!Number.isFinite(n) || n < f.range[0] || n > f.range[1] || (f.int && !Number.isInteger(n)))
        return { ok: false, error: `${k} : nombre entre ${f.range[0]} et ${f.range[1]} attendu` };
      args[k] = n;
    } else if (f.kind === "str") {
      if (typeof v !== "string") return { ok: false, error: `${k} : texte attendu` };
      const t = v.replace(/\s+/g, " ").trim();
      if (!t || t.length > f.max) return { ok: false, error: `${k} : 1 à ${f.max} caractères` };
      args[k] = t;
    } else {
      if (!Array.isArray(v) || v.length > f.max || !v.every((x) => typeof x === "string" && f.values.includes(x)))
        return { ok: false, error: `${k} : liste de ${f.max} valeurs au plus parmi ${f.values.join(", ")}` };
      args[k] = [...new Set(v as string[])];
    }
  }
  for (const k of REQUIRED[tool] ?? []) if (!(k in args)) return { ok: false, error: `${k} : obligatoire` };
  return { ok: true, args };
}

/* ---- Fiches d'annonces ---- */

/** Annonce rendue à l'utilisateur : tout vient de la base (aucune URL ni chiffre écrit par le modèle). */
export interface Card {
  id: number;
  url: string | null;
  title: string | null;
  rent: number | null;
  surface: number | null;
  rooms: number | null;
  zone: string | null;
  since: string;
  online: boolean;
}

interface Row {
  rid: number;
  source: string;
  listing_id: string;
  url: string | null;
  postal_code: string | null;
  rent_cc: number | null;
  surface: number | null;
  rooms: number | null;
  first_seen: string;
  gone_at: string | null;
  payload: string;
}
const COLUMNS =
  "l.rowid AS rid, l.source, l.listing_id, l.url, l.postal_code, l.rent_cc, l.surface, l.rooms, l.first_seen, l.gone_at, l.payload";

interface Payload {
  listing?: {
    title?: string | null;
    district?: string | null;
    address?: string | null;
    description?: string | null;
    floor?: number | null;
    propertyType?: string | null;
  };
  evaluation?: { flags?: string[] };
  photo?: { grid?: Record<string, { answer?: string }>; summary?: string | null } | null;
  geo?: { station?: { name?: string; minutes?: number | null } | null; dpe?: string | null } | null;
}
function parsePayload(s: string): Payload {
  try {
    const p = JSON.parse(s) as unknown;
    return p && typeof p === "object" ? (p as Payload) : {};
  } catch {
    return {};
  }
}

const zoneLabel = (code: string | null): string | null =>
  code ? (settings().zones.find((z) => z.postalCode === code)?.label ?? code) : null;
const yesLabels = (p: Payload): string[] =>
  settings()
    .photoCriteria.filter((c) => p.photo?.grid?.[c.id]?.answer === "oui")
    .map((c) => c.label.toLowerCase());

function cardOf(r: Row, p: Payload, online: boolean): Card {
  const title = p.listing?.title ? clip(p.listing.title.replace(/\s+/g, " ").trim(), ASSISTANT_TITLE_MAX) : null;
  return {
    id: r.rid,
    url: safeUrl(r.url),
    title: title || null,
    rent: r.rent_cc,
    surface: r.surface,
    rooms: r.rooms,
    zone: zoneLabel(r.postal_code),
    since: r.first_seen.slice(0, 10),
    online,
  };
}

/** Forme compacte donnée au modèle (clés courtes, pas d'URL : il n'en a pas besoin et ne doit pas en écrire). */
function forModel(c: Card, p: Payload): Record<string, unknown> {
  const photos = yesLabels(p);
  return {
    id: c.id,
    titre: c.title,
    loyer: c.rent === null ? null : Math.round(c.rent),
    surface: c.surface,
    pieces: c.rooms,
    zone: c.zone,
    depuis: c.since,
    en_ligne: c.online,
    ...(photos.length ? { photos_oui: photos } : {}),
  };
}

export interface ToolResult {
  /** Donnée renvoyée au modèle (petite). */
  data: unknown;
  /** Annonces à lister dans la réponse (déjà bornées) ; null : l'outil n'en donne pas. */
  cards: Card[] | null;
}

const limitOf = (a: Args): number => (typeof a.limite === "number" ? a.limite : ASSISTANT_TOOL_LIMIT_DEFAULT);

/** chercher_annonces : requête D1 paramétrée et bornée, filtres repris du tableau de bord (viewFilters). */
async function chercher(env: Env, a: Args, now: Date): Promise<ToolResult> {
  const limit = limitOf(a);
  // « deteste » n'est pas un filtre du tableau de bord : condition propre plus bas.
  const f = viewFilters(
    {
      zone: (a.zone as string | undefined) ?? null,
      prix: (a.loyer_max as number | undefined) ?? null,
      surface: (a.surface_min as number | undefined) ?? null,
      suivi: a.suivi === "deteste" ? null : ((a.suivi as string | undefined) ?? null),
    },
    settings().sources.dedicated,
  );
  let sql = ` AND l.alert_status IN ('sent','pending','silent')${f.sql}`;
  const binds: (string | number)[] = [...f.binds];
  const status = (a.statut as string | undefined) ?? "en_ligne";
  if (status === "en_ligne") sql += ` AND ${ONLINE_SQL}`;
  else if (status === "disparue") sql += ` AND ${GONE_SQL}`;
  if (typeof a.pieces_min === "number") {
    sql += " AND (l.rooms IS NULL OR l.rooms >= ?)";
    binds.push(a.pieces_min);
  }
  if (typeof a.pieces_max === "number") {
    sql += " AND (l.rooms IS NULL OR l.rooms <= ?)";
    binds.push(a.pieces_max);
  }
  if (typeof a.depuis_jours === "number") {
    sql += " AND l.first_seen >= ?";
    binds.push(new Date(now.getTime() - a.depuis_jours * DAY_MS).toISOString());
  }
  for (const id of (a.photo_oui as string[] | undefined) ?? []) {
    sql += " AND CASE WHEN json_valid(l.payload) THEN json_extract(l.payload, ?) END = 'oui'";
    binds.push(`$.photo.grid.${id}.answer`);
  }
  if (a.suivi === "deteste") {
    sql +=
      " AND EXISTS (SELECT 1 FROM feedback fb WHERE fb.source = l.source AND fb.listing_id = l.listing_id AND fb.type = 'avis' AND fb.value = 'deteste')";
  }
  const order = orderBy((a.tri as SortKey | undefined) ?? "recentes", "l");
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM listings l WHERE 1 = 1${sql} ORDER BY ${order} LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<Row>();
  return rowsResult(results, (r) => r.gone_at === null || status === "en_ligne");
}

function rowsResult(rows: Row[], online: (r: Row) => boolean): ToolResult {
  const cards: Card[] = [];
  const data: Record<string, unknown>[] = [];
  for (const r of rows) {
    const p = parsePayload(r.payload);
    const c = cardOf(r, p, online(r));
    cards.push(c);
    data.push(forModel(c, p));
  }
  return { data: { nombre: data.length, annonces: data }, cards };
}

/** recherche_semantique : sans la limite horaire du tableau de bord (le chat est déjà authentifié et limité). */
async function semantique(env: Env, a: Args, now: Date): Promise<ToolResult> {
  const limit = limitOf(a);
  const res = await semanticSearch(env, a.requete as string, {
    rateLimit: false,
    zone: (a.zone as string | undefined) ?? null,
    prix: (a.loyer_max as number | undefined) ?? null,
    surface: (a.surface_min as number | undefined) ?? null,
    includeGone: a.statut === "toutes",
    limit,
    now,
  });
  if (res.status === "off")
    return {
      data: { erreur: "recherche par sens indisponible (non activée) : utilise chercher_annonces" },
      cards: null,
    };
  if (res.status !== "ok") return { data: { erreur: `recherche par sens indisponible (${res.status})` }, cards: null };
  if (!res.rows.length) return { data: { nombre: 0, annonces: [] }, cards: [] };
  // semanticSearch ne rend pas le rowid : une lecture de plus, paramétrée, sur les couples (source, annonce) trouvés.
  const keys = res.rows.slice(0, limit);
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM listings l WHERE (l.source, l.listing_id) IN (VALUES ${keys.map(() => "(?, ?)").join(", ")})`,
  )
    .bind(...keys.flatMap((r) => [r.source, r.listing_id]))
    .all<Row>();
  const byKey = new Map(results.map((r) => [`${r.source}\u0000${r.listing_id}`, r]));
  const ordered = keys.map((k) => byKey.get(`${k.source}\u0000${k.listing_id}`)).filter((r): r is Row => !!r);
  const goneOf = new Map(keys.map((k) => [`${k.source}\u0000${k.listing_id}`, k.gone]));
  return rowsResult(ordered, (r) => !goneOf.get(`${r.source}\u0000${r.listing_id}`));
}

/** marche : cellules (zone × tranche) des agrégats, effectifs fiables seulement. */
async function marche(env: Env, a: Args, now: Date): Promise<ToolResult> {
  const m = await loadMarket(env.DB);
  if (!m) return { data: { erreur: "indicateurs pas encore calculés" }, cards: null };
  const out: Record<string, unknown>[] = [];
  for (const z of settings().zones) {
    if (a.zone && a.zone !== z.postalCode) continue;
    const buckets =
      typeof a.pieces === "number" ? [String(a.pieces)] : [ALL_BUCKET, "1", "2", "3", String(MARKET_MAX_ROOMS_BUCKET)];
    for (const b of buckets) {
      const c = m.cells.get(`${z.postalCode}|${b}`);
      if (!c) continue;
      const life = lifeOf(c),
        price = m2Of(c);
      const beyond = c.lifeN >= 1 && c.lifeMedianH === null;
      if (life === null && price === null && !beyond) continue;
      out.push({
        zone: z.label,
        pieces: b === ALL_BUCKET ? "toutes" : b === String(MARKET_MAX_ROOMS_BUCKET) ? `${b} et plus` : b,
        duree_vie_mediane: life !== null ? lifeText(life) : beyond ? "plus de 10 jours" : null,
        annonces_duree: c.lifeN,
        loyer_m2_median: price !== null ? Math.round(price * 10) / 10 : null,
        annonces_prix: c.m2N,
      });
    }
  }
  const trend = trendOf(dailySeries(m, now));
  return {
    data: {
      periode_jours: 30,
      cellules: out,
      nouvelles_par_jour: trend ? Math.round(trend.recent * 10) / 10 : null,
      note: out.length ? undefined : "pas assez d'annonces pour une médiane fiable",
    },
    cards: null,
  };
}

async function profil(env: Env): Promise<ToolResult> {
  const s = await loadProfile(env.DB);
  if (!s) return { data: { profil: null, note: "aucun profil enregistré" }, cards: null };
  const p = s.profile;
  return {
    data: {
      indispensable_ou_non: p.criteria,
      station_max_min: p.transitMaxMin,
      etage_min: p.floorMin,
      budget_max: p.budgetMax,
      surface_min: p.surfaceMin,
      mots: p.keywords,
    },
    cards: null,
  };
}

/** annonce : détail d'une annonce (rowid), description coupée, retours de l'utilisateur ; une seule carte. */
async function annonce(env: Env, a: Args): Promise<ToolResult> {
  const r = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM listings l WHERE l.rowid = ? AND l.alert_status IN ('sent','pending','silent','duplicate')`,
  )
    .bind(a.id as number)
    .first<Row>();
  if (!r) return { data: { erreur: "annonce introuvable" }, cards: null };
  const p = parsePayload(r.payload);
  const fb = await getFeedback(env.DB, r.source, r.listing_id).catch(() => ({}));
  const card = cardOf(r, p, r.gone_at === null);
  const l = p.listing ?? {};
  const grid = settings()
    .photoCriteria.filter((c) => p.photo?.grid?.[c.id])
    .map((c) => `${c.label.toLowerCase()} : ${p.photo!.grid![c.id]!.answer}`);
  const st = p.geo?.station;
  return {
    data: {
      ...forModel(card, p),
      adresse: l.address ?? l.district ?? null,
      etage: l.floor ?? null,
      type: l.propertyType ?? null,
      description:
        p.photo?.summary ?? (l.description ? clip(l.description.replace(/\s+/g, " "), ASSISTANT_DESC_MAX) : null),
      grille_photo: grid.length ? grid : undefined,
      station: st?.name ? `${st.name}${st.minutes ? ` à ~${st.minutes} min` : ""}` : undefined,
      dpe: p.geo?.dpe ?? undefined,
      retours_utilisateur: Object.keys(fb).length ? fb : undefined,
    },
    cards: [card],
  };
}

/** Exécute un outil DÉJÀ validé. Lève sur erreur D1 (l'appelant l'attrape et la renvoie au modèle comme « indisponible »). */
export async function runTool(env: Env, tool: ToolName, args: Args, now: Date): Promise<ToolResult> {
  switch (tool) {
    case "chercher_annonces":
      return chercher(env, args, now);
    case "recherche_semantique":
      return semantique(env, args, now);
    case "marche":
      return marche(env, args, now);
    case "profil":
      return profil(env);
    case "annonce":
      return annonce(env, args);
  }
}

/** Texte « 1 450 € · 38 m² · 2 p. » d'une annonce (valeurs de la base, jamais du modèle). */
export const factsOf = (c: Card): string =>
  [
    c.rent === null ? null : `${num(c.rent)} €`,
    c.surface === null ? null : `${num(c.surface)} m²`,
    c.rooms === null ? null : `${c.rooms} p.`,
    c.zone,
  ]
    .filter(Boolean)
    .join(" · ");
