export interface Team {
  /** NHL three-letter code, used as the key everywhere. */
  code: string;
  name: string;
  /** Lower-case names, nicknames and abbreviations that appear in headlines. */
  aliases: string[];
  /** Primary colour as a Discord embed integer. */
  color: number;
}

export const TEAMS: readonly Team[] = [
  { code: "ANA", name: "Anaheim Ducks", aliases: ["anaheim", "ducks"], color: 0xf47a38 },
  { code: "BOS", name: "Boston Bruins", aliases: ["boston", "bruins", "b's"], color: 0xfcb514 },
  { code: "BUF", name: "Buffalo Sabres", aliases: ["buffalo", "sabres"], color: 0x003087 },
  { code: "CGY", name: "Calgary Flames", aliases: ["calgary", "flames"], color: 0xc8102e },
  { code: "CAR", name: "Carolina Hurricanes", aliases: ["carolina", "hurricanes", "canes"], color: 0xcc0000 },
  { code: "CHI", name: "Chicago Blackhawks", aliases: ["chicago", "blackhawks", "hawks"], color: 0xcf0a2c },
  { code: "COL", name: "Colorado Avalanche", aliases: ["colorado", "avalanche", "avs"], color: 0x6f263d },
  { code: "CBJ", name: "Columbus Blue Jackets", aliases: ["columbus", "blue jackets", "jackets"], color: 0x002654 },
  { code: "DAL", name: "Dallas Stars", aliases: ["dallas", "stars"], color: 0x006847 },
  { code: "DET", name: "Detroit Red Wings", aliases: ["detroit", "red wings", "wings"], color: 0xce1126 },
  { code: "EDM", name: "Edmonton Oilers", aliases: ["edmonton", "oilers"], color: 0xff4c00 },
  { code: "FLA", name: "Florida Panthers", aliases: ["florida", "panthers"], color: 0xc8102e },
  { code: "LAK", name: "Los Angeles Kings", aliases: ["los angeles", "la kings", "kings"], color: 0x111111 },
  { code: "MIN", name: "Minnesota Wild", aliases: ["minnesota", "wild"], color: 0x154734 },
  { code: "MTL", name: "Montréal Canadiens", aliases: ["montreal", "montréal", "canadiens", "habs"], color: 0xaf1e2d },
  { code: "NSH", name: "Nashville Predators", aliases: ["nashville", "predators", "preds"], color: 0xffb81c },
  { code: "NJD", name: "New Jersey Devils", aliases: ["new jersey", "devils"], color: 0xce1126 },
  { code: "NYI", name: "New York Islanders", aliases: ["islanders", "isles"], color: 0x00539b },
  { code: "NYR", name: "New York Rangers", aliases: ["rangers", "nyr"], color: 0x0038a8 },
  { code: "OTT", name: "Ottawa Senators", aliases: ["ottawa", "senators", "sens"], color: 0xc52032 },
  { code: "PHI", name: "Philadelphia Flyers", aliases: ["philadelphia", "flyers", "philly"], color: 0xf74902 },
  { code: "PIT", name: "Pittsburgh Penguins", aliases: ["pittsburgh", "penguins", "pens"], color: 0xfcb514 },
  { code: "SJS", name: "San Jose Sharks", aliases: ["san jose", "sharks"], color: 0x006d75 },
  { code: "SEA", name: "Seattle Kraken", aliases: ["seattle", "kraken"], color: 0x99d9d9 },
  { code: "STL", name: "St. Louis Blues", aliases: ["st. louis", "st louis", "blues"], color: 0x002f87 },
  { code: "TBL", name: "Tampa Bay Lightning", aliases: ["tampa bay", "tampa", "lightning", "bolts"], color: 0x002868 },
  { code: "TOR", name: "Toronto Maple Leafs", aliases: ["toronto", "maple leafs", "leafs"], color: 0x00205b },
  { code: "UTA", name: "Utah Mammoth", aliases: ["utah", "mammoth"], color: 0x71afe5 },
  { code: "VAN", name: "Vancouver Canucks", aliases: ["vancouver", "canucks", "nucks"], color: 0x00205b },
  { code: "VGK", name: "Vegas Golden Knights", aliases: ["vegas", "golden knights", "knights"], color: 0xb4975a },
  { code: "WSH", name: "Washington Capitals", aliases: ["washington", "capitals", "caps"], color: 0xc8102e },
  { code: "WPG", name: "Winnipeg Jets", aliases: ["winnipeg", "jets"], color: 0x041e42 },
];

const BY_CODE = new Map(TEAMS.map((t) => [t.code, t]));

export function getTeam(code: string): Team | undefined {
  return BY_CODE.get(code.toUpperCase());
}

const CANADIAN = new Set(["CGY", "EDM", "MTL", "OTT", "TOR", "VAN", "WPG"]);

export function isCanadianTeam(code: string): boolean {
  return CANADIAN.has(code.toUpperCase());
}

const normalize = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/**
 * Turns what a user typed (or picked from autocomplete) into a team.
 * Accepts a code ("TOR"), full name ("Toronto Maple Leafs") or alias ("leafs").
 */
export function resolveTeam(input: string): Team | undefined {
  const q = normalize(input);
  if (!q) return undefined;
  return TEAMS.find(
    (t) => normalize(t.code) === q || normalize(t.name) === q || t.aliases.some((a) => normalize(a) === q),
  );
}

/** Teams whose code, name or alias contains the query, for slash-command autocomplete. */
export function searchTeams(query: string): Team[] {
  const q = normalize(query);
  if (!q) return [...TEAMS];
  const starts: Team[] = [];
  const contains: Team[] = [];
  for (const t of TEAMS) {
    const fields = [t.code, t.name, ...t.aliases].map(normalize);
    if (fields.some((f) => f.startsWith(q) || f.split(" ").some((w) => w.startsWith(q)))) starts.push(t);
    else if (fields.some((f) => f.includes(q))) contains.push(t);
  }
  return [...starts, ...contains];
}
