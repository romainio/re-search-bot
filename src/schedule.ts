import { GROUP_COUNT, LANE_COUNT } from "./config/schedule";
import { settings } from "./derive";
import type { Settings } from "./derive";
import type { SourceDef } from "./types";

const parisHour = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris",
  hour: "numeric",
  hourCycle: "h23",
});

/** Fenêtre de lecture de l'instance (heure de Paris) : début inclus, fin exclue. */
export function isActiveHour(now: Date, window: Settings["window"] = settings().window): boolean {
  const hour = parseInt(parisHour.format(now), 10);
  return hour >= window.startHour && hour < window.endHour;
}

/** Groupe lu à cette minute par la voie `lane` : lane × GROUP_COUNT + minute UTC modulo GROUP_COUNT. */
export function groupFor(now: Date, lane = 0): number {
  return lane * GROUP_COUNT + (now.getUTCMinutes() % GROUP_COUNT);
}

/**
 * Source à lire à ce passage ? Toujours en cadence normale ; en cadence réduite, seulement quand le créneau de 5 minutes de
 * l'heure est un multiple de every / 5, soit une lecture toutes les `every` minutes.
 */
export function isDue(src: Pick<SourceDef, "every">, now: Date): boolean {
  if (!src.every || src.every <= 5) return true;
  return Math.floor(now.getUTCMinutes() / 5) % Math.round(src.every / 5) === 0;
}

/** Groupes lus à cette minute, un par voie, en parallèle. */
export function groupsFor(now: Date): number[] {
  return Array.from({ length: LANE_COUNT }, (_, lane) => groupFor(now, lane));
}

const parisHM = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

/** Minutes écoulées depuis minuit, heure de Paris. */
export function parisMinuteOfDay(now: Date): number {
  const p = Object.fromEntries(parisHM.formatToParts(now).map((x) => [x.type, x.value]));
  return parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
}
