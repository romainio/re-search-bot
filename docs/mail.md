# Alertes par mail (Email Routing)

Le Worker exporte un handler `email(message, env, ctx)`. Les mails d'alerte des portails (SeLoger, Leboncoin, Bien'ici, PAP, Logic-Immo)
et des agences autorisées sont lus, et leurs annonces entrent dans le circuit normal (`processListings`, filtre, doublons, alertes
Telegram) comme une source virtuelle `mail_<expéditeur>`. Éteint par défaut (`MAIL_INGEST="false"`).

**État au 09/11/2026 : non activable sans domaine.** Le compte Cloudflare n'a aucun domaine, et Email Routing exige un domaine sur le DNS
Cloudflare. Le code est prêt, testé et inerte : le champ `addresses` n'est **pas** dans `wrangler.jsonc` (le déploiement échouerait). Procédure
d'activation complète plus bas.

## Traitement d'un mail (`src/mail/handler.ts`)

1. `MAIL_INGEST` éteint : **ignoré sans rejet**. Rejeter ferait croire au portail que l'adresse est morte : il la désabonnerait.
2. En-tête `From` : adresse hors de la liste blanche (`src/mail/senders.ts`) : **`setReject`** (refus SMTP définitif). Pourquoi rejeter ici : le
   refus est fait pendant la session SMTP (aucun mail de rebond n'est émis par nous, pas de « backscatter »), et cette adresse dédiée n'a aucune
   raison de recevoir autre chose ; l'expéditeur légitime voit l'erreur.
3. **DMARC** : le premier en-tête `Authentication-Results` (celui de `mx.cloudflare.net`, posé par Email Routing avant le Worker) doit porter
   `dmarc=pass`, sinon rejet (`MAIL_REQUIRE_DMARC`). Sans cela, n'importe qui pourrait écrire « From: alertes@seloger.com ». Un en-tête
   `Authentication-Results` ajouté par l'expéditeur est ignoré (seule la première valeur compte).
4. Mail de plus de 400 Ko (`MAIL_MAX_BYTES`), MIME illisible, ou sans annonce (confirmation d'abonnement, newsletter) : **accepté et ignoré**
   (jamais rejeté, pour la raison du point 1).
5. Lecture du MIME avec [`postal-mime`](https://www.npmjs.com/package/postal-mime) (voir « Dépendance »), puis les annonces :
   - **lecteur déterministe** quand le service a un motif de lien d'annonce (`MailSender.linkPattern`) : un lien d'annonce et le texte de sa
     carte (prix en €, CC/HC, surface, pièces, code postal), identifiant = URL sans paramètres (les paramètres de suivi changent à chaque
     mail). Deux dispositions sont comprises : texte après le lien, ou texte avant un bouton final. Une carte sans prix plausible est ignorée ;
   - sinon (motif absent, liens de suivi, format changé) **lecteur universel** (`docs/lecteur-universel.md`) sur le HTML du mail : conversion
     Markdown (repli : texte de l'HTML) -> réduction -> modèle -> validation stricte, fonction `mail` du budget IA (1 000 neurons par jour, ~40 par
     mail). Texte seul : le texte. IA absente ou budget épuisé : mail accepté sans annonce.
6. `processListings(env.DB, mail_<clé>, annonces, maintenant)` : même circuit que les autres sources. L'envoi Telegram part au prochain passage
   du cron en fenêtre active (9h-20h de Paris), comme pour toute annonce.

**Premier mail d'un expéditeur : silencieux, comme un premier passage.** Choix : le mail qui suit l'abonnement porte en général le stock en
cours (annonces déjà en ligne depuis des jours), exactement le cas que le premier passage silencieux des sources existe pour absorber ; les
mails suivants sont des nouveautés et alertent. Inconvénient accepté : si la toute première annonce reçue est une vraie nouveauté, elle n'alerte
pas. Pour l'éviter, s'abonner puis envoyer d'abord une alerte à vide, ou vérifier à la main le premier mail. (Le comportement est celui de
`processListings` : pas de code spécifique.)

## Source virtuelle : jamais « en panne » ni « en retard »

Chaque expéditeur de `MAIL_SENDERS` donne une source `mail_<clé>` au registre (`settings().sources.mail`, construit par `src/sources.ts`), `active: true` et `virtual: true`.
Elle n'est **jamais lue par le cron** : hors des groupes, des sous-lots `/part` (`parsePartRequest` la refuse), de `detectStale`. Le handler
n'écrit ni `last_run` ni état de santé (`markRun`, `recordOutcome` ne sont jamais appelés) : sans passage attendu, aucune panne ni aucun
retard n'est possible, même après des jours sans mail. Au tableau de bord : « Par mail ». Seul `source_state.initialized` et `zones` sont écrits
(premier mail silencieux). Les annonces d'une source mail ne sont jamais marquées « disparues » (la détection de disparition exige un `last_run`).

## Liste blanche et agences

`src/mail/senders.ts` : `MAIL_SENDERS` = clé, nom, domaines (le domaine exact ou un sous-domaine : `mail.seloger.com` est de `seloger.com` ;
`seloger.com.evil.fr` et `notseloger.com` sont refusés), page d'accueil, motif de lien d'annonce facultatif, téléphone facultatif. **Pour ajouter une
agence** : une ligne dans ce tableau (sans motif de lien : lecteur universel), la source `mail_<clé>` apparaît d'elle-même. Vérifier le domaine
d'expédition sur le premier mail reçu (journal : `mail <clé> : ...`, ou un rejet « Expéditeur non autorisé »).

Les motifs de lien des portails (`linkPattern`) et leurs domaines d'expédition sont écrits d'après la structure publique de leurs URL d'annonce, **sans
avoir vu de vrai mail** : à confirmer sur le premier mail reçu de chaque portail. Si le motif ne retrouve rien, le lecteur universel prend le
relais (plus cher en neurons, mais fonctionnel).

## Fixtures de test : synthétiques

`test/fixtures/mail/*.html` sont **synthétiques**, construits le 09/11/2026 à partir de la structure publique des mails d'alerte (une carte par annonce :
image, titre, caractéristiques, prix, bouton) ; chacun le dit en commentaire. Ce ne sont pas de vrais mails (aucun n'a pu être obtenu). Le
lecteur déterministe est volontairement tolérant (ni table ni classe CSS supposées). `test/mail.test.ts` fabrique les mails MIME autour (multipart,
quoted-printable, en-têtes d'authentification).

## Dépendance : `postal-mime`

Analyse MIME (multipart, quoted-printable, base64, jeux de caractères) : l'écrire à la main serait fragile. `postal-mime` 4.2.0 : **aucune
dépendance**, JavaScript pur (TextDecoder, pas d'API Node), module ESM ; c'est la bibliothèque que la documentation Cloudflare Email Workers utilise
en exemple. 1,2 Mo non minifié dans `node_modules` (tout le paquet, cjs et esm) ; seul le chemin d'import est embarqué par le bundler (voir
la taille mesurée dans le rapport de fin de chantier). CPU : l'analyse d'un mail est dans l'invocation `email()`, qui a ses 10 ms de CPU
(plan gratuit) ; `MAIL_MAX_BYTES` (400 Ko) la borne. À mesurer sur un vrai mail après l'activation (`wrangler tail`, `cpuTime`) ; un mail d'alerte
type fait 30 à 100 Ko.

## Activation pour un utilisateur qui a un domaine

1. **Domaine** : acheter ou ajouter un domaine au compte Cloudflare (Domain Registration, ou un domaine existant dont les serveurs de noms
   passent chez Cloudflare). Email Routing exige que le DNS soit chez Cloudflare. Un sous-domaine suffit (`alertes.exemple.fr`).
2. **Email Routing** : l'activer sur le domaine (tableau de bord : Compute > Email Service > Email Routing > Activer ; Cloudflare ajoute les
   enregistrements MX et SPF). Par l'API : `POST /zones/{zone_id}/email/routing/dns` (« enable »), ou avec le MCP Cloudflare. Vérifier le statut `ready`.
3. **Adresse et règle** : dans `wrangler.jsonc`, champ de premier niveau (Wrangler 4.113.0 ou plus) :

   ```jsonc
   "addresses": ["alertes@exemple.fr"],
   ```

   `wrangler deploy` crée la règle « Send to a Worker » vers ce Worker (et la maintient). Sans Wrangler : tableau de bord, Routing Rules > Create
   routing rule > Action « Send to a Worker » > `re-search`. Une règle par adresse.
4. **Interrupteur** : `"MAIL_INGEST": "true"` dans `vars`, puis `npx wrangler deploy`.
5. **Abonnements** : créer les alertes des portails (SeLoger, Leboncoin, Bien'ici, PAP, Logic-Immo : critères de `instance.config.json`, location, Paris 17
   et Levallois-Perret, 1 000 à 1 600 €) avec **cette adresse** comme adresse d'alerte (ou un compte dédié aux alertes). Plusieurs portails exigent
   de cliquer sur un lien de confirmation reçu par mail : il arrive au Worker, qui l'ignore (pas d'annonce). Pour le lire, remplacer
   provisoirement la règle de l'adresse par « Send to an email » vers une boîte personnelle (destinataire vérifié), confirmer, puis remettre
   la règle « Send to a Worker » (`wrangler deploy` la rétablit).
6. **Test** : envoyer un mail depuis un autre domaine : il doit être rejeté (journal Email Routing : « rejected »). Attendre le premier mail d'un
   portail : journal `mail seloger: N annonces, ...` (`npx wrangler tail`) ; il est silencieux. Au second, l'alerte arrive sur Telegram. Local :
   `npx wrangler dev` expose `POST /cdn-cgi/local/email` (`?from=...&to=...`, corps = mail brut) ; pour passer le contrôle DMARC en local, ajouter
   l'en-tête `Authentication-Results: mx.cloudflare.net; dmarc=pass`.

Limites du plan gratuit : 25 Mio par mail et 200 règles par domaine côté Email Routing ; un Worker d'email compte dans les limites normales de CPU
(10 ms) et de requêtes (50 sous-requêtes : un mail en utilise au plus 3, conversion et modèle).

## Tests

`test/mail.test.ts` : liste blanche (domaines exacts, sous-domaines, imitations), interrupteur éteint (aucun rejet), rejets (expéditeur, DMARC absent,
raté ou falsifié), mail trop gros ou illisible, mail sans annonce, MIME texte et HTML (quoted-printable), lecteur déterministe (deux dispositions),
repli universel (liens de suivi, texte seul, conversion absente), entrée dans `process` (premier mail silencieux, alerte au second, pas de doublon,
envoi Telegram), source jamais « en retard » ni « en panne » (health, tableau de bord, groupes, `/part`).
