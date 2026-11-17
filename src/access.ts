import type { Env } from "./types";
import { authorized, hmacHex } from "./crypto";

// Accès au tableau de bord. DASHBOARD_PUBLIC="true" : public ; sinon `?k=ADMIN_KEY` ou le cookie posé après une visite avec la
// clé. Le cookie ne contient jamais la clé, seulement une signature HMAC propre au tableau de bord.

export const DASH_COOKIE = "rs_dash";
/** Durée du cookie du tableau de bord : 30 jours sans redonner la clé. */
const DASH_COOKIE_MAX_AGE_S = 30 * 24 * 3600;
const token = (env: Pick<Env, "ADMIN_KEY">): Promise<string> => hmacHex(env.ADMIN_KEY, "re-search:dashboard");
const cookieOf = (header: string | null): string | null => {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === DASH_COOKIE) return v.join("=");
  }
  return null;
};

/** `response` null : accès accordé (tableau de bord rendu). Sinon la réponse à renvoyer (redirection posant le cookie, ou refus 403). */
export async function dashboardGate(
  request: Request,
  env: Env,
): Promise<{ response: Response | null; isPrivate: boolean }> {
  if (env.DASHBOARD_PUBLIC === "true") return { response: null, isPrivate: false };
  const deny = (): Response =>
    new Response(
      "Tableau de bord privé : ouvrez-le avec ?k=<ADMIN_KEY> (une première fois suffit, un cookie prend le relais).",
      {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      },
    );
  if (!env.ADMIN_KEY) return { response: deny(), isPrivate: true };
  const url = new URL(request.url);
  if (authorized(url.searchParams.get("k"), env.ADMIN_KEY)) {
    // La clé ne reste pas dans l'URL (historique, journaux) : cookie, puis redirection vers la même page sans `k`.
    url.searchParams.delete("k");
    return {
      isPrivate: true,
      response: new Response(null, {
        status: 302,
        headers: {
          location: url.pathname + url.search,
          "set-cookie": `${DASH_COOKIE}=${await token(env)}; Path=/; Max-Age=${DASH_COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`,
          "cache-control": "no-store",
        },
      }),
    };
  }
  if (authorized(cookieOf(request.headers.get("cookie")), await token(env))) return { response: null, isPrivate: true };
  return { response: deny(), isPrivate: true };
}

/** Jeton de l'en-tête « Authorization: Bearer <jeton> », ou null. */
export function bearerOf(request: Request): string | null {
  return /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
}

/**
 * Accès aux routes d'administration : en-tête « Authorization: Bearer <ADMIN_KEY> ». `?k=ADMIN_KEY` reste accepté sur un GET, pour
 * ouvrir une route dans un navigateur ; jamais sur une écriture (une clé dans l'URL finit dans les journaux et l'historique).
 */
export function adminAuthorized(request: Request, env: Pick<Env, "ADMIN_KEY">): boolean {
  const bearer = bearerOf(request);
  if (bearer !== null) return authorized(bearer, env.ADMIN_KEY);
  return request.method === "GET" && authorized(new URL(request.url).searchParams.get("k"), env.ADMIN_KEY);
}
