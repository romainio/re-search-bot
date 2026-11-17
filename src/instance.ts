import rawInstance from "../instance.config.json";
import { publicUrl } from "./public-url";
import { PARSER_IDS } from "./types";
import type { ParserId } from "./types";
import { errMsg, isObj } from "./guards";
import type { Obj } from "./guards";

/**
 * Configuration de l'instance : `instance.config.json` (schéma `instance.schema.json`), embarqué dans le bundle et validé une
 * fois par isolat. Une erreur lève au chargement avec toutes les erreurs trouvées, chacune avec son chemin. Le fichier livré est
 * une instance non paramétrée (aucune zone, aucune source) : l'assistant la remplit par MCP. Les tests chargent
 * `examples/paris-17-levallois.json` à la place (alias de vitest.config.ts).
 */

/** Zone surveillée : code postal, libellé court (alerte, tableau de bord) et, pour une commune, son nom reconnu sans code postal. */
export interface UserZone {
  postalCode: string;
  label: string;
  /** Nom de la commune, reconnu quand l'annonce ne donne pas de code postal. */
  town?: RegExp;
  /** Emprise [sud, ouest, nord, est] en degrés pour la prospection (OpenStreetMap) ; sans elle, zone ignorée par celle-ci. */
  bbox?: [number, number, number, number];
}

/** Critère de la grille d'analyse des photos (`showNo` affiche aussi un « non », `parent` rattache le critère à un autre). */
export interface UserPhotoCriterion {
  id: string;
  question: string;
  emoji: string;
  label: string;
  showNo?: boolean;
  parent?: string;
}

/** Source telle que décrite dans le JSON (après validation) ; `group` absent : réparti par assignGroups. */
export interface InstanceSource {
  id: string;
  name: string;
  url: string;
  parser: ParserId;
  group?: number;
  zones: string[];
  filteredToZones: boolean;
  phone: string | null;
  encoding: "utf-8" | "windows-1252";
  active: boolean;
  stopMarker?: string;
  every?: number;
  maxBytes?: number;
  render?: "browser";
  note?: string;
  extraPage?: boolean;
}

export interface Instance {
  zones: UserZone[];
  outOfZoneTowns: { postalCode: string; town: RegExp }[];
  neighborhoodKeywords: string[];
  /** Nom affiché du quartier repéré par neighborhoodKeywords (alerte, tableau de bord) ; défaut « Quartier ». */
  neighborhoodLabel: string;
  keywordsZone: string;
  criteria: { rentMin: number; rentMax: number; surfaceMin: number; roomsMin: number; excludeGroundFloor: boolean };
  window: { startHour: number; endHour: number; summaryHour: number; summaryMinute: number };
  photoCriteria: UserPhotoCriterion[];
  ai: { dailyNeurons: number; featureCaps: Record<string, number> };
  geo: { stationPostalCodes: string[]; rentCapPostalCodes: string[] };
  sources: InstanceSource[];
}

/** Lecteurs qu'une source peut nommer : « mail » est réservé aux sources virtuelles. */
export const USER_PARSER_IDS: readonly ParserId[] = PARSER_IDS.filter((p) => p !== "mail");
/** Cadences acceptées pour `every` (minutes) : multiples de 5 qui divisent 60 (schedule.isDue). */
export const EVERY_VALUES: readonly number[] = [5, 10, 15, 20, 30, 60];

const DEFAULT_PHOTO_CRITERIA: UserPhotoCriterion[] = [
  { id: "parquet", question: "le sol visible est du parquet", emoji: "🪵", label: "Parquet" },
  { id: "carrelage", question: "le sol visible est du carrelage", emoji: "🔲", label: "Carrelage" },
  { id: "moquette", question: "le sol visible est de la moquette", emoji: "🧶", label: "Moquette" },
  {
    id: "stratifie",
    question: "le sol visible est du stratifié ou du vinyle imitation bois",
    emoji: "📏",
    label: "Stratifié",
  },
  {
    id: "cuisine_equipee",
    question: "la cuisine est équipée (plaques, évier, meubles, électroménager visible)",
    emoji: "🍳",
    label: "Cuisine équipée",
    showNo: true,
  },
  {
    id: "cuisine_recente",
    question: "la cuisine paraît récente ou rénovée",
    emoji: "✨",
    label: "récente",
    parent: "cuisine_equipee",
  },
  { id: "baignoire", question: "une baignoire est visible", emoji: "🛁", label: "Baignoire", showNo: true },
  { id: "douche", question: "une douche est visible", emoji: "🚿", label: "Douche" },
  {
    id: "luminosite",
    question: "le logement paraît lumineux (grandes fenêtres, lumière naturelle)",
    emoji: "☀️",
    label: "Lumineux",
    showNo: true,
  },
  {
    id: "exterieur",
    question: "un balcon, une terrasse ou un extérieur est visible",
    emoji: "🌿",
    label: "Balcon/extérieur",
  },
];
const DEFAULT_AI = {
  dailyNeurons: 8_000,
  featureCaps: {
    photo: 4_000,
    prospect: 500,
    embed: 1_000,
    profile: 400,
    universal: 3_000,
    mail: 1_000,
    assistant: 1_500,
  },
};

const show = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

/** Collecte des erreurs : chaque contrôle ajoute un message préfixé de son chemin, la validation continue pour tout signaler d'un coup. */
class Check {
  errors: string[] = [];
  err(path: string, msg: string): void {
    this.errors.push(`${path} : ${msg}`);
  }
  /** Clés inconnues d'un objet (faute de frappe : refusée plutôt qu'ignorée en silence). */
  keys(o: Obj, allowed: readonly string[], path: string): void {
    for (const k of Object.keys(o))
      if (k !== "$schema" && !allowed.includes(k))
        this.err(path ? `${path}.${k}` : k, `clé inconnue (attendues : ${allowed.join(", ")})`);
  }
  str(v: unknown, path: string, opts: { optional?: boolean } = {}): string | undefined {
    if (v === undefined && opts.optional) return undefined;
    if (typeof v !== "string" || v.trim() === "") {
      this.err(path, `chaîne non vide attendue, reçu ${show(v)}`);
      return undefined;
    }
    return v;
  }
  num(
    v: unknown,
    path: string,
    opts: { optional?: boolean; min?: number; max?: number; int?: boolean } = {},
  ): number | undefined {
    if (v === undefined && opts.optional) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || (opts.int && !Number.isInteger(v))) {
      this.err(path, `${opts.int ? "entier" : "nombre"} attendu, reçu ${show(v)}`);
      return undefined;
    }
    if ((opts.min !== undefined && v < opts.min) || (opts.max !== undefined && v > opts.max)) {
      this.err(path, `valeur hors bornes [${opts.min ?? "-∞"}, ${opts.max ?? "∞"}] : ${v}`);
      return undefined;
    }
    return v;
  }
  bool(v: unknown, path: string, opts: { optional?: boolean } = {}): boolean | undefined {
    if (v === undefined && opts.optional) return undefined;
    if (typeof v !== "boolean") {
      this.err(path, `booléen attendu, reçu ${show(v)}`);
      return undefined;
    }
    return v;
  }
  /** Expression régulière écrite en chaîne, insensible à la casse. */
  regex(v: unknown, path: string): RegExp | undefined {
    const s = this.str(v, path);
    if (s === undefined) return undefined;
    try {
      return new RegExp(s, "i");
    } catch (e) {
      this.err(path, `expression régulière invalide ${show(s)} (${errMsg(e)})`);
      return undefined;
    }
  }
  arr(v: unknown, path: string, opts: { optional?: boolean; min?: number } = {}): unknown[] | undefined {
    if (v === undefined && opts.optional) return undefined;
    if (!Array.isArray(v)) {
      this.err(path, `liste attendue, reçu ${show(v)}`);
      return undefined;
    }
    if (opts.min && v.length < opts.min) {
      this.err(path, `au moins ${opts.min} élément(s) attendu(s)`);
      return undefined;
    }
    return v;
  }
  obj(v: unknown, path: string, opts: { optional?: boolean } = {}): Obj | undefined {
    if (v === undefined && opts.optional) return undefined;
    if (!isObj(v)) {
      this.err(path, `objet attendu, reçu ${show(v)}`);
      return undefined;
    }
    return v;
  }
}

const POSTAL = /^\d{5}$/;

/** Valide et convertit le contenu d'un fichier d'instance. Lève une Error qui énumère toutes les erreurs (chemin : message). */
export function validateInstance(raw: unknown, label = "instance.config.json"): Instance {
  const c = new Check();
  const root = c.obj(raw, "(racine)");
  if (!root) throw new Error(`${label} invalide :\n- ${c.errors.join("\n- ")}`);
  c.keys(
    root,
    [
      "zones",
      "outOfZoneTowns",
      "neighborhoodKeywords",
      "neighborhoodLabel",
      "keywordsZone",
      "criteria",
      "window",
      "photoCriteria",
      "ai",
      "geo",
      "sources",
    ],
    "",
  );

  // Zones
  const zones: UserZone[] = [];
  (c.arr(root.zones, "zones") ?? []).forEach((zr, i) => {
    const p = `zones[${i}]`;
    const z = c.obj(zr, p);
    if (!z) return;
    c.keys(z, ["postalCode", "label", "town", "bbox"], p);
    const postalCode = c.str(z.postalCode, `${p}.postalCode`);
    if (postalCode !== undefined && !POSTAL.test(postalCode))
      c.err(`${p}.postalCode`, `code postal à 5 chiffres attendu, reçu ${show(postalCode)}`);
    if (postalCode && zones.some((o) => o.postalCode === postalCode))
      c.err(`${p}.postalCode`, `zone en double : ${postalCode}`);
    const label = c.str(z.label, `${p}.label`);
    const zone: UserZone = { postalCode: postalCode ?? "", label: label ?? "" };
    if (z.town !== undefined) {
      const t = c.regex(z.town, `${p}.town`);
      if (t) zone.town = t;
    }
    if (z.bbox !== undefined) {
      const b = c.arr(z.bbox, `${p}.bbox`);
      if (b) {
        const n = b.map((x, j) => c.num(x, `${p}.bbox[${j}]`));
        if (b.length !== 4) c.err(`${p}.bbox`, "4 nombres attendus [sud, ouest, nord, est]");
        else if (n.every((x) => x !== undefined)) {
          const [s, w, no, e] = n as number[];
          if (s >= no || w >= e) c.err(`${p}.bbox`, "emprise incohérente : sud < nord et ouest < est attendus");
          else zone.bbox = [s, w, no, e];
        }
      }
    }
    zones.push(zone);
  });
  const known = new Set(zones.map((z) => z.postalCode));

  const outOfZoneTowns: { postalCode: string; town: RegExp }[] = [];
  (c.arr(root.outOfZoneTowns, "outOfZoneTowns", { optional: true }) ?? []).forEach((tr, i) => {
    const p = `outOfZoneTowns[${i}]`;
    const t = c.obj(tr, p);
    if (!t) return;
    c.keys(t, ["postalCode", "town"], p);
    const postalCode = c.str(t.postalCode, `${p}.postalCode`);
    const town = c.regex(t.town, `${p}.town`);
    if (postalCode !== undefined && !POSTAL.test(postalCode))
      c.err(`${p}.postalCode`, `code postal à 5 chiffres attendu, reçu ${show(postalCode)}`);
    if (postalCode && known.has(postalCode))
      c.err(`${p}.postalCode`, `${postalCode} est une zone surveillée : elle ne peut pas être « hors zone »`);
    if (postalCode && town) outOfZoneTowns.push({ postalCode, town });
  });

  const neighborhoodKeywords: string[] = [];
  (c.arr(root.neighborhoodKeywords, "neighborhoodKeywords", { optional: true }) ?? []).forEach((k, i) => {
    const s = c.str(k, `neighborhoodKeywords[${i}]`);
    if (s) neighborhoodKeywords.push(s);
  });
  const neighborhoodLabel = c.str(root.neighborhoodLabel, "neighborhoodLabel", { optional: true }) ?? "Quartier";
  let keywordsZone = c.str(root.keywordsZone, "keywordsZone", { optional: true }) ?? zones[0]?.postalCode ?? "";
  if (root.keywordsZone !== undefined && !known.has(keywordsZone)) {
    c.err("keywordsZone", `zone inconnue ${show(keywordsZone)} (zones : ${[...known].join(", ")})`);
    keywordsZone = zones[0]?.postalCode ?? "";
  }

  // Critères : facultatifs tant qu'aucune zone n'est surveillée (instance non paramétrée), requis ensuite.
  const cr = c.obj(root.criteria, "criteria", { optional: zones.length === 0 });
  const criteria = { rentMin: 0, rentMax: 0, surfaceMin: 0, roomsMin: 0, excludeGroundFloor: false };
  if (cr) {
    c.keys(cr, ["rentMin", "rentMax", "surfaceMin", "roomsMin", "excludeGroundFloor"], "criteria");
    criteria.rentMax = c.num(cr.rentMax, "criteria.rentMax", { min: 0 }) ?? 0;
    criteria.rentMin = c.num(cr.rentMin, "criteria.rentMin", { optional: true, min: 0 }) ?? 0;
    criteria.surfaceMin = c.num(cr.surfaceMin, "criteria.surfaceMin", { optional: true, min: 0 }) ?? 0;
    criteria.roomsMin = c.num(cr.roomsMin, "criteria.roomsMin", { optional: true, min: 0, int: true }) ?? 0;
    criteria.excludeGroundFloor =
      c.bool(cr.excludeGroundFloor, "criteria.excludeGroundFloor", { optional: true }) ?? false;
    if (criteria.rentMin > criteria.rentMax)
      c.err("criteria.rentMin", `rentMin (${criteria.rentMin}) dépasse rentMax (${criteria.rentMax})`);
  }

  // Fenêtre horaire
  const window = { startHour: 9, endHour: 20, summaryHour: 20, summaryMinute: 5 };
  const w = c.obj(root.window, "window", { optional: true });
  if (w) {
    c.keys(w, ["startHour", "endHour", "summaryHour", "summaryMinute"], "window");
    window.startHour =
      c.num(w.startHour, "window.startHour", { optional: true, min: 0, max: 23, int: true }) ?? window.startHour;
    window.endHour =
      c.num(w.endHour, "window.endHour", { optional: true, min: 1, max: 24, int: true }) ?? window.endHour;
    window.summaryHour =
      c.num(w.summaryHour, "window.summaryHour", { optional: true, min: 0, max: 23, int: true }) ?? window.summaryHour;
    window.summaryMinute =
      c.num(w.summaryMinute, "window.summaryMinute", { optional: true, min: 0, max: 59, int: true }) ??
      window.summaryMinute;
  }
  if (window.startHour >= window.endHour)
    c.err("window", `startHour (${window.startHour}) doit précéder endHour (${window.endHour})`);

  // Critères photo
  let photoCriteria = DEFAULT_PHOTO_CRITERIA;
  const pc = c.arr(root.photoCriteria, "photoCriteria", { optional: true });
  if (pc) {
    photoCriteria = [];
    const ids = new Set<string>();
    pc.forEach((r, i) => {
      const p = `photoCriteria[${i}]`;
      const o = c.obj(r, p);
      if (!o) return;
      c.keys(o, ["id", "question", "emoji", "label", "showNo", "parent"], p);
      const id = c.str(o.id, `${p}.id`);
      const question = c.str(o.question, `${p}.question`);
      const emoji = c.str(o.emoji, `${p}.emoji`);
      const label = c.str(o.label, `${p}.label`);
      const showNo = c.bool(o.showNo, `${p}.showNo`, { optional: true });
      const parent = c.str(o.parent, `${p}.parent`, { optional: true });
      if (id) {
        if (ids.has(id)) c.err(`${p}.id`, `identifiant en double : ${id}`);
        ids.add(id);
      }
      if (id && question && emoji && label)
        photoCriteria.push({
          id,
          question,
          emoji,
          label,
          ...(showNo !== undefined ? { showNo } : {}),
          ...(parent ? { parent } : {}),
        });
    });
    for (const [i, k] of photoCriteria.entries())
      if (k.parent && !ids.has(k.parent)) c.err(`photoCriteria[${i}].parent`, `critère parent inconnu : ${k.parent}`);
  }

  // Plafonds IA
  const ai = {
    dailyNeurons: DEFAULT_AI.dailyNeurons,
    featureCaps: { ...DEFAULT_AI.featureCaps } as Record<string, number>,
  };
  const a = c.obj(root.ai, "ai", { optional: true });
  if (a) {
    c.keys(a, ["dailyNeurons", "featureCaps"], "ai");
    ai.dailyNeurons = c.num(a.dailyNeurons, "ai.dailyNeurons", { optional: true, min: 0 }) ?? ai.dailyNeurons;
    const fc = c.obj(a.featureCaps, "ai.featureCaps", { optional: true });
    if (fc) {
      ai.featureCaps = {};
      for (const [k, v] of Object.entries(fc)) {
        const n = c.num(v, `ai.featureCaps.${k}`, { min: 0 });
        if (n !== undefined) ai.featureCaps[k] = n;
      }
    }
  }

  // Données géographiques
  const geo = { stationPostalCodes: [] as string[], rentCapPostalCodes: [] as string[] };
  const g = c.obj(root.geo, "geo", { optional: true });
  if (g) {
    c.keys(g, ["stationPostalCodes", "rentCapPostalCodes"], "geo");
    for (const k of ["stationPostalCodes", "rentCapPostalCodes"] as const) {
      (c.arr(g[k], `geo.${k}`, { optional: true }) ?? []).forEach((v, i) => {
        const s = c.str(v, `geo.${k}[${i}]`);
        if (s) geo[k].push(s);
      });
    }
  }

  // Sources
  const sources: InstanceSource[] = [];
  const seen = new Set<string>();
  (c.arr(root.sources, "sources") ?? []).forEach((sr, i) => {
    const s = c.obj(sr, `sources[${i}]`);
    if (!s) return;
    const id = c.str(s.id, `sources[${i}].id`);
    const p = `sources[${i}${id ? `:${id}` : ""}]`;
    c.keys(
      s,
      [
        "id",
        "name",
        "url",
        "parser",
        "group",
        "zones",
        "filteredToZones",
        "phone",
        "encoding",
        "stopMarker",
        "every",
        "maxBytes",
        "active",
        "render",
        "note",
        "extraPage",
      ],
      p,
    );
    if (id !== undefined) {
      if (!/^[a-z0-9_]+$/.test(id))
        c.err(`${p}.id`, `identifiant en minuscules, chiffres et _ attendu, reçu ${show(id)}`);
      if (seen.has(id)) c.err(`${p}.id`, `identifiant en double : ${id}`);
      seen.add(id);
    }
    const name = c.str(s.name, `${p}.name`);
    const url = c.str(s.url, `${p}.url`);
    // Comme pour les outils MCP : une configuration ne fait pas lire une adresse interne au Worker.
    if (url) {
      try {
        publicUrl(url);
      } catch (e) {
        c.err(`${p}.url`, `${(e as Error).message}, reçu ${show(url)}`);
      }
    }
    const parser = c.str(s.parser, `${p}.parser`);
    if (parser !== undefined && !USER_PARSER_IDS.includes(parser as ParserId))
      c.err(`${p}.parser`, `lecteur inconnu ${show(parser)} (attendus : ${USER_PARSER_IDS.join(", ")})`);
    const group = c.num(s.group, `${p}.group`, { optional: true, min: 0, int: true });
    const szones: string[] = [];
    (c.arr(s.zones, `${p}.zones`, { min: 1 }) ?? []).forEach((z, j) => {
      const code = c.str(z, `${p}.zones[${j}]`);
      if (code === undefined) return;
      if (!known.has(code))
        c.err(`${p}.zones[${j}]`, `zone inconnue ${show(code)} (zones de l'instance : ${[...known].join(", ")})`);
      else szones.push(code);
    });
    const filteredToZones = c.bool(s.filteredToZones, `${p}.filteredToZones`, { optional: true }) ?? false;
    let phone: string | null = null;
    if (s.phone !== undefined && s.phone !== null) phone = c.str(s.phone, `${p}.phone`) ?? null;
    let encoding: InstanceSource["encoding"] = "utf-8";
    if (s.encoding !== undefined) {
      if (s.encoding === "utf-8" || s.encoding === "windows-1252") encoding = s.encoding;
      else c.err(`${p}.encoding`, `"utf-8" ou "windows-1252" attendu, reçu ${show(s.encoding)}`);
    }
    const stopMarker = c.str(s.stopMarker, `${p}.stopMarker`, { optional: true });
    const every = c.num(s.every, `${p}.every`, { optional: true, int: true });
    if (every !== undefined && !EVERY_VALUES.includes(every))
      c.err(`${p}.every`, `cadence en minutes attendue parmi ${EVERY_VALUES.join(", ")}, reçu ${every}`);
    const maxBytes = c.num(s.maxBytes, `${p}.maxBytes`, { optional: true, min: 1, int: true });
    const active = c.bool(s.active, `${p}.active`, { optional: true }) ?? true;
    let render: "browser" | undefined;
    if (s.render !== undefined) {
      if (s.render !== "browser") c.err(`${p}.render`, `"browser" attendu, reçu ${show(s.render)}`);
      else if (parser !== "universal") c.err(`${p}.render`, 'réservé aux sources "universal"');
      else render = "browser";
    }
    const note = c.str(s.note, `${p}.note`, { optional: true });
    const extraPage = c.bool(s.extraPage, `${p}.extraPage`, { optional: true });
    if (id && name && url && parser) {
      sources.push({
        id,
        name,
        url,
        parser: parser as ParserId,
        zones: szones,
        filteredToZones,
        phone,
        encoding,
        active,
        ...(group !== undefined ? { group } : {}),
        ...(stopMarker ? { stopMarker } : {}),
        ...(every !== undefined ? { every } : {}),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        ...(render ? { render } : {}),
        ...(note ? { note } : {}),
        ...(extraPage ? { extraPage } : {}),
      });
    }
  });

  if (c.errors.length) throw new Error(`${label} invalide :\n- ${c.errors.join("\n- ")}`);
  return {
    zones,
    outOfZoneTowns,
    neighborhoodKeywords,
    neighborhoodLabel,
    keywordsZone,
    criteria,
    window,
    photoCriteria,
    ai,
    geo,
    sources,
  };
}

/** Instance paramétrée : au moins une zone surveillée. Sans zone, le cron ne fait rien et l'assistant commence par definir_recherche. */
export const isConfigured = (i: Instance): boolean => i.zones.length > 0;

/**
 * Groupes de lecture : une source qui nomme son `group` le garde, les autres vont dans l'ordre au groupe le moins chargé
 * (déterministe), au plus `maxPerGroup` sources actives par groupe. Une source inactive n'occupe pas de place.
 */
export function assignGroups(
  sources: readonly InstanceSource[],
  totalGroups: number,
  maxPerGroup: number,
): (InstanceSource & { group: number })[] {
  const errors: string[] = [];
  const load = new Array<number>(totalGroups).fill(0);
  for (const s of sources) {
    if (s.group === undefined) continue;
    if (s.group >= totalGroups) {
      errors.push(`source ${s.id} : group ${s.group} hors de 0-${totalGroups - 1}`);
      continue;
    }
    if (s.active) load[s.group]++;
  }
  load.forEach((n, g) => {
    if (n > maxPerGroup) errors.push(`groupe ${g} : ${n} sources actives (${maxPerGroup} au plus)`);
  });
  const out = sources.map((s) => {
    if (s.group !== undefined) return { ...s, group: Math.min(s.group, totalGroups - 1) };
    if (!s.active) return { ...s, group: 0 };
    let best = 0;
    for (let g = 1; g < totalGroups; g++) if (load[g] < load[best]) best = g;
    if (load[best] >= maxPerGroup) {
      errors.push(
        `source ${s.id} : tous les groupes sont pleins (${totalGroups} x ${maxPerGroup} sources actives au plus)`,
      );
      return { ...s, group: best };
    }
    load[best]++;
    return { ...s, group: best };
  });
  if (errors.length) throw new Error(`répartition des sources en groupes impossible :\n- ${errors.join("\n- ")}`);
  return out;
}

/** Contenu brut du fichier embarqué (GET /config). */
export const BUNDLED_RAW: unknown = rawInstance;

/** L'instance du fichier embarqué : valeur de départ, et repli sans configuration en D1. */
export const INSTANCE: Instance = validateInstance(rawInstance);
