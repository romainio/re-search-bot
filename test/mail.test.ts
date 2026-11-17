import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_MAX_BYTES } from "../src/config/mail";
import { TOTAL_GROUPS } from "../src/config/schedule";
import { renderDashboard } from "../src/dashboard/render";
import { settings } from "../src/derive";
import { detectStale, staleMinutes } from "../src/health";
import worker from "../src/index";
import { handleMail } from "../src/mail/handler";
import type { MailMessage } from "../src/mail/handler";
import { htmlToText } from "../src/mail/html";
import { parseCardText, readMailCards } from "../src/mail/readers";
import { addressOf, domainOf, MAIL_SENDERS, senderFor } from "../src/mail/senders";
import { getPendingAlerts } from "../src/process";
import { groupParts, parsePartRequest } from "../src/scan";
import type { Env } from "../src/types";
import lbc from "./fixtures/mail/leboncoin-alerte.html?raw";
import pap from "./fixtures/mail/pap-alerte.html?raw";
import selogerConfirm from "./fixtures/mail/seloger-confirmation.html?raw";
import seloger from "./fixtures/mail/seloger-alerte.html?raw";
import { fakeAi, withAi } from "./universal-helpers";

const cfg = settings();

// Les mails sont SYNTHÉTIQUES (test/fixtures/mail/*.html : structure publique des mails d'alerte des portails, pas de vrais mails).

const E = (o: Partial<Env> = {}): Env => ({
  ...(env as unknown as Env),
  TELEGRAM_BOT_TOKEN: "tok",
  TELEGRAM_CHAT_ID: "42",
  WHATSAPP_ENABLED: "false",
  MAIL_INGEST: "true",
  ...o,
});
const AUTH_OK =
  "mx.cloudflare.net; spf=pass smtp.mailfrom=bounce.seloger.com; dkim=pass header.d=seloger.com; dmarc=pass header.from=seloger.com";
const at = (h: number, m: number, d = 9) => new Date(Date.UTC(2026, 10, d, h, m));

/** Quoted-printable (RFC 2045) : octets hors ASCII et « = » codés, lignes coupées à 72 caractères par « = » final. */
function qp(s: string): string {
  const out: string[] = [];
  for (const line of s.split("\n")) {
    let enc = "";
    for (const b of new TextEncoder().encode(line))
      enc += b === 0x3d || b > 126 ? `=${b.toString(16).toUpperCase().padStart(2, "0")}` : String.fromCharCode(b);
    while (enc.length > 72) {
      let cut = 72;
      if (enc[cut - 1] === "=" || enc[cut - 2] === "=") cut = enc[cut - 1] === "=" ? cut - 1 : cut - 2;
      out.push(`${enc.slice(0, cut)}=`);
      enc = enc.slice(cut);
    }
    out.push(enc);
  }
  return out.join("\r\n");
}

interface MailOpts {
  from?: string;
  subject?: string;
  html?: string;
  text?: string;
  auth?: string | null;
  qp?: boolean;
  size?: number;
}
type TestMail = MailMessage & { setReject: ReturnType<typeof vi.fn> & ((reason: string) => void) };
function mail(o: MailOpts = {}): TestMail {
  const from = o.from ?? "SeLoger <alertes@mail.seloger.com>";
  const B = "BOUNDARY42";
  const parts: string[] = [];
  if (o.text !== undefined)
    parts.push(
      `--${B}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: ${o.qp ? "quoted-printable" : "8bit"}\r\n\r\n${o.qp ? qp(o.text) : o.text}`,
    );
  if (o.html !== undefined)
    parts.push(
      `--${B}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: ${o.qp ? "quoted-printable" : "8bit"}\r\n\r\n${o.qp ? qp(o.html) : o.html}`,
    );
  const head = [
    `From: ${from}`,
    "To: alertes@exemple.test",
    `Subject: ${o.subject ?? "Nouvelles annonces"}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${B}"`,
  ];
  const raw = `${head.join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n--${B}--\r\n`;
  const bytes = new TextEncoder().encode(raw);
  const headers = new Headers({ from, subject: o.subject ?? "Nouvelles annonces" });
  if (o.auth !== null) headers.append("authentication-results", o.auth ?? AUTH_OK);
  return {
    from: "bounce@x.test",
    headers,
    raw: new Response(bytes).body!,
    rawSize: o.size ?? bytes.length,
    setReject: vi.fn() as unknown as TestMail["setReject"],
  };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM listings"),
    env.DB.prepare("DELETE FROM source_state"),
    env.DB.prepare("DELETE FROM ai_usage"),
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("liste blanche d'expéditeurs", () => {
  it("adresse lue dans l'en-tête From ; domaine exact ou sous-domaine ; domaines qui ressemblent seulement refusés", () => {
    expect(addressOf('"SeLoger" <Alertes@Mail.SeLoger.com>')).toBe("alertes@mail.seloger.com");
    expect(addressOf("a@b.fr")).toBe("a@b.fr");
    expect(addressOf(null)).toBeNull();
    expect(domainOf("x@seloger.com")).toBe("seloger.com");
    expect(senderFor("alertes@seloger.com")?.key).toBe("seloger");
    expect(senderFor("no-reply@mail.seloger.com")?.key).toBe("seloger");
    expect(senderFor("x@alerte.pap.fr")?.key).toBe("pap");
    expect(senderFor("x@seloger.com.evil.fr")).toBeNull();
    expect(senderFor("x@notseloger.com")).toBeNull();
    expect(senderFor("x@gmail.com")).toBeNull();
    expect(senderFor(null)).toBeNull();
  });

  it("les cinq portails sont autorisés ; une agence s'ajoute avec une ligne (source virtuelle mail_<clé> au registre)", () => {
    expect(MAIL_SENDERS.map((s) => s.key)).toEqual(["seloger", "leboncoin", "bienici", "pap", "logicimmo"]);
    const extra = [
      ...MAIL_SENDERS,
      { key: "agencex", name: "Agence X", domains: ["agence-x.fr"], home: "https://agence-x.fr/" },
    ];
    expect(senderFor("alerte@agence-x.fr", extra)?.key).toBe("agencex");
    expect(senderFor("alerte@agence-x.fr")).toBeNull();
    expect(cfg.sources.mail.map((s) => s.id)).toEqual(MAIL_SENDERS.map((s) => `mail_${s.key}`));
    expect(cfg.sources.mail.every((s) => s.active && s.virtual && s.parser === "mail")).toBe(true);
  });
});

describe("handler email : garde-fous", () => {
  it("interrupteur MAIL_INGEST éteint : mail ignoré SANS rejet (un rejet ferait désabonner l'adresse), rien lu ni écrit", async () => {
    const m = mail({ html: seloger });
    expect(await handleMail(m, E({ MAIL_INGEST: "false" }))).toBe("off");
    expect(await handleMail(m, E({ MAIL_INGEST: undefined }))).toBe("off");
    expect(m.setReject).not.toHaveBeenCalled();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM listings").first<{ n: number }>())!.n).toBe(0);
  });

  it("expéditeur hors liste blanche : rejeté (setReject) ; dmarc non réussi ou absent : rejeté ; aucune lecture du MIME", async () => {
    const ai = fakeAi({ listings: [] });
    const e = withAi(E(), ai);
    const stranger = mail({ from: "Pub <promo@gmail.com>", html: seloger });
    expect(await handleMail(stranger, e)).toBe("rejected");
    expect(stranger.setReject).toHaveBeenCalledTimes(1);
    const lookalike = mail({ from: "x@seloger.com.evil.fr", html: seloger });
    expect(await handleMail(lookalike, e)).toBe("rejected");
    for (const auth of [
      "mx.cloudflare.net; dmarc=fail",
      "mx.cloudflare.net; spf=pass; dkim=pass",
      "evil.example; dmarc=pass",
      null,
    ]) {
      const m = mail({ html: seloger, auth });
      expect(await handleMail(m, e), String(auth)).toBe("rejected");
      expect(m.setReject).toHaveBeenCalledTimes(1);
    }
    // En-tête d'authentification fourni par l'expéditeur (ajouté après celui de Cloudflare) : seul le premier de mx.cloudflare.net compte.
    const forged = mail({ html: seloger, auth: "mx.cloudflare.net; dmarc=fail" });
    forged.headers.append("authentication-results", "mx.cloudflare.net; dmarc=pass");
    expect(await handleMail(forged, e)).toBe("rejected");
    expect(ai.run).not.toHaveBeenCalled();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM listings").first<{ n: number }>())!.n).toBe(0);
  });

  it("mail trop gros : accepté et ignoré (jamais rejeté) ; mail sans annonce (confirmation d'abonnement) : accepté, aucune écriture, aucun appel modèle", async () => {
    const big = mail({ html: seloger, size: MAIL_MAX_BYTES + 1 });
    expect(await handleMail(big, E())).toBe("ignored");
    expect(big.setReject).not.toHaveBeenCalled();
    const ai = fakeAi({ listings: [] });
    const conf = mail({ html: selogerConfirm, text: "Votre alerte est créée." });
    expect(await handleMail(conf, withAi(E(), ai))).toBe("no_listing");
    expect(conf.setReject).not.toHaveBeenCalled();
    expect(ai.run).not.toHaveBeenCalled();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM listings").first<{ n: number }>())!.n).toBe(0);
  });

  it("MIME illisible : ignoré sans exception", async () => {
    const m = mail({ html: seloger });
    const broken: MailMessage = {
      ...m,
      raw: new ReadableStream({
        start(c) {
          c.error(new Error("flux coupé"));
        },
      }),
    };
    expect(await handleMail(broken, E())).toBe("ignored");
  });

  it("export email du Worker : appelable, sans effet quand l'interrupteur est éteint", async () => {
    const m = mail({ html: seloger });
    const ctx = createExecutionContext();
    await worker.email!(m as unknown as ForwardableEmailMessage, E({ MAIL_INGEST: "false" }), ctx);
    await waitOnExecutionContext(ctx);
    expect(m.setReject).not.toHaveBeenCalled();
    const bad = mail({ from: "x@gmail.com", html: seloger });
    await worker.email!(bad as unknown as ForwardableEmailMessage, E(), ctx);
    expect(bad.setReject).toHaveBeenCalledTimes(1);
  });
});

describe("lecture des mails d'alerte", () => {
  it("lecteur déterministe SeLoger (texte et HTML en quoted-printable) : deux annonces, identifiant = URL sans paramètres de suivi, aucun appel modèle", async () => {
    const ai = fakeAi({ listings: [] });
    const html = seloger;
    expect(readMailCards(MAIL_SENDERS[0], html)).toHaveLength(2);
    const m = mail({ text: "2 nouvelles annonces", html, qp: true });
    expect(await handleMail(m, withAi(E(), ai), at(10, 0))).toBe("ingested");
    expect(ai.run).not.toHaveBeenCalled();
    const rows = await env.DB.prepare(
      "SELECT source, listing_id, alert_status, alert_kind, rent_cc, surface, postal_code FROM listings ORDER BY listing_id",
    ).all();
    expect(rows.results).toEqual([
      {
        source: "mail_seloger",
        listing_id: "https://www.seloger.com/annonces/locations/appartement/levallois-perret-92/987654321.htm",
        alert_status: "silent",
        alert_kind: null,
        rent_cc: 1480,
        surface: 61,
        postal_code: "92300",
      },
      {
        source: "mail_seloger",
        listing_id: "https://www.seloger.com/annonces/locations/appartement/paris-17eme-75/batignolles/123456789.htm",
        alert_status: "silent",
        alert_kind: null,
        rent_cc: 1350,
        surface: 42,
        postal_code: "75017",
      },
    ]);
    const l = readMailCards(MAIL_SENDERS[0], html)[0];
    expect(l).toMatchObject({
      price: 1350,
      priceIsCC: true,
      charges: null,
      surface: 42,
      rooms: 2,
      postalCode: "75017",
      agency: "SeLoger (alerte mail)",
    });
    expect(readMailCards(MAIL_SENDERS[0], html)[1]).toMatchObject({
      price: 1480,
      priceIsCC: false,
      rooms: 3,
      postalCode: "92300",
    });
  });

  it("disposition « texte puis bouton » (PAP) : le texte de chaque carte est celui qui précède son lien", () => {
    const cards = readMailCards(MAIL_SENDERS.find((s) => s.key === "pap")!, pap);
    expect(cards.map((c) => [c.id, c.price, c.surface, c.rooms, c.priceIsCC, c.postalCode])).toEqual([
      ["https://www.pap.fr/annonces/appartement-paris-17e-r471852236", 1190, 38, 2, true, "75017"],
      ["https://www.pap.fr/annonces/appartement-paris-17e-r471900112", 1560, 55, 3, true, "75017"],
    ]);
  });

  it("format inconnu (liens de suivi) : lecteur universel sur le HTML du mail (Markdown puis modèle), dépense inscrite sous la fonction `mail`", async () => {
    const ai = fakeAi({
      listings: [
        {
          url: "https://email.leboncoin.fr/c/xyz123abc",
          title: "Appartement 2 pièces lumineux",
          price: 1290,
          price_kind: "CC",
          charges: null,
          surface: 44,
          rooms: 2,
          floor: null,
          address: null,
          postal_code: "75017",
          district: null,
          photo: null,
          property_type: "Appartement",
        },
      ],
      empty: false,
    });
    expect(readMailCards(MAIL_SENDERS[1], lbc)).toEqual([]);
    expect(
      await handleMail(mail({ from: "Leboncoin <alerte@mail.leboncoin.fr>", html: lbc }), withAi(E(), ai), at(10, 0)),
    ).toBe("ingested");
    expect(ai.toMarkdown).toHaveBeenCalledTimes(1);
    expect(ai.run).toHaveBeenCalledTimes(1);
    const row = await env.DB.prepare("SELECT feature, calls FROM ai_usage").first<{ feature: string; calls: number }>();
    expect(row).toEqual({ feature: "mail", calls: 1 });
    const l = await env.DB.prepare("SELECT source, listing_id FROM listings").first<{
      source: string;
      listing_id: string;
    }>();
    expect(l).toEqual({ source: "mail_leboncoin", listing_id: "https://email.leboncoin.fr/c/xyz123abc" });
  });

  it("mail sans HTML (texte seul) : lecteur universel sur le texte ; conversion Markdown absente : repli sur le texte de l'HTML", async () => {
    const answer = {
      listings: [
        {
          url: null,
          title: "Appartement 2 pièces lumineux",
          price: 1290,
          price_kind: "CC",
          charges: null,
          surface: 44,
          rooms: 2,
          floor: null,
          address: null,
          postal_code: "75017",
          district: null,
          photo: null,
          property_type: null,
        },
      ],
      empty: false,
    };
    const text =
      "Nouvelle annonce\nAppartement 2 pièces lumineux, 44 m²\n1 290 € / mois, charges comprises\nParis 17ème (75017)";
    const ai = fakeAi(answer);
    expect(await handleMail(mail({ from: "alerte@bienici.com", text }), withAi(E(), ai), at(10, 0))).toBe("ingested");
    expect(ai.toMarkdown).not.toHaveBeenCalled();
    const noConv = fakeAi(answer);
    const e = withAi(E(), { run: noConv.run } as unknown as ReturnType<typeof fakeAi>);
    await env.DB.prepare("DELETE FROM listings").run();
    expect(
      await handleMail(
        mail({
          from: "alerte@bienici.com",
          html: `<p>Nouvelle annonce</p><p>Appartement 2 pièces lumineux, 44 m²</p><p>1 290 &euro; / mois, charges comprises</p><p>Paris 17ème (75017)</p>`,
        }),
        e,
        at(10, 0),
      ),
    ).toBe("ingested");
    expect(noConv.run).toHaveBeenCalledTimes(1);
    expect(htmlToText("<p>a&nbsp;b</p><p>1&nbsp;290&nbsp;&euro;</p>")).toBe("a b\n1 290 €");
  });

  it("IA absente ou budget épuisé : le mail au format inconnu est accepté sans annonce, jamais rejeté", async () => {
    const m = mail({ from: "Leboncoin <alerte@mail.leboncoin.fr>", html: lbc });
    expect(await handleMail(m, E(), at(10, 0))).toBe("no_listing");
    expect(m.setReject).not.toHaveBeenCalled();
  });

  it("parseCardText : prix, CC/HC, charges, surface, pièces, code postal ; sans prix plausible, rien", () => {
    expect(parseCardText("Studio 24 m²\n980 € HC charges : 60 €\nParis 17ème")).toMatchObject({
      price: 980,
      priceIsCC: false,
      charges: 60,
      surface: 24,
      rooms: 1,
      postalCode: "75017",
    });
    expect(parseCardText("3 pièces 61,5 m²\n1 480 € CC")).toMatchObject({
      price: 1480,
      priceIsCC: true,
      surface: 61.5,
      rooms: 3,
    });
    expect(parseCardText("Abonnement à 9 €")).toBeNull();
    expect(parseCardText("Parking 120 000 €")).toBeNull();
  });
});

describe("entrée dans le circuit normal (process)", () => {
  it("premier mail d'un expéditeur silencieux (stock en cours), la nouvelle annonce du second mail devient une alerte ; une annonce déjà vue n'alerte pas", async () => {
    expect(await handleMail(mail({ html: seloger }), E(), at(10, 0))).toBe("ingested");
    expect(await getPendingAlerts(env.DB, 10)).toHaveLength(0);
    // Second mail : l'annonce de Paris 17 revient (déjà connue) et une nouvelle arrive (autre numéro, 1 290 € CC, 40 m², 2 pièces).
    const second = seloger
      .replaceAll("123456789", "555555555")
      .replaceAll("1&nbsp;350&nbsp;&euro; CC", "1&nbsp;290&nbsp;&euro; CC")
      .replaceAll("42 m²", "40 m²");
    expect(await handleMail(mail({ html: second }), E(), at(11, 0))).toBe("ingested");
    const pending = await getPendingAlerts(env.DB, 10);
    expect(pending.map((p) => [p.source, p.listing.id, p.listing.price])).toEqual([
      [
        "mail_seloger",
        "https://www.seloger.com/annonces/locations/appartement/paris-17eme-75/batignolles/555555555.htm",
        1290,
      ],
    ]);
    // Troisième mail identique au second : rien de nouveau.
    expect(await handleMail(mail({ html: second }), E(), at(12, 0))).toBe("ingested");
    expect(await getPendingAlerts(env.DB, 10)).toHaveLength(1);
  });

  it("l'alerte part par le circuit habituel (Telegram), avec le nom de la source mail", async () => {
    await handleMail(mail({ html: seloger }), E(), at(10, 0));
    const second = seloger.replaceAll("123456789", "555555555");
    await handleMail(mail({ html: second }), E(), at(11, 0));
    const tg = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })));
    const { sendPendingAlerts } = await import("../src/notify/send");
    const r = await sendPendingAlerts(E(), cfg.sources.all, at(11, 5));
    expect(r.sent).toBe(1);
    expect(JSON.stringify(tg.mock.calls)).toContain("SeLoger (alerte mail)");
  });
});

describe("source mail : jamais en panne ni en retard", () => {
  it("aucune ligne de santé, aucun last_run : detectStale ne la signale jamais, même en pleine fenêtre active et des jours après le dernier mail", async () => {
    await handleMail(mail({ html: seloger }), E(), at(10, 0, 2));
    const st = await env.DB.prepare("SELECT * FROM source_state WHERE source = 'mail_seloger'").first<{
      initialized: number;
      last_run: string | null;
      broken: number;
      consecutive_failures: number;
    }>();
    expect(st).toMatchObject({ initialized: 1, last_run: null, broken: 0, consecutive_failures: 0 });
    expect(await detectStale(env.DB, cfg.sources.all, at(12, 0))).toEqual([]);
    expect(staleMinutes(st!.last_run, at(12, 0))).toBeNull();
    // Même avec un last_run ancien posé à la main, une source virtuelle n'est jamais jugée : elle n'est pas dans les sources lues.
    await env.DB.prepare("UPDATE source_state SET last_run = ? WHERE source = 'mail_seloger'")
      .bind(at(8, 0, 1).toISOString())
      .run();
    expect(
      await detectStale(
        env.DB,
        cfg.sources.all.filter((s) => !s.virtual),
        at(12, 0),
      ),
    ).toEqual([]);
  });

  it("hors des groupes et des sous-lots /part ; tableau de bord : « Par mail », ni « En retard », ni « En panne », ni « Jamais lue »", async () => {
    expect(
      Array.from({ length: TOTAL_GROUPS }, (_, g) => groupParts(g))
        .flat()
        .flat()
        .some((id) => id.startsWith("mail_")),
    ).toBe(false);
    expect(parsePartRequest({ ids: ["mail_seloger"], now: new Date().toISOString() })).toBeNull();
    const html = await renderDashboard(env.DB, cfg.sources.all, at(12, 0), new URLSearchParams());
    const row = html.match(/<tr><td>SeLoger \(alerte mail\)<\/td><td>(.*?)<\/td>/)![1];
    expect(row).toContain("Par mail");
    expect(row).not.toMatch(/retard|panne|Jamais/);
  });
});
