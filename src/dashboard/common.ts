import { decimal } from "../format";
import { DAY_MS } from "../time";

const parisFmt = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
/** Date et heure de Paris, « 17/11 08:05 » ; vide si la date est illisible. */
export function parisDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = Object.fromEntries(parisFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
}

/** Ligne d'annonce lue pour une carte ; `since` : première détection du cluster ; `score` : similarité d'une recherche sémantique. */
export interface Row {
  source: string;
  listing_id: string;
  alert_status: string;
  alert_attempts: number;
  first_seen: string;
  payload: string;
  since?: string | null;
  score?: number;
}

/** Durée en jours, une décimale : « 2,5 j ». */
export const days = (ms: number): string => `${decimal(Math.max(0, ms) / DAY_MS)} j`;
export const between = (from: string, to: string | Date): number => new Date(to).getTime() - new Date(from).getTime();
