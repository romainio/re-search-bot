/** Lecteurs connus (PARSERS) ; liste à l'exécution pour valider la configuration. */
export const PARSER_IDS = [
  "bienici",
  "orpi",
  "foncia",
  "lbi",
  "lbi2",
  "fnaim",
  "nestenn",
  "apimo",
  "netty",
  "laforet",
  "century21",
  "oralia",
  "osl",
  "billie",
  "office5",
  "at1605",
  "caimmo",
  "wpapimo",
  "era",
  "universal",
  "mail",
] as const;
export type ParserId = (typeof PARSER_IDS)[number];
export interface SourceDef {
  id: string;
  name: string;
  url: string;
  parser: ParserId;
  /** Groupe de lecture, 0 à TOTAL_GROUPS - 1 (réparti par assignGroups). */
  group: number;
  /**
   * Zones (codes postaux) couvertes : celles que filtre l'URL si filteredToZones, sinon celles de l'agence. Servent au libellé
   * d'une annonce sans code postal, au drapeau « quartier » et au passage silencieux d'une zone ajoutée.
   */
  zones: string[];
  /** L'URL ne renvoie que des annonces de `zones` : une annonce sans code postal y est réputée localisée. */
  filteredToZones: boolean;
  phone: string | null;
  encoding: "utf-8" | "windows-1252";
  active: boolean;
  /**
   * Marqueur de fin de liste : la lecture en flux s'arrête au premier morceau qui le contient. Prouvé sur la fixture : après la
   * dernière carte (mêmes annonces avec et sans coupure). Absent : page entière.
   */
  stopMarker?: string;
  /** Page 2 et suivantes : zéro carte y est normal ; un changement de gabarit reste détecté par la page 1. */
  extraPage?: boolean;
  /** Cadence réduite (minutes, multiple de 5 qui divise 60), pour une source qui limite le débit (HTTP 429). */
  every?: number;
  /** Octets lus au plus (défaut SOURCE_MAX_BYTES). */
  maxBytes?: number;
  /** Source universelle : "browser" rend la page (construite en JavaScript) dans Browser Run avant la conversion Markdown. */
  render?: "browser";
  /** Source virtuelle (alertes par mail) : jamais lue par le cron, donc jamais « en panne » ni « en retard ». */
  virtual?: true;
}
export interface Listing {
  source: string;
  id: string;
  url: string;
  price: number | null;
  charges: number | null;
  priceIsCC: boolean | null;
  surface: number | null;
  rooms: number | null;
  /** Étage quand la source le donne (0 = rez-de-chaussée). */
  floor?: number | null;
  title: string | null;
  address: string | null;
  district: string | null;
  postalCode: string | null;
  photo: string | null;
  /** Galerie (https, GALLERY_MAX au plus) lue sur la fiche ; `photo` reste la vignette. */
  photos?: string[];
  agency: string | null;
  phone: string | null;
  propertyType: string | null;
  publishedAt: string | null;
  /** Début du texte de l'annonce tiré de sa fiche. */
  description?: string | null;
}
export type Flag = "charges_inconnues" | "localisation_non_confirmee" | "prix_inconnu" | "quartier";
export interface Evaluation {
  keep: boolean;
  rentCC: number | null;
  flags: Flag[] /** Si keep=false : "type" | "localisation" | "surface" | "pieces" | "rdc" | "prix_bas" | "prix_haut". */;
  reason?: string;
}
export interface Env {
  DB: D1Database;
  ADMIN_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  /** Conversation Telegram ; à défaut, celle liée en D1 par /start <code>. */
  TELEGRAM_CHAT_ID?: string;
  /** "true" : tableau de bord public ; sinon réservé à ?k=ADMIN_KEY ou au cookie posé après une visite avec la clé. */
  DASHBOARD_PUBLIC?: string;
  WHATSAPP_ENABLED: string;
  CALLMEBOT_PHONE?: string;
  CALLMEBOT_APIKEY?: string;
  /** Service binding vers ce Worker pour les sous-lots /part ; à défaut, ctx.exports. */
  SELF?: Fetcher;
  /** Analyse des photos (grille de critères et mini description). Les interrupteurs valent "true" ou "false" (défaut). */
  PHOTO_SCORING?: string;
  /** Écart au prix médian du marché dans les alertes et le bilan du soir. */
  MARKET_HINTS?: string;
  /** Indices géographiques et réglementaires (src/geo/). */
  GEO_HINTS?: string;
  /** Binding Workers AI, requis par les fonctions IA. */
  AI?: {
    run(model: string, input: unknown): Promise<unknown>;
    /** Conversion de documents en Markdown, gratuite pour le HTML ; absente des tests. */
    toMarkdown?(
      files: { name: string; blob: Blob } | { name: string; blob: Blob }[],
      options?: unknown,
    ): Promise<unknown>;
  };
  /** Lecteur universel ; éteint, ses sources sont ignorées. */
  UNIVERSAL_READER?: string;
  /** Rendu navigateur des sources universelles `render: "browser"`. */
  BROWSER_RENDER?: string;
  /** Binding Browser Run, non déclaré par défaut (docs/lecteur-universel.md). */
  BROWSER?: { quickAction(name: string, body: unknown): Promise<Response> };
  /** Alertes par mail ; éteint, tout mail reçu est ignoré. */
  MAIL_INGEST?: string;
  PROSPECT_ENABLED?: string;
  /** Étape IA « publie-t-il des locations ? » de la prospection. */
  PROSPECT_AI?: string;
  /** Telegram interactif : webhook /telegram, profil, boutons ; éteint, 404. */
  TELEGRAM_INTERACTIVE?: string;
  /** Secret du webhook Telegram ; absent, dérivé d'ADMIN_KEY par HMAC. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Assistant conversationnel ; éteint, un message libre reçoit l'aide. */
  ASSISTANT_ENABLED?: string;
  /** Serveur MCP (route /mcp) ; éteint, 404. */
  MCP_ENABLED?: string;
  SEMANTIC_SEARCH?: string;
  /** Index Vectorize, absent tant qu'il n'est pas créé et déclaré. */
  VECTORIZE?: VectorizeLike;
}
/** Partie de l'API Vectorize utilisée par le Worker. */
export interface VectorizeLike {
  upsert(
    vectors: { id: string; values: number[]; metadata?: Record<string, string | number | boolean> }[],
  ): Promise<unknown>;
  query(
    vector: number[],
    options: { topK: number; returnMetadata?: "all" | "indexed" | "none"; filter?: Record<string, unknown> },
  ): Promise<{ matches: { id: string; score: number; metadata?: Record<string, unknown> | null }[] }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}
