// Fichiers .sql importés comme texte (règle « Text » de wrangler.jsonc ; vitest.config.ts pour les tests).
declare module "*.sql" {
  const sql: string;
  export default sql;
}
