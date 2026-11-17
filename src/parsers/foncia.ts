import { at, hasValue } from "../guards";
import type { Listing, SourceDef } from "../types";
import { num, str } from "./json-fields";

const SEARCH_KEY = "POST.https://fnc-api.prod.fonciatech.net/annonces/annonces/search";

const ENT: Record<string, string> = { q: '"', s: "'", l: "<", g: ">", a: "&" };

// Échappement TransferState d'Angular, décodé en une passe (&a; est l'esperluette : pas de double décodage).
function decodeState(s: string): string {
  let out = "",
    i = 0;
  for (;;) {
    const amp = s.indexOf("&", i);
    if (amp < 0) return out + s.slice(i);
    const rep = s.charCodeAt(amp + 2) === 59 ? ENT[s[amp + 1]] : undefined;
    if (rep === undefined) {
      out += s.slice(i, amp + 1);
      i = amp + 1;
      continue;
    }
    out += s.slice(i, amp) + rep;
    i = amp + 3;
  }
}

export function parseFoncia(body: string, src: SourceDef): Listing[] {
  const open = body.indexOf('<script id="serverApp-state"');
  if (open < 0) throw new Error("foncia: serverApp-state missing");
  const start = body.indexOf(">", open) + 1;
  const end = body.indexOf("</script>", start);
  if (start === 0 || end < 0) throw new Error("foncia: serverApp-state unterminated");
  const text = body.slice(start, end);
  // Repère l'entrée de recherche dans le texte échappé et ne décode que sa valeur (~20 % de l'état).
  const k = text.indexOf(`&q;${SEARCH_KEY}`);
  const v = k < 0 ? -1 : text.indexOf("&q;:{&q;", k);
  if (v < 0) throw new Error("foncia: annonces search entry missing");
  const from = v + 4;
  const nextKey = /,&q;(?:GET|POST)\./g;
  nextKey.lastIndex = from;
  const nk = nextKey.exec(text);
  const to = nk ? nk.index : text.lastIndexOf("}");
  let state: unknown;
  try {
    state = JSON.parse(decodeState(text.slice(from, to)));
  } catch {
    throw new Error("foncia: search entry is not valid JSON");
  }
  const annonces = at(state, "body", "annonces");
  if (!Array.isArray(annonces)) throw new Error("foncia: annonces search entry missing");
  return annonces
    .filter((a: unknown) => hasValue(at(a, "reference")))
    .map((a: unknown): Listing => {
      const desc = str(at(a, "description")) ?? "";
      const path = str(at(a, "canonicalUrl"));
      // Loyer CC seulement si le texte de l'annonce le dit, sinon inconnu.
      const isCC = /\bCC\b|charges comprises/i.test(desc) ? true : null;
      return {
        source: src.id,
        id: String(at(a, "reference")),
        url: path?.startsWith("/") ? `https://fr.foncia.com${path}` : src.url,
        price: num(at(a, "loyer")),
        charges: null,
        priceIsCC: isCC,
        surface: num(at(a, "surface", "habitable")),
        rooms: num(at(a, "nbPiece")),
        title: str(at(a, "titles", "main")),
        address: null,
        district: null,
        postalCode: str(at(a, "localisation", "codePostal")),
        photo: str(at(a, "medias", 0)),
        agency: null,
        phone: null,
        propertyType: str(at(a, "typeBien")),
        publishedAt: str(at(a, "datePublication")),
      };
    });
}
