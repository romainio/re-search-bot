// Alertes par mail (src/mail/, docs/mail.md).

/** Taille maximale d'un mail traité (octets) : au-delà, ignoré sans erreur (le CPU de l'analyse MIME croît avec la taille). */
export const MAIL_MAX_BYTES = 400_000;
/** Annonces gardées au plus d'un mail. */
export const MAIL_MAX_LISTINGS = 30;
/** Seuls les mails dont l'en-tête Authentication-Results de mx.cloudflare.net porte dmarc=pass sont lus (anti-usurpation de l'expéditeur). */
export const MAIL_REQUIRE_DMARC = true;
