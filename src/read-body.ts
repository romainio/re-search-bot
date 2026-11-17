import type { SourceDef } from "./types";

// Lecture bornée d'un corps de réponse ; ce qui n'est pas lu est abandonné (flux annulé), ni téléchargé ni décodé.
//  - Pages liste (readBody) : morceaux de CHUNK octets dans un tampon réutilisé, décodés au fil de l'eau ; arrêt au marqueur de
//    fin ou au plafond. Un tampon unique de 2 Mo coûterait plus cher par page (allocation, remise à zéro).
//  - Fiches (readCapped) : un seul tampon de maxBytes rempli en flux, décodé une fois.

/** Taille d'un morceau lu en flux : avec un marqueur de fin, au plus CHUNK octets lus au-delà de lui. */
const CHUNK = 64 * 1024;

export interface BodyRead {
  /** Texte décodé : page entière, ou coupée juste après le marqueur de fin (inclus), ou au plafond. */
  text: string;
  /** Octets tirés du flux (au plus maxBytes ; avec un marqueur, jusqu'à CHUNK octets au-delà de lui). */
  bytes: number;
  /** Marqueur de fin trouvé : la lecture s'est arrêtée là. */
  stopped: boolean;
  /** Plafond maxBytes atteint sans marqueur : la fin de la page n'a pas été lue. */
  truncated: boolean;
}

export interface ReadOptions {
  maxBytes: number;
  encoding: SourceDef["encoding"];
  /** Repère de fin propre à la page : rien n'est lu au-delà du morceau où il apparaît. */
  stopMarker?: string;
}

/** Lecteur BYOB avec readAtLeast (corps d'un fetch dans workerd, flux d'octets), sinon null (lecture par défaut). */
function byobReader(body: ReadableStream<Uint8Array>): ReadableStreamBYOBReader | null {
  let byob: ReadableStreamBYOBReader;
  try {
    byob = body.getReader({ mode: "byob" });
  } catch {
    return null;
  }
  if (typeof byob.readAtLeast !== "function") {
    byob.releaseLock();
    return null;
  } // hors workerd : lecture par défaut
  return byob;
}

/**
 * Corps lu en flux, au plus `maxBytes` octets : au-delà, le flux est annulé (le reste n'est ni téléchargé ni décodé).
 * truncated : plafond atteint avant la fin du flux (une page d'exactement maxBytes octets compte aussi comme tronquée).
 */
export async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const byob = byobReader(res.body);
  if (byob) {
    // readAtLeast (extension workerd) remplit le tampon en un appel natif ; la lecture par défaut coûte une promesse par morceau
    // de 4 Ko, soit plusieurs fois plus de CPU.
    let buffer = new ArrayBuffer(maxBytes),
      n = 0,
      done = false;
    while (n < maxBytes && !done) {
      const r = await byob.readAtLeast(maxBytes - n, new Uint8Array(buffer, n));
      if (!r.value) throw new Error("flux interrompu");
      buffer = r.value.buffer as ArrayBuffer;
      n += r.value.byteLength;
      done = r.done;
    }
    if (!done) await byob.cancel().catch(() => {});
    return { bytes: new Uint8Array(buffer, 0, n), truncated: !done };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0,
    done = false;
  while (n < maxBytes) {
    const r = await reader.read();
    if (r.done) {
      done = true;
      break;
    }
    chunks.push(r.value);
    n += r.value.byteLength;
  }
  if (!done) await reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(n, maxBytes));
  let o = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, out.length - o);
    out.set(take === c.byteLength ? c : c.subarray(0, take), o);
    o += take;
    if (o >= out.length) break;
  }
  return { bytes: out, truncated: !done };
}

/** Lecture par morceaux d'au plus `max` octets ; null en fin de flux. */
type Pull = (max: number) => Promise<Uint8Array | null>;

function puller(body: ReadableStream<Uint8Array>): { pull: Pull; cancel: () => Promise<void> } {
  const byob = byobReader(body);
  if (byob) {
    let buffer = new ArrayBuffer(CHUNK),
      ended = false;
    return {
      // Le tampon est réutilisé d'un morceau à l'autre : chaque morceau est décodé (copié en texte) avant la lecture suivante.
      pull: async (max) => {
        if (ended) return null;
        const want = Math.min(CHUNK, max);
        const r = await byob.readAtLeast(want, new Uint8Array(buffer, 0, want));
        if (!r.value) throw new Error("flux interrompu");
        buffer = r.value.buffer as ArrayBuffer;
        ended = r.done;
        if (r.value.byteLength > 0) return r.value;
        // readAtLeast(≥ 1) ne rend 0 octet qu'en fin de flux : sinon le flux est incohérent, jamais une fin de page silencieuse.
        if (ended) return null;
        throw new Error("flux interrompu");
      },
      cancel: () => byob.cancel().catch(() => {}),
    };
  }
  const reader = body.getReader();
  return {
    pull: async (max) => {
      const r = await reader.read();
      if (r.done) return null;
      return r.value.byteLength > max ? r.value.subarray(0, max) : r.value;
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

/**
 * Corps lu en flux et décodé, au plus `maxBytes` octets. Avec `stopMarker`, la lecture s'arrête au premier morceau où il
 * apparaît (même à cheval sur deux morceaux) et le texte finit juste après lui. Sans marqueur : page entière, ou plafond.
 */
export async function readBody(res: Response, opts: ReadOptions): Promise<BodyRead> {
  if (!res.body) return { text: "", bytes: 0, stopped: false, truncated: false };
  const { pull, cancel } = puller(res.body);
  const decoder = new TextDecoder(opts.encoding === "windows-1252" ? "windows-1252" : "utf-8");
  const marker = opts.stopMarker ?? "";
  const keep = Math.max(0, marker.length - 1); // fin du texte déjà décodé gardée pour un marqueur à cheval sur deux morceaux
  const parts: string[] = [];
  let n = 0,
    tail = "",
    stopped = false,
    ended = false;
  while (n < opts.maxBytes) {
    const chunk = await pull(opts.maxBytes - n);
    if (chunk === null) {
      ended = true;
      break;
    }
    n += chunk.byteLength;
    const s = decoder.decode(chunk, { stream: true });
    if (!marker) {
      parts.push(s);
      continue;
    }
    let cut = -1;
    if (tail !== "") {
      const j = (tail + s.slice(0, keep)).indexOf(marker);
      if (j >= 0) cut = j + marker.length - tail.length;
    }
    if (cut < 0) {
      const k = s.indexOf(marker);
      if (k >= 0) cut = k + marker.length;
    }
    if (cut >= 0) {
      parts.push(s.slice(0, cut));
      stopped = true;
      break;
    }
    parts.push(s);
    if (keep > 0) tail = s.length >= keep ? s.slice(s.length - keep) : (tail + s).slice(-keep);
  }
  if (ended)
    parts.push(decoder.decode()); // fin du flux : une séquence incomplète finale devient U+FFFD, comme un décodage d'un bloc
  else await cancel();
  return { text: parts.join(""), bytes: n, stopped, truncated: !stopped && !ended };
}
