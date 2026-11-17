import { GROUP_MAX_SOURCES, TOTAL_GROUPS } from "./config/schedule";
import { UNIVERSAL_BROWSER_MAX, UNIVERSAL_MAX_ACTIVE } from "./config/universal";
import { assignGroups } from "./instance";
import type { Instance } from "./instance";
import { MAIL_SENDERS } from "./mail/senders";
import type { SourceDef } from "./types";

type Def = Omit<SourceDef, "active" | "encoding"> & { encoding?: SourceDef["encoding"]; active?: boolean };
const def = (d: Def): SourceDef => ({ encoding: "utf-8", active: true, ...d });

/**
 * Applique une sélection : "auto" garde active toute source dont les zones recoupent `zones`, une liste d'ids ne garde que
 * celles-là. Aucune source n'est supprimée (tableau de bord et historique intacts).
 */
export function applyUserSources(
  list: SourceDef[],
  selection: "auto" | readonly string[],
  zones: readonly { postalCode: string }[],
): SourceDef[] {
  const codes = new Set(zones.map((z) => z.postalCode));
  return list.map((s) => {
    const wanted = selection === "auto" ? s.zones.some((c) => codes.has(c)) : selection.includes(s.id);
    return !wanted && s.active ? { ...s, active: false } : s;
  });
}

/**
 * Sources lues par le cron : actives, non virtuelles et, parmi les universelles, les UNIVERSAL_MAX_ACTIVE premières (dont
 * UNIVERSAL_BROWSER_MAX en navigateur) : un plafond de coût indépendant des interrupteurs.
 */
export function readableIds(sources: readonly SourceDef[]): Set<string> {
  const ids = new Set<string>();
  let universal = 0,
    browser = 0;
  for (const s of sources) {
    if (!s.active || s.virtual) continue;
    if (s.parser === "universal") {
      if (universal >= UNIVERSAL_MAX_ACTIVE || (s.render === "browser" && browser >= UNIVERSAL_BROWSER_MAX)) continue;
      universal++;
      if (s.render === "browser") browser++;
    }
    ids.add(s.id);
  }
  return ids;
}

/** Registre des sources d'une instance (Settings.sources). */
export interface SourceRegistry {
  /** Lecteurs dédiés : toutes les sources du fichier qui ne sont pas universelles. */
  readonly dedicated: readonly SourceDef[];
  /** Sources universelles, lues dans la limite UNIVERSAL_MAX_ACTIVE. */
  readonly universal: readonly SourceDef[];
  /** Sources que le cron peut lire : lecteurs dédiés puis sources universelles. */
  readonly cron: readonly SourceDef[];
  /** Identifiants des sources de `cron` réellement lues (readableIds). */
  readonly readable: ReadonlySet<string>;
  /** Sources virtuelles des alertes par mail (`mail_<clé>`, une par expéditeur) : toutes zones, liste non filtrée. */
  readonly mail: readonly SourceDef[];
  /** Registre complet : sources du cron et sources virtuelles. */
  readonly all: readonly SourceDef[];
}

// Registre tiré de l'instance. Les sources sans « group » explicite sont réparties dans l'ordre du fichier (assignGroups), qui
// est aussi l'ordre des sous-lots : deux pages lourdes ne doivent pas se suivre dans un groupe (test/scan.test.ts).
export function sourceRegistry(i: Instance): SourceRegistry {
  const registry = assignGroups(i.sources, TOTAL_GROUPS, GROUP_MAX_SOURCES).map(({ note: _note, group, ...s }) =>
    def({ ...s, group }),
  );
  const dedicated = applyUserSources(
    registry.filter((s) => s.parser !== "universal"),
    "auto",
    i.zones,
  );
  const universal = applyUserSources(
    registry.filter((s) => s.parser === "universal"),
    "auto",
    i.zones,
  );
  const cron = [...dedicated, ...universal];
  const allZones = i.zones.map((z) => z.postalCode);
  const mail = applyUserSources(
    MAIL_SENDERS.map((m) =>
      def({
        id: `mail_${m.key}`,
        name: m.name,
        url: m.home,
        parser: "mail",
        group: 0,
        zones: allZones,
        filteredToZones: false,
        phone: m.phone ?? null,
        virtual: true,
      }),
    ),
    "auto",
    i.zones,
  );
  return { dedicated, universal, cron, readable: readableIds(cron), mail, all: [...cron, ...mail] };
}
