import { buildTools } from "./assistant/tools";
import type { ToolTable } from "./assistant/tools";
import { UNIVERSAL_DAILY_CAP } from "./config/ai";
import { norm } from "./filter";
import { INSTANCE } from "./instance";
import type { Instance, UserPhotoCriterion, UserZone } from "./instance";
import { stopWordsOf } from "./prospect/match";
import { sourceRegistry } from "./sources";
import type { SourceRegistry } from "./sources";

/**
 * Réglages en vigueur : tout ce qui se tire de l'instance, calculé une fois par `derive` et gelé. Un changement de configuration
 * remplace l'objet entier, sans mélange de deux configurations ; un traitement qui veut une vue stable lit settings() une fois.
 */
export interface Settings {
  /** L'instance validée d'où tout le reste est tiré. */
  readonly instance: Instance;
  readonly criteria: Readonly<Instance["criteria"]>;
  readonly zones: readonly UserZone[];
  /** Codes postaux acceptés par evaluate ; tout autre code connu est écarté en « localisation ». */
  readonly allowedPostalCodes: readonly string[];
  /** Communes voisines hors zones : une annonce qui les cite est écartée en « localisation ». */
  readonly outOfZoneTowns: Instance["outOfZoneTowns"];
  /** Quartier : le drapeau « quartier » n'est posé que sur une annonce de `zone`, ou de zone inconnue. */
  readonly neighborhood: {
    readonly keywords: readonly string[];
    readonly normalizedKeywords: readonly string[];
    readonly zone: string;
    readonly label: string;
  };
  /** Fenêtre de lecture et résumé du soir, en heure de Paris. */
  readonly window: Readonly<Instance["window"]>;
  readonly photoCriteria: readonly UserPhotoCriterion[];
  readonly photoIds: ReadonlySet<string>;
  /** Plafonds de neurons par jour UTC, global et par fonction (clé de canSpend/record). */
  readonly ai: { readonly dailyNeurons: number; readonly featureCaps: Readonly<Record<string, number>> };
  readonly geo: Readonly<Instance["geo"]>;
  /** Prospection : emprise de chaque zone (Overpass) et mots sans valeur d'identification d'un nom d'agence. */
  readonly prospect: {
    readonly bbox: Readonly<Record<string, readonly [number, number, number, number]>>;
    readonly stopWords: ReadonlySet<string>;
  };
  readonly sources: SourceRegistry;
  /** Codes postaux des zones en JSON (paramètre lié des requêtes de marché). */
  readonly marketZonesJson: string;
  /** Schémas des outils de l'assistant (zones et critères photo de l'instance). */
  readonly assistantTools: ToolTable;
}

/** Gel profond des objets et tableaux ; RegExp et Set restent tels quels. */
function deepFreeze<T>(o: T): T {
  if (
    o &&
    typeof o === "object" &&
    !Object.isFrozen(o) &&
    (Array.isArray(o) || Object.getPrototypeOf(o) === Object.prototype)
  ) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** Réglages d'une instance déjà validée ; lève seulement si les sources ne tiennent pas dans les groupes (vérifié par checkInstance). */
export function derive(i: Instance): Settings {
  return deepFreeze({
    instance: i,
    criteria: i.criteria,
    zones: i.zones,
    allowedPostalCodes: i.zones.map((z) => z.postalCode),
    outOfZoneTowns: i.outOfZoneTowns,
    neighborhood: {
      keywords: i.neighborhoodKeywords,
      normalizedKeywords: i.neighborhoodKeywords.map(norm),
      zone: i.keywordsZone,
      label: i.neighborhoodLabel,
    },
    window: i.window,
    photoCriteria: i.photoCriteria,
    photoIds: new Set(i.photoCriteria.map((c) => c.id)),
    // Le lecteur universel garde au moins UNIVERSAL_DAILY_CAP, quel que soit le plafond de l'instance.
    ai: {
      dailyNeurons: i.ai.dailyNeurons,
      featureCaps: { ...i.ai.featureCaps, universal: Math.max(i.ai.featureCaps.universal ?? 0, UNIVERSAL_DAILY_CAP) },
    },
    geo: i.geo,
    prospect: {
      bbox: Object.fromEntries(
        i.zones.flatMap((z): [string, [number, number, number, number]][] => (z.bbox ? [[z.postalCode, z.bbox]] : [])),
      ),
      stopWords: stopWordsOf(i),
    },
    sources: sourceRegistry(i),
    marketZonesJson: JSON.stringify(i.zones.map((z) => z.postalCode)),
    assistantTools: buildTools(i),
  });
}

// Dérivation paresseuse : derive et ses briques s'importent mutuellement, rien ne se calcule au chargement d'un module.
let bundled: Settings | undefined;
let current: Settings | undefined;

/** Réglages du fichier embarqué : valeur de départ, et repli quand D1 ne porte aucune configuration. */
export function bundledSettings(): Settings {
  bundled ??= derive(INSTANCE);
  return bundled;
}

/** Réglages en vigueur dans cet isolat. */
export function settings(): Settings {
  return current ?? bundledSettings();
}

/** Met en vigueur des réglages : un remplacement atomique pour qui a déjà lu settings(). */
export function useSettings(s: Settings): void {
  current = s;
}
