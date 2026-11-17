// Migrations D1 embarquées dans le bundle (règle « Text » de wrangler.jsonc ; plugin équivalent dans vitest.config.ts) et appliquées par
// src/migrate.ts. Chaque nouvelle migration s'ajoute ICI (import + ligne) : test/migrate.test.ts échoue si la liste et le dossier divergent.
import m0001 from "../migrations/0001_init.sql";
import m0002 from "../migrations/0002_health_alerts.sql";
import m0003 from "../migrations/0003_gone.sql";
import m0004 from "../migrations/0004_source_zones.sql";
import m0005 from "../migrations/0005_daily_summary.sql";
import m0006 from "../migrations/0006_filtered_reason.sql";
import m0008 from "../migrations/0008_agency_candidates.sql";
import m0009 from "../migrations/0009_market.sql";
import m0010 from "../migrations/0010_ai_usage.sql";
import m0011 from "../migrations/0011_telegram.sql";
import m0013 from "../migrations/0013_semantic_search.sql";
import m0014 from "../migrations/0014_assistant.sql";
import m0015 from "../migrations/0015_settings.sql";
import m0016 from "../migrations/0016_universal_state.sql";
import m0017 from "../migrations/0017_quartier_flag.sql";

export interface Migration {
  name: string;
  sql: string;
}
/** Dans l'ordre des numéros ; `name` = nom du fichier, comme dans la table d1_migrations de wrangler. */
export const MIGRATIONS: readonly Migration[] = [
  { name: "0001_init.sql", sql: m0001 },
  { name: "0002_health_alerts.sql", sql: m0002 },
  { name: "0003_gone.sql", sql: m0003 },
  { name: "0004_source_zones.sql", sql: m0004 },
  { name: "0005_daily_summary.sql", sql: m0005 },
  { name: "0006_filtered_reason.sql", sql: m0006 },
  { name: "0008_agency_candidates.sql", sql: m0008 },
  { name: "0009_market.sql", sql: m0009 },
  { name: "0010_ai_usage.sql", sql: m0010 },
  { name: "0011_telegram.sql", sql: m0011 },
  { name: "0013_semantic_search.sql", sql: m0013 },
  { name: "0014_assistant.sql", sql: m0014 },
  { name: "0015_settings.sql", sql: m0015 },
  { name: "0016_universal_state.sql", sql: m0016 },
  { name: "0017_quartier_flag.sql", sql: m0017 },
];
