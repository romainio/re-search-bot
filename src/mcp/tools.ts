import { buildHealth } from "../admin-health";
import { runTool, toolSchemas, validateArgs } from "../assistant/tools";
import { MCP_PROBE_MAX_BYTES, NEIGHBOR_MAX, NEIGHBOR_RADIUS_KM, NEIGHBOR_RADIUS_MAX_KM } from "../config/mcp";
import { UNIVERSAL_DEFAULT_EVERY } from "../config/universal";
import { settings } from "../derive";
import { fetchSource } from "../fetch-source";
import { isObj } from "../guards";
import type { Obj } from "../guards";
import { EVERY_VALUES, isConfigured, USER_PARSER_IDS } from "../instance";
import { configOrigin, loadLiveConfig, saveSwitches } from "../live-config";
import { detectTemplate } from "../prospect/template";
import { publicUrl } from "../public-url";
import { setupTelegram } from "../telegram/webhook";
import type { Env, SourceDef } from "../types";
import { bool, list, num, str, townRegex } from "./args";
import { localise } from "./communes";
import { probe, REFUSED, sourceFromArgs } from "./probe";
import { proposeSources } from "./propose";
import { commit, rawConfig, rawSources, searchOf } from "./stored-config";
import { rotateMcpToken } from "./token";

// Outils MCP : un assistant IA paramètre l'instance avec l'utilisateur. Toute écriture passe par src/live-config.ts (validée,
// sans redéploiement). Une source n'est ajoutée qu'après une lecture réussie par le Worker : un site qui refuse la lecture
// automatique (403, 429, anti-bot) n'est jamais ajouté.

export interface ToolContext {
  env: Env;
  origin: string;
  now: Date;
}
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Obj;
  run: (args: Obj, ctx: ToolContext) => Promise<unknown>;
}

/* ---- Schémas ---- */
const S = { type: "string" } as const;
const N = { type: "number" } as const;
const B = { type: "boolean" } as const;
const POSTALS = { type: "array", items: { type: "string", pattern: "^\\d{5}$" } } as const;
const schema = (properties: Obj, required: string[] = []): Obj => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const SOURCE_FIELDS = {
  adresse: { ...S, description: "Adresse de la page qui LISTE les locations (pas la page d'accueil)." },
  lecteur: {
    type: "string",
    enum: [...USER_PARSER_IDS],
    description:
      "Lecteur du gabarit du site (detecter_gabarit le propose) ; « universal » : lecture par le modèle, pour un site sans lecteur.",
  },
  zones: { ...POSTALS, description: "Codes postaux de la recherche que cette source couvre (défaut : tous)." },
  filtree_sur_les_zones: {
    ...B,
    description:
      "true si l'adresse ne renvoie QUE des annonces de ces zones (recherche déjà filtrée par ville) ; false pour une agence qui liste tout (défaut).",
  },
  encodage: { type: "string", enum: ["utf-8", "windows-1252"] },
  cadence_minutes: {
    type: "number",
    enum: [...EVERY_VALUES],
    description: `Lecture toutes les N minutes (défaut : 5 ; ${UNIVERSAL_DEFAULT_EVERY} pour « universal »).`,
  },
};

const SEARCH_SCHEMA = (toolSchemas() as { function: { name: string; description: string; parameters: Obj } }[]).find(
  (t) => t.function.name === "chercher_annonces",
)!;

export const MCP_TOOLS: McpTool[] = [
  {
    name: "etat",
    description:
      "État de l'instance : recherche en vigueur, fonctions allumées, Telegram lié ou non, sources en panne, problèmes à traiter et prochaines étapes. À appeler en premier.",
    inputSchema: schema({}),
    run: async (_a, { env, now }) => {
      const h = await buildHealth(env, now);
      const i = settings().instance;
      const configured = isConfigured(i);
      const active = i.sources.filter((s) => s.active).length;
      const next: string[] = [];
      if (!configured)
        next.push(
          "Définir la recherche de l'utilisateur (definir_recherche) : zones et loyer_max au moins ; puis completer_localisation.",
        );
      else if (active === 0)
        next.push(
          "Ajouter des sources (proposer_sources puis ajouter_source ; agence locale : detecter_gabarit) : aucune source active.",
        );
      if (!h.secrets.TELEGRAM_BOT_TOKEN)
        next.push(
          "Secret TELEGRAM_BOT_TOKEN absent : à créer avec @BotFather puis à ajouter au Worker (tableau de bord Cloudflare, Variables et secrets).",
        );
      else if (!h.secrets.TELEGRAM_CHAT_ID) next.push("Lier la conversation Telegram (lier_telegram).");
      return {
        parametree: configured,
        configuration:
          configOrigin() === "d1" ? "enregistrée (modifiable ici)" : "fichier embarqué (instance.config.json)",
        recherche: searchOf(),
        sources: {
          total: i.sources.length,
          actives: active,
          en_panne: h.sources?.broken ?? [],
          en_retard: h.sources?.stale ?? [],
        },
        fonctions: h.switches.map((s) => ({
          nom: s.name,
          allumee: s.on,
          guide: s.doc,
          ...(s.missing.length ? { manque: s.missing } : {}),
        })),
        telegram: {
          jeton: h.secrets.TELEGRAM_BOT_TOKEN ?? false,
          conversation_liee: h.secrets.TELEGRAM_CHAT_ID ?? false,
        },
        ia: h.ai ? { neurons_du_jour: h.ai.spent, plafond: h.ai.cap } : null,
        problemes: h.problems,
        prochaines_etapes: next,
      };
    },
  },
  {
    name: "definir_recherche",
    description:
      "Définit ou modifie la recherche : zones (codes postaux), loyer, surface, pièces, heures d'alerte. Seuls les champs donnés changent. Changer les zones retire les sources qui ne couvrent plus aucune zone (elles sont nommées dans la réponse). Seuls ces critères retirent une annonce : tout le reste n'est qu'un indice.",
    inputSchema: schema({
      zones: {
        type: "array",
        description:
          "Zones surveillées (remplace la liste). Un code postal par zone ; « commune » : nom de la ville, pour reconnaître une annonce sans code postal.",
        items: schema(
          {
            code_postal: { ...S, pattern: "^\\d{5}$" },
            libelle: { ...S, description: "Nom court affiché dans les alertes (« Lyon 3e »)." },
            commune: S,
          },
          ["code_postal", "libelle"],
        ),
      },
      communes_exclues: {
        type: "array",
        description: "Communes voisines à écarter quand une source les mélange à la recherche (remplace la liste).",
        items: schema({ code_postal: { ...S, pattern: "^\\d{5}$" }, commune: S }, ["code_postal", "commune"]),
      },
      loyer_min: { ...N, description: "Loyer minimal, charges comprises (écarte les parkings et les colocations)." },
      loyer_max: { ...N, description: "Loyer maximal, charges comprises." },
      surface_min: { ...N, description: "Surface minimale en m²." },
      pieces_min: { ...N, description: "Nombre de pièces minimal." },
      exclure_rez_de_chaussee: B,
      quartiers: {
        type: "array",
        items: S,
        description:
          "Mots qui signalent un quartier préféré dans une annonce (noms de rues, de places, de stations) : indice, jamais un filtre.",
      },
      nom_du_quartier: {
        ...S,
        description:
          "Nom affiché du quartier repéré par ces mots (« Croix-Rousse ») : badge de l'alerte et filtre du tableau de bord.",
      },
      heure_debut: { ...N, description: "Première heure des alertes (0-23, heure de Paris)." },
      heure_fin: { ...N, description: "Dernière heure des alertes (1-24)." },
    }),
    run: async (a, { env, now }) => {
      const { raw, version } = await rawConfig(env.DB);
      const removed: string[] = [];
      const zones = list(a, "zones");
      if (zones) {
        const before = new Map(
          (Array.isArray(raw.zones) ? (raw.zones as unknown[]) : []).filter(isObj).map((z) => [z.postalCode, z]),
        );
        raw.zones = zones.map((z, i) => {
          if (!isObj(z)) throw new Error(`zones[${i}] : objet attendu`);
          const postalCode = str(z, "code_postal", true);
          const town = str(z, "commune");
          // Une zone gardée conserve son emprise (prospection) et sa commune quand « commune » n'est pas redonnée.
          const kept = before.get(postalCode);
          const keptTown = town ? townRegex(town) : kept?.town;
          return {
            ...(kept?.bbox ? { bbox: kept.bbox } : {}),
            postalCode,
            label: str(z, "libelle", true),
            ...(keptTown ? { town: keptTown } : {}),
          };
        });
        const codes = new Set((raw.zones as Obj[]).map((z) => z.postalCode));
        raw.sources = rawSources(raw).flatMap((s) => {
          const left = (Array.isArray(s.zones) ? s.zones : []).filter((z) => codes.has(z));
          if (!left.length) {
            removed.push(String(s.id));
            return [];
          }
          return [{ ...s, zones: left }];
        });
        if (Array.isArray(raw.outOfZoneTowns))
          raw.outOfZoneTowns = (raw.outOfZoneTowns as unknown[]).filter((t) => isObj(t) && !codes.has(t.postalCode));
        if (raw.keywordsZone !== undefined && !codes.has(raw.keywordsZone)) delete raw.keywordsZone;
      }
      const out = list(a, "communes_exclues");
      if (out)
        raw.outOfZoneTowns = out.map((t, i) => {
          if (!isObj(t)) throw new Error(`communes_exclues[${i}] : objet attendu`);
          return { postalCode: str(t, "code_postal", true), town: townRegex(str(t, "commune", true)) };
        });
      const criteria: Obj = { ...(isObj(raw.criteria) ? raw.criteria : {}) };
      for (const [arg, key] of [
        ["loyer_min", "rentMin"],
        ["loyer_max", "rentMax"],
        ["surface_min", "surfaceMin"],
        ["pieces_min", "roomsMin"],
      ] as const) {
        const v = num(a, arg);
        if (v !== undefined) criteria[key] = v;
      }
      const rdc = bool(a, "exclure_rez_de_chaussee");
      if (rdc !== undefined) criteria.excludeGroundFloor = rdc;
      // Rien à écrire tant qu'aucun critère n'est donné : une instance non paramétrée n'en porte pas.
      if (Object.keys(criteria).length) raw.criteria = criteria;
      const kw = list(a, "quartiers");
      if (kw) raw.neighborhoodKeywords = kw;
      const label = str(a, "nom_du_quartier");
      if (label) raw.neighborhoodLabel = label;
      const start = num(a, "heure_debut"),
        end = num(a, "heure_fin");
      if (start !== undefined || end !== undefined)
        raw.window = {
          ...(isObj(raw.window) ? raw.window : {}),
          ...(start !== undefined ? { startHour: start } : {}),
          ...(end !== undefined ? { endHour: end } : {}),
        };
      await commit(env, raw, version, now);
      return {
        ok: true,
        recherche: searchOf(),
        ...(removed.length ? { sources_retirees: removed } : {}),
        sources_actives: settings().instance.sources.filter((s) => s.active).length,
      };
    },
  },
  {
    name: "completer_localisation",
    description:
      "Complète la localisation par l'API publique des communes (geo.api.gouv.fr) : commune de chaque zone quand son code postal ne couvre qu'elle, et communes voisines dans un rayon donné, enregistrées comme communes à écarter (une annonce qui les nomme sans code postal est alors refusée au lieu d'être gardée « localisation non confirmée »). À appeler après definir_recherche. Les communes ajoutées à la main sont gardées.",
    inputSchema: schema({
      rayon_km: {
        ...N,
        description: `Rayon autour des zones (défaut ${NEIGHBOR_RADIUS_KM} km, au plus ${NEIGHBOR_RADIUS_MAX_KM}).`,
      },
    }),
    run: async (a, { env, now }) => {
      const radius = num(a, "rayon_km") ?? NEIGHBOR_RADIUS_KM;
      if (radius <= 0 || radius > NEIGHBOR_RADIUS_MAX_KM)
        throw new Error(`rayon_km : entre 1 et ${NEIGHBOR_RADIUS_MAX_KM}`);
      const { raw, version } = await rawConfig(env.DB);
      const zones = (Array.isArray(raw.zones) ? (raw.zones as unknown[]) : []).filter(isObj);
      const codes = zones.map((z) => String(z.postalCode));
      const loc = await localise(codes, radius);
      const named: string[] = [];
      for (const z of zones) {
        const town = loc.zoneTowns[String(z.postalCode)];
        if (town && z.town === undefined) {
          z.town = townRegex(town);
          named.push(`${String(z.postalCode)} ${town}`);
        }
      }
      const found = loc.neighbors.map((n) => ({ postalCode: n.postalCode, town: townRegex(n.nom) }));
      const foundCodes = new Set(found.map((t) => t.postalCode));
      const kept = (Array.isArray(raw.outOfZoneTowns) ? (raw.outOfZoneTowns as unknown[]) : []).filter(
        (t): t is Obj => isObj(t) && !foundCodes.has(String(t.postalCode)),
      );
      raw.outOfZoneTowns = [...kept, ...found].slice(0, NEIGHBOR_MAX + kept.length);
      await commit(env, raw, version, now);
      return {
        ok: true,
        rayon_km: radius,
        zones_nommees: named,
        communes_exclues: loc.neighbors.map((n) => `${n.nom} (${n.postalCode}, ${n.km} km)`),
        gardees_a_la_main: kept.length,
        conseil:
          "Si une commune de la liste fait partie de la recherche, l'ajouter comme zone (definir_recherche) : elle sera retirée des communes exclues au prochain appel.",
      };
    },
  },
  {
    name: "proposer_sources",
    description:
      "Propose des sources pour les zones de la recherche : Bien'ici et les réseaux nationaux (Foncia, Laforêt, Orpi, ERA, Crédit Agricole Immobilier, Century 21), adresses construites pour chaque commune ou arrondissement. Rien n'est enregistré : ajouter chaque proposition par ajouter_source (qui la lit d'abord ; celles qui échouent sont à laisser de côté). Les agences locales s'ajoutent ensuite une à une (detecter_gabarit).",
    inputSchema: schema({}),
    run: async () => {
      const i = settings().instance;
      const { proposals, unknown } = await proposeSources(
        i.zones.map((z) => z.postalCode),
        { min: i.criteria.rentMin, max: i.criteria.rentMax },
      );
      const ids = new Set(i.sources.map((s) => s.id));
      const urls = new Set(i.sources.map((s) => s.url));
      return {
        propositions: proposals.map((p) => ({
          ...p,
          ...(ids.has(p.id) || urls.has(p.adresse) ? { deja_enregistree: true } : {}),
        })),
        ...(unknown.length ? { codes_postaux_inconnus: unknown } : {}),
        conseil:
          "Appeler ajouter_source pour chaque proposition non enregistrée, avec ses champs tels quels (id, nom, adresse, lecteur, zones, filtree_sur_les_zones). Une proposition « verifie: false » suit un modèle d'adresse pas encore vu sur cette ville : l'essai tranche.",
      };
    },
  },
  {
    name: "lister_sources",
    description:
      "Sources enregistrées (agences et portails lus) : identifiant, adresse, lecteur, zones, active ou non.",
    inputSchema: schema({}),
    run: async () => ({
      sources: settings().instance.sources.map((s) => ({
        id: s.id,
        nom: s.name,
        adresse: s.url,
        lecteur: s.parser,
        zones: s.zones,
        active: s.active,
        ...(s.note ? { note: s.note } : {}),
      })),
    }),
  },
  {
    name: "detecter_gabarit",
    description:
      "Lit la page d'un site d'agence (une requête) et reconnaît son gabarit : rend le lecteur à utiliser, ou indique qu'aucun lecteur dédié n'existe.",
    inputSchema: schema({ adresse: { ...S, description: "Adresse du site ou de sa page de locations." } }, ["adresse"]),
    run: async (a) => {
      const url = publicUrl(str(a, "adresse", true));
      const res = await fetchSource({
        id: "gabarit",
        name: "gabarit",
        url,
        parser: "universal",
        group: 0,
        zones: [],
        filteredToZones: false,
        phone: null,
        encoding: "utf-8",
        active: true,
        maxBytes: MCP_PROBE_MAX_BYTES,
      });
      if (!res.ok)
        return {
          ok: false,
          erreur: res.reason,
          conseil: REFUSED.test(res.reason)
            ? "Ce site refuse la lecture automatique : ne pas l'ajouter (aucun contournement d'anti-bot)."
            : "Page injoignable : vérifier l'adresse.",
        };
      const m = detectTemplate(res.body);
      return m.parser
        ? {
            ok: true,
            gabarit: m.template,
            lecteur: m.parser,
            conseil: "Essayer ce lecteur sur la page qui liste les locations (tester_source).",
          }
        : {
            ok: true,
            gabarit: "inconnu",
            lecteur: null,
            conseil:
              "Aucun lecteur dédié. Essayer « universal » (lecture par le modèle : UNIVERSAL_READER allumé, consomme le budget IA), ou un portail qui reprend les annonces de cette agence.",
          };
    },
  },
  {
    name: "tester_source",
    description:
      "Essaie une source sans rien enregistrer : lit la page, applique le lecteur et les critères de la recherche, rend le nombre d'annonces lues et gardées avec des exemples. Donner « id » pour une source déjà enregistrée, sinon « adresse » et « lecteur ».",
    inputSchema: schema({ id: { ...S, description: "Identifiant d'une source enregistrée." }, ...SOURCE_FIELDS }),
    run: async (a, { env }) => {
      const id = str(a, "id");
      let src: SourceDef;
      if (id) {
        const s = settings().instance.sources.find((x) => x.id === id);
        if (!s) throw new Error(`source inconnue : ${id} (lister_sources)`);
        src = { ...s, group: 0 } as SourceDef;
      } else src = sourceFromArgs(a, "essai", "essai");
      const r = await probe(env, src);
      return r.ok ? { ok: true, ...r.report } : { ok: false, erreur: r.reason, conseil: r.advice };
    },
  },
  {
    name: "ajouter_source",
    description:
      "Ajoute une source après l'avoir lue avec succès (l'essai est refait ici : une source illisible ou un site qui refuse la lecture automatique n'est jamais ajouté). Le premier passage est silencieux : seules les annonces qui paraissent ensuite sont alertées.",
    inputSchema: schema(
      {
        id: { ...S, pattern: "^[a-z0-9_]+$", description: "Identifiant court et stable (« foncia_lyon3 »)." },
        nom: { ...S, description: "Nom affiché dans les alertes." },
        ...SOURCE_FIELDS,
        telephone: { ...S, description: "Téléphone de l'agence, s'il est connu (affiché dans l'alerte)." },
      },
      ["id", "nom", "adresse", "lecteur"],
    ),
    run: async (a, { env, now }) => {
      const src = sourceFromArgs(a, str(a, "id", true), str(a, "nom", true));
      const { raw, version } = await rawConfig(env.DB);
      if (rawSources(raw).some((s) => s.id === src.id)) throw new Error(`identifiant déjà pris : ${src.id}`);
      const r = await probe(env, src);
      if (!r.ok) throw new Error(`source non ajoutée, lecture impossible (${r.reason}). ${r.advice}`);
      raw.sources = [
        ...rawSources(raw),
        {
          id: src.id,
          name: src.name,
          url: src.url,
          parser: src.parser,
          zones: src.zones,
          filteredToZones: src.filteredToZones,
          phone: src.phone,
          ...(src.encoding !== "utf-8" ? { encoding: src.encoding } : {}),
          ...(src.every !== undefined ? { every: src.every } : {}),
        },
      ];
      await commit(env, raw, version, now);
      return {
        ok: true,
        ajoutee: src.id,
        essai: r.report,
        sources_actives: settings().instance.sources.filter((s) => s.active).length,
      };
    },
  },
  {
    name: "retirer_source",
    description: "Retire une source de la configuration (ses annonces déjà vues restent au tableau de bord).",
    inputSchema: schema({ id: S }, ["id"]),
    run: async (a, { env, now }) => {
      const id = str(a, "id", true);
      const { raw, version } = await rawConfig(env.DB);
      const left = rawSources(raw).filter((s) => s.id !== id);
      if (left.length === rawSources(raw).length) throw new Error(`source inconnue : ${id} (lister_sources)`);
      raw.sources = left;
      await commit(env, raw, version, now);
      return { ok: true, retiree: id, sources_actives: settings().instance.sources.filter((s) => s.active).length };
    },
  },
  {
    name: "regler_fonctions",
    description:
      "Allume ou éteint des fonctions facultatives (noms et guides : outil etat). true : allumée, false : éteinte, null : valeur d'origine du déploiement. Éteindre MCP_ENABLED coupe ce serveur.",
    inputSchema: schema(
      {
        fonctions: {
          type: "object",
          description: "{ NOM: true | false | null }",
          additionalProperties: { type: ["boolean", "null"] },
        },
      },
      ["fonctions"],
    ),
    run: async (a, { env, now }) => {
      const saved = await saveSwitches(env.DB, a.fonctions, now);
      const live = await loadLiveConfig(env);
      const h = await buildHealth(live, now);
      return {
        ok: true,
        enregistrees: saved,
        manques: h.switches
          .filter((s) => s.on && s.missing.length)
          .map((s) => ({ nom: s.name, manque: s.missing, guide: s.doc })),
      };
    },
  },
  {
    name: "lier_telegram",
    description:
      "Installe le lien avec le bot Telegram et rend le code à envoyer au bot (« /start CODE ») pour recevoir les alertes dans cette conversation. Demande le secret TELEGRAM_BOT_TOKEN et la fonction TELEGRAM_INTERACTIVE allumée.",
    inputSchema: schema({}),
    run: async (_a, { env, origin }) => {
      if (env.TELEGRAM_INTERACTIVE !== "true")
        throw new Error(
          "TELEGRAM_INTERACTIVE est éteinte : l'allumer d'abord (regler_fonctions), puis rappeler lier_telegram",
        );
      const r = await setupTelegram(env, origin);
      if (r.status !== 200) throw new Error(`installation Telegram refusée : ${JSON.stringify(r.body).slice(0, 500)}`);
      const link = r.body.link as { code: string; instruction: string } | undefined;
      return link
        ? { ok: true, a_faire: link.instruction, code: link.code }
        : { ok: true, conversation: "déjà liée : les alertes y arrivent" };
    },
  },
  {
    name: "regenerer_adresse",
    description:
      "Change l'adresse de ce connecteur (nouveau jeton) et rend la nouvelle. L'ancienne cesse de fonctionner aussitôt : remplacer l'adresse dans les réglages du connecteur de l'assistant. À faire si l'adresse a été divulguée.",
    inputSchema: schema({}),
    run: async (_a, { env, origin }) => ({
      ok: true,
      adresse: `${origin}/mcp/${await rotateMcpToken(env.DB)}`,
      a_faire:
        "Remplacer l'adresse du connecteur par celle-ci dans les réglages de l'assistant : l'ancienne ne répond plus.",
    }),
  },
  {
    name: "chercher_annonces",
    description: `${SEARCH_SCHEMA.function.description} Lecture seule.`,
    // Schéma recalculé à chaque tools/list (zones en vigueur).
    inputSchema: SEARCH_SCHEMA.function.parameters,
    run: async (a, { env, now }) => {
      const v = validateArgs("chercher_annonces", a);
      if (!v.ok) throw new Error(v.error);
      return (await runTool(env, "chercher_annonces", v.args, now)).data;
    },
  },
];

/** Liste rendue par tools/list : le schéma de chercher_annonces suit les zones de la configuration en vigueur. */
export function toolList(): { name: string; description: string; inputSchema: Obj }[] {
  const search = (toolSchemas() as { function: { name: string; parameters: Obj } }[]).find(
    (t) => t.function.name === "chercher_annonces",
  );
  return MCP_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.name === "chercher_annonces" && search ? search.function.parameters : t.inputSchema,
  }));
}
