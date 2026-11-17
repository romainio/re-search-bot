/**
 * Groupes de sources : la minute UTC modulo GROUP_COUNT désigne le groupe lu, soit une lecture toutes les 5 minutes (GROUP_COUNT
 * divise 60). GROUP_MAX_SOURCES est borné par PASS_DEADLINE_MS et les sous-requêtes de l'orchestrateur.
 */
export const GROUP_COUNT = 5;
export const GROUP_MAX_SOURCES = 10;
/**
 * Voies : chaque minute lit un groupe par voie en parallèle (groupe v × GROUP_COUNT + minute modulo GROUP_COUNT). Un seul cron,
 * car Cloudflare fusionne deux crons équivalents.
 */
export const LANE_COUNT = 2;
/** Groupes au registre (SourceDef.group, 0 à TOTAL_GROUPS - 1). */
export const TOTAL_GROUPS = GROUP_COUNT * LANE_COUNT;

/** Source sans passage complet depuis plus de N minutes (en fenêtre active) : signalée en panne. */
export const STALE_AFTER_MINUTES = 20;
/** Retard toléré (minutes) d'une source à cadence réduite (SourceDef.every). */
export const staleAfterMinutes = (every = 5): number => STALE_AFTER_MINUTES + Math.max(0, every - 5);
