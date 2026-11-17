import { MINUTE_MS } from "../time";

/** Sous-requêtes par invocation sur le plan gratuit (fetch, binding de service, API externe). */
export const SUBREQUEST_LIMIT = 50;
/** Marge de l'orchestrateur : un saut de redirection compte comme une sous-requête. */
export const SUBREQUEST_MARGIN = 2;

/** Sources par sous-lot, chaque sous-lot dans sa propre invocation /part (10 ms de CPU) : deux sources dépassent ce budget. */
export const PART_SIZE = 1;
/** Délai maximal d'un sous-lot avant de le compter en échec. */
export const PART_TIMEOUT_MS = 25_000;
/** Aucun sous-lot ne démarre après ce délai : un passage ne déborde pas sur le cron suivant. */
export const PASS_DEADLINE_MS = 40_000;
/**
 * Écart maximal entre l'instant signé et l'horloge de /part (anti-rejeu). L'orchestrateur signe son horloge réelle, jamais
 * scheduledTime (un cron peut partir en retard) : l'écart normal est la durée du passage.
 */
export const PART_MAX_SKEW_MS = 10 * MINUTE_MS;
/** Taille maximale du corps d'une requête interne (/part, /embed). */
export const PART_MAX_BODY = 4096;
/** Marge laissée après les fiches d'un sous-lot pour le traitement et les écritures D1. */
export const ENRICH_RESERVE_MS = 5_000;
/** Temps restant sous lequel un sous-lot ne lance plus de fiche ni de géocodage. */
export const MIN_LOOKUP_TIMEOUT_MS = 1_000;

/** Doublons entre sources : écart de loyer (€) et de surface (m²) tolérés pour une même annonce. */
export const DUP_PRICE_TOLERANCE = 150;
export const DUP_SURFACE_TOLERANCE = 1;
/** Alertes envoyées au plus par passage (les suivantes attendent le passage suivant). */
export const ALERT_BUDGET = 15;
export const MAX_ALERT_ATTEMPTS = 5;
/** Passages en échec de suite avant de déclarer une source en panne. */
export const FAILURES_BEFORE_BROKEN = 3;
/** Zéro annonce après au moins ce nombre au passage précédent : gabarit changé, compté en échec (1 ou 2 puis 0 : page vide légitime). */
export const EMPTY_SUSPECT_MIN_PREV = 3;
/** last_seen n'est réécrit qu'au-delà de ce délai : ~2 écritures D1 par annonce et par jour au lieu d'une par passage. */
export const SEEN_REFRESH_HOURS = 6;
/**
 * Annonce absente d'un passage réussi et du précédent, vue il y a plus de 12 h : disparue. 12 h couvrent le retard possible de
 * last_seen (SEEN_REFRESH_HOURS) ; exiger deux passages écarte une absence passagère.
 */
export const GONE_AFTER_HOURS = 12;
/** Lignes suivies lues au plus par source et par passage. */
export const TRACKED_LIMIT = 500;
/** Fenêtre du tableau de bord (section « Disparues récemment », chiffres de tête). */
export const GONE_WINDOW_DAYS = 30;
