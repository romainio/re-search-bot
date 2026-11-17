/** 1400 -> "1 400" (espace simple U+0020). */
export const num = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** Nombre à virgule décimale française : decimal(2.5) -> "2,5", decimal(0.42, 2) -> "0,42". */
export const decimal = (n: number, digits = 1): string => n.toFixed(digits).replace(".", ",");

/** Tronque à `max` unités UTF-16 avec « … » ; une demi-paire (emoji coupé) en fin de tranche est retirée. */
export const clip = (s: string, max: number): string =>
  s.length <= max
    ? s
    : `${s
        .slice(0, Math.max(0, max - 1))
        .replace(/[\uD800-\uDBFF]$/, "")
        .trimEnd()}…`;
