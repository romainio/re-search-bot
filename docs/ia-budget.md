# Socle IA : budget de neurons et appel Workers AI

Toute fonction qui appelle Workers AI (analyse photo, profil en langage naturel, prospection, lecteur universel, assistant...)
passe par `src/ai/`. Règles : plan gratuit uniquement (10 000 neurons par jour, remise à zéro à 00:00 UTC), jamais bloquant, une
fonction éteinte ou un binding absent ne change rien au comportement du Worker.

## Pièces

| Fichier                        | Rôle                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ai/budget.ts`             | estimation des neurons, cumul du jour UTC en D1 (`ai_usage`, migration 0010), plafonds                                                                                    |
| `src/ai/run.ts`                | `runJson` : un appel unique avec délai, budget, comptabilité et validation JSON                                                                                           |
| `src/ai/embed.ts`              | `runEmbed` : embeddings d'un lot de textes (bge-m3, fonction `embed`), même budget (recherche sémantique, `docs/recherche-semantique.md`)                                 |
| `src/config/ai.ts`             | `AI_MODEL_RATES` (tarif par modèle), `AI_FALLBACK_RATE`, `UNIVERSAL_DAILY_CAP`                                                                                            |
| `ai` de `instance.config.json` | plafond global (`dailyNeurons`, 8 000) et par fonction (`featureCaps`), lus par `settings().ai` (`src/derive.ts`) ; valeurs par défaut : `DEFAULT_AI` (`src/instance.ts`) |

## Utiliser le socle dans une nouvelle fonction

1. **Nommer la fonction** et lui donner un plafond par défaut dans `DEFAULT_AI.featureCaps` (`src/instance.ts`). Sans ligne, seul le plafond global
   (8 000) s'applique. La somme des plafonds peut dépasser 8 000 : le global tranche.
2. **Tarif du modèle** : si le modèle n'est pas dans `AI_MODEL_RATES`, ajouter ses neurons par million de jetons (page de tarifs
   Workers AI : dollars par million de jetons divisés par 0,000011 $ le neuron). Sans ligne : `AI_FALLBACK_RATE` (pessimiste).
   Vérifier dans la doc Workers AI que le modèle est disponible sur le plan gratuit.
3. **Estimer** le coût d'un appel (constante nommée dans `src/config/`, pessimiste) : c'est ce qui est testé avant l'appel, et
   inscrit si le modèle ne renvoie pas `usage`.
4. **Appeler `runJson`** :

```ts
import { runJson } from "../ai/run";

const result = await runJson(env, {
  feature: "profil", // clé de settings().ai.featureCaps
  model: PROFIL_MODEL,
  input: { messages, max_tokens: 300 }, // corps de env.AI.run
  estimate: PROFIL_ESTIMATE_NEURONS,
  timeoutMs: PROFIL_TIMEOUT_MS,
  validate: (json) => (typeof (json as any)?.zone === "string" ? { zone: (json as any).zone } : null),
});
if (!result) {
  /* repli : continuer sans l'indice */
}
```

`validate` reçoit l'objet JSON extrait de la réponse (texte libre, balises ```json tolérées, format `choices[0].message.content`
ou `response`) et renvoie la valeur typée, ou `null` pour refuser (validation stricte : refuser plutôt que corriger). `runJson`
rend `null` sur tout échec : binding `AI` absent, budget épuisé, erreur ou délai du modèle, réponse sans JSON, validation refusée.
Il ne lève jamais.

Pour un usage plus fin : `canSpend(env.DB, feature, estimate)` avant et `record(env.DB, feature, model, usage, estimate)` après
(`budget.ts`), `answerText` et `extractJson` (`run.ts`).

## Fonctions branchées

| Fonction (`settings().ai.featureCaps`) | Plafond du jour                        | Modèle          | Doc                                                                                                                                                                 |
| -------------------------------------- | -------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `photo`                                | 4 000                                  | Gemma 4 26B A4B | `docs/photo-scoring.md`                                                                                                                                             |
| `prospect`                             | 500                                    | Gemma 4 26B A4B | `docs/prospection.md`                                                                                                                                               |
| `universal`                            | 4 000 (plancher `UNIVERSAL_DAILY_CAP`) | Gemma 4 26B A4B | `docs/lecteur-universel.md` (~40 neurons par lecture du modèle, 0 pour une page inchangée : empreinte du texte réduit ; 15 sources ~2 600 à 3 800 neurons par jour) |
| `mail`                                 | 1 000                                  | Gemma 4 26B A4B | `docs/mail.md` (lecteur universel sur un mail au format inconnu)                                                                                                    |

`env.AI.toMarkdown` (conversion Markdown, HTML) n'est pas compté : gratuit pour le HTML.

**Éviter l'appel plutôt que le plafonner.** Une fonction qui relit souvent la même entrée (page d'agence) mémorise l'empreinte de ce qu'elle a
envoyé au modèle et le résultat (lecteur universel : table `universal_state`, migration 0016) : entrée identique, pas d'appel, donc pas de
neurons. Un budget épuisé ne bloque alors que les lectures dont l'entrée a changé. `runJson` accepte `onSpent(neurons)` pour connaître la
dépense réelle d'un appel (rapport du sous-lot, `/test`).

## Comptabilité

- Une lecture D1 par appel (`canSpend` : toutes les lignes du jour, quelques-unes) et UNE écriture (`record` : insertion ou
  cumul de la ligne `(jour, fonction)`).
- Neurons d'un appel = `prompt_tokens` x tarif d'entrée + `completion_tokens` x tarif de sortie (`usage` renvoyé par le modèle).
  `usage` absent : l'estimation de l'appelant (jamais 0). Seul `total_tokens` : tout au tarif de sortie.
- Réponse reçue (même au JSON refusé) : inscrite, le modèle l'a facturée. Délai dépassé : inscrit à l'estimation (l'appel a pu
  tourner). Erreur levée par le modèle : rien d'inscrit.
- Jour UTC (`utcDay`) : les neurons gratuits se remettent à zéro à 00:00 UTC, pas à minuit de Paris.
- Erreur D1 (table absente, indisponibilité) : `canSpend` refuse, donc pas d'appel sans compteur fiable.
- Consommation du jour : `SELECT feature, neurons, calls FROM ai_usage WHERE day = date('now')`. La valeur de référence reste le
  tableau de bord Workers AI de Cloudflare.

## Tests

`env.AI` se simule (`{ run: vi.fn(async () => ({ choices: [{ message: { content: "{...}" } }], usage: {...} })) }`) ; voir
`test/ai.test.ts` (budget, `runJson`) et `test/photo.test.ts` (une fonction complète). Penser à vider `ai_usage` entre les tests.

- Sortie brute (appels d'outils) : `runAi(env, { ..., parse })` rend ce que `parse` tire de la sortie complète du modèle ; `runJson` en est un cas particulier (assistant, `docs/assistant.md`).
