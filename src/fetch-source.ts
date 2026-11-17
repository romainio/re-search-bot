import { SOURCE_MAX_BYTES, SOURCE_TIMEOUT_MS, USER_AGENT } from "./config/fetch";
import { readBody } from "./read-body";
import type { SourceDef } from "./types";

/** body : page décodée, coupée après le marqueur de fin (stopped) ou au plafond (truncated) ; bytes : octets tirés du flux. */
export type FetchResult =
  | { ok: true; body: string; bytes: number; stopped: boolean; truncated: boolean }
  | { ok: false; reason: string };

const ANTIBOT = /captcha-delivery|cf-chl-|Just a moment/;

export async function fetchSource(src: SourceDef): Promise<FetchResult> {
  try {
    const res = await fetch(src.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "fr-FR,fr;q=0.9",
        Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      },
    });
    if (res.status >= 400) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const r = await readBody(res, {
      maxBytes: src.maxBytes ?? SOURCE_MAX_BYTES,
      encoding: src.encoding,
      stopMarker: src.stopMarker,
    });
    if (ANTIBOT.test(r.text.slice(0, 20_000))) return { ok: false, reason: "anti-bot" };
    return { ok: true, body: r.text, bytes: r.bytes, stopped: r.stopped, truncated: r.truncated };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "réseau" };
  }
}
