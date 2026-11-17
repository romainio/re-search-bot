import { MIGRATIONS } from "./migrations";
import type { Migration } from "./migrations";
import { errMsg } from "./guards";

// Migrations D1 appliquées par le Worker lui-même. La table `d1_migrations` a le schéma de wrangler : une base migrée par
// wrangler ne rejoue rien. Verrou : chaque migration est un batch (transaction) qui commence par insérer son nom (UNIQUE) ; de
// deux invocations concurrentes, la perdante est annulée en entier, relit la table et continue.

/** Table de wrangler (même définition que `wrangler d1 migrations apply`). */
const CREATE_TABLE =
  "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)";

/**
 * Instructions d'un fichier SQL : commentaires de ligne retirés, découpe sur « ; » hors apostrophes. Un bloc `BEGIN ... END` (corps de
 * déclencheur) n'est pas coupé. Les migrations du dépôt n'ont ni guillemets doubles ni commentaires /* *\/ : non gérés.
 */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "",
    quote = false,
    depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      cur += ch;
      if (ch === "'") quote = false;
      continue;
    }
    if (ch === "'") {
      quote = true;
      cur += ch;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      cur += "\n";
      continue;
    }
    if (ch === ";" && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
    if (/[A-Za-z]/.test(ch) && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? " ")) {
      const word = /^[A-Za-z]+/.exec(sql.slice(i, i + 8))?.[0]?.toUpperCase();
      if (word === "BEGIN" && /^BEGIN\b/i.test(sql.slice(i, i + 6))) depth++;
      else if (word === "END" && depth > 0 && /^END\b/i.test(sql.slice(i, i + 4))) depth--;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const names = async (db: D1Database): Promise<Set<string>> => {
  const { results } = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  return new Set(results.map((r) => r.name));
};

/** Applique, dans l'ordre, les migrations absentes de d1_migrations. Renvoie les noms appliqués par cet appel. Lève en cas d'échec. */
export async function applyMigrations(
  db: D1Database,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<string[]> {
  let done: Set<string>;
  try {
    done = await names(db);
  } catch {
    await db.exec(CREATE_TABLE);
    done = await names(db);
  }
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    try {
      await db.batch([
        db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(m.name),
        ...splitSql(m.sql).map((s) => db.prepare(s)),
      ]);
      applied.push(m.name);
    } catch (e) {
      // Perdante d'une course : la migration est déjà enregistrée par l'autre invocation, son batch a été annulé en entier.
      if ((await names(db).catch(() => new Set<string>())).has(m.name)) continue;
      throw new Error(`migration ${m.name} : ${errMsg(e)}`);
    }
  }
  return applied;
}

/** Bases déjà vérifiées par cet isolat (la vérification coûte une lecture D1, une seule fois). */
const checked = new WeakMap<D1Database, Promise<void>>();

/** Garantit que la base est migrée, une fois par isolat ; jamais bloquant (échec journalisé, retenté à l'invocation suivante). */
export function ensureMigrated(db: D1Database, migrations: readonly Migration[] = MIGRATIONS): Promise<void> {
  let p = checked.get(db);
  if (!p) {
    p = applyMigrations(db, migrations)
      .then((applied) => {
        if (applied.length) console.log(`migrations appliquées : ${applied.join(", ")}`);
      })
      .catch((e: unknown) => {
        checked.delete(db);
        console.error("migrations:", errMsg(e));
      });
    checked.set(db, p);
  }
  return p;
}
