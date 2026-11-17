// Prospection des agences (src/prospect/, docs/prospection.md).

/** API Recherche d'entreprises : activité NAF 68.31Z (agences immobilières) ; 25 résultats par page au plus (limite de l'API). */
export const PROSPECT_NAF = "68.31Z";
export const PROSPECT_ENTREPRISES_URL = "https://recherche-entreprises.api.gouv.fr/search";
export const PROSPECT_ENTREPRISES_PER_PAGE = 25;
/** Pages de l'API lues par pas (~110 Ko de JSON chacune, sous les 10 ms de CPU). */
export const PROSPECT_PAGES_PER_STEP = 3;
/** Overpass : miroir public (usage raisonnable : une requête par zone et par campagne, jamais en rafale). */
export const PROSPECT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
/** Éléments OSM lus au plus par zone (« out ... N » côté serveur) : borne la taille de la réponse et le CPU du parsing JSON. */
export const PROSPECT_OVERPASS_LIMIT = 200;
/** Réponse Overpass abandonnée au-delà de cette taille (octets). */
export const PROSPECT_OVERPASS_MAX_BYTES = 400_000;
/** Délai d'une requête Overpass : le serveur peut mettre plusieurs secondes à répondre. */
export const PROSPECT_OVERPASS_TIMEOUT_MS = 20_000;

/** Page d'accueil d'un site candidat : octets lus au plus, délai, sites regardés par pas (sous-requêtes parallèles). */
export const PROSPECT_SITE_MAX_BYTES = 300_000;
export const PROSPECT_SITE_TIMEOUT_MS = 8_000;
export const PROSPECT_SITES_PER_STEP = 8;
/** Sous-requêtes externes au plus par pas (sous les 50 du plan gratuit, marge pour l'écriture Telegram et les réessais). */
export const PROSPECT_STEP_BUDGET = 20;
export const PROSPECT_API_TIMEOUT_MS = 10_000;
/** Une campagne par mois : la suivante part quand la précédente a commencé il y a au moins ce nombre de jours. */
export const PROSPECT_INTERVAL_DAYS = 28;
/** Bail d'un pas : un pas pris depuis moins de ce délai n'est pas relancé par un cron voisin. */
export const PROSPECT_LEASE_MS = 60_000;
/** Pas en échec de suite avant d'abandonner la phase en cours. */
export const PROSPECT_MAX_STEP_FAILURES = 5;
/** Texte de page envoyé au modèle pour « publie-t-il des locations ? » (caractères). */
export const PROSPECT_AI_TEXT_MAX = 3_000;
/** Coût pessimiste d'un appel « publie-t-il des locations ? » (~1 200 jetons en entrée). */
export const PROSPECT_AI_ESTIMATE_NEURONS = 15;
/** Candidats listés au plus dans la section du tableau de bord et dans le message Telegram. */
export const PROSPECT_DASHBOARD_LIMIT = 40;
export const PROSPECT_TELEGRAM_LIMIT = 10;
/** Plateformes partagées par plusieurs agences : un site n'y est rapproché du registre que si l'hôte est identique. */
export const PROSPECT_PLATFORM_DOMAINS: readonly string[] = [
  "la-boite-immo.com",
  "fnaim.fr",
  "orpi.com",
  "century21.fr",
  "ca-immobilier.fr",
  "bienici.com",
  "foncia.com",
  "laforet.com",
  "eraimmobilier.com",
  "nestenn.com",
  "stephaneplaza.com",
  "guy-hoquet.com",
  "immo-facile.com",
];
