import { describe, expect, it } from "vitest";
import example from "../examples/paris-17-levallois.json";
import schema from "../instance.schema.json";
// Le fichier livré lui-même : l'alias de vitest ne vise que l'import JSON, pas sa lecture en texte.
import shippedRaw from "../instance.config.json?raw";
import { GROUP_MAX_SOURCES, TOTAL_GROUPS } from "../src/config/schedule";
import { settings } from "../src/derive";
import { assignGroups, EVERY_VALUES, INSTANCE, isConfigured, USER_PARSER_IDS, validateInstance } from "../src/instance";
import type { InstanceSource } from "../src/instance";
import { NEARBY as LAFORET_NEARBY } from "../src/parsers/laforet";
import { PARSERS } from "../src/parsers/index";
import { PARSER_IDS } from "../src/types";

const cfg = settings();

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** Exemple modifié par `f`, puis validé : le message d'erreur (ou null si valide). */
// biome-ignore lint/suspicious/noExplicitAny: instance volontairement malformée par chaque cas, hors de tout type.
type Loose = any;
const errorOf = (f: (i: Loose) => void): string | null => {
  const i = clone(example) as Loose;
  f(i);
  try {
    validateInstance(i);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

describe("validation de l'instance", () => {
  it("l'exemple de référence est valide et chargé tel quel (alias de vitest)", () => {
    expect(() => validateInstance(example)).not.toThrow();
    expect(INSTANCE.sources).toHaveLength(47);
    expect(INSTANCE.zones.map((z) => z.postalCode)).toEqual(["75017", "92300"]);
  });
  it("le fichier livré est une instance non paramétrée, valide : aucune zone, aucune source, aucun critère personnel", () => {
    const shipped = JSON.parse(shippedRaw) as Record<string, unknown>;
    expect(Object.keys(shipped).sort()).toEqual(["$schema", "sources", "zones"]);
    const v = validateInstance(shipped);
    expect(isConfigured(v)).toBe(false);
    expect(v.sources).toEqual([]);
    expect(v.criteria).toEqual({ rentMin: 0, rentMax: 0, surfaceMin: 0, roomsMin: 0, excludeGroundFloor: false });
    expect(isConfigured(INSTANCE)).toBe(true);
  });
  it("critères facultatifs sans zone, requis dès qu'une zone est surveillée", () => {
    expect(() => validateInstance({ zones: [], sources: [] })).not.toThrow();
    expect(() => validateInstance({ zones: [{ postalCode: "69003", label: "Lyon 3e" }], sources: [] })).toThrow(
      /criteria : objet attendu/,
    );
    expect(() =>
      validateInstance({ zones: [{ postalCode: "69003", label: "Lyon 3e" }], criteria: { rentMax: 900 }, sources: [] }),
    ).not.toThrow();
  });
  it("parser inconnu : erreur claire avec le chemin et la liste des lecteurs", () => {
    const m = errorOf((i) => {
      i.sources[2].parser = "inconnu";
    });
    expect(m).toContain("sources[2:foncia_17].parser");
    expect(m).toContain("lecteur inconnu");
    expect(m).toContain("bienici");
  });
  it("« mail » est réservé aux sources virtuelles", () => {
    expect(
      errorOf((i) => {
        i.sources[0].parser = "mail";
      }),
    ).toContain("lecteur inconnu");
  });
  it("zone inconnue dans une source", () => {
    expect(
      errorOf((i) => {
        i.sources[0].zones = ["99999"];
      }),
    ).toContain('zone inconnue "99999"');
  });
  it("identifiant dupliqué", () => {
    expect(
      errorOf((i) => {
        i.sources[1].id = i.sources[0].id;
      }),
    ).toContain("identifiant en double : bienici");
  });
  it("expression régulière invalide (zone, commune voisine)", () => {
    expect(
      errorOf((i) => {
        i.zones[1].town = "(levallois";
      }),
    ).toMatch(/zones\[1\]\.town : expression régulière invalide/);
    expect(
      errorOf((i) => {
        i.outOfZoneTowns[0].town = "[a-";
      }),
    ).toMatch(/outOfZoneTowns\[0\]\.town : expression régulière invalide/);
  });
  it("clé inconnue (faute de frappe), type faux, bornes incohérentes : toutes les erreurs d'un coup", () => {
    const m = errorOf((i) => {
      i.criteria.rentMaxx = 1;
      i.criteria.rentMin = 2000;
      i.window.startHour = 21;
      i.sources[0].every = 7;
      i.sources[0].url = "ftp://x";
    });
    expect(m).toContain("criteria.rentMaxx : clé inconnue");
    expect(m).toContain("rentMin (2000) dépasse rentMax (1600)");
    expect(m).toContain("window : startHour (21)");
    expect(m).toContain("sources[0:bienici].every");
    expect(m).toContain("sources[0:bienici].url");
  });
  it("adresse de source interne (IP, nom local, identifiants) : refusée comme par les outils MCP", () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://localhost:8787/",
      "https://10.0.0.1/a",
      "https://[::1]/",
      "https://intranet/",
      "https://nas.local/",
      "https://u:p@exemple.fr/",
    ]) {
      expect(
        errorOf((i) => {
          i.sources[1].url = url;
        }),
        url,
      ).toMatch(/sources\[1:orpi_17\]\.url : .*reçu/);
    }
    expect(
      errorOf((i) => {
        i.sources[1].url = "https://www.exemple.fr/louer?p=1";
      }),
    ).toBeNull();
  });
  it("zone en double, keywordsZone inconnue, render hors source universelle, racine non objet", () => {
    expect(
      errorOf((i) => {
        i.zones[1].postalCode = "75017";
      }),
    ).toContain("zone en double");
    expect(
      errorOf((i) => {
        i.keywordsZone = "00000";
      }),
    ).toContain("keywordsZone : zone inconnue");
    expect(
      errorOf((i) => {
        i.sources[0].render = "browser";
      }),
    ).toContain('réservé aux sources "universal"');
    expect(() => validateInstance([])).toThrow(/objet attendu/);
  });
  it("conversion : town devient une RegExp insensible à la casse, valeurs par défaut", () => {
    const v = validateInstance({
      zones: [{ postalCode: "69003", label: "Lyon 3", town: "\\blyon\\b" }],
      criteria: { rentMax: 900 },
      sources: [{ id: "a", name: "A", url: "https://a.fr", parser: "lbi", zones: ["69003"] }],
    });
    expect(v.zones[0].town).toBeInstanceOf(RegExp);
    expect(v.zones[0].town?.test("Lyon 3e")).toBe(true);
    expect(v.criteria).toEqual({ rentMin: 0, rentMax: 900, surfaceMin: 0, roomsMin: 0, excludeGroundFloor: false });
    expect(v.window).toEqual({ startHour: 9, endHour: 20, summaryHour: 20, summaryMinute: 5 });
    expect(v.keywordsZone).toBe("69003");
    expect(v.photoCriteria).toHaveLength(10);
    expect(v.sources[0]).toMatchObject({ encoding: "utf-8", active: true, filteredToZones: false, phone: null });
    expect(v.geo).toEqual({ stationPostalCodes: [], rentCapPostalCodes: [] });
  });
  it("le nom des communes de l'exemple reconnaît les textes attendus", () => {
    const old: [string, RegExp][] = [
      ["92250", /\bla\s+garenne[\s-]+colombes\b/i],
      ["92270", /\bbois[\s-]+colombes\b/i],
      ["92200", /\bneuilly\b/i],
      // Le quartier « Clichy-Batignolles » (17e) n'est pas la commune : l'exception est portée par l'expression de l'exemple.
      ["92110", /(?<!batignolles[\s-]*)\bclichy\b(?![\s-]*batignolles)/i],
      ["92400", /\bcourbevoie\b/i],
      ["92700", /\bcolombes\b/i],
      ["92800", /\bputeaux\b/i],
      ["92100", /\bboulogne\b/i],
      ["92600", /\basni[eè]res\b/i],
      ["93400", /\bsaint[\s-]+ouen\b/i],
      ["92150", /\bsuresnes\b/i],
      ["92130", /\bissy[\s-]+les[\s-]+moulineaux\b/i],
      ["92000", /\bnanterre\b/i],
    ];
    expect(INSTANCE.outOfZoneTowns.map((t) => [t.postalCode, t.town.source, t.town.flags])).toEqual(
      old.map(([c, r]) => [c, r.source, r.flags]),
    );
    expect(INSTANCE.zones[1].town?.source).toBe(/\blevallois\b/i.source);
  });
  it("le schéma JSON liste exactement les lecteurs du code et les cadences acceptées", () => {
    const props = schema.properties.sources.items.properties;
    expect([...props.parser.enum].sort()).toEqual([...USER_PARSER_IDS].sort());
    expect([...props.every.enum]).toEqual([...EVERY_VALUES]);
    expect(Object.keys(props).sort()).toEqual([
      "active",
      "encoding",
      "every",
      "extraPage",
      "filteredToZones",
      "group",
      "id",
      "maxBytes",
      "name",
      "note",
      "parser",
      "phone",
      "render",
      "stopMarker",
      "url",
      "zones",
    ]);
  });
  it("chaque lecteur nommé existe dans PARSERS ; le marqueur de Laforêt de l'exemple est celui du lecteur", () => {
    for (const p of PARSER_IDS) expect(PARSERS[p], p).toBeTypeOf("function");
    expect(cfg.sources.dedicated.find((s) => s.id === "laforet_17")?.stopMarker).toBe(LAFORET_NEARBY);
    expect(cfg.sources.dedicated.find((s) => s.id === "laforet_levallois")?.stopMarker).toBe(LAFORET_NEARBY);
  });
  it("la source universelle d'exemple vient de l'exemple JSON, inactive ; les lecteurs dédiés restent dans cfg.sources.dedicated", () => {
    expect(cfg.sources.universal.map((s) => [s.id, s.active, s.group])).toEqual([["david_immo", false, 6]]);
    expect(cfg.sources.dedicated.every((s) => s.parser !== "universal")).toBe(true);
    expect(cfg.sources.cron).toHaveLength(47);
  });
});

describe("groupes automatiques (assignGroups)", () => {
  const mk = (id: string, group?: number, active = true): InstanceSource => ({
    id,
    name: id,
    url: "https://x",
    parser: "lbi",
    zones: ["75017"],
    filteredToZones: false,
    phone: null,
    encoding: "utf-8",
    active,
    ...(group !== undefined ? { group } : {}),
  });

  it("sans group : répartition dans l'ordre de la liste, le groupe le moins chargé d'abord (déterministe)", () => {
    const out = assignGroups(
      Array.from({ length: 25 }, (_, i) => mk(`s${i}`)),
      TOTAL_GROUPS,
      GROUP_MAX_SOURCES,
    );
    expect(out.slice(0, 12).map((s) => s.group)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1]);
    expect(
      assignGroups(
        Array.from({ length: 25 }, (_, i) => mk(`s${i}`)),
        TOTAL_GROUPS,
        GROUP_MAX_SOURCES,
      ),
    ).toEqual(out);
  });
  it("un group explicite est respecté et compte dans la charge des autres", () => {
    const out = assignGroups([mk("a", 0), mk("b", 0), mk("c"), mk("d")], 2, 10);
    expect(out.map((s) => s.group)).toEqual([0, 0, 1, 1]);
  });
  it("au plus maxPerGroup sources actives par groupe ; une source inactive n'occupe pas de place", () => {
    const list = [mk("a"), mk("b"), mk("c"), mk("d"), mk("e", undefined, false)];
    expect(assignGroups(list, 2, 2).map((s) => s.group)).toEqual([0, 1, 0, 1, 0]);
    expect(() => assignGroups([...list, mk("f")], 2, 2)).toThrow(/tous les groupes sont pleins/);
  });
  it("erreurs claires : group hors plage, groupe explicite surchargé", () => {
    expect(() => assignGroups([mk("a", 5)], 2, 10)).toThrow(/group 5 hors de 0-1/);
    expect(() => assignGroups([mk("a", 0), mk("b", 0), mk("c", 0)], 2, 2)).toThrow(/groupe 0 : 3 sources actives/);
  });
  it("l'exemple de référence garde ses groupes explicites (aucun changement de comportement)", () => {
    const byId = new Map(cfg.sources.dedicated.map((s) => [s.id, s.group]));
    for (const s of example.sources)
      if ("group" in s)
        expect(byId.get(s.id) ?? cfg.sources.universal.find((u) => u.id === s.id)?.group, s.id).toBe(s.group);
  });
  it("une instance sans aucun group est valide : toutes ses sources actives reçoivent un groupe de 0 à TOTAL_GROUPS - 1", () => {
    const i = clone(example) as Loose;
    for (const s of i.sources) delete s.group;
    const v = validateInstance(i);
    const out = assignGroups(v.sources, TOTAL_GROUPS, GROUP_MAX_SOURCES);
    expect(out.every((s) => s.group >= 0 && s.group < TOTAL_GROUPS)).toBe(true);
    const counts = new Map<number, number>();
    for (const s of out.filter((x) => x.active)) counts.set(s.group, (counts.get(s.group) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(GROUP_MAX_SOURCES);
  });
});
