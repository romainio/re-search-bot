import { MCP_SAMPLE_SIZE } from "../config/mcp";
import { UNIVERSAL_DEFAULT_EVERY } from "../config/universal";
import { settings } from "../derive";
import { fetchSource } from "../fetch-source";
import { evaluate } from "../filter";
import type { Obj } from "../guards";
import { EVERY_VALUES, USER_PARSER_IDS } from "../instance";
import { publicUrl } from "../public-url";
import { parseSource } from "../scan";
import type { Env, Listing, ParserId, SourceDef } from "../types";
import { readUniversal } from "../universal/read";
import { bool, num, postalList, str } from "./args";

// Essai d'une source : une lecture, le lecteur, le filtre ; rien n'est écrit.

/** Raisons d'un refus de lecture automatique : un tel site n'est jamais ajouté. */
export const REFUSED = /^HTTP (401|403|429)$|anti-bot/;
export type Probe = { ok: true; report: Obj } | { ok: false; reason: string; advice: string };

function sample(listings: Listing[], src: SourceDef): Obj {
  const evals = listings.map((l) => evaluate(l, src));
  const reasons: Record<string, number> = {};
  for (const e of evals) if (!e.keep) reasons[e.reason ?? "autre"] = (reasons[e.reason ?? "autre"] ?? 0) + 1;
  return {
    annonces_lues: listings.length,
    annonces_gardees: evals.filter((e) => e.keep).length,
    motifs_de_refus: reasons,
    // Annonces gardées d'abord : l'utilisateur vérifie ce qui lui sera alerté ; puis quelques refusées, avec leur motif.
    exemples: listings
      .map((l, i) => ({ l, e: evals[i]! }))
      .sort((a, b) => Number(b.e.keep) - Number(a.e.keep))
      .slice(0, MCP_SAMPLE_SIZE)
      .map(({ l, e }) => ({
        titre: l.title,
        loyer: l.price,
        surface: l.surface,
        pieces: l.rooms,
        code_postal: l.postalCode,
        lien: l.url,
        gardee: e.keep,
        ...(e.keep ? {} : { motif: e.reason }),
      })),
  };
}

export async function probe(env: Env, src: SourceDef): Promise<Probe> {
  if (src.parser === "universal") {
    // Lecture par le modèle (dépense des neurons), sans rien mémoriser.
    const u = await readUniversal(env, src, { persist: false, force: true });
    if (u.status === "ok") return { ok: true, report: { ...sample(u.listings, src), neurons: u.neurons ?? 0 } };
    return {
      ok: false,
      reason: u.reason,
      advice:
        u.status === "skipped"
          ? "Lecteur universel indisponible : allumer UNIVERSAL_READER (regler_fonctions) et vérifier le budget IA (etat)."
          : "La page n'a pas pu être lue par le modèle.",
    };
  }
  const res = await fetchSource(src);
  if (!res.ok) {
    return {
      ok: false,
      reason: res.reason,
      advice: REFUSED.test(res.reason)
        ? "Ce site refuse la lecture automatique : ne pas l'ajouter (aucun contournement d'anti-bot)."
        : "Page injoignable : vérifier l'adresse (celle de la liste des locations, pas la page d'accueil).",
    };
  }
  const p = parseSource(src, res.body, res.truncated);
  if (!p.ok)
    return {
      ok: false,
      reason: p.reason,
      advice:
        "Le lecteur ne reconnaît pas cette page : vérifier le gabarit (detecter_gabarit) et l'adresse de la liste des locations, ou essayer le lecteur « universal ».",
    };
  return { ok: true, report: { ...sample(p.listings, src), lecture: { octets: res.bytes, tronquee: res.truncated } } };
}

export function sourceFromArgs(a: Obj, id: string, name: string): SourceDef {
  const parser = str(a, "lecteur", true);
  if (!USER_PARSER_IDS.includes(parser as ParserId))
    throw new Error(`lecteur inconnu « ${parser} » (attendus : ${USER_PARSER_IDS.join(", ")})`);
  const known = settings().instance.zones.map((z) => z.postalCode);
  const zones = postalList(a, "zones") ?? known;
  const unknown = zones.filter((z) => !known.includes(z));
  if (unknown.length)
    throw new Error(
      `zones inconnues : ${unknown.join(", ")} (zones de la recherche : ${known.join(", ")} ; les changer : definir_recherche)`,
    );
  const encoding = str(a, "encodage") ?? "utf-8";
  if (encoding !== "utf-8" && encoding !== "windows-1252") throw new Error('encodage : "utf-8" ou "windows-1252"');
  const every = num(a, "cadence_minutes") ?? (parser === "universal" ? UNIVERSAL_DEFAULT_EVERY : undefined);
  if (every !== undefined && !EVERY_VALUES.includes(every))
    throw new Error(`cadence_minutes : ${EVERY_VALUES.join(", ")}`);
  return {
    id,
    name,
    url: publicUrl(str(a, "adresse", true)),
    parser: parser as ParserId,
    group: 0,
    zones,
    filteredToZones: bool(a, "filtree_sur_les_zones") ?? false,
    phone: str(a, "telephone") ?? null,
    encoding,
    active: true,
    ...(every !== undefined ? { every } : {}),
  };
}
