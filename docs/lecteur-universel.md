# Lecteur universel

Pour une agence dont le gabarit n'a pas de lecteur dédié (`src/parsers/`), une source `parser: "universal"` lit la page avec un
modèle : page -> Markdown -> réduction -> modèle -> annonces validées. Éteint par défaut (`UNIVERSAL_READER="false"`), économe (le modèle
n'est appelé que si la page a changé), plafonné en sources (15) et en neurons. Il ne remplace pas un lecteur dédié (gratuit en neurons, déterministe) : c'est la solution pour les
sites sans gabarit connu, ou à l'essai avant d'écrire un lecteur.

## Chaîne de lecture (`src/universal/`)

1. **Contrôles** (`read.ts`, `readUniversal`) : interrupteur `UNIVERSAL_READER`, cadence `every >= 15`, binding `AI`, budget de neurons
   du jour (`canSpend`). Sans lecture mémorisée de la source, le budget est testé avant toute requête (une lecture sans neurons ne
   télécharge pas la page) ; avec elle, la page est téléchargée (gratuit) car elle peut être inchangée, et le budget n'est testé que si
   le modèle doit être appelé.
2. **Page** : `fetchSource` (mêmes en-têtes, délai 10 s, détection d'anti-bot) borné à `UNIVERSAL_HTML_MAX_BYTES` (1 Mo).
3. **Markdown** : `env.AI.toMarkdown({ name: "page.html", blob }, { conversionOptions: { html: { hostname } } })` (`htmlToMarkdown`). Le
   nom d'hôte fait résoudre les liens relatifs par la conversion. Échec ou binding sans `toMarkdown` : la source échoue
   (« conversion Markdown indisponible »).
4. **Réduction** (`reduce.ts`, déterministe) : on garde les lignes autour d'un prix en € (3 avant, 4 après) quand une surface (m²) ou
   des pièces sont dans la fenêtre, fenêtres fusionnées et dédoublonnées, lignes coupées à 400 caractères, plafond
   `UNIVERSAL_MAX_CHARS` (6 000, fenêtres entières). Page David Immo : 10 900 -> 2 400 caractères.
5. **Empreinte** (`fingerprint.ts`) : SHA-256 (`crypto.subtle`, 32 caractères hexadécimaux) du texte réduit normalisé, comparée à celle de la
   dernière lecture réussie (table `universal_state`, migration 0016). Identique : **le modèle n'est pas appelé**, les annonces de cette
   lecture (JSON compact en D1) sont rendues au traitement. Voir « Détection de changement ».
6. **Modèle** (`extractListings`, via `runJson`, fonction `universal`) : Gemma 4 26B A4B (plan gratuit), température 0, 1 200 jetons de
   sortie au plus, consigne d'extraction littérale.
7. **Validation stricte** (`schema.ts`, `validateExtraction`) : refuser plutôt que corriger (voir plus bas).

Zéro annonce valide : **échec de la source** (compte comme un passage en échec, 3 échecs = en panne, comme les autres sources), sauf **état
vide explicite** : le modèle répond `"empty": true` ET la page contient une formule d'état vide (« Aucun bien ne correspond », `EMPTY_STATE`).
Page sans aucun bloc d'annonce ni formule d'état vide : « aucune annonce dans la page » (gabarit changé).

## Validation du JSON du modèle

Réponse : `{ "listings": [ ... ], "empty": false }`. Un champ inconnu dans la réponse la refuse en entier. Une annonce est refusée (et
comptée) si :

- elle contient un champ hors de `url, title, price, price_kind, charges, surface, rooms, floor, address, postal_code, district, photo,
  property_type` (champ inventé) ;
- son prix est hors de 200 à 20 000 € (`UNIVERSAL_PRICE_RANGE`), ou sa surface hors de 5 à 500 m², ou ses pièces non entières ou
  au-delà de 12, ou ses charges supérieures au loyer ;
- le **prix ou la surface annoncés ne sont pas écrits dans le texte réduit** envoyé au modèle (« 1 350 », « 1.350 » et « 1350 »
  se valent ; les décimales avec point ou virgule) : un chiffre absent du texte est inventé.

Sont mis à `null` sans refuser l'annonce : les charges non écrites dans le texte ; le lien qui n'est pas écrit dans le texte ; une photo
qui n'est pas une URL https du texte ; `priceIsCC` quand le texte ne dit pas « CC / charges comprises » (ou « HC / hors charges »)
alors que le modèle l'affirme.

**Identifiant stable** : l'URL de l'annonce normalisée (relative résolue sur la page, hôte en minuscules, sans ancre, sans paramètres de
suivi `utm_`, `fbclid`, `xtor`..., paramètres triés, sans « / » final), sinon un hachage FNV-1a du titre, du prix et de la surface
(`h:xxxxxxxx`) ; sans lien ni titre, annonce refusée.

## Coût en neurons

Tarif Workers AI du 20/10/2026, Gemma 4 26B A4B : 9 091 neurons par million de jetons en entrée, 27 273 en sortie (`AI_MODEL_RATES`).

- **Conversion Markdown : 0 neuron pour du HTML.** La page Workers AI « Markdown Conversion » indique que la conversion est gratuite pour la
  plupart des formats ; seules les images appellent des modèles (détection d'objets puis description), donc des neurons. Le HTML n'en
  consomme pas. Disponible avec le binding `AI`, sur le plan gratuit comme sur le plan payant (le binding est déjà déclaré dans
  `wrangler.jsonc`). Aucun neuron n'est donc compté pour `toMarkdown` ; si Cloudflare changeait cela, le suivi du tableau de bord Workers AI
  le montrerait (valeur de référence) et il faudrait inscrire la conversion dans `ai_usage`.
- **Une lecture** : ~2 500 jetons en entrée (6 000 caractères de texte réduit + consigne) = 22 neurons, ~700 jetons en sortie
  (10 annonces) = 19 neurons : **~40 neurons par lecture** ; pire cas 55 (plafond de sortie), estimation prudente de l'appel 65
  (`UNIVERSAL_ESTIMATE_NEURONS`).
- **Avant la détection de changement** : chaque passage appelait le modèle. Fixture `test/fixtures/davidimmo.html` : 2 400 caractères
  réduits + consigne = ~1 250 jetons en entrée (~11 neurons) et 3 annonces en sortie (~270 jetons, ~7 neurons) : **~18 neurons par passage**
  (estimation au tarif ci-dessus : aucun appel réel dans les tests ; la valeur réelle d'une lecture est inscrite dans `ai_usage` et rendue
  par `/test?source=ID&force=1` dans `neurons`). Une page de 10 annonces : ~40. À 30 min, 22 passages par jour et par source : 15 sources
  = 15 x 22 x 40 = **13 200 neurons par jour**, déjà au-delà des 10 000 gratuits ; à 15 min, 26 400.
- **Après** : un passage sur page inchangée coûte **0 neuron** (une page, une conversion Markdown gratuite, une empreinte : moins de 3 ms de CPU,
  2 sous-requêtes au lieu de 3). Seuls les changements réels de la page, et le filet de 3 jours, appellent le modèle.
- **Par jour, 15 sources à 15 min** (44 passages par source, 9h-20h) : lectures du modèle par source et par jour = changements de page + filet
  (1/3). Une page d'agence change de 2 à 4 fois par jour ouvré (annonce nouvelle, prix modifié, annonce retirée) : ~4,3 lectures, soit
  15 x 4,3 x 40 = **~2 600 neurons par jour**. Pessimiste, 6 changements par jour et 40 neurons : 15 x 6,3 x 40 = **~3 800**. Très pessimiste
  (page qui change à chaque passage, par exemple un carrousel d'annonces mises en avant dans un ordre aléatoire, que l'empreinte ne trie qu'en partie) :
  la dépense est plafonnée par `settings().ai.featureCaps.universal`.
- **Plafond `universal` : 4 000** (plancher `UNIVERSAL_DAILY_CAP` dans `src/config/ai.ts`) : au-dessus du pessimiste (3 800), et sous le plafond global
  (8 000, partagé avec l'analyse des photos : 4 000, le mail : 1 000, le reste : < 2 000). Un plafond d'instance plus haut dans `instance.config.json` (`ai.featureCaps`) reste
  respecté. Plafond atteint : les lectures qui exigent le modèle sont « skipped » (voir plus bas), celles de pages inchangées continuent.
- Une source seule : ~170 neurons par jour (2 à 4 changements), contre 900 avant à 30 min.

## Garde-fous

| Garde-fou          | Mécanisme                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cadence            | `every >= UNIVERSAL_MIN_EVERY` (15) : une source plus rapide échoue (« cadence universelle inférieure à 15 min »)                                                                           |
| Plafond de sources | `UNIVERSAL_MAX_ACTIVE` (15) : seules les 15 premières sources universelles actives du registre sont lues (`readableIds`)                                                                    |
| Page inchangée     | empreinte identique : 0 neuron, jamais si texte réduit < `UNIVERSAL_UNCHANGED_MIN_CHARS` (100), lecture précédente sans annonce, ou lecture de plus de `UNIVERSAL_RECHECK_DAYS` (3) jours   |
| Budget épuisé      | **lecture non tentée (« skipped »)**, pas un échec : voir ci-dessous                                                                                                                        |
| Interrupteur       | `UNIVERSAL_READER` à `"false"` : sources universelles ignorées, aucune requête                                                                                                              |
| CPU                | la réduction est mesurée sur la page lourde Laforêt (1,2 Mo de HTML) sous les 8 ms d'un `/part` (`test/universal.cpu.test.ts`) ; la conversion se fait chez Cloudflare (hors CPU du Worker) |
| Sous-requêtes      | une lecture = 1 page + 1 conversion + 1 appel modèle : 3 des 50 d'un `/part` (rendu navigateur : 1 + 1)                                                                                     |

**Budget épuisé : pourquoi ce n'est pas un échec.** Le budget se remet à zéro à 00:00 UTC (1h ou 2h de Paris) : de l'épuisement jusqu'au soir, toutes
les lectures de la journée seraient refusées. Compté comme échec, le troisième passage (au bout d'une heure) mettrait la source « en
panne » (`FAILURES_BEFORE_BROKEN`, health.ts) et lancerait une fausse alerte, alors que la page n'a rien. Le sous-lot enregistre donc le passage
(`last_run` : la source n'est pas « en retard » non plus) sans enregistrer de succès ni d'échec, et le rapport du passage porte
`skipped: "budget IA épuisé"`. Le même traitement vaut pour l'interrupteur éteint et le binding `AI` absent. En revanche une réponse du modèle
refusée, une page en erreur ou zéro annonce valide sont de vrais échecs (panne au troisième passage, comme toute source).

Les annonces lues passent ensuite dans le circuit habituel (`evaluate`, premier passage silencieux, doublons, alertes) : aucune règle ne
change. Pas de fiche détaillée (aucun lecteur de fiche pour la famille).

## Détection de changement (page inchangée = 0 neuron)

**Empreinte.** Calculée sur le texte réduit (celui qui irait au modèle, donc après `reduceMarkdown`), normalisé par `normalizeForFingerprint`.
La normalisation ne retire que ce que le modèle n'extrait jamais (il extrait : lien, titre, prix, charges, surface, pièces, étage, adresse,
code postal, quartier, photo, type) et qui varie sans que l'annonce change. Motifs retenus, un par un :

| Motif                                                                                                                                                                                                    | Pourquoi il est sûr                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Minuscules, espaces (dont insécables `U+00A0`, `U+202F`) réduits, lignes vides retirées                                                                                                                  | la conversion Markdown varie en espaces et en casse sans changer le contenu ; « 1 350 » et « 1 350 » valent le même nombre  |
| Blocs d'annonces triés                                                                                                                                                                                   | l'ordre d'un carrousel ou d'un tri par défaut change sans que le stock change ; un bloc modifié change toujours l'empreinte |
| Paramètres d'URL de suivi ou de session (`utm_*`, `fbclid`, `gclid`, `xtor`, `mc_*`, `phpsessid`, `jsessionid`, `sessionid`, `sid`, `token`, `csrf`, `nonce`, `ts`, `timestamp`, `cb`, `cachebust`, `_`) | jamais l'identité d'une annonce (`stableId` retire déjà le suivi) ; les autres paramètres (`id=5`) restent                  |
| Horodatage ISO (`2026-11-09T14:32:05Z`)                                                                                                                                                                  | donnée incrustée, jamais un champ extrait                                                                                   |
| « mis à jour / publié / actualisé / modifié / ajouté / mise en ligne » suivi d'une date, ou de « aujourd'hui », « hier »                                                                                 | seule une date précédée d'un tel verbe est retirée : une date de disponibilité (« libre le 15/12 ») reste                   |
| « il y a N secondes / minutes / heures / jours / semaines / mois / ans »                                                                                                                                 | dérive à chaque lecture                                                                                                     |
| Heures « 14h32 », « 14:32 »                                                                                                                                                                              | horloge ou heure de mise à jour ; une surface ou un prix n'ont jamais ce format                                             |
| Compteurs « N vues / consultations / visiteurs / visualisations »                                                                                                                                        | pluriels seulement : « 1 vue sur le parc » (un titre) reste                                                                 |

Volontairement **non** retirés : le nombre de résultats (« 12 biens »), les prix, les dates sans verbe de mise à jour, tout texte de titre. Un
motif trop large figerait le stock (rattrapé par le filet de 3 jours), un motif trop étroit coûte seulement une lecture de plus.

**Voie retenue pour les annonces : une copie compacte en D1** (`universal_state.listings`, JSON des annonces validées de la dernière lecture
réussie, 15 au plus), plutôt qu'une relecture de `listings`. Raison : `listings` garde aussi les annonces filtrées et disparues, sans
mémoire de ce que la dernière lecture contenait ; la copie est exactement la liste que le traitement aval a reçue. Il reçoit donc la même
liste qu'après une relecture identique : annonces connues (aucune alerte), présence rafraîchie (`last_seen`), aucune disparition (`gone_at`
seulement pour une annonce absente de la liste), `last_run` écrit, santé inchangée. Page changée : appel du modèle comme avant, puis la
copie et l'empreinte sont remplacées (une écriture D1). Une lecture en échec ne touche pas à la copie : la page qui revient à l'identique
est de nouveau « inchangée ».

**Jamais « inchangée »** : texte réduit vide ou de moins de 100 caractères (`UNIVERSAL_UNCHANGED_MIN_CHARS`) ; lecture précédente sans
annonce ; dernière lecture du modèle de plus de 3 jours (`UNIVERSAL_RECHECK_DAYS`, filet : la relecture rafraîchit la date).
Une page cassée (maintenance, gabarit changé) donne un texte réduit vide ou différent : échec ou relecture comme avant, jamais un stock figé.

**Budget épuisé** : comportement inchangé pour une page qui doit être lue par le modèle (« skipped », jamais « en panne »). Une page inchangée
n'exige pas de neurons : elle reste lue et son passage est un succès.

**Observabilité.** Le rapport du sous-lot (`/part`, résultat de `/scan`) porte pour une source universelle `unchanged: true` et
`savedNeurons` (coût de la lecture évitée) quand la page est inchangée, sinon `neurons` (dépense réelle de l'appel). `/test?source=ID&k=CLE`
renvoie `unchanged`, `savedNeurons`, `neurons` ; il n'écrit rien (ni empreinte ni annonces) ; `&force=1` ignore l'empreinte et relit par le modèle.

## Ajouter une source universelle

1. Une requête de référence (`test/fixtures/<agence>.html`, sans contournement d'anti-bot).
2. Une entrée dans `sources` de `instance.config.json` : `parser: "universal"`, `every: 15` (ou plus), `group` d'une voie libre,
   `active: false` au départ. Elle rejoint `settings().sources.universal`, le registre des lecteurs dédiés (`settings().sources.dedicated`) reste inchangé.
3. Un test sur la fixture avec un modèle simulé (`test/universal.test.ts`, `fakeAi`).
4. Vérifier avec `/test?source=ID&k=CLE` (dépense des neurons, sans écriture en base) avec `UNIVERSAL_READER="true"`, puis passer `active: true`.

La source d'exemple, **inactive** : `david_immo` (David Immo, Monceau-Ternes, site maison sans lecteur),
fixture `test/fixtures/davidimmo.html` (une requête le 09/11/2026, 200, 97 Ko, prix « CC »).

## Rendu navigateur (`render: "browser"`)

Pour une page construite en JavaScript. Éteint par défaut (`BROWSER_RENDER="false"`), au plus `UNIVERSAL_BROWSER_MAX` (2) sources, uniquement pour une
source universelle marquée `render: "browser"`. Browser Run, plan gratuit : 10 minutes de navigateur par jour, 1 requête rapide toutes les
10 secondes (doc Cloudflare « Browser Run, Limits »). Une lecture = UN rendu (quick action `markdown` du binding), à la cadence de la source
(`every >= UNIVERSAL_BROWSER_MIN_EVERY` = 30 : le rendu a lieu même si la page est inchangée, la cadence de 15 min des autres sources lui est refusée) : 22 rendus par jour et par source, de 5 à 10 s chacun, donc 2 à 4 minutes par source et par jour.

Le binding **n'est pas déclaré** dans `wrangler.jsonc` (il exige Browser Run côté compte) : sans lui, la source marquée échoue proprement avec
« rendu navigateur indisponible » (aussi quand l'interrupteur est éteint). Pour l'activer, ajouter dans `wrangler.jsonc` :

```jsonc
"browser": { "binding": "BROWSER" },
```

(`compatibility_date` supérieure ou égale à 2026-03-24 : c'est le cas), passer `BROWSER_RENDER` à `"true"`, marquer la source `render: "browser"`.
Le rendu remplace le téléchargement et la conversion `toMarkdown` : le Markdown vient du navigateur. En développement local, la quick action exige
`wrangler dev --remote`.

## Tests

`test/universal.test.ts` (modèle, conversion et navigateur simulés) : réduction (cartes gardées, plafond, CPU sur la fixture Laforêt), validation
stricte (champs inventés, prix incohérents, identifiants), lecture complète de la fixture David Immo, état vide, budget épuisé, cadence,
plafonds, rendu navigateur absent ou présent ; `test/universal-unchanged.test.ts` : empreinte (stable, sensible, insensible aux motifs volatils, CPU),
page inchangée/changée/vide/trop courte, filet de 3 jours, budget épuisé, `/test`, `runPart` (zéro appel, aucune disparition ni alerte) ; intégration `runPart` (premier passage silencieux puis alerte, pas de panne sur budget épuisé,
panne au troisième échec).
