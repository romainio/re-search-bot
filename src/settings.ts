// Réglages de l'instance en D1 (table `settings`) : clé -> valeur texte. Lecture jamais bloquante (table absente : null).

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  try {
    return (
      (await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null
    );
  } catch {
    return null;
  }
}

export async function setSetting(db: D1Database, key: string, value: string, now: Date = new Date()): Promise<void> {
  await db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key, value, now.toISOString())
    .run();
}

/** Supprime la ligne seulement si elle porte encore `value` ; vrai si elle a été supprimée (consommation unique d'un code). */
export async function deleteSettingIf(db: D1Database, key: string, value: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM settings WHERE key = ? AND value = ?").bind(key, value).run();
  return (r.meta.changes ?? 0) === 1;
}

/** Écrit la ligne seulement si la clé n'existe pas encore (première écriture gagnante entre deux requêtes simultanées). */
export async function setSettingIfAbsent(
  db: D1Database,
  key: string,
  value: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING")
    .bind(key, value, now.toISOString())
    .run();
}
