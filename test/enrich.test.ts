import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "../src/derive";
import worker from "../src/index";
import orpiListRaw from "./fixtures/orpi.html?raw";
import orpiDetailRaw from "./fixtures/detail/orpi.html?raw";
import { DETAIL_TIMEOUT_MS, MAX_ENRICH_PER_SOURCE, USER_AGENT } from "../src/config/fetch";
import { PART_SIZE } from "../src/config/scan";
import { DETAIL_PARSERS } from "../src/detail/index";
import { fetchDetail } from "../src/enrich";
import { fetchSource } from "../src/fetch-source";
import { evaluate } from "../src/filter";
import { sendPendingAlerts } from "../src/notify/send";
import { getPendingAlerts } from "../src/process";
import { PARSERS } from "../src/parsers/index";
import { runPart } from "../src/scan";
import type { Env } from "../src/types";

const cfg = settings();

const E: Env = {
  ...(env as unknown as Env),
  ADMIN_KEY: "secret-key",
  TELEGRAM_BOT_TOKEN: "tok",
  TELEGRAM_CHAT_ID: "42",
  WHATSAPP_ENABLED: "false",
};
const ORPI = cfg.sources.dedicated.find((s) => s.id === "orpi_17")!;
const FNAIM = cfg.sources.dedicated.find((s) => s.id === "fnaim_17")!;
const NOW = new Date(Date.UTC(2026, 9, 19, 10, 0));
const enc = (o: object) => JSON.stringify(o).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
/** Page liste Orpi (attribut data-result, comme le site) et fiche Orpi (attribut data-estate). */
const orpiList = (items: object[]) => `<html><div data-result="${enc({ items, similars: [] })}"></div></html>`;
const orpiDetail = (estate: object) => `<html><div data-estate="${enc(estate)}"></div></html>`;
const detailUrl = (slug: string) => `https://www.orpi.com/annonce-location-${slug}/`;
/** Annonce de liste Orpi : nouvelle, gardée par evaluate (1 500 €, CC inconnu : « charges non connues »). */
const item = (id: number, o: object = {}) => ({
  id,
  slug: `appartement-t2-paris-17-75017-x${id}`,
  price: 1500,
  surface: 41,
  nbRooms: 2,
  type: "appartement",
  images: [`https://img.test/${id}.jpg`],
  agency: { name: "Orpi Test" },
  ...o,
});

/** Page liste FNAIM (cartes <li class="item">, 1 500 € sans mention CC) et fiche FNAIM (1 500 € CC dont 100 de provision). */
const fnaimList = (ids: number[]) =>
  `<ul>${ids
    .map(
      (id) =>
        `<li class="item" data-id="${id}"><a href="/annonce-immobiliere/${id}/location-appartement.htm">voir</a>` +
        `<h3>Appartement 2 pièces 40m² PARIS 17</h3><p class="price">1 500 €</p></li>`,
    )
    .join("")}</ul>`;
const fnaimUrl = (id: number) => `https://www.fnaim.fr/annonce-immobiliere/${id}/location-appartement.htm`;
const fnaimDetail =
  '<h2>Informations sur les prix</h2><p><span class="loyerChargeComprise">Loyer : <strong>1 500 &euro;</strong> par mois charges comprises</span>' +
  "<br>- 100 € par mois de provision pour charges</p>";

type Route = Response | (() => Response | Promise<Response>);
function mockFetch(list: string, details: Record<string, Route> = {}, listUrl: string = ORPI.url) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const u = String(input instanceof Request ? input.url : input);
    if (u.startsWith("https://api.telegram.org/")) return new Response(JSON.stringify({ ok: true }));
    if (u === listUrl) return new Response(list);
    const r = details[u];
    if (r) return typeof r === "function" ? r() : r.clone();
    return new Response("introuvable", { status: 404 });
  });
}
const detailCalls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => !cfg.sources.dedicated.some((s) => s.url === u) && !u.startsWith("https://api.telegram.org/"));
const row = (id: string, source = "orpi_17") =>
  env.DB.prepare("SELECT alert_status, rent_cc, payload FROM listings WHERE source = ? AND listing_id = ?")
    .bind(source, id)
    .first<{ alert_status: string; rent_cc: number | null; payload: string }>();
const payload = async (id: string, source = "orpi_17") =>
  JSON.parse((await row(id, source))!.payload) as {
    listing: Record<string, unknown>;
    evaluation: { keep: boolean; flags: string[]; reason?: string };
    listPrice?: number | null;
  };
const initialized = (source = "orpi_17") =>
  env.DB.prepare("INSERT INTO source_state (source, initialized) VALUES (?, 1)").bind(source).run();

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM listings"), env.DB.prepare("DELETE FROM source_state")]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 19, 10, 0, 2)));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("enrichissement dans le sous-lot (runPart, fetch mocké)", () => {
  it("(a) nouvelle annonce Orpi sans CC en liste, la fiche donne 1 500 € CC dont 100 de charges : alerte « 1 500 € CC »", async () => {
    await initialized();
    const spy = mockFetch(orpiList([item(101)]), {
      [detailUrl("appartement-t2-paris-17-75017-x101")]: new Response(
        orpiDetail({
          price: 1500,
          priceHC: 1400,
          chargeReserve: 100,
          surface: 41,
          nbRooms: 2,
          zipCode: "75017",
          longAd: "Beau 2 pièces lumineux",
          agency: { name: "Orpi Nouallet", phone: "01 40 25 48 28", zipcode: "75017" },
        }),
      ),
    });
    const r = await runPart(E, [ORPI], NOW);
    expect(r.sources).toEqual([expect.objectContaining({ id: "orpi_17", ok: true, count: 1 })]);
    expect(detailCalls(spy)).toEqual([detailUrl("appartement-t2-paris-17-75017-x101")]);
    expect(await row("101")).toMatchObject({ alert_status: "pending", rent_cc: 1500 });
    const p = await payload("101");
    expect(p.listing).toMatchObject({
      price: 1500,
      priceIsCC: true,
      charges: 100,
      description: "Beau 2 pièces lumineux",
      phone: "01 40 25 48 28",
      photo: "https://img.test/101.jpg",
    });
    expect(p.evaluation.flags).not.toContain("charges_inconnues");

    expect((await sendPendingAlerts(E, cfg.sources.dedicated, NOW)).sent).toBe(1);
    const tg = spy.mock.calls.filter((c) => String(c[0]).startsWith("https://api.telegram.org/"));
    const caption = JSON.parse((tg[0][1] as RequestInit).body as string).caption as string;
    expect(caption).toContain("1 500 € CC");
    expect(caption).not.toContain("charges non connues");
  });

  it("(a') fixtures réelles : liste Orpi du 19/10 + fiche 1500213 -> 1 500 € CC, 40 € de charges ; l'autre annonce gardée (fiche 404) garde ses données de liste", async () => {
    await initialized();
    const listings = PARSERS.orpi(orpiListRaw, ORPI);
    const kept = listings.filter((l) => evaluate(l, ORPI).keep);
    const target = kept.find((l) => l.id === "1500213")!;
    expect(target).toBeDefined();
    // Orpi : 1 fiche par passage. Les annonces gardées placées avant 1500213 sont déjà connues : sa fiche est la seule lue.
    for (const l of kept.slice(0, kept.indexOf(target))) {
      await env.DB.prepare(
        "INSERT INTO listings (source, listing_id, cluster, first_seen, alert_status, payload) VALUES ('orpi_17', ?, ?, ?, 'sent', '{}')",
      )
        .bind(l.id, `orpi_17:${l.id}`, NOW.toISOString())
        .run();
    }
    const spy = mockFetch(orpiListRaw, { [target.url]: new Response(orpiDetailRaw) });
    await runPart(E, [ORPI], NOW);
    expect(detailCalls(spy)).toEqual([target.url]);
    expect(await row("1500213")).toMatchObject({ alert_status: "pending", rent_cc: 1500 });
    expect((await payload("1500213")).listing).toMatchObject({
      price: 1500,
      priceIsCC: true,
      charges: 40,
      surface: 41.2,
    });
    for (const l of kept.slice(kept.indexOf(target) + 1)) {
      expect((await payload(l.id)).listing).toMatchObject({ priceIsCC: null, charges: null });
      expect((await payload(l.id)).evaluation.flags).toContain("charges_inconnues");
    }
  });

  it("(b) la fiche révèle une surface de 30 m² : annonce « filtered », aucune alerte", async () => {
    await initialized();
    const spy = mockFetch(orpiList([item(102)]), {
      [detailUrl("appartement-t2-paris-17-75017-x102")]: new Response(
        orpiDetail({ price: 1500, priceHC: 1400, chargeReserve: 100, surface: 30, zipCode: "75017" }),
      ),
    });
    await runPart(E, [ORPI], NOW);
    expect(detailCalls(spy)).toHaveLength(1);
    expect((await row("102"))!.alert_status).toBe("filtered");
    expect((await payload("102")).evaluation).toMatchObject({ keep: false, reason: "surface" });
    expect((await sendPendingAlerts(E, cfg.sources.dedicated, NOW)).sent).toBe(0);
  });

  it("(c) fiche en 500 ou en délai dépassé (AbortSignal.timeout 10 s) : alerte avec les données de la liste", async () => {
    await initialized();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const details = {
      [detailUrl("appartement-t2-paris-17-75017-x103")]: new Response("erreur", { status: 500 }),
      [detailUrl("appartement-t2-paris-17-75017-x104")]: () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    };
    const spy = mockFetch(orpiList([item(103)]), details);
    expect((await runPart(E, [ORPI], NOW)).sources[0]).toMatchObject({ ok: true, count: 1 });
    const first = detailCalls(spy);
    spy.mockRestore();
    const spy2 = mockFetch(orpiList([item(103), item(104)]), details); // 103 connue : seule la fiche de 104 est lue
    const r = await runPart(E, [ORPI], NOW);
    expect(r.sources[0]).toMatchObject({ ok: true, count: 2 });
    expect([...first, ...detailCalls(spy2)]).toEqual([
      detailUrl("appartement-t2-paris-17-75017-x103"),
      detailUrl("appartement-t2-paris-17-75017-x104"),
    ]);
    expect(timeout).toHaveBeenCalledWith(DETAIL_TIMEOUT_MS);
    expect(DETAIL_TIMEOUT_MS).toBe(10_000);
    for (const id of ["103", "104"]) {
      expect(await row(id)).toMatchObject({ alert_status: "pending", rent_cc: 1500 });
      const p = await payload(id);
      expect(p.listing).toMatchObject({ price: 1500, priceIsCC: null, charges: null });
      expect(p.evaluation.flags).toContain("charges_inconnues");
    }
  });

  it("(d) annonce déjà connue : aucune requête de fiche", async () => {
    await initialized();
    await env.DB.prepare(
      "INSERT INTO listings (source, listing_id, cluster, first_seen, alert_status, payload) VALUES ('orpi_17', '105', 'orpi_17:105', ?, 'sent', '{}')",
    )
      .bind(NOW.toISOString())
      .run();
    const spy = mockFetch(orpiList([item(105)]));
    await runPart(E, [ORPI], NOW);
    expect(detailCalls(spy)).toEqual([]);
    expect(spy.mock.calls.map((c) => String(c[0]))).toEqual([ORPI.url]);
  });

  it("(e) 5 nouvelles annonces FNAIM gardées : 3 fiches au plus (MAX_ENRICH_PER_SOURCE), les 2 autres passent avec la liste", async () => {
    expect(MAX_ENRICH_PER_SOURCE).toBe(3);
    await initialized("fnaim_17");
    const ids = [211, 212, 213, 214, 215];
    const spy = mockFetch(
      fnaimList(ids),
      Object.fromEntries(ids.map((id) => [fnaimUrl(id), new Response(fnaimDetail)])),
      FNAIM.url,
    );
    await runPart(E, [FNAIM], NOW);
    expect(detailCalls(spy)).toEqual(ids.slice(0, 3).map(fnaimUrl));
    expect(spy).toHaveBeenCalledTimes(1 + 3);
    for (const id of ["211", "212", "213"])
      expect((await payload(id, "fnaim_17")).listing).toMatchObject({ price: 1500, priceIsCC: true, charges: 100 });
    for (const id of ["214", "215"])
      expect((await payload(id, "fnaim_17")).listing).toMatchObject({ priceIsCC: null, charges: null });
    for (const id of ids) expect((await row(String(id), "fnaim_17"))!.alert_status).toBe("pending");
  });

  it("famille lourde plafonnée à 1 fiche par passage (orpi : maxPerPass 1) ; les autres au plafond par défaut", async () => {
    expect(DETAIL_PARSERS.orpi!.maxPerPass).toBe(1);
    for (const p of ["fnaim", "laforet", "foncia"] as const) expect(DETAIL_PARSERS[p]!.maxPerPass).toBeUndefined();
    await initialized();
    const ids = [111, 112, 113, 114, 115];
    const spy = mockFetch(
      orpiList(ids.map((id) => item(id))),
      Object.fromEntries(
        ids.map((id) => [
          detailUrl(`appartement-t2-paris-17-75017-x${id}`),
          new Response(orpiDetail({ price: 1500, priceHC: 1450, chargeReserve: 50, zipCode: "75017" })),
        ]),
      ),
    );
    await runPart(E, [ORPI], NOW);
    expect(detailCalls(spy)).toEqual([detailUrl("appartement-t2-paris-17-75017-x111")]);
    expect((await payload("111")).listing).toMatchObject({ priceIsCC: true, charges: 50 });
    for (const id of ["112", "113", "114", "115"])
      expect((await payload(id)).listing).toMatchObject({ priceIsCC: null, charges: null });
    for (const id of ids) expect((await row(String(id)))!.alert_status).toBe("pending");
  });

  it("filtrée « prix_haut » sur la fiche (liste 1 600 sans CC, fiche CC 1 650) : pas de « Baisse de prix » au passage suivant sur la même liste ; alerte si le prix de la liste baisse (1 550)", async () => {
    await initialized();
    const url = detailUrl("appartement-t2-paris-17-75017-x171");
    const spy1 = mockFetch(orpiList([item(171, { price: 1600 })]), {
      [url]: new Response(orpiDetail({ price: 1650, priceHC: 1550, chargeReserve: 100, zipCode: "75017" })),
    });
    await runPart(E, [ORPI], NOW);
    expect(detailCalls(spy1)).toEqual([url]);
    expect((await row("171"))!.alert_status).toBe("filtered");
    expect(await payload("171")).toMatchObject({
      listPrice: 1600,
      listing: { price: 1650, priceIsCC: true },
      evaluation: { reason: "prix_haut" },
    });
    spy1.mockRestore();

    const spy2 = mockFetch(orpiList([item(171, { price: 1600 })]));
    await runPart(E, [ORPI], new Date(NOW.getTime() + 60_000));
    expect(detailCalls(spy2)).toEqual([]); // annonce connue : pas de fiche
    expect((await row("171"))!.alert_status).toBe("filtered");
    expect(await getPendingAlerts(env.DB, 10)).toEqual([]);
    spy2.mockRestore();

    const spy3 = mockFetch(orpiList([item(171, { price: 1550 })]));
    await runPart(E, [ORPI], new Date(NOW.getTime() + 120_000));
    expect(await getPendingAlerts(env.DB, 10)).toMatchObject([{ id: "171", kind: "price_drop" }]);
    expect((await payload("171")).listPrice).toBe(1550);
    expect((await sendPendingAlerts(E, cfg.sources.dedicated, NOW)).sent).toBe(1);
    const tg = spy3.mock.calls.filter((c) => String(c[0]).startsWith("https://api.telegram.org/"));
    expect(JSON.parse((tg[0][1] as RequestInit).body as string).caption).toContain("Baisse de prix");
  });

  it("lecteur qui lève (read, synchrone), qui renvoie null, ou filtre de gabarit qui lève : la passe garde les données de la liste, la source reste OK", async () => {
    await initialized();
    const orig = DETAIL_PARSERS.orpi!;
    const url = (id: number) => detailUrl(`appartement-t2-paris-17-75017-x${id}`);
    const cases: [number, typeof orig][] = [
      [
        181,
        {
          read: () => {
            throw new Error("lecteur cassé");
          },
        },
      ],
      [182, { read: () => null as unknown as Record<string, never> }],
      [
        183,
        {
          read: orig.read,
          accepts: () => {
            throw new Error("filtre cassé");
          },
        },
      ],
    ];
    try {
      const seen: number[] = [];
      for (const [id, reader] of cases) {
        DETAIL_PARSERS.orpi = reader;
        seen.push(id);
        mockFetch(orpiList(seen.map((x) => item(x))), {
          [url(id)]: new Response(orpiDetail({ price: 1500, priceHC: 1400, chargeReserve: 100 })),
        });
        const r = await runPart(E, [ORPI], NOW);
        expect(r.sources[0], String(id)).toMatchObject({ ok: true });
        expect(await row(String(id)), String(id)).toMatchObject({ alert_status: "pending", rent_cc: 1500 });
        expect((await payload(String(id))).listing, String(id)).toMatchObject({ priceIsCC: null });
        vi.restoreAllMocks();
      }
    } finally {
      DETAIL_PARSERS.orpi = orig;
    }
  });

  it("fiche lue mais aucun champ trouvé (gabarit changé, lecture coupée) : avertissement journalisé, sans secret", async () => {
    await initialized();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch(orpiList([item(191)]), {
      [detailUrl("appartement-t2-paris-17-75017-x191")]: new Response("<html>gabarit inconnu</html>"),
    });
    await runPart(E, [ORPI], NOW);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0].join(" "))).toMatch(/orpi_17 191.*aucun champ/);
    expect(String(warn.mock.calls[0].join(" "))).not.toContain("secret-key");
  });

  it("(f) annonce rejetée sur la liste (parking, loyer hors fourchette, surface < 35 connue) : aucune requête de fiche", async () => {
    await initialized();
    const spy = mockFetch(
      orpiList([item(121, { type: "parking" }), item(122, { price: 2500 }), item(123, { surface: 20 })]),
    );
    await runPart(E, [ORPI], NOW);
    expect(detailCalls(spy)).toEqual([]);
    for (const id of ["121", "122", "123"]) expect((await row(id))!.alert_status).toBe("filtered");
  });

  it("premier passage d'une source (aucune alerte possible, annonces « silent ») : aucune requête de fiche", async () => {
    const spy = mockFetch(orpiList([item(131)]));
    await runPart(E, [ORPI], NOW);
    expect(detailCalls(spy)).toEqual([]);
    expect((await row("131"))!.alert_status).toBe("silent");
  });

  it("passage précédent de la source en échec (sous-lot tué, par exemple au-delà du CPU) : aucune fiche, alerte avec la liste ; fiches de retour ensuite", async () => {
    await env.DB.prepare(
      "INSERT INTO source_state (source, initialized, consecutive_failures) VALUES ('orpi_17', 1, 1)",
    ).run();
    const details = {
      [detailUrl("appartement-t2-paris-17-75017-x161")]: new Response(
        orpiDetail({ price: 1500, priceHC: 1400, chargeReserve: 100 }),
      ),
    };
    const spy = mockFetch(orpiList([item(161)]), details);
    await runPart(E, [ORPI], NOW);
    expect(detailCalls(spy)).toEqual([]);
    expect(await row("161")).toMatchObject({ alert_status: "pending", rent_cc: 1500 });
    expect((await payload("161")).listing).toMatchObject({ priceIsCC: null });
    // Le passage a réussi (compteur remis à 0) : une nouvelle annonce au passage suivant a de nouveau sa fiche.
    spy.mockRestore();
    const spy2 = mockFetch(orpiList([item(161), item(162)]), {
      [detailUrl("appartement-t2-paris-17-75017-x162")]: new Response(
        orpiDetail({ price: 1500, priceHC: 1400, chargeReserve: 100 }),
      ),
    });
    await runPart(E, [ORPI], NOW);
    expect(detailCalls(spy2)).toEqual([detailUrl("appartement-t2-paris-17-75017-x162")]);
  });

  it("lecture de la liste trop lente (moins de 1 s avant la réserve de fin de sous-lot) : aucune fiche, alerte avec la liste", async () => {
    await initialized();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u !== ORPI.url) return new Response(orpiDetail({ price: 1500, priceHC: 1400, chargeReserve: 100 }));
      vi.setSystemTime(Date.now() + 19_500); // 25 s de délai de sous-lot - 5 s de réserve : il reste 0,5 s
      return new Response(orpiList([item(141)]));
    });
    await runPart(E, [ORPI], NOW);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await row("141"))!.alert_status).toBe("pending");
  });

  it("budget de sous-requêtes d'un sous-lot : PART_SIZE sources + MAX_ENRICH_PER_SOURCE fiches chacune, loin des 50", () => {
    expect(PART_SIZE * (1 + MAX_ENRICH_PER_SOURCE)).toBeLessThanOrEqual(10);
  });
});

describe("fetchDetail : lecture bornée", () => {
  it("lit le corps en flux et s'arrête à maxBytes (flux annulé), décodé une fois", async () => {
    let pulls = 0,
      cancelled = false;
    const chunk = new TextEncoder().encode("a".repeat(100_000));
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulls++;
          if (pulls > 10) c.close();
          else c.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    const out = await fetchDetail("https://example.test/fiche", 250_000, "utf-8", 10_000);
    expect(out).toHaveLength(250_000);
    expect(pulls).toBeLessThanOrEqual(4);
    expect(cancelled).toBe(true);
  });

  it("corps d'octets (lecture BYOB readAtLeast) : préfixe exact de maxBytes octets ; page plus courte : page entière", async () => {
    const page = orpiDetailRaw; // 396 Ko, caractères multi-octets compris
    const bytes = new TextEncoder().encode(page);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(bytes));
    expect(await fetchDetail("https://example.test/a", 300_000, "utf-8", 10_000)).toBe(
      new TextDecoder().decode(bytes.subarray(0, 300_000)),
    );
    expect(await fetchDetail("https://example.test/b", 600_000, "utf-8", 10_000)).toBe(page);
  });

  it("page liste : même User-Agent que les fiches", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("<html></html>"));
    await fetchSource(cfg.sources.dedicated[0]!);
    expect(new Headers((spy.mock.calls[0][1] as RequestInit).headers).get("user-agent")).toBe(USER_AGENT);
  });

  it("HTTP différent de 200 ou erreur réseau : null ; le bot se présente (User-Agent du projet, fr-FR)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("non", { status: 404 }));
    expect(await fetchDetail("https://example.test/a", 1000, "utf-8", 10_000)).toBeNull();
    const headers = new Headers((spy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get("user-agent")).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^re-search\/\d.*github\.com/);
    expect(headers.get("accept-language")).toMatch(/^fr-FR/);
    spy.mockRejectedValueOnce(new TypeError("réseau"));
    expect(await fetchDetail("https://example.test/b", 1000, "utf-8", 10_000)).toBeNull();
    spy.mockResolvedValueOnce(new Response("<html>ok</html>"));
    expect(await fetchDetail("https://example.test/c", 1000, "utf-8", 10_000)).toBe("<html>ok</html>");
  });
});

describe("route /test : résultat enrichi des 3 premières annonces gardées, sans écrire en base", () => {
  it("enriched: true et champs réellement modifiés quand la fiche a donné des champs (une seule fiche Orpi)", async () => {
    mockFetch(orpiList([item(151, { type: "parking" }), item(152), item(153)]), {
      [detailUrl("appartement-t2-paris-17-75017-x152")]: new Response(
        orpiDetail({ price: 1500, priceHC: 1400, chargeReserve: 100, zipCode: "75017" }),
      ),
    });
    const res = await worker.fetch(
      new Request("https://x.test/test?source=orpi_17&k=secret-key"),
      E,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      count: number;
      enriched: {
        id: string;
        enriched: boolean;
        fields: string[];
        listing: Record<string, unknown>;
        evaluation: { flags: string[] };
      }[];
    };
    expect(body.count).toBe(3);
    // Orpi : 1 fiche (même plafond qu'un passage) ; fields = champs que la fusion a réellement changés (prix et CP identiques).
    expect(body.enriched.map((e) => [e.id, e.enriched, e.fields])).toEqual([["152", true, ["charges", "priceIsCC"]]]);
    expect(body.enriched[0].listing).toMatchObject({ price: 1500, priceIsCC: true, charges: 100 });
    expect(body.enriched[0].evaluation.flags).not.toContain("charges_inconnues");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM listings").first<{ n: number }>())!.n).toBe(0);
  });
});
