import path from "node:path";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

/** Fichier d'instance des tests : l'exemple de référence, jamais instance.config.json (propre à chaque instance). */
const EXAMPLE = path.join(import.meta.dirname, "examples", "paris-17-levallois.json");

/** Migrations .sql importées comme texte, comme la règle Text de wrangler.jsonc. */
const sqlAsText = {
  name: "sql-as-text",
  enforce: "pre" as const,
  transform: (code: string, id: string) =>
    id.split("?")[0].endsWith(".sql") ? { code: `export default ${JSON.stringify(code)};`, map: null } : null,
};

/** Interrupteurs de fonctions, tous éteints : chaque test qui a besoin d'une fonction l'allume lui-même. */
const SWITCHES_OFF = Object.fromEntries(
  [
    "WHATSAPP_ENABLED",
    "PHOTO_SCORING",
    "GEO_HINTS",
    "MARKET_HINTS",
    "PROSPECT_ENABLED",
    "PROSPECT_AI",
    "SEMANTIC_SEARCH",
    "TELEGRAM_INTERACTIVE",
    "UNIVERSAL_READER",
    "BROWSER_RENDER",
    "MAIL_INGEST",
    "ASSISTANT_ENABLED",
    "MCP_ENABLED",
  ].map((k) => [k, "false"]),
);

/**
 * Mesures de CPU (*.cpu.test.ts) : à part et un fichier à la fois, car d'autres fichiers en parallèle faussent les chronos.
 * `npm test` les exclut, `npm run test:cpu` ne lance qu'elles.
 */
export const CPU_TESTS = "test/**/*.cpu.test.ts";

export const testConfig = (cpu: boolean) =>
  defineConfig(async () => {
    const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
    return {
      resolve: { alias: [{ find: /^(\.\.?\/)+instance\.config\.json$/, replacement: EXAMPLE }] },
      plugins: [
        sqlAsText,
        cloudflareTest({
          wrangler: { configPath: "./wrangler.jsonc" },
          // Jamais de session distante : les tests simulent Workers AI et Vectorize, et la CI n'a pas de jeton.
          remoteBindings: false,
          // ADMIN_KEY de test : le Worker appelé par SELF (route /part) reçoit l'env du pool, pas celui des tests.
          miniflare: {
            // Les tests appellent le Worker par SELF ; en production, ctx.exports suffit.
            serviceBindings: { SELF: kCurrentWorker },
            bindings: {
              TEST_MIGRATIONS: migrations,
              ADMIN_KEY: "secret-key",
              DASHBOARD_PUBLIC: "true",
              ...SWITCHES_OFF,
            },
          },
        }),
      ],
      // Délai par test de 20 s : les passages sur toutes les sources (une invocation /part chacune) dépassent les 5 s par défaut.
      // Worktrees des agents (.claude/worktrees) exclus : leurs copies des tests tourneraient aussi.
      test: {
        setupFiles: ["./test/apply-migrations.ts"],
        testTimeout: 20_000,
        // Un seul processus : plusieurs isolats ouverts en même temps faussent les chronos.
        ...(cpu ? { include: [CPU_TESTS], fileParallelism: false, maxWorkers: 1 } : {}),
        exclude: ["**/node_modules/**", ".claude/**", ...(cpu ? [] : [CPU_TESTS])],
      },
    };
  });

export default testConfig(false);
