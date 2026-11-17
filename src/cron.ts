import { settings } from "./derive";
import { errMsg } from "./guards";
import { isConfigured } from "./instance";
import { loadLiveConfig } from "./live-config";
import { refreshMarketStats } from "./market";
import { ensureMigrated } from "./migrate";
import { runProspectStep } from "./prospect/run";
import { runScan, selfRunner } from "./scan";
import { groupsFor, isActiveHour } from "./schedule";
import { semanticOn } from "./search/embed";
import { embedViaSelf } from "./search/self";
import { isSummaryTime, sendDailySummary } from "./summary";
import type { Env } from "./types";

/**
 * Cron de chaque minute. scheduledTime ne sert qu'à choisir le groupe (stable même si le cron part en retard) ; tout le reste se
 * juge sur l'horloge réelle, car /part refuse un instant trop éloigné de la sienne.
 */
export async function onCron(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  const now = new Date();
  await ensureMigrated(env.DB);
  env = await loadLiveConfig(env);
  const s = settings();
  // Instance pas encore paramétrée (aucune zone, donc aucune source) : rien à lire, à résumer ni à prospecter.
  if (!isConfigured(s.instance)) return;
  // Une lecture d'une ligne par passage ; recalcul (D1 seulement) au plus une fois par heure.
  ctx.waitUntil(refreshMarketStats(env.DB, now).catch((e) => console.error("marché:", errMsg(e))));
  // Un pas d'indexation dans sa propre invocation.
  if (semanticOn(env)) ctx.waitUntil(embedViaSelf(env, now, ctx));
  // Un groupe par voie (LANE_COUNT), lus en parallèle.
  if (isActiveHour(now, s.window))
    ctx.waitUntil(runScan(env, groupsFor(new Date(controller.scheduledTime)), now, selfRunner(env, ctx), s));
  // Résumé du soir, une fois par jour.
  else if (isSummaryTime(now, s.window))
    ctx.waitUntil(sendDailySummary(env, s.sources.all, now).then((r) => console.log(`résumé du soir : ${r}`)));
  // Hors fenêtre active et hors créneau du résumé : un pas de la prospection mensuelle.
  else if (env.PROSPECT_ENABLED === "true") {
    ctx.waitUntil(
      runProspectStep(env, now).then((r) => {
        if (r.result === "pas") console.log(`prospection : ${r.phase}, ${r.subrequests} sous-requêtes`);
      }),
    );
  }
}
