# Assistant conversationnel Telegram (chantier 9)

Questions libres en français dans le chat Telegram du bot. Code : `src/assistant/` (`tools.ts`, `chat.ts`) et le crochet
`handleFreeMessage` de `src/telegram/assistant.ts`. Migration `0014_assistant.sql` (table `assistant_history`).

## Activer

- `ASSISTANT_ENABLED` = `"true"` dans `wrangler.jsonc` (`"false"` par défaut), en plus de `TELEGRAM_INTERACTIVE` (webhook, voir
  `docs/telegram-interactif.md`) et du binding `AI`. Pas de nouveau secret, pas de nouvelle ressource Cloudflare.
- Éteint (ou sans binding AI) : le message libre reçoit l'aide, exactement comme avant. Une commande inconnue (« /xyz ») reçoit aussi l'aide.

## Exemples de questions

- « les annonces de la semaine avec baignoire sous 1 450 € » -> `chercher_annonces` (`depuis_jours` 7, `photo_oui` baignoire, `loyer_max` 1450)
- « combien de temps restent les 2 pièces à Levallois ? » -> `marche` (zone 92300, 2 pièces) : durée de vie médiane sur 30 jours
- « montre-moi celles que j'ai marquées visite » -> `chercher_annonces` (`suivi` visite)
- « qu'est-ce qui est près de Brochant ? » -> `recherche_semantique` (si `SEMANTIC_SEARCH` est actif, sinon le modèle se rabat sur `chercher_annonces`)
- « et à Levallois ? » (suivi) : les 3 derniers échanges et leurs filtres sont rejoués au modèle
- « que dit mon profil ? », « détail de l'annonce n°123 » -> `profil`, `annonce`

La réponse tient en une courte phrase du modèle, suivie de 5 annonces au plus : lien, loyer, surface, pièces, zone, numéro court (`n°123`).

## Modèle et approche : appels d'outils natifs, repli en un appel

**Modèle** : `@cf/google/gemma-4-26b-a4b-it` (`ASSISTANT_MODEL`). La page du modèle dans la doc Cloudflare le marque « Function
calling » (comme `@cf/zai-org/glm-4.7-flash`) et le changelog du 28/07/2026 le liste parmi les modèles qui **restent sur le plan gratuit**
(seuls `kimi-k2.6`, `kimi-k2.7-code` et `glm-5.2` exigent le plan payant). C'est le modèle du profil et de la grille photo : son tarif est
déjà dans `AI_MODEL_RATES` (9 091 / 27 273 neurons par million de jetons). GLM-4.7-Flash coûterait 36 364 neurons/M en sortie (+33 %) sans
gain démontré ; Gemma 4 est multilingue (35+ langues).

**Approche** : appel d'outils natif (paramètre `tools` de `env.AI.run`), parce que le modèle choisit seul entre cinq outils et enchaîne
(« les 2 pièces de Levallois » -> `marche`, « celles avec baignoire » -> `chercher_annonces`) ; un repli à filtres uniques ne sait pas
répondre « combien de temps restent… ». Pour ne pas dépendre du format des messages `tool` (qui varie selon le modèle), les appels et
résultats sont rejoués au modèle comme texte (« [appel d'outil] … », « [résultat de l'outil … : DONNÉES] … »). La sortie est lue sous
les deux formes (`tool_calls[{name, arguments}]` de Workers AI et `choices[0].message.tool_calls[{function}]` d'OpenAI).

**Repli** : si le modèle n'aboutit à aucun appel valide (erreur, JSON invalide, outil inconnu, arguments refusés à chaque tour), UN appel
`runJson` produit l'objet de filtres de `chercher_annonces` (même schéma, même validation), la requête D1 s'exécute et la réponse est
formatée **sans second appel modèle** (`Filtres : Paris 17 · ≤ 1 450 €` puis la liste). Un texte du modèle sans aucun résultat d'outil
n'est jamais rendu après le premier tour (il pourrait inventer des annonces).

À noter : les formats de sortie ci-dessus viennent de la documentation Cloudflare, pas d'un essai réel (aucun appel réseau dans ce
chantier) ; les tests rejouent des sorties conformes à la doc. Au premier déploiement, essayer une question et lire `wrangler tail` :
si le modèle ne répond pas par des appels d'outils, le repli prend le relais sans rien casser.

## Outils (lecture seule, schémas fermés)

Le modèle n'écrit jamais de SQL. Chaque outil valide ses arguments (`validateArgs`) : type, bornes (constantes `ASSISTANT_*_RANGE`),
liste de valeurs, longueur ; toute valeur hors schéma est **refusée** (jamais corrigée) et l'erreur revient au modèle, qui peut se
reprendre dans la limite des tours. Les valeurs validées ne sont jamais concaténées au SQL (paramètres liés ; seuls des fragments constants).

| Outil                  | Arguments                                                                                                                                                                                                                        | Source                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `chercher_annonces`    | `zone`, `loyer_max`, `surface_min`, `pieces_min`, `pieces_max`, `depuis_jours`, `statut` (en_ligne, disparue, toutes), `photo_oui` (critères de la grille, 4 au plus), `suivi` (aime, deteste, appelee, visite), `tri`, `limite` | D1, `LIMIT` constant (10 au plus), filtres de `viewFilters` du tableau de bord, `json_extract` du `photo.grid` avec chemin lié |
| `recherche_semantique` | `requete`, `zone`, `loyer_max`, `surface_min`, `statut`, `limite`                                                                                                                                                                | `semanticSearch(env, q, { rateLimit: false })` (le plafond de neurons « embed » s'applique toujours)                           |
| `marche`               | `zone`, `pieces`                                                                                                                                                                                                                 | agrégats de `src/market.ts` (3 petites tables), effectifs fiables seulement                                                    |
| `profil`               | aucun                                                                                                                                                                                                                            | `loadProfile`                                                                                                                  |
| `annonce`              | `id` (identifiant court = rowid, champ `id` des résultats)                                                                                                                                                                       | D1 + retours de l'utilisateur                                                                                                  |

Résultats petits : titre coupé à 70 caractères, pas d'URL ni de payload, 5 annonces par défaut (10 au plus). Au plus 3 appels d'outils par
tour du modèle et 6 par question.

## Tours et boucle

Au plus **3 tours d'outils** (`ASSISTANT_MAX_TOOL_TURNS`) ; si le modèle en demande encore, un dernier appel **sans outil** force la
réponse (4 appels modèle au plus). Outil inconnu, arguments hors schéma (injection comprise) ou 7e appel : rien n'est exécuté, l'erreur
revient au modèle.

## Sécurité

- Seul le chat autorisé arrive jusqu'ici (secret du webhook et chat vérifiés par `webhook.ts`).
- Aucune écriture D1 hors `assistant_history` et `ai_usage` (test : toutes les autres tables sont identiques avant et après).
- Aucune URL inventée : les liens viennent de la colonne `url` de la base (http et https seulement, guillemets neutralisés) ; le texte du
  modèle est échappé en HTML (`esc`), ses balises s'affichent telles quelles. Le modèle ne reçoit même pas les URL.
- Texte d'annonces et résultats d'outils présentés comme **données** (injection indirecte : au pire une réponse fausse, aucun outil ne
  modifie quoi que ce soit).
- Message ≤ 4 096 caractères : texte du modèle coupé à 700 caractères, 5 annonces au plus, retrait d'annonces entières si besoin.

## Budget, débit, historique

- Fonction `assistant` : **1 500 neurons par jour** (`settings().ai.featureCaps`), dans le plafond global de 8 000 (`docs/ia-budget.md`). Chaque
  appel passe par le socle (`runAi`, nouvelle fonction de `src/ai/run.ts` qui rend la sortie brute ; `runJson` en est maintenant un cas
  particulier, comportement inchangé).
- Estimation pessimiste : 45 neurons par appel (`ASSISTANT_ESTIMATE_CALL`), 180 par question (4 appels) testés **avant** de commencer.
  Budget épuisé : « Assistant en pause jusqu'à demain », aucun appel, aucune écriture.
- **Coût réel** : consigne ~300 jetons + schémas d'outils ~1 100 + historique (0 à 300) + question ; un résultat de 5 annonces ~400 jetons.
  Un appel d'outil ≈ 1 850 jetons en entrée et 60 en sortie ≈ 18 neurons ; l'appel de réponse ≈ 2 300 en entrée, 100 en sortie ≈ 24. Une
  question typique (un outil) ≈ **42 neurons**, avec deux outils ≈ 70 : environ 30 questions par jour avant le plafond de 1 500. Les
  neurons inscrits sont ceux de `usage` renvoyé par le modèle (estimation seulement s'il manque).
- **Limite de débit** : 20 questions par heure glissante (`ASSISTANT_MAX_PER_HOUR`), comptées dans `assistant_history`.
- **Historique** : table `assistant_history` (question, réponse courte, filtres utilisés). Les 3 derniers échanges (`ASSISTANT_HISTORY_TURNS`)
  de moins de 24 h sont rejoués au modèle ; tout ce qui a plus de 24 h est purgé à chaque nouvelle question. Écritures D1 par question :
  deux (purge + insertion en un lot, puis la réponse) plus l'inscription des neurons à chaque appel.

## CPU

Le webhook répond 200 tout de suite et traite l'update en `waitUntil`. Chaque étape reste légère : validation de schéma, une à trois
requêtes D1 bornées, `JSON.parse` de 10 payloads au plus, formatage de 5 lignes. Les attentes (modèle, D1) ne comptent pas dans les 10 ms.

## Limites connues

- Formats de sortie des appels d'outils non éprouvés sur le service réel (voir plus haut) ; le repli couvre l'échec.
- `recherche_semantique` hérite des limites de `docs/recherche-semantique.md` (cluster dont seule la tête a disparu masqué).
- Les critères photo ne couvrent que les annonces dont l'alerte a été envoyée avec `PHOTO_SCORING` actif.
- Pas de mémoire au-delà de 3 échanges ni de 24 h ; pas d'écriture (marquer une annonce passe toujours par les boutons).
