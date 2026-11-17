import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "../src/derive";
import worker from "../src/index";
import { UNIVERSAL_RECHECK_DAYS } from "../src/config/universal";
import { getPendingAlerts } from "../src/process";
import { runPart } from "../src/scan";
import type { Env, SourceDef } from "../src/types";
import { fingerprint, normalizeForFingerprint } from "../src/universal/fingerprint";
import { reduceMarkdown } from "../src/universal/reduce";
import { readUniversal } from "../src/universal/read";
import david from "./fixtures/davidimmo.html?raw";
import { fakeAi, fakeMarkdown, withAi } from "./universal-helpers";

const cfg = settings();

// Lecteur universel économe : empreinte du texte réduit, page inchangée = aucun appel du modèle (docs/lecteur-universel.md).

const E = (o: Partial<Env> = {}): Env => ({
  ...(env as unknown as Env),
  ADMIN_KEY: "k",
  TELEGRAM_BOT_TOKEN: "tok",
  TELEGRAM_CHAT_ID: "42",
  WHATSAPP_ENABLED: "false",
  UNIVERSAL_READER: "true",
  ...o,
});
const SRC: SourceDef = { ...cfg.sources.universal[0], active: true, every: 15 };
const T0 = new Date(Date.UTC(2026, 10, 9, 10, 0));
const plus = (ms: number) => new Date(T0.getTime() + ms);
const H = 3_600_000,
  D = 24 * H;

const ANSWER = {
  listings: [
    {
      url: "/location-appartement-3-pieces-levallois-perret-92300-17461.html",
      title: "Appartement 3 pièces à Levallois-Perret",
      price: 2550,
      price_kind: "CC",
      charges: null,
      surface: 55,
      rooms: 3,
      floor: null,
      address: null,
      postal_code: "92300",
      district: null,
      photo: null,
      property_type: "Appartement",
    },
    {
      url: "/location-appartement-2-pieces-paris-75018-17257.html",
      title: "Appartement 2 pièces Paris 18",
      price: 1521,
      price_kind: "CC",
      charges: null,
      surface: 39,
      rooms: 2,
      floor: null,
      address: null,
      postal_code: "75018",
      district: "Custine-Clignancourt",
      photo: null,
      property_type: "Appartement",
    },
    {
      url: "/location-appartement-1-piece-paris-75018-15287.html",
      title: "Appartement 1 pièce Paris 18 Guy Môquet",
      price: 1349,
      price_kind: "CC",
      charges: null,
      surface: 30.66,
      rooms: 1,
      floor: null,
      address: null,
      postal_code: "75018",
      district: null,
      photo: null,
      property_type: "Appartement",
    },
  ],
  empty: false,
};

const mockPage = (html: string) => vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(html));
const reduced = reduceMarkdown(fakeMarkdown(david));

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM listings"),
    env.DB.prepare("DELETE FROM source_state"),
    env.DB.prepare("DELETE FROM ai_usage"),
    env.DB.prepare("DELETE FROM universal_state"),
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("empreinte du texte réduit", () => {
  it("stable : la même page donne la même empreinte (32 caractères hexadécimaux)", async () => {
    const a = await fingerprint(reduced),
      b = await fingerprint(reduceMarkdown(fakeMarkdown(david)));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("sensible à un vrai changement : prix, surface, lien d'une annonce, annonce de plus, date de disponibilité", async () => {
    const base = await fingerprint(reduced);
    expect(await fingerprint(reduced.replace("2 550 €", "2 450 €"))).not.toBe(base);
    expect(await fingerprint(reduced.replace("30.66", "31.66"))).not.toBe(base);
    expect(await fingerprint(reduced.replace("-17257.html", "-17258.html"))).not.toBe(base);
    expect(await fingerprint(`${reduced}\n---\nStudio Paris 17\n25 m²\n900 € CC\n[Voir](/studio-1.html)`)).not.toBe(
      base,
    );
    expect(await fingerprint(`${reduced}\nLibre le 15/12/2026`)).not.toBe(
      await fingerprint(`${reduced}\nLibre le 20/12/2026`),
    );
  });

  it("insensible aux motifs volatils : compteurs, « il y a », heures, horodatages, mises à jour, jetons de session et de suivi, espaces, ordre des blocs", async () => {
    // Deux lectures de la même page où seule la valeur volatile change (la ligne existe aux deux : seul son nombre ou son heure bouge).
    const pairs: [string, string][] = [
      ["1 234 vues", "1 301 vues"],
      ["87 consultations", "91 consultations"],
      ["Mis à jour il y a 3 heures", "Mis à jour il y a 4 heures"],
      ["Actualisé à 14h32", "Actualisé à 14h47"],
      ["Mise à jour : 09/11/2026", "Mise à jour : 10/11/2026"],
      ["publié hier", "publié aujourd'hui"],
      ["2026-11-09T14:32:05Z", "2026-11-09T14:47:05.120Z"],
      ["Mis à jour le 9.11.26", "Mis à jour le 10.11.26"],
    ];
    for (const [x, y] of pairs)
      expect(
        await fingerprint(`${reduced}
${x}`),
        x,
      ).toBe(
        await fingerprint(`${reduced}
${y}`),
      );
    const link = "](/location-appartement-2-pieces-paris-75018-17257.html";
    const base = await fingerprint(reduced);
    expect(await fingerprint(reduced.replace(link, `${link}?PHPSESSID=abc123def`))).toBe(base);
    expect(await fingerprint(reduced.replace(link, `${link}?utm_source=mail&xtor=AL-1`))).toBe(base);
    expect(await fingerprint(reduced.replace(link, `${link}?id=5&sid=zz&token=a1b2`))).toBe(
      await fingerprint(reduced.replace(link, `${link}?id=5&sid=yy&token=c3d4`)),
    );
    expect(await fingerprint(reduced.replace(/ /g, "  \t "))).toBe(base); // espaces
    expect(await fingerprint(reduced.split("\n---\n").reverse().join("\n---\n"))).toBe(base); // ordre des blocs
    expect(normalizeForFingerprint("Prix 1 350 € / 2 550 €")).toBe(normalizeForFingerprint("prix 1 350 € / 2 550 €"));
    // Un paramètre qui n'est pas du bruit reste : deux annonces dont seul l'identifiant du lien diffère sont deux annonces.
    expect(await fingerprint(reduced.replace(link, `${link}?id=5`))).not.toBe(
      await fingerprint(reduced.replace(link, `${link}?id=6`)),
    );
  });
});

describe("lecture : page inchangée, changée, cas de robustesse", () => {
  it("page inchangée : aucun appel du modèle, mêmes annonces, neurons évités chiffrés ; page changée : appel, puis de nouveau inchangée", async () => {
    mockPage(david);
    const ai = fakeAi(ANSWER);
    const r1 = await readUniversal(withAi(E(), ai), SRC, { now: T0 });
    expect(r1).toMatchObject({ status: "ok" });
    expect(r1.status === "ok" && r1.unchanged).toBeUndefined();
    expect(ai.run).toHaveBeenCalledTimes(1);
    const cost = r1.status === "ok" ? (r1.neurons ?? 0) : 0;
    expect(cost).toBeGreaterThan(30);
    expect(cost).toBeLessThan(55);

    const r2 = await readUniversal(withAi(E(), ai), SRC, { now: plus(15 * 60_000) });
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(r2).toMatchObject({ status: "ok", unchanged: true, savedNeurons: cost });
    expect(r2.status === "ok" && r2.listings).toEqual(r1.status === "ok" ? r1.listings : null);

    // Une annonce change de prix sur la page : le modèle est rappelé, l'empreinte mise à jour.
    mockPage(david.replace("2 550", "2 450"));
    const ai2 = fakeAi({
      listings: [{ ...ANSWER.listings[0], price: 2450 }, ANSWER.listings[1], ANSWER.listings[2]],
      empty: false,
    });
    const r3 = await readUniversal(withAi(E(), ai2), SRC, { now: plus(30 * 60_000) });
    expect(ai2.run).toHaveBeenCalledTimes(1);
    expect(r3).toMatchObject({ status: "ok" });
    expect(r3.status === "ok" && r3.unchanged).toBeUndefined();
    expect(await readUniversal(withAi(E(), ai2), SRC, { now: plus(45 * 60_000) })).toMatchObject({
      status: "ok",
      unchanged: true,
    });
    expect(ai2.run).toHaveBeenCalledTimes(1);
  });

  it("bruit sur la page (compteur de vues, jeton de session) : toujours inchangée", async () => {
    const ai = fakeAi(ANSWER);
    const noisy = (views: string, ago: string, sid: string) =>
      david
        .replace("</body>", `<div>${views} vues</div><div>Mis à jour il y a ${ago}</div></body>`)
        .replaceAll('.html"', `.html?PHPSESSID=${sid}"`);
    mockPage(noisy("3 412", "2 heures", "aaa111"));
    await readUniversal(withAi(E(), ai), SRC, { now: T0 });
    mockPage(noisy("3 498", "3 heures", "bbb222"));
    const r = await readUniversal(withAi(E(), ai), SRC, { now: plus(15 * 60_000) });
    expect(r).toMatchObject({ status: "ok", unchanged: true });
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it("page vide ou cassée après un stock : jamais « inchangée » (échec comme avant), et le retour de la page donne de nouveau « inchangée »", async () => {
    const ai = fakeAi(ANSWER);
    mockPage(david);
    await readUniversal(withAi(E(), ai), SRC, { now: T0 });
    mockPage("<html><body><h1>Maintenance</h1></body></html>");
    expect(await readUniversal(withAi(E(), ai), SRC, { now: plus(15 * 60_000) })).toEqual({
      status: "fail",
      reason: "aucune annonce dans la page",
    });
    expect(ai.run).toHaveBeenCalledTimes(1);
    // Le stock mémorisé n'a pas été écrasé par l'échec.
    mockPage(david);
    expect(await readUniversal(withAi(E(), ai), SRC, { now: plus(30 * 60_000) })).toMatchObject({
      status: "ok",
      unchanged: true,
    });
  });

  it("texte réduit trop court : jamais « inchangé » même à empreinte identique, si la lecture précédente avait des annonces", async () => {
    const short = "Studio 20 m²\n500 € CC";
    expect(reduceMarkdown(short).length).toBeLessThan(100);
    await env.DB.prepare(
      "INSERT INTO universal_state (source, fingerprint, listings, count, neurons, read_at) VALUES (?, ?, ?, 1, 40, ?)",
    )
      .bind(SRC.id, await fingerprint(reduceMarkdown(short)), JSON.stringify([{ id: "x" }]), T0.toISOString())
      .run();
    mockPage(`<html><body><p>${short.replace("\n", "</p><p>")}</p></body></html>`);
    const ai = fakeAi(ANSWER);
    const r = await readUniversal(withAi(E(), ai), SRC, { now: plus(15 * 60_000) });
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(r.status === "ok" && r.unchanged).toBeFalsy();
  });

  it("lecture précédente sans annonce : jamais réutilisée", async () => {
    await env.DB.prepare(
      "INSERT INTO universal_state (source, fingerprint, listings, count, neurons, read_at) VALUES (?, ?, '[]', 0, 40, ?)",
    )
      .bind(SRC.id, await fingerprint(reduced), T0.toISOString())
      .run();
    mockPage(david);
    const ai = fakeAi(ANSWER);
    expect(await readUniversal(withAi(E(), ai), SRC, { now: plus(15 * 60_000) })).toMatchObject({
      status: "ok",
      listings: expect.any(Array),
    });
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it(`filet : une page inchangée depuis plus de ${UNIVERSAL_RECHECK_DAYS} jours est relue par le modèle`, async () => {
    const ai = fakeAi(ANSWER);
    mockPage(david);
    await readUniversal(withAi(E(), ai), SRC, { now: T0 });
    expect(
      await readUniversal(withAi(E(), ai), SRC, { now: plus((UNIVERSAL_RECHECK_DAYS * 24 - 1) * H) }),
    ).toMatchObject({ unchanged: true });
    expect(ai.run).toHaveBeenCalledTimes(1);
    const r = await readUniversal(withAi(E(), ai), SRC, { now: plus(UNIVERSAL_RECHECK_DAYS * D + H) });
    expect(ai.run).toHaveBeenCalledTimes(2);
    expect(r.status === "ok" && r.unchanged).toBeUndefined();
    // La relecture rafraîchit la date : le jour suivant, de nouveau inchangée.
    expect(await readUniversal(withAi(E(), ai), SRC, { now: plus((UNIVERSAL_RECHECK_DAYS + 1) * D) })).toMatchObject({
      unchanged: true,
    });
  });

  it("budget épuisé : page inchangée = lecture « ok » sans neurons ; page changée = « skipped » ; sans lecture mémorisée = « skipped » avant toute requête", async () => {
    const ai = fakeAi(ANSWER);
    const spy = mockPage(david);
    await readUniversal(withAi(E(), ai), SRC, { now: T0 });
    await env.DB.prepare("UPDATE ai_usage SET neurons = ?").bind(cfg.ai.featureCaps.universal).run();
    expect(await readUniversal(withAi(E(), ai), SRC, { now: plus(15 * 60_000) })).toMatchObject({
      status: "ok",
      unchanged: true,
    });
    mockPage(david.replace("2 550", "2 450"));
    expect(await readUniversal(withAi(E(), ai), SRC, { now: plus(30 * 60_000) })).toEqual({
      status: "skipped",
      reason: "budget IA épuisé",
    });
    expect(ai.run).toHaveBeenCalledTimes(1);
    await env.DB.prepare("DELETE FROM universal_state").run();
    spy.mockClear();
    expect(await readUniversal(withAi(E(), ai), SRC, { now: plus(45 * 60_000) })).toEqual({
      status: "skipped",
      reason: "budget IA épuisé",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rendu navigateur : cadence d'au moins 30 min (le rendu a lieu même si la page est inchangée)", async () => {
    const ai = fakeAi(ANSWER);
    expect(
      await readUniversal(withAi(E({ BROWSER_RENDER: "true" }), ai), { ...SRC, render: "browser", every: 15 }),
    ).toEqual({ status: "fail", reason: "cadence du rendu navigateur inférieure à 30 min" });
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("persist: false (/test) n'écrit rien ; force relit par le modèle malgré une empreinte identique", async () => {
    const ai = fakeAi(ANSWER);
    mockPage(david);
    await readUniversal(withAi(E(), ai), SRC, { now: T0, persist: false });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM universal_state").first<{ n: number }>())!.n).toBe(0);
    await readUniversal(withAi(E(), ai), SRC, { now: T0 });
    expect(await readUniversal(withAi(E(), ai), SRC, { now: plus(60_000), force: true })).toMatchObject({
      status: "ok",
    });
    expect(ai.run).toHaveBeenCalledTimes(3);
  });

  it("/test?source= : unchanged et neurons évités (sans écriture ; force=1 relit)", async () => {
    mockPage(david);
    const ai = fakeAi(ANSWER);
    const e = withAi(E(), ai);
    await readUniversal(e, SRC); // état mémorisé par un passage du cron
    const call = async (q: string) =>
      (
        await worker.fetch(new Request(`https://x.test/test?source=david_immo&k=k${q}`), e, createExecutionContext())
      ).json() as Promise<{ count: number; unchanged: boolean; savedNeurons: number; neurons: number }>;
    const unchanged = await call("");
    expect(unchanged).toMatchObject({ count: 3, unchanged: true });
    expect(unchanged.savedNeurons).toBeGreaterThan(30);
    expect(ai.run).toHaveBeenCalledTimes(1);
    const forced = await call("&force=1");
    expect(forced).toMatchObject({ count: 3, unchanged: false, savedNeurons: 0 });
    expect(forced.neurons).toBeGreaterThan(30);
    expect(ai.run).toHaveBeenCalledTimes(2);
  });
});

describe("dans le passage (runPart) : une page inchangée se comporte comme une page relue", () => {
  // Deux annonces gardées par le filtre (Levallois, loyers et surfaces dans la cible), lues sur la page David Immo adaptée.
  const URL_A = "/location-appartement-2-pieces-levallois-perret-92300-99999.html",
    URL_B = "/location-appartement-2-pieces-levallois-perret-92300-88888.html";
  const page = david
    .replaceAll("/location-appartement-1-piece-paris-75018-15287.html", URL_A)
    .replaceAll("30.66", "41")
    .replaceAll("/location-appartement-2-pieces-paris-75018-17257.html", URL_B);
  const A = { ...ANSWER.listings[2], url: URL_A, surface: 41, rooms: 2, postal_code: "92300" };
  const B = { ...ANSWER.listings[1], url: URL_B, postal_code: "92300" };
  const kept = async () =>
    (
      await env.DB.prepare(
        "SELECT listing_id, gone_at, last_seen, alert_status FROM listings WHERE source = ? AND alert_status != 'filtered'",
      )
        .bind(SRC.id)
        .all<{ listing_id: string; gone_at: string | null; last_seen: string | null; alert_status: string }>()
    ).results;

  it("zéro appel du modèle, aucune disparition, aucune alerte, santé inchangée ; le rapport porte unchanged et les neurons évités", async () => {
    mockPage(page);
    const ai = fakeAi({ listings: [A, B], empty: false });
    const e = withAi(E(), ai);
    const r1 = await runPart(e, [SRC], T0);
    expect(r1.sources[0]).toMatchObject({ ok: true, count: 2 });
    expect(r1.sources[0].unchanged).toBeUndefined();
    expect(r1.sources[0].neurons).toBeGreaterThan(30);
    expect(await kept()).toHaveLength(2);
    // Plus de deux jours de passages sur la même page, bien au-delà de GONE_AFTER_HOURS (12 h) : rien ne disparaît.
    for (const t of [plus(15 * 60_000), plus(6 * H), plus(13 * H), plus(26 * H), plus(2 * D)]) {
      const r = await runPart(e, [SRC], t);
      expect(r.events).toEqual([]);
      expect(r.sources[0]).toMatchObject({ ok: true, count: 2, unchanged: true });
      expect(r.sources[0].savedNeurons).toBeGreaterThan(30);
    }
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(await getPendingAlerts(env.DB, 10)).toHaveLength(0);
    for (const row of await kept()) {
      expect(row.gone_at).toBeNull();
      expect(row.alert_status).toBe("silent");
      expect(row.last_seen).toBe(plus(2 * D).toISOString()); // présence rafraîchie comme après une vraie relecture
    }
    const st = await env.DB.prepare("SELECT consecutive_failures, broken, last_run FROM source_state WHERE source = ?")
      .bind(SRC.id)
      .first<{ consecutive_failures: number; broken: number; last_run: string }>();
    expect(st).toMatchObject({ consecutive_failures: 0, broken: 0, last_run: plus(2 * D).toISOString() });
  });

  it("page changée : le modèle est appelé, une annonce retirée de la page disparaît normalement, une nouvelle alerte part", async () => {
    mockPage(page);
    await runPart(withAi(E(), fakeAi({ listings: [A, B], empty: false })), [SRC], T0);
    const idle = fakeAi({ listings: [A, B], empty: false });
    await runPart(withAi(E(), idle), [SRC], plus(15 * 60_000));
    expect(idle.run).not.toHaveBeenCalled();
    // B est retirée de la page : le modèle est rappelé (la page a changé) et ne rend plus que A.
    mockPage(page.replaceAll(URL_B, "/x.html").replaceAll("1 521", "0 000"));
    const ai2 = fakeAi({ listings: [A], empty: false });
    await runPart(withAi(E(), ai2), [SRC], plus(20 * H));
    const r = await runPart(withAi(E(), ai2), [SRC], plus(21 * H));
    expect(ai2.run).toHaveBeenCalledTimes(1);
    expect(r.sources[0]).toMatchObject({ ok: true, count: 1, unchanged: true });
    const rows = await kept();
    expect(rows.filter((x) => x.gone_at !== null).map((x) => x.listing_id)).toEqual([expect.stringContaining("88888")]);
  });
});
