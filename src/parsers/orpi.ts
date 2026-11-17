import { at, hasValue } from "../guards";
import type { Listing, SourceDef } from "../types";
import { num, str } from "./json-fields";

const NAMED: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" };

const UTF16 = new TextDecoder("utf-16le");

// Décodeur en une passe de l'attribut data-result (~20 000 références numériques, trop lentes par regex) : unités UTF-16 écrites
// dans un Uint16Array, décodées une fois. Gère &#x..; &#..; &quot; &amp; &lt; &gt; &apos;. Sert aussi à data-estate (fiche).
export function decodeAttr(s: string): string {
  const n = s.length,
    buf = new Uint16Array(n);
  let o = 0,
    i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c !== 38) {
      buf[o++] = c;
      i++;
      continue;
    }
    let j = i + 1,
      cp = -1;
    if (s.charCodeAt(j) === 35) {
      j++;
      const hex = (s.charCodeAt(j) | 32) === 120;
      if (hex) j++;
      let v = 0,
        digits = 0;
      for (; j < n; j++) {
        const d = s.charCodeAt(j);
        const x = d >= 48 && d <= 57 ? d - 48 : hex && (d | 32) >= 97 && (d | 32) <= 102 ? (d | 32) - 87 : -1;
        if (x < 0) break;
        v = v * (hex ? 16 : 10) + x;
        digits++;
      }
      if (digits > 0 && s.charCodeAt(j) === 59 && v > 0 && v <= 0x10ffff && !(v >= 0xd800 && v <= 0xdfff)) cp = v;
    } else {
      const semi = s.indexOf(";", j);
      if (semi > 0 && semi - j <= 5) {
        const r = NAMED[s.slice(j, semi)];
        if (r !== undefined) {
          cp = r.charCodeAt(0);
          j = semi;
        }
      }
    }
    if (cp < 0) {
      buf[o++] = 38;
      i++;
      continue;
    }
    if (cp > 0xffff) {
      const t = cp - 0x10000;
      buf[o++] = 0xd800 + (t >> 10);
      buf[o++] = 0xdc00 + (t & 1023);
    } else buf[o++] = cp;
    i = j + 1;
  }
  return UTF16.decode(buf.subarray(0, o));
}

export function parseOrpi(body: string, src: SourceDef): Listing[] {
  const m = body.match(/\bdata-result="([^"]*)"/);
  if (!m) throw new Error("orpi: data-result missing");
  let json: unknown;
  try {
    json = JSON.parse(decodeAttr(m[1]));
  } catch {
    throw new Error("orpi: data-result is not valid JSON");
  }
  const items = at(json, "items");
  if (!Array.isArray(items)) throw new Error("orpi: items[] missing");
  return items
    .filter((a: unknown) => hasValue(at(a, "id")))
    .map((a: unknown): Listing => {
      const slug = str(at(a, "slug"));
      return {
        source: src.id,
        id: String(at(a, "id")),
        // La page d'annonce est rendue côté client (aucun href dans le HTML) : format d'URL vérifié en ligne.
        url: slug ? `https://www.orpi.com/annonce-location-${slug}/` : src.url,
        price: num(at(a, "price")),
        charges: null,
        priceIsCC: null,
        surface: num(at(a, "surface")),
        rooms: num(at(a, "nbRooms")),
        title: null,
        address: null,
        district: str(at(a, "district", "name")),
        postalCode: slug?.match(/-(\d{5})-/)?.[1] ?? null,
        photo: str(at(a, "images", 0)),
        agency: str(at(a, "agency", "name")),
        phone: null,
        propertyType: str(at(a, "type")),
        publishedAt: str(at(a, "onMarketSince")),
      };
    });
}
