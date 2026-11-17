import PostalMime from "postal-mime";
import { MAIL_MAX_BYTES, MAIL_MAX_LISTINGS, MAIL_REQUIRE_DMARC } from "../config/mail";
import { settings } from "../derive";
import { processListings } from "../process";
import type { Env, Listing } from "../types";
import { extractListings, htmlToMarkdown } from "../universal/read";
import { htmlToText } from "./html";
import { readMailCards } from "./readers";
import { addressOf, senderFor } from "./senders";
import type { MailSender } from "./senders";
import { errMsg } from "../guards";

/** Le sous-ensemble de ForwardableEmailMessage (Email Routing) dont le traitement a besoin : simple à simuler dans les tests. */
export interface MailMessage {
  readonly from: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

/** Issue d'un mail : pour les tests et le journal. */
export type MailOutcome = "off" | "rejected" | "ignored" | "no_listing" | "ingested";

export const mailIngestOn = (env: Env): boolean => env.MAIL_INGEST === "true";

/** Vrai si le premier en-tête Authentication-Results, posé par Email Routing, dit dmarc=pass ; les suivants peuvent venir de l'expéditeur. */
export function dmarcPass(headers: Headers): boolean {
  // Headers fusionne les en-têtes de même nom : seul le premier (celui de Cloudflare) compte ; un suivant commence par « , hôte ; ».
  const first = (headers.get("authentication-results") ?? "").split(/,\s*(?=[a-z0-9-]+(?:\.[a-z0-9-]+)+\s*;)/i)[0];
  return /^\s*mx\.cloudflare\.net\b/i.test(first) && /\bdmarc=pass\b/i.test(first);
}

/**
 * Traite un mail reçu par Email Routing. Éteint, ou mail trop gros, illisible, sans annonce : accepté et ignoré, jamais rejeté
 * (un rejet ferait désabonner l'adresse par le portail). Expéditeur hors liste blanche ou DMARC non réussi : rejeté. Sinon les
 * annonces suivent le circuit normal comme source virtuelle `mail_<expéditeur>`, le premier mail d'un expéditeur étant
 * silencieux (il porte le stock en cours). Aucune exception ne remonte.
 */
export async function handleMail(message: MailMessage, env: Env, now: Date = new Date()): Promise<MailOutcome> {
  if (!mailIngestOn(env)) return "off";
  try {
    // Pré-contrôle bon marché sur l'en-tête From, avant toute analyse MIME (CPU).
    const sender = senderFor(addressOf(message.headers.get("from")));
    if (!sender) {
      message.setReject("Expéditeur non autorisé");
      return "rejected";
    }
    if (MAIL_REQUIRE_DMARC && !dmarcPass(message.headers)) {
      message.setReject("Authentification de l'expéditeur non confirmée");
      return "rejected";
    }
    if (message.rawSize > MAIL_MAX_BYTES) {
      console.warn(`mail ${sender.key}: ${message.rawSize} octets, ignoré`);
      return "ignored";
    }

    const parsed = await new PostalMime().parse(await new Response(message.raw).arrayBuffer());
    const listings = await listingsOf(env, sender, parsed.html ?? null, parsed.text ?? null);
    if (listings.length === 0) {
      console.log(`mail ${sender.key}: aucune annonce`);
      return "no_listing";
    }

    const src = settings().sources.mail.find((s) => s.id === `mail_${sender.key}`);
    if (!src) return "ignored";
    const r = await processListings(env.DB, src, listings, now);
    console.log(`mail ${sender.key}: ${listings.length} annonces, ${r.inserted} nouvelles, ${r.pending} à alerter`);
    return "ingested";
  } catch (e) {
    console.error("mail:", errMsg(e));
    return "ignored";
  }
}

/** Annonces d'un mail : lecteur déterministe de l'expéditeur, sinon lecteur universel (Markdown du HTML, ou texte du mail). */
async function listingsOf(env: Env, sender: MailSender, html: string | null, text: string | null): Promise<Listing[]> {
  const cards = html ? readMailCards(sender, html) : [];
  if (cards.length > 0) return cards;
  const home = new URL(sender.home);
  const md = (html ? ((await htmlToMarkdown(env, html, home.hostname)) ?? htmlToText(html)) : text) ?? "";
  if (!md.trim()) return [];
  const r = await extractListings(
    env,
    md,
    {
      source: `mail_${sender.key}`,
      agency: sender.name,
      phone: sender.phone ?? null,
      baseUrl: sender.home,
      keepQuery: false,
      max: MAIL_MAX_LISTINGS,
    },
    "mail",
  );
  return r.status === "ok" ? r.listings : [];
}
