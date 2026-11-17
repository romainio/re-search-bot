// Assistant conversationnel (src/assistant/, docs/assistant.md).

/** Modèle de l'assistant : appel de fonctions, plan gratuit, tarif dans AI_MODEL_RATES. */
export const ASSISTANT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
/** Tours d'outils au plus par question ; ensuite, un dernier appel sans outil force la réponse. */
export const ASSISTANT_MAX_TOOL_TURNS = 3;
/** Appels d'outils exécutés au plus par tour du modèle, et au total par question (le surplus est ignoré). */
export const ASSISTANT_MAX_CALLS_PER_TURN = 3;
export const ASSISTANT_MAX_CALLS_TOTAL = 6;
/** Délai d'un appel modèle (l'utilisateur attend la réponse). */
export const ASSISTANT_TIMEOUT_MS = 20_000;
/** Jetons de sortie au plus par appel (un appel d'outil ou une réponse courte). */
export const ASSISTANT_MAX_TOKENS = 400;
/** Coût pessimiste d'un appel modèle : ~3 500 jetons en entrée, 300 en sortie. */
export const ASSISTANT_ESTIMATE_CALL = 45;
/** Coût pessimiste d'une question entière, vérifié avant de commencer. */
export const ASSISTANT_ESTIMATE_QUESTION = ASSISTANT_ESTIMATE_CALL * (ASSISTANT_MAX_TOOL_TURNS + 1);
/** Questions acceptées par heure glissante (comptées dans assistant_history) et longueur maximale d'une question. */
export const ASSISTANT_MAX_PER_HOUR = 20;
export const ASSISTANT_QUESTION_MAX = 400;
/** Historique : échanges rejoués au modèle, et durée de conservation (heures) avant purge. */
export const ASSISTANT_HISTORY_TURNS = 3;
export const ASSISTANT_HISTORY_HOURS = 24;
/** Longueurs (caractères) des textes rejoués au modèle : historique, question précédente, appel et résultat d'outil. */
export const ASSISTANT_HISTORY_ANSWER_MAX = 300;
export const ASSISTANT_HISTORY_CONTEXT_MAX = 500;
export const ASSISTANT_PREVIOUS_QUESTION_MAX = 200;
export const ASSISTANT_TOOL_NAME_MAX = 40;
export const ASSISTANT_TOOL_ARGS_SHOWN = 300;
export const ASSISTANT_TOOL_RESULT_MAX = 4_000;
/** Annonces listées au plus dans une réponse, et rendues au plus par un outil (petit résultat = peu de jetons). */
export const ASSISTANT_LIST_MAX = 5;
export const ASSISTANT_TOOL_LIMIT_MAX = 10;
export const ASSISTANT_TOOL_LIMIT_DEFAULT = 5;
/** Arguments bruts d'un appel d'outil (texte JSON) acceptés au plus (caractères). */
export const ASSISTANT_ARGS_MAX = 2_000;
/** Texte du modèle conservé dans la réponse (caractères) ; le reste est coupé. */
export const ASSISTANT_TEXT_MAX = 700;
/** Titre et description d'une annonce dans un résultat d'outil (caractères). */
export const ASSISTANT_TITLE_MAX = 70;
export const ASSISTANT_DESC_MAX = 300;
/** Bornes de validation des arguments d'outils (hors bornes : appel refusé, jamais « corrigé » en silence). */
export const ASSISTANT_RENT_RANGE: readonly [number, number] = [300, 10_000];
export const ASSISTANT_SURFACE_RANGE: readonly [number, number] = [9, 250];
export const ASSISTANT_ROOMS_RANGE: readonly [number, number] = [1, 10];
export const ASSISTANT_DAYS_RANGE: readonly [number, number] = [1, 90];
export const ASSISTANT_QUERY_MAX = 100;
export const ASSISTANT_PAUSED =
  "Assistant en pause jusqu'à demain (budget d'IA du jour atteint). Les alertes et les commandes /profil continuent.";
