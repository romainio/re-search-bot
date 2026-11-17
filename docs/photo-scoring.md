# Option « yeux » : grille de critères et mini description tirées des photos d'une alerte

Ajoute à l'alerte Telegram, à partir des photos de l'annonce (`Listing.photo` et la galerie `Listing.photos`) :

- une **grille fermée** de critères, une ligne compacte : `🪵 Parquet · 🍳 Cuisine équipée (récente ?) · 🛁 Baignoire ✗ · ☀️ Lumineux` ;
- une **mini description** (1 à 2 phrases factuelles, 220 caractères au plus) qui remplace la description brute tronquée.

Code : `src/notify/photo.ts` (analyse), `src/ai/` (socle budget et appel, voir `docs/ia-budget.md`), appel par `sendPendingAlerts`
(`src/notify/send.ts`), rendu par `formatTelegram` et `gridLine` (`src/notify/format.ts`). Critères et constantes : `src/config/ai.ts`.

## Activation

Désactivée par défaut (`PHOTO_SCORING = "false"` dans `wrangler.jsonc`). Aucun secret : le modèle tourne sur Workers AI, par le
binding `AI`. Passer `PHOTO_SCORING` à `"true"`, puis déployer. Il faut que la migration `0010_ai_usage.sql` soit appliquée
(budget de neurons) : sans la table, aucun appel n'est fait (le budget refuse), l'alerte part comme avant.

Avec `PHOTO_SCORING` différent de `"true"`, ou sans binding `AI`, aucun appel n'est fait et le message est identique à celui d'avant.

## La grille

Les critères sont une **liste de données** (`photoCriteria` de `instance.config.json`, lue par `settings().photoCriteria`) : avec `TELEGRAM_INTERACTIVE`, le profil de recherche (`docs/telegram-interactif.md`) la filtre et l'ordonne
(`profileCriteria`, passée à `analyzePhoto`). Chaque critère a un `id`, une question posée au modèle, un emoji et un libellé. Réponses possibles, et seulement
celles-ci : `oui`, `non`, `incertain` (« les photos ne permettent pas de trancher »), avec le rang de la photo qui le montre.

Critères livrés : sol parquet, carrelage, moquette, stratifié ; cuisine équipée, cuisine récente ; baignoire ; douche ; luminosité ;
balcon/extérieur.

Rendu (`gridLine`) : un `oui` s'affiche, un `incertain` s'affiche avec « ? », un `non` seulement pour les critères `showNo`
(cuisine équipée, baignoire, luminosité : leur absence compte, « 🛁 Baignoire ✗ »). Un critère `parent` (cuisine récente) se
rattache entre parenthèses à son parent.

Validation **stricte** (`parseAnalysis`) : la réponse est refusée en entier si la grille manque, si un critère de la liste manque
ou si une réponse n'est pas exactement `oui | non | incertain` (casse et espaces tolérés). Tolérés car indicatifs : un rang de
photo invalide (devient null), une clé en plus, une mini description absente. Le rang de photo est conservé dans
`PhotoAnalysis.grid[id].photo` (non affiché dans l'alerte, disponible pour le tableau de bord ou l'index sémantique).

### Pourquoi le score 0-100 disparaît

Un nombre unique mélangeait des goûts (lumière, cuisine, sol) et ne se contrôlait pas ; une réponse par critère se vérifie d'un
coup d'œil sur la photo, et reste exploitable par les chantiers suivants (profil, recherche sémantique). Le garder « en
secondaire » aurait doublé le prompt et les jetons de sortie pour un chiffre sans valeur : retiré (« Pourquoi », « Points
faibles », « Non vérifiable » aussi : la grille les remplace).

## La mini description

Même appel que la grille. Tirée de la description de l'annonce (jusqu'à `DESCRIPTION_MAX` = 1 200 caractères, transmise au modèle
comme simple donnée avec l'ordre d'ignorer toute instruction qu'elle contient) et des photos, factuelle, sans rien inventer,
`SUMMARY_MAX` = 220 caractères (raccourcie si le modèle dépasse). Dans l'alerte elle remplace la description brute ; sans elle
(modèle muet sur ce champ), la description brute reste. La grille est la dernière ligne de la légende.

Légende Telegram ≤ 1 024 caractères : rabotage dans l'ordre mini description (ou description), puis titre, puis adresse ; la
grille, courte, n'est jamais rabotée.

`DESCRIPTION_MAX` passe de 300 à 1 200 : la mini description a besoin du texte (cuisine, sol, charges apparaissent souvent après
300 caractères). Coût D1 : la description vit dans le `payload` JSON de la ligne `listings` ; l'écriture est facturée à la ligne, pas
à l'octet, et ne concerne que les annonces nouvelles lues en fiche (3 au plus par source et par passage) : +900 octets au plus
par annonce, aucune écriture ni lecture de plus. L'alerte et les cartes du tableau de bord n'en montrent toujours que 200 caractères.

## Galerie

Les lecteurs de fiche dont la fiche expose la liste des photos remontent jusqu'à 5 URL https dans `Listing.photos`
(`mergeDetail` fusionne celle de la liste puis celle de la fiche, sans doublon). La vignette reste `photo`. Aujourd'hui : Orpi
(`data-estate.images`). Les autres fiches n'exposent facilement qu'une image (`og:image`, déjà la
vignette) : pas de galerie, l'analyse n'utilise alors qu'une photo. L'analyse envoie au plus `PHOTO_MAX_IMAGES` = 4 images.

## Modèle et plusieurs images

`@cf/google/gemma-4-26b-a4b-it` (Gemma 4 26B A4B, vision, Workers AI, disponible sur le plan Workers Free : 10 000 neurons par jour
gratuits, 0,10 $/M jetons en entrée et 0,30 $/M en sortie, pages Workers AI du 20/10/2026). Entrée au format messages OpenAI :
le contenu d'un message est une liste, donc plusieurs `image_url` dans un seul appel. La documentation de la page du modèle ne
chiffre pas de limite d'images ; si le modèle en refusait plusieurs, `PHOTO_MAX_IMAGES = 1` (config) rétablit une image par appel
sans autre changement. L'image composite n'est pas utilisée (impossible côté Worker gratuit : 10 ms de CPU).

## Garde-fous

- Appelée seulement pour une alerte réellement en cours d'envoi (jamais pour le stock silencieux, les doublons ou les annonces
  filtrées), et seulement si l'annonce a au moins une photo https.
- Un seul appel par annonce, délai de 12 s (`PHOTO_TIMEOUT_MS`), réflexion désactivée, `max_tokens` 600, sortie JSON.
- Budget de sous-requêtes : l'appel compte dans les 50 de `sendPendingAlerts` (voir `src/config/scan.ts`). Il n'est fait que s'il reste de la
  place pour lui et pour l'envoi du message (pire cas) ; sinon l'alerte part sans analyse.
- Budget de neurons : `src/ai/budget.ts` (plafond global 8 000 par jour UTC, 6 000 pour la fonction `photo`). Plafond atteint :
  pas d'appel, l'alerte part sans bloc.
- Un échec (réseau, HTTP, délai, JSON invalide, grille refusée) renvoie `null` : l'alerte part sans le bloc, jamais bloquée.
- Si Telegram échoue de façon transitoire, l'alerte est rejouée au passage suivant, avec une nouvelle analyse (un appel de plus).

## Coût

Estimation par alerte : ~1 200 jetons de consigne et de description, 4 images à ~1 100 jetons, soit ~5 600 jetons en entrée
(~51 neurons) et ~400 en sortie (~11 neurons) : environ 55 à 65 neurons par alerte, 70 retenus comme estimation pessimiste
(`PHOTO_ESTIMATE_NEURONS`, aussi inscrite quand le modèle ne renvoie pas `usage`). Plafond photo de 6 000 neurons par jour : plus de
85 alertes analysées par jour. Consommation réelle : table `ai_usage` (`SELECT * FROM ai_usage ORDER BY day DESC`) et tableau de bord
Workers AI de Cloudflare ; ajuster `PHOTO_ESTIMATE_NEURONS` et `PHOTO_MAX_IMAGES` d'après les premiers jours.

## Limites : ce que la photo ne dit pas

La grille n'est qu'une aide pour décider de regarder l'annonce, jamais une preuve. Une photo ne permet pas de vérifier :

- le bruit (rue, voisins, travaux), l'humidité, les odeurs, l'isolation ;
- l'exposition réelle, la lumière selon la saison et l'heure, le vis-à-vis ;
- l'état des canalisations, de l'électricité, du chauffage ;
- les dimensions réelles (objectif grand angle), l'étage, l'état des parties communes ;
- si la photo est récente ou représente bien le logement (photo d'agence, mise en scène, retouche).

Quand les photos ne montrent pas l'élément (vignette d'extérieur, plan, logo), la bonne réponse est `incertain`. Les modèles de vision
de Workers AI sont plus modestes que ceux d'un fournisseur dédié : comparer la grille à son propre jugement sur quelques alertes avant
de s'y fier.
