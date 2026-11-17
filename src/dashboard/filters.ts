import { settings } from "../derive";
import { SEMANTIC_QUERY_MAX, SEMANTIC_QUERY_MIN, SEMANTIC_UNAVAILABLE } from "../config/semantic";
import { num } from "../format";
import { attr, esc } from "../html";
import { isFiltered, NEIGHBORHOOD, priceCaps, SORT_LABELS, surfaceMins } from "../listings-query";
import type { SortKey, View } from "../listings-query";
import type { SearchResult } from "../search/search";
import { FOLLOW_FILTERS } from "../telegram/feedback";

/** Recherche sémantique : `result` est celle de `?q=`, s'il y en a une. */
export interface SearchPanel {
  q: string;
  result: SearchResult | null;
}

/** Rechargement automatique de la page (option « Actualisation »), en secondes. */
export const AUTO_REFRESH_S = 60;

/** Lien d'une vue : paramètres dans un ordre fixe, valeurs de la liste blanche seulement. */
function viewHref(v: View): string {
  const q = new URLSearchParams();
  if (v.zone) q.set("zone", v.zone);
  if (v.prix != null) q.set("prix", String(v.prix));
  if (v.surface != null) q.set("surface", String(v.surface));
  if (v.tri !== "recentes") q.set("tri", v.tri);
  if (v.suivi) q.set("suivi", v.suivi);
  if (v.auto) q.set("auto", "1");
  if (v.q) q.set("q", v.q);
  const s = q.toString();
  return s ? `/?${s}` : "/";
}

/** Libellés du filtre « Suivi » (retours des boutons Telegram). */
const FOLLOW_LABELS: Readonly<Record<string, string>> = {
  aime: "👍 aimées",
  appelee: "📞 appelées",
  visite: "🗓 visites",
};

/** Champ de recherche (GET sans JavaScript) : les filtres de la vue sont conservés en champs cachés. */
export function searchForm(v: View, q: string): string {
  const hidden = (name: string, val: string | number | null | undefined): string =>
    val === null || val === undefined || val === ""
      ? ""
      : `<input type="hidden" name="${name}" value="${attr(String(val))}">`;
  return (
    `<form class="search" method="get" action="/" role="search"><input type="search" name="q" value="${attr(q)}" minlength="${SEMANTIC_QUERY_MIN}" maxlength="${SEMANTIC_QUERY_MAX}" placeholder="Rechercher : 2 pièces lumineux près du métro…" aria-label="Recherche dans les annonces">` +
    `${hidden("zone", v.zone)}${hidden("prix", v.prix)}${hidden("surface", v.surface)}${hidden("tri", v.tri !== "recentes" ? v.tri : null)}${hidden("auto", v.auto ? 1 : null)}<button type="submit">Rechercher</button></form>`
  );
}

/** Barre de filtres (liens, sans JavaScript) : l'option courante de chaque ligne est marquée (aria-current). */
export function filterBar(v: View, interactive = false): string {
  const chip = (label: string, next: Partial<View>, on: boolean): string =>
    `<a class="chip${on ? " on" : ""}"${on ? ' aria-current="true"' : ""} href="${attr(viewHref({ ...v, ...next }))}">${esc(label)}</a>`;
  const row = (title: string, chips: string[]): string =>
    `<div class="frow"><span class="flabel">${esc(title)}</span>${chips.join("")}</div>`;
  const { zones, neighborhood } = settings();
  const reset = isFiltered(v) || v.tri !== "recentes" || v.auto ? ' <a class="reset" href="/">réinitialiser</a>' : "";
  return (
    '<nav class="filtres" aria-label="Filtres">' +
    row("Zone", [
      chip("Toutes", { zone: null }, v.zone === null),
      ...zones.map((z) => chip(z.label, { zone: z.postalCode }, v.zone === z.postalCode)),
      ...(neighborhood.keywords.length
        ? [chip(`${neighborhood.label} seulement`, { zone: NEIGHBORHOOD }, v.zone === NEIGHBORHOOD)]
        : []),
    ]) +
    row("Prix max", [
      chip("Tous", { prix: null }, v.prix === null),
      ...priceCaps().map((p) => chip(`≤ ${num(p)} €`, { prix: p }, v.prix === p)),
    ]) +
    row("Surface min", [
      chip("Toutes", { surface: null }, v.surface === null),
      ...surfaceMins().map((m) => chip(`≥ ${m} m²`, { surface: m }, v.surface === m)),
    ]) +
    row(
      "Tri",
      (Object.keys(SORT_LABELS) as SortKey[]).map((k) => chip(SORT_LABELS[k], { tri: k }, v.tri === k)),
    ) +
    (interactive
      ? row("Suivi", [
          chip("Toutes", { suivi: null }, v.suivi === null),
          ...Object.keys(FOLLOW_FILTERS).map((k) => chip(FOLLOW_LABELS[k] ?? k, { suivi: k }, v.suivi === k)),
        ])
      : "") +
    row("Actualisation", [
      chip("non", { auto: false }, !v.auto),
      chip(`toutes les ${AUTO_REFRESH_S} s`, { auto: true }, v.auto),
    ]) +
    `<p class="mute">Loyer ou surface inconnus : annonce gardée.${reset}</p></nav>`
  );
}

/** Ligne au-dessus des résultats : la recherche en cours, ou la raison pour laquelle elle n'a pas répondu (la liste habituelle suit). */
export function searchNote(r: SearchResult): string {
  if (r.status === "ok")
    return `<p class="mute" id="recherche">Résultats pour « ${esc(r.query)} », du plus proche au moins proche. <a class="reset" href="/">effacer la recherche</a></p>`;
  const text =
    r.status === "invalid"
      ? `Recherche invalide : ${SEMANTIC_QUERY_MIN} à ${SEMANTIC_QUERY_MAX} caractères (lettres, chiffres, ponctuation courante).`
      : r.status === "off"
        ? ""
        : `${SEMANTIC_UNAVAILABLE[0].toUpperCase() + SEMANTIC_UNAVAILABLE.slice(1)}.`;
  return text ? `<p class="pend" id="recherche">${esc(text)}</p>` : "";
}
