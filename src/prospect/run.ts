import { USER_AGENT } from "../config/fetch";
import {
  PROSPECT_AI_TEXT_MAX,
  PROSPECT_INTERVAL_DAYS,
  PROSPECT_LEASE_MS,
  PROSPECT_MAX_STEP_FAILURES,
  PROSPECT_PAGES_PER_STEP,
  PROSPECT_SITE_MAX_BYTES,
  PROSPECT_SITE_TIMEOUT_MS,
  PROSPECT_SITES_PER_STEP,
  PROSPECT_STEP_BUDGET,
  PROSPECT_TELEGRAM_LIMIT,
} from "../config/prospect";
import { settings } from "../derive";
import { esc } from "../html";
import { sendTelegramMessage } from "../notify/send";
import { readBody } from "../read-body";
import type { Env, SourceDef } from "../types";
import { classifyRental, prospectAiOn, prospectOn } from "./ai";
import { fetchEntreprisesPage, fetchOverpass } from "./apis";
import { inRegistry, sameAgency } from "./match";
import { detectTemplate, pageText } from "./template";
import { TEMPLATE_NO_SITE, TEMPLATE_UNKNOWN } from "./types";
import type { Candidate } from "./types";
import { errMsg } from "../guards";
import { DAY_MS } from "../time";

/**
 * Prospection des agences par pas reprenables : entreprises (API Recherche d'entreprises) -> osm (Overpass) -> sites (gabarit et
 * verdict) -> fin (message Telegram) -> repos. L'état est en D1 : chaque pas relit son curseur, fait au plus
 * PROSPECT_STEP_BUDGET sous-requêtes et enregistre la suite, sous un bail. Un pas en échec laisse le curseur.
 */
export type Phase = "entreprises" | "osm" | "sites" | "fin" | "repos";
const NEXT: Record<Phase, Phase> = { entreprises: "osm", osm: "sites", sites: "fin", fin: "repos", repos: "repos" };

interface State {
  phase: Phase;
  cursor: { z?: number; p?: number };
  started_at: string;
  finished_at: string | null;
  lease_until: string | null;
  failures: number;
}

export interface StepReport {
  enabled: boolean;
  /** "pas" (travail fait), "repos" (rien avant la prochaine campagne), "occupé" (un autre pas tient le bail), "éteint". */
  result: "pas" | "repos" | "occupé" | "éteint";
  phase?: Phase;
  subrequests: number;
  /** Candidats écrits (nouveaux ou mis à jour) et déjà au registre (écartés) pendant ce pas. */
  written?: number;
  inRegistry?: number;
  sitesChecked?: number;
  notified?: boolean;
  failed?: boolean;
}

const getState = (db: D1Database) =>
  db
    .prepare("SELECT phase, cursor, started_at, finished_at, lease_until, failures FROM prospect_state WHERE id = 1")
    .first<Omit<State, "cursor"> & { cursor: string }>()
    .then((r): State | null => {
      if (!r) return null;
      let cursor: State["cursor"] = {};
      try {
        cursor = JSON.parse(r.cursor) as State["cursor"];
      } catch {
        /* curseur illisible : la phase repart de son début */
      }
      return { ...r, cursor };
    });

async function startCampaign(db: D1Database, now: Date): Promise<void> {
  await db
    .prepare(
      `INSERT INTO prospect_state (id, phase, cursor, started_at, finished_at, lease_until, failures) VALUES (1, 'entreprises', '{}', ?1, NULL, NULL, 0)
     ON CONFLICT(id) DO UPDATE SET phase = 'entreprises', cursor = '{}', started_at = ?1, finished_at = NULL, lease_until = NULL, failures = 0`,
    )
    .bind(now.toISOString())
    .run();
}

/** Une campagne démarre quand aucune n'existe ou que la dernière, terminée, a commencé il y a au moins PROSPECT_INTERVAL_DAYS jours. */
export function campaignDue(state: State | null, now: Date): boolean {
  if (!state) return true;
  if (state.phase !== "repos") return false;
  return now.getTime() - new Date(state.started_at).getTime() >= PROSPECT_INTERVAL_DAYS * DAY_MS;
}

/** Prend le bail du pas (une seule invocation à la fois) ; false si un autre pas le tient encore. */
async function takeLease(db: D1Database, now: Date): Promise<boolean> {
  const r = await db
    .prepare("UPDATE prospect_state SET lease_until = ?1 WHERE id = 1 AND (lease_until IS NULL OR lease_until < ?2)")
    .bind(new Date(now.getTime() + PROSPECT_LEASE_MS).toISOString(), now.toISOString())
    .run();
  return !!r.meta.changes;
}

interface Row {
  id: string;
  name: string;
  website: string | null;
  phone: string | null;
  address: string | null;
  postal_code: string | null;
}

/**
 * Écrit les candidats lus, hors registre ; un candidat qui désigne une agence déjà en base complète sa ligne. Le statut n'est
 * jamais réécrit ; un site nouvellement connu remet le candidat à regarder.
 */
export async function saveCandidates(
  db: D1Database,
  found: Candidate[],
  now: Date,
  sources: readonly SourceDef[] = settings().sources.dedicated,
): Promise<{ written: number; inRegistry: number }> {
  const iso = now.toISOString();
  const existing = (
    await db
      .prepare("SELECT id, name, website, phone, address, postal_code FROM agency_candidates LIMIT 2000")
      .all<Row>()
  ).results;
  const stmts: D1PreparedStatement[] = [];
  let skipped = 0;
  for (const c of found) {
    if (inRegistry(c, sources)) {
      skipped++;
      continue;
    }
    const same =
      existing.find((e) => e.id === c.id) ??
      existing.find(
        (e) =>
          (e.postal_code === c.postalCode || !e.postal_code || !c.postalCode) &&
          sameAgency({ names: [e.name], website: e.website }, c),
      );
    if (same) {
      stmts.push(
        db
          .prepare(
            `UPDATE agency_candidates SET last_seen = ?2,
           phone = COALESCE(phone, ?3), address = COALESCE(address, ?4),
           checked_at = CASE WHEN website IS NULL AND ?5 IS NOT NULL THEN NULL ELSE checked_at END,
           website = COALESCE(website, ?5)
         WHERE id = ?1`,
          )
          .bind(same.id, iso, c.phone, c.address, c.website),
      );
      if (!same.website && c.website) same.website = c.website;
      continue;
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO agency_candidates (id, name, address, postal_code, website, phone, origin, first_seen, last_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
        )
        .bind(c.id, c.names[0], c.address, c.postalCode, c.website, c.phone, c.origin, iso),
    );
    existing.push({
      id: c.id,
      name: c.names[0],
      website: c.website,
      phone: c.phone,
      address: c.address,
      postal_code: c.postalCode,
    });
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return { written: stmts.length, inRegistry: skipped };
}

/** Phase « sites » : regarde la page d'accueil de chaque candidat non vérifié (gabarit, puis verdict seulement si gabarit inconnu). */
async function sitesStep(
  env: Env,
  now: Date,
  budget: number,
): Promise<{ checked: number; calls: number; more: boolean }> {
  const iso = now.toISOString();
  await env.DB.prepare(
    "UPDATE agency_candidates SET template = ?1, checked_at = ?2 WHERE checked_at IS NULL AND website IS NULL",
  )
    .bind(TEMPLATE_NO_SITE, iso)
    .run();
  const rows = (
    await env.DB.prepare(
      "SELECT id, website FROM agency_candidates WHERE checked_at IS NULL AND website IS NOT NULL ORDER BY first_seen LIMIT ?",
    )
      .bind(Math.min(PROSPECT_SITES_PER_STEP, budget))
      .all<{ id: string; website: string }>()
  ).results;
  const aiOn = prospectAiOn(env);
  const done = await Promise.all(
    rows.map(async (r) => {
      let html: string | null = null;
      try {
        const res = await fetch(r.website, {
          redirect: "follow",
          headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
          signal: AbortSignal.timeout(PROSPECT_SITE_TIMEOUT_MS),
        });
        if (res.status < 400)
          html = (await readBody(res, { maxBytes: PROSPECT_SITE_MAX_BYTES, encoding: "utf-8" })).text;
        else await res.body?.cancel().catch(() => {});
      } catch {
        /* site injoignable : traité comme gabarit inconnu */
      }
      const m = html ? detectTemplate(html) : { template: TEMPLATE_UNKNOWN, parser: null };
      // Le modèle en dernier, seulement pour un gabarit inconnu dont la page a été lue.
      const rental =
        html && m.parser === null && aiOn ? await classifyRental(env, pageText(html, PROSPECT_AI_TEXT_MAX)) : null;
      return { id: r.id, m, rental };
    }),
  );
  if (done.length) {
    await env.DB.batch(
      done.map((d) =>
        env.DB.prepare(
          "UPDATE agency_candidates SET template = ?2, parser = ?3, rental = ?4, checked_at = ?5 WHERE id = ?1",
        ).bind(d.id, d.m.template, d.m.parser, d.rental, iso),
      ),
    );
  }
  const left = await env.DB.prepare("SELECT 1 AS x FROM agency_candidates WHERE checked_at IS NULL LIMIT 1").first();
  return { checked: done.length, calls: rows.length, more: !!left };
}

/** Candidats nouveaux de la campagne qui ont un site (seuls actionnables), pour le message final. */
async function newOfCampaign(
  db: D1Database,
  since: string,
): Promise<{
  n: number;
  rows: {
    name: string;
    template: string | null;
    website: string | null;
    phone: string | null;
    rental: string | null;
  }[];
}> {
  const n =
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM agency_candidates WHERE status = 'nouveau' AND website IS NOT NULL AND first_seen >= ?",
        )
        .bind(since)
        .first<{ n: number }>()
    )?.n ?? 0;
  const rows = (
    await db
      .prepare(
        "SELECT name, template, website, phone, rental FROM agency_candidates WHERE status = 'nouveau' AND website IS NOT NULL AND first_seen >= ?1 ORDER BY (parser IS NULL), first_seen LIMIT ?2",
      )
      .bind(since, PROSPECT_TELEGRAM_LIMIT)
      .all<{
        name: string;
        template: string | null;
        website: string | null;
        phone: string | null;
        rental: string | null;
      }>()
  ).results;
  return { n, rows };
}

/** Texte (HTML de Telegram) du récapitulatif de fin de campagne. */
export function formatRecap(
  n: number,
  rows: {
    name: string;
    template: string | null;
    website: string | null;
    phone: string | null;
    rental: string | null;
  }[],
): string {
  const lines = rows.map((r) => {
    const tpl =
      r.template === TEMPLATE_NO_SITE
        ? "sans site"
        : r.template === TEMPLATE_UNKNOWN
          ? "gabarit inconnu"
          : `gabarit ${r.template}`;
    const rental = r.rental ? `, locations : ${r.rental}` : "";
    return `• ${esc(r.name)} (${esc(tpl)}${rental})${r.website ? ` ${esc(r.website)}` : ""}${r.phone ? ` ${esc(r.phone)}` : ""}`;
  });
  const more = n > rows.length ? `\n… et ${n - rows.length} autres sur le tableau de bord.` : "";
  return `<b>Agences candidates</b> : ${n} nouvelle${n > 1 ? "s" : ""}\n${lines.join("\n")}${more}`;
}

/** Un pas de campagne, borné à PROSPECT_STEP_BUDGET sous-requêtes ; éteint, aucun effet. `start` relance une campagne au repos. */
export async function runProspectStep(
  env: Env,
  now: Date,
  opts: { start?: boolean; sources?: readonly SourceDef[] } = {},
): Promise<StepReport> {
  if (!prospectOn(env)) return { enabled: false, result: "éteint", subrequests: 0 };
  const db = env.DB;
  const zones = settings().zones;
  let state = await getState(db);
  if (campaignDue(state, now) || (opts.start && state?.phase === "repos")) {
    await startCampaign(db, now);
    state = await getState(db);
  }
  if (!state || state.phase === "repos") return { enabled: true, result: "repos", phase: "repos", subrequests: 0 };
  if (!(await takeLease(db, now))) return { enabled: true, result: "occupé", phase: state.phase, subrequests: 0 };

  const report: StepReport = { enabled: true, result: "pas", phase: state.phase, subrequests: 0 };
  let phase: Phase = state.phase;
  let cursor = state.cursor;
  let failed = false;
  try {
    if (phase === "entreprises") {
      let z = cursor.z ?? 0,
        p = cursor.p ?? 1;
      for (
        let i = 0;
        i < PROSPECT_PAGES_PER_STEP && z < zones.length && report.subrequests < PROSPECT_STEP_BUDGET;
        i++
      ) {
        report.subrequests++;
        const page = await fetchEntreprisesPage(zones[z].postalCode, p);
        if (!page) {
          failed = true;
          break;
        }
        const w = await saveCandidates(db, page.candidates, now, opts.sources);
        report.written = (report.written ?? 0) + w.written;
        report.inRegistry = (report.inRegistry ?? 0) + w.inRegistry;
        if (p >= page.totalPages) {
          z++;
          p = 1;
        } else p++;
      }
      cursor = { z, p };
      if (!failed && z >= zones.length) {
        phase = "osm";
        cursor = {};
      }
    } else if (phase === "osm") {
      const z = cursor.z ?? 0;
      if (z >= zones.length) {
        phase = "sites";
        cursor = {};
      } else {
        report.subrequests++;
        const found = await fetchOverpass(zones[z].postalCode);
        if (!found) failed = true;
        else {
          const w = await saveCandidates(db, found, now, opts.sources);
          report.written = w.written;
          report.inRegistry = w.inRegistry;
          cursor = { z: z + 1 };
          if (z + 1 >= zones.length) {
            phase = "sites";
            cursor = {};
          }
        }
      }
    } else if (phase === "sites") {
      const s = await sitesStep(env, now, PROSPECT_STEP_BUDGET - report.subrequests);
      report.subrequests += s.calls;
      report.sitesChecked = s.checked;
      if (!s.more) phase = "fin";
    }
    if (phase === "fin") {
      // « repos » posé avant l'envoi : jamais deux messages (au pire, le message est perdu).
      await db
        .prepare(
          "UPDATE prospect_state SET phase = 'repos', finished_at = ?1, lease_until = NULL, failures = 0 WHERE id = 1",
        )
        .bind(now.toISOString())
        .run();
      const { n, rows } = await newOfCampaign(db, state.started_at);
      report.phase = "fin";
      if (n > 0) {
        report.subrequests++;
        report.notified = !!(await sendTelegramMessage(env, formatRecap(n, rows)))?.ok;
      }
      return report;
    }
  } catch (e) {
    console.error("prospection:", errMsg(e));
    failed = true;
  }
  report.failed = failed;
  let failures = failed ? state.failures + 1 : 0;
  if (failures >= PROSPECT_MAX_STEP_FAILURES) {
    phase = NEXT[phase];
    cursor = {};
    failures = 0;
  }
  await db
    .prepare("UPDATE prospect_state SET phase = ?1, cursor = ?2, failures = ?3, lease_until = NULL WHERE id = 1")
    .bind(phase, JSON.stringify(cursor), failures)
    .run();
  return report;
}
