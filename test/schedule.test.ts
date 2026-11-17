import { describe, expect, it } from "vitest";
import { GROUP_COUNT, LANE_COUNT, TOTAL_GROUPS } from "../src/config/schedule";
import { settings } from "../src/derive";
import { groupFor, groupsFor, isActiveHour, isDue } from "../src/schedule";
import { groupParts } from "../src/scan";

const cfg = settings();

describe("isActiveHour", () => {
  it("couvre 9h00-19h59 heure de Paris, été comme hiver", () => {
    expect(isActiveHour(new Date("2026-10-19T07:00:00Z"))).toBe(true); // 9h00 Paris (UTC+2)
    expect(isActiveHour(new Date("2026-10-19T06:59:00Z"))).toBe(false); // 8h59
    expect(isActiveHour(new Date("2026-10-19T17:59:00Z"))).toBe(true); // 19h59
    expect(isActiveHour(new Date("2026-10-19T18:00:00Z"))).toBe(false); // 20h00
    expect(isActiveHour(new Date("2026-12-01T07:30:00Z"))).toBe(false); // 8h30 Paris (UTC+1)
    expect(isActiveHour(new Date("2026-12-01T18:30:00Z"))).toBe(true); // 19h30 Paris
    expect(isActiveHour(new Date("2026-10-25T08:00:00Z"))).toBe(true); // passage heure d'hiver, 9h00
    expect(isActiveHour(new Date("2026-03-29T07:00:00Z"))).toBe(true); // passage heure d'été, 9h00
  });
});

describe("groupFor", () => {
  it("retourne la minute UTC modulo 5 (GROUP_COUNT, qui divise 60 : chaque groupe toutes les 5 minutes, y compris à l'heure pleine)", () => {
    expect(GROUP_COUNT).toBe(5);
    expect(groupFor(new Date("2026-10-19T07:07:00Z"))).toBe(2);
    expect(groupFor(new Date("2026-10-19T07:59:30Z"))).toBe(4);
    expect(groupFor(new Date("2026-10-19T08:00:00Z"))).toBe(0);
    const start = Date.UTC(2026, 9, 19, 7, 0);
    for (let m = 0; m < 240; m++) expect(groupFor(new Date(start + m * 60_000))).toBe(m % 5); // cycle régulier sur 4 heures
  });

  it("voie 1 : groupes 5 à 9, même cadence (chaque groupe toutes les 5 minutes)", () => {
    expect(TOTAL_GROUPS).toBe(10);
    const start = Date.UTC(2026, 9, 19, 7, 0);
    for (let m = 0; m < 240; m++) expect(groupFor(new Date(start + m * 60_000), 1)).toBe(5 + (m % 5));
  });
});

describe("groupsFor", () => {
  it("un groupe par voie à chaque minute : g et g + 5 (deux voies, un seul cron)", () => {
    expect(LANE_COUNT).toBe(2);
    expect(groupsFor(new Date("2026-10-19T08:00:00Z"))).toEqual([0, 5]);
    expect(groupsFor(new Date("2026-10-19T07:59:30Z"))).toEqual([4, 9]);
  });
});

describe("isDue : cadence réduite (SourceDef.every)", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 26, 10, m));
  it("sans every (ou 5) : toujours due", () => {
    for (let m = 0; m < 60; m++) {
      expect(isDue({}, at(m))).toBe(true);
      expect(isDue({ every: 5 }, at(m))).toBe(true);
    }
  });
  it("every 15 : une lecture sur trois pour la minute de son groupe, toutes les 15 minutes, hors heure pleine comprise", () => {
    for (const g of [0, 1, 2, 3, 4]) {
      const due = Array.from({ length: 60 }, (_, m) => m).filter((m) => m % 5 === g && isDue({ every: 15 }, at(m)));
      expect(due).toEqual([g, g + 15, g + 30, g + 45]);
    }
  });
  it("Century 21 : lu toutes les 15 min, jamais deux fois dans le même quart d'heure", () => {
    const c21 = cfg.sources.dedicated.filter((s) => s.id.startsWith("century21"));
    expect(c21).toHaveLength(2);
    for (const s of c21) {
      expect(s.every).toBe(15);
      const reads = Array.from({ length: 60 }, (_, m) => m).filter((m) => m % 5 === s.group % 5 && isDue(s, at(m)));
      expect(reads).toHaveLength(4);
      expect(reads.every((m, i) => i === 0 || m - reads[i - 1] === 15)).toBe(true);
      expect(groupParts(s.group).flat()).not.toContain(s.id); // désactivée (403/429 depuis Cloudflare) : absente des sous-lots, cadence conservée au registre
    }
  });
});
