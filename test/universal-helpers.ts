import { vi } from "vitest";
import type { Env } from "../src/types";

/**
 * Conversion HTML -> Markdown sommaire, pour simuler env.AI.toMarkdown dans les tests (la vraie conversion tourne chez Cloudflare) :
 * liens en [texte](url), balises retirées, entités courantes décodées, un retour à la ligne par fin de bloc.
 */
export function fakeMarkdown(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|select)\b[\s\S]*?<\/\1>/gi, "")
    .replace(
      /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_m, h: string, t: string) =>
        `[${t
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()}](${h})`,
    )
    .replace(/<\/?(?:br|p|div|li|tr|h[1-6]|span|table|ul)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&euro;/g, "€")
    .replace(/&sup2;/g, "²")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;/g, "'")
    .replace(/&eacute;/g, "é")
    .replace(/&egrave;/g, "è")
    .replace(/&agrave;/g, "à")
    .replace(/&ecirc;/g, "ê")
    .replace(/&ccedil;/g, "ç")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n");
}

/** Un env.AI simulé : conversion Markdown sommaire, modèle qui répond `answer` (objet JSON) avec un `usage` donné. */
export function fakeAi(
  answer: unknown,
  usage: { prompt_tokens: number; completion_tokens: number } = { prompt_tokens: 2400, completion_tokens: 700 },
) {
  const run = vi.fn(async (_model: string, _input: unknown) => ({
    choices: [{ message: { content: JSON.stringify(answer) } }],
    usage,
  }));
  const toMarkdown = vi.fn(async (file: unknown) => {
    const f = file as { blob: Blob };
    return { name: "page.html", format: "markdown", data: fakeMarkdown(await f.blob.text()) };
  });
  return { run, toMarkdown };
}

export type FakeAi = ReturnType<typeof fakeAi>;
export const withAi = (env: Env, ai: FakeAi | undefined, o: Partial<Env> = {}): Env => ({
  ...env,
  AI: ai as unknown as Env["AI"],
  ...o,
});
