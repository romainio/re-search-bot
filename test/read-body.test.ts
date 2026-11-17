import { describe, expect, it } from "vitest";
import { readBody } from "../src/read-body";

const enc = new TextEncoder();
const CHUNK = 64 * 1024;

/**
 * Corps servi en flux de morceaux de `size` octets, tirés un par un (highWaterMark 0 : rien n'est lu d'avance).
 * byteStream : flux d'octets (lecture BYOB readAtLeast, comme le corps d'un fetch dans workerd) ; sinon flux par défaut.
 * stats.pulled : octets réellement servis par la « source réseau ».
 */
function chunked(data: Uint8Array, size: number, byteStream: boolean) {
  const stats = { pulled: 0, cancelled: false };
  let i = 0;
  const pull = (c: ReadableStreamDefaultController<Uint8Array> | ReadableByteStreamController) => {
    if (i >= data.length) {
      c.close();
      return;
    }
    const part = data.slice(i, i + size);
    i += part.length;
    stats.pulled += part.length;
    c.enqueue(part);
  };
  const cancel = () => {
    stats.cancelled = true;
  };
  const stream = byteStream
    ? new ReadableStream({ type: "bytes", pull, cancel }, { highWaterMark: 0 })
    : new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  return { res: new Response(stream), stats };
}

const MARK = '<footer class="footer">';

describe.each([
  ["flux par défaut", false],
  ["flux d'octets (BYOB readAtLeast)", true],
])("readBody, %s", (_label, byteStream) => {
  it("s'arrête au marqueur : texte coupé juste après lui, octets lus < taille totale, flux annulé", async () => {
    const page = `${"a".repeat(300_000) + MARK}<script>${"b".repeat(700_000)}`;
    const data = enc.encode(page);
    const { res, stats } = chunked(data, CHUNK, byteStream);
    const r = await readBody(res, { maxBytes: 2_000_000, encoding: "utf-8", stopMarker: MARK });
    const end = page.indexOf(MARK) + MARK.length;
    expect(r.text).toBe(page.slice(0, end));
    expect(r).toMatchObject({ stopped: true, truncated: false });
    expect(r.bytes).toBeGreaterThanOrEqual(end);
    expect(r.bytes).toBeLessThanOrEqual(end + CHUNK);
    expect(stats.pulled).toBeLessThan(data.length / 2);
    expect(stats.cancelled).toBe(true);
  });

  it("marqueur à cheval sur deux morceaux : trouvé", async () => {
    for (const before of [1, 3, MARK.length - 1]) {
      const page = "x".repeat(CHUNK - before) + MARK + "y".repeat(200_000);
      const { res } = chunked(enc.encode(page), CHUNK, byteStream);
      const r = await readBody(res, { maxBytes: 2_000_000, encoding: "utf-8", stopMarker: MARK });
      expect(r.text, `coupé ${before} caractères avant la frontière`).toBe(page.slice(0, CHUNK - before + MARK.length));
      expect(r.stopped).toBe(true);
    }
  });

  it("caractères multi-octets coupés entre deux morceaux (é sur 2 octets, € sur 3, emoji sur 4) : texte intact", async () => {
    for (const ch of ["é", "€", "🏠"]) {
      const n = enc.encode(ch).length;
      // Le caractère commence 1 octet avant la frontière du premier morceau : ses octets sont répartis sur deux morceaux.
      const page = "a".repeat(CHUNK - 1) + ch + "loyer 1 300 €".repeat(10_000) + MARK + "z".repeat(100_000);
      expect(enc.encode(page.slice(0, CHUNK - 1 + ch.length)).length).toBe(CHUNK - 1 + n);
      const withMark = chunked(enc.encode(page), CHUNK, byteStream);
      const r = await readBody(withMark.res, { maxBytes: 2_000_000, encoding: "utf-8", stopMarker: MARK });
      expect(r.text).toBe(page.slice(0, page.indexOf(MARK) + MARK.length));
      // Lecture complète (sans marqueur) : même texte que le décodage d'un bloc.
      const full = chunked(enc.encode(page), CHUNK, byteStream);
      expect((await readBody(full.res, { maxBytes: 2_000_000, encoding: "utf-8" })).text).toBe(page);
    }
  });

  it("plafond atteint sans marqueur : corps tronqué signalé (truncated), maxBytes octets exactement, flux annulé", async () => {
    const page = "c".repeat(500_000);
    const { res, stats } = chunked(enc.encode(page), CHUNK, byteStream);
    const r = await readBody(res, { maxBytes: 150_000, encoding: "utf-8", stopMarker: MARK });
    expect(r).toMatchObject({ stopped: false, truncated: true, bytes: 150_000 });
    expect(r.text).toBe(page.slice(0, 150_000));
    expect(stats.pulled).toBeLessThan(150_000 + CHUNK);
    expect(stats.cancelled).toBe(true);
  });

  it("marqueur absent et page courte : lecture complète normale (ni arrêt ni troncature)", async () => {
    const page = `<html>${"d".repeat(100_000)}é</html>`;
    const { res, stats } = chunked(enc.encode(page), CHUNK, byteStream);
    const r = await readBody(res, { maxBytes: 2_000_000, encoding: "utf-8", stopMarker: MARK });
    expect(r).toEqual({ text: page, bytes: enc.encode(page).length, stopped: false, truncated: false });
    expect(stats.cancelled).toBe(false);
  });

  it("marqueur en fin de page (le flux se termine juste après) et dans le premier morceau", async () => {
    for (const page of ["e".repeat(200_000) + MARK, `<html>${MARK}${"f".repeat(300_000)}`]) {
      const { res } = chunked(enc.encode(page), CHUNK, byteStream);
      const r = await readBody(res, { maxBytes: 2_000_000, encoding: "utf-8", stopMarker: MARK });
      expect(r.text).toBe(page.slice(0, page.indexOf(MARK) + MARK.length));
      expect(r.stopped).toBe(true);
    }
  });

  it("sans marqueur configuré : page entière ; plafond atteint : truncated", async () => {
    const page = `${"g".repeat(300_000)}€`;
    const a = chunked(enc.encode(page), CHUNK, byteStream);
    expect(await readBody(a.res, { maxBytes: 2_000_000, encoding: "utf-8" })).toEqual({
      text: page,
      bytes: 300_003,
      stopped: false,
      truncated: false,
    });
    const b = chunked(enc.encode(page), CHUNK, byteStream);
    const r = await readBody(b.res, { maxBytes: 100_000, encoding: "utf-8" });
    expect(r).toMatchObject({ bytes: 100_000, stopped: false, truncated: true });
    expect(r.text).toBe(page.slice(0, 100_000));
    expect(b.stats.cancelled).toBe(true);
  });

  it("morceaux de 3 octets, plus courts que le marqueur : marqueur réparti sur plusieurs morceaux trouvé, caractères multi-octets intacts", async () => {
    const page = "<html>Loyer 1 300 € — 2 pièces, 38 m² 🏠 ".repeat(40) + MARK + "après le marqueur".repeat(50);
    const withMark = chunked(enc.encode(page), 3, byteStream);
    const r = await readBody(withMark.res, { maxBytes: 2_000_000, encoding: "utf-8", stopMarker: MARK });
    expect(r.text).toBe(page.slice(0, page.indexOf(MARK) + MARK.length));
    expect(r).toMatchObject({ stopped: true, truncated: false });
    // Flux par défaut : chaque morceau de 3 octets est décodé seul (chemin (tail + s).slice(-keep)) et la lecture s'arrête au
    // marqueur. BYOB : readAtLeast regroupe les morceaux jusqu'à 64 Ko, cette page de 3 Ko est lue d'un coup.
    if (!byteStream) expect(withMark.stats.pulled).toBeLessThan(enc.encode(page).length);
    const full = chunked(enc.encode(page.replace(MARK, "<footer>")), 3, byteStream);
    const f = await readBody(full.res, { maxBytes: 2_000_000, encoding: "utf-8", stopMarker: MARK });
    expect(f).toMatchObject({ text: page.replace(MARK, "<footer>"), stopped: false, truncated: false });
  });

  it("windows-1252 : décodage par morceaux (0x80 = €) et arrêt au marqueur", async () => {
    const latin = (s: string) => Uint8Array.from(s, (c) => (c === "€" ? 0x80 : c.charCodeAt(0)));
    const page = "Loyer 1 200 € é".repeat(10_000) + MARK + "h".repeat(100_000);
    const { res } = chunked(latin(page), CHUNK, byteStream);
    const r = await readBody(res, { maxBytes: 2_000_000, encoding: "windows-1252", stopMarker: MARK });
    expect(r.text).toBe(page.slice(0, page.indexOf(MARK) + MARK.length));
    expect(r.stopped).toBe(true);
  });
});

describe("readBody, corps d'un Response construit sur des octets (corps natif)", () => {
  it("arrêt au marqueur et lecture complète", async () => {
    const page = "i".repeat(400_000) + MARK + "j".repeat(400_000);
    const r = await readBody(new Response(enc.encode(page)), {
      maxBytes: 2_000_000,
      encoding: "utf-8",
      stopMarker: MARK,
    });
    expect(r.text).toBe(page.slice(0, 400_000 + MARK.length));
    expect(r.bytes).toBeLessThan(page.length);
    expect((await readBody(new Response(enc.encode(page)), { maxBytes: 2_000_000, encoding: "utf-8" })).text).toBe(
      page,
    );
  });

  it("corps vide ou absent : texte vide", async () => {
    expect(await readBody(new Response(null), { maxBytes: 1000, encoding: "utf-8", stopMarker: MARK })).toEqual({
      text: "",
      bytes: 0,
      stopped: false,
      truncated: false,
    });
    expect(await readBody(new Response(""), { maxBytes: 1000, encoding: "utf-8" })).toEqual({
      text: "",
      bytes: 0,
      stopped: false,
      truncated: false,
    });
  });
});

describe("readBody, lecteur BYOB qui rend 0 octet", () => {
  /** Réponse dont le corps est un lecteur BYOB factice : chaque readAtLeast rend 0 octet avec ce `done`. */
  const zeroRead = (done: boolean) => {
    const reader = {
      readAtLeast: async (_min: number, view: Uint8Array) => ({ value: new Uint8Array(view.buffer, 0, 0), done }),
      cancel: async () => {},
      releaseLock: () => {},
    };
    return { body: { getReader: () => reader } } as unknown as Response;
  };

  it("0 octet avec done : fin du flux, texte vide", async () => {
    expect(await readBody(zeroRead(true), { maxBytes: 1000, encoding: "utf-8", stopMarker: MARK })).toEqual({
      text: "",
      bytes: 0,
      stopped: false,
      truncated: false,
    });
  });

  it("0 octet sans done : erreur (jamais une fin de page silencieuse)", async () => {
    await expect(readBody(zeroRead(false), { maxBytes: 1000, encoding: "utf-8", stopMarker: MARK })).rejects.toThrow(
      "flux interrompu",
    );
  });
});
