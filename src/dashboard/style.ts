/** Feuille de style du tableau de bord (thèmes clair et sombre, sans JavaScript). */
export const CSS = `
:root{--bg:#f5f5f4;--card:#fff;--fg:#1c1917;--mute:#6b6560;--line:#e7e5e4;--accent:#0f766e;--accent-bg:#ccfbf1;--warn:#b45309;--bad:#b91c1c;--ok:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1d1b;--fg:#f5f5f4;--mute:#a8a29e;--line:#2e2c29;--accent:#5eead4;--accent-bg:#134e4a;--warn:#fbbf24;--bad:#f87171;--ok:#4ade80}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:16px}
h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.1rem;margin:28px 0 10px}
.sub{color:var(--mute);margin:0 0 12px;font-size:.9rem}
.grid{display:grid;gap:12px;grid-template-columns:1fr}
@media (min-width:700px){.grid{grid-template-columns:1fr 1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
.ph{aspect-ratio:16/10;background:var(--line);overflow:hidden}
.ph img{width:100%;height:100%;object-fit:cover;display:block}
.body{padding:12px;display:flex;flex-direction:column;gap:4px;flex:1}
.rent{font-size:1.15rem;font-weight:650}
.mute{color:var(--mute);font-size:.9rem}
.badge{display:inline-block;background:var(--accent-bg);color:var(--accent);border-radius:999px;padding:1px 10px;font-size:.8rem;font-weight:600;align-self:flex-start}
.badge.warn{background:transparent;color:var(--warn);border:1px solid var(--warn);font-weight:500}
.hints{display:flex;flex-wrap:wrap;gap:4px}
.pend{color:var(--warn);font-size:.85rem}
.desc{color:var(--mute);font-size:.85rem}
a.btn{margin-top:auto;padding-top:8px;color:var(--accent);font-weight:600;text-decoration:none}
a.btn:hover{text-decoration:underline}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line)}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;font-size:.9rem}
tr:last-child td{border-bottom:0}th{color:var(--mute);font-weight:600}
.ok{color:var(--ok)}.bad{color:var(--bad)}.never{color:var(--mute)}
.tw{overflow-x:auto}
.kpis{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 12px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;font-size:.9rem}
.kpi b{font-size:1.15rem;margin-right:4px}
details{margin:20px 0 0}summary{cursor:pointer;font-weight:600;font-size:1.05rem}
details .tw{margin-top:10px}
.filtres{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:0 0 12px}
.frow{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:4px 0}
.flabel{color:var(--mute);font-size:.85rem;min-width:96px}
.chip{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:.85rem;color:var(--fg);text-decoration:none}
.chip.on{background:var(--accent-bg);color:var(--accent);border-color:var(--accent);font-weight:600}
.filtres p{margin:6px 0 0}.reset{color:var(--accent);font-weight:600}
.mcp{margin:24px 0}.mcp code{display:block;word-break:break-all;padding:8px;border-radius:6px;background:rgba(127,127,127,.12)}
.follow{font-size:.85rem;font-weight:600}
.mkt{font-size:.85rem;color:var(--mute)}.fastmk{color:var(--warn);font-weight:600}
.search{display:flex;gap:6px;margin:0 0 12px}.search input[type=search]{flex:1;min-width:0;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit}.search button{padding:6px 14px;border:1px solid var(--accent);border-radius:8px;background:var(--accent-bg);color:var(--accent);font:inherit;font-weight:600;cursor:pointer}
.score{font-size:.75rem;opacity:.8}
.bars{display:flex;align-items:flex-end;gap:2px;height:48px;margin:8px 0}.bars span{flex:1;background:var(--accent);min-height:1px;border-radius:2px 2px 0 0}
`;
