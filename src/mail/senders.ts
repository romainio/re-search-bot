// Expéditeurs autorisés des alertes par mail (liste blanche) : un mail d'un autre domaine est rejeté. Une ligne ici suffit à
// ajouter un expéditeur : la source virtuelle `mail_<clé>` apparaît au registre. Domaine à vérifier sur le premier mail reçu.

export interface MailSender {
  /** Clé courte, minuscules et chiffres : la source virtuelle s'appelle `mail_<key>`. */
  key: string;
  name: string;
  /** Domaines d'expédition (le domaine exact ou un sous-domaine : « mail.seloger.com » est de « seloger.com »). */
  domains: string[];
  /** Page d'accueil (lien de repli d'une annonce sans lien, tableau de bord). */
  home: string;
  /** Motif des liens d'annonce : active le lecteur déterministe ; absent ou sans résultat, lecteur universel. */
  linkPattern?: string;
  phone?: string | null;
}

export const MAIL_SENDERS: readonly MailSender[] = [
  {
    key: "seloger",
    name: "SeLoger (alerte mail)",
    domains: ["seloger.com"],
    home: "https://www.seloger.com/",
    linkPattern: "seloger\\.com/(?:annonces|detail|classified)",
  },
  {
    key: "leboncoin",
    name: "Leboncoin (alerte mail)",
    domains: ["leboncoin.fr"],
    home: "https://www.leboncoin.fr/",
    linkPattern: "leboncoin\\.fr/(?:ad|locations)/",
  },
  {
    key: "bienici",
    name: "Bien'ici (alerte mail)",
    domains: ["bienici.com"],
    home: "https://www.bienici.com/",
    linkPattern: "bienici\\.com/annonce/",
  },
  {
    key: "pap",
    name: "PAP (alerte mail)",
    domains: ["pap.fr"],
    home: "https://www.pap.fr/",
    linkPattern: "pap\\.fr/annonces?/",
  },
  {
    key: "logicimmo",
    name: "Logic-Immo (alerte mail)",
    domains: ["logic-immo.com"],
    home: "https://www.logic-immo.com/",
  },
];

/** Domaine de l'adresse « nom@domaine » (minuscules), ou null. */
export function domainOf(address: string): string | null {
  const m = address
    .trim()
    .toLowerCase()
    .match(/^[^@\s]+@([a-z0-9.-]+)$/);
  return m ? m[1] : null;
}

/** Adresse d'un en-tête From (« Nom <a@b.fr> » ou « a@b.fr »), en minuscules, ou null. */
export function addressOf(from: string | null | undefined): string | null {
  if (!from) return null;
  const m = from.match(/<([^<>\s]+@[^<>\s]+)>/) ?? from.match(/([^\s<>"',;]+@[^\s<>"',;]+)/);
  return m ? m[1].toLowerCase() : null;
}

/** Expéditeur autorisé de cette adresse (domaine exact ou sous-domaine d'un domaine de la liste), ou null. */
export function senderFor(address: string | null, senders: readonly MailSender[] = MAIL_SENDERS): MailSender | null {
  const d = address ? domainOf(address) : null;
  if (!d) return null;
  return senders.find((s) => s.domains.some((x) => d === x || d.endsWith(`.${x}`))) ?? null;
}
