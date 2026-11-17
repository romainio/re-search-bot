/** Réponse JSON ; `headers` complète ou remplace l'en-tête de type. */
export const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

export const notFound = (): Response => new Response("Not found", { status: 404 });
