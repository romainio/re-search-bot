/** Message de l'erreur levée par withTimeout (aussi raison enregistrée d'un sous-lot non lancé à temps). */
export const TIMEOUT_MESSAGE = "délai dépassé";

/**
 * La promesse, ou une erreur TIMEOUT_MESSAGE au bout de `ms` : pour un appel qui n'accepte pas d'AbortSignal (Workers AI, Vectorize,
 * service binding). L'appel lui-même continue ; seule l'attente est bornée.
 */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export const isTimeout = (e: unknown): boolean => e instanceof Error && e.message === TIMEOUT_MESSAGE;
