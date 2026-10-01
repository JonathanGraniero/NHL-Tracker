// NHL.com lists networks by short code ("SNP", "TVAS", "MSG-B"). These are
// the ones whose names we're sure of; anything else is shown as NHL.com
// sends it. French-language channels are marked, since most viewers outside
// Quebec won't recognise them.
const NAMES: Record<string, string> = {
  // Canada
  SN: "Sportsnet",
  SN1: "Sportsnet One",
  SN360: "Sportsnet 360",
  "SN+": "Sportsnet+",
  SNE: "Sportsnet East",
  SNO: "Sportsnet Ontario",
  SNP: "Sportsnet Pacific",
  SNW: "Sportsnet West",
  CITY: "Citytv",
  Prime: "Prime Video",
  TVAS: "TVA Sports",
  TVAS2: "TVA Sports 2",
  RDS: "RDS",
  RDS2: "RDS2",
  RDSI: "RDS Info",
  // United States
  NHLN: "NHL Network",
  HULU: "Hulu",
  "HBO MAX": "HBO Max",
  ALT: "Altitude",
  CHSN: "Chicago Sports Network",
  DSN: "Detroit SportsNet",
  MNMT: "Monumental Sports",
  "MSG-B": "MSG Buffalo",
  MSGSN: "MSG Sportsnet",
  NBCSCA: "NBC Sports California",
  NBCSP: "NBC Sports Philadelphia",
  SCRIPPS: "Scripps Sports",
  "SN-PIT": "SportsNet Pittsburgh",
};

const FRENCH = new Set(["TVAS", "TVAS2", "RDS", "RDS2", "RDSI"]);

export interface Network {
  name: string;
  french: boolean;
}

export function network(code: string): Network {
  return { name: NAMES[code] ?? code, french: FRENCH.has(code) };
}

/** "TVA Sports (French)", "NESN (BOS)", "RDS (MTL, French)" */
export function networkLabel(code: string, teams: readonly string[] = []): string {
  const { name, french } = network(code);
  const notes = [...teams, ...(french ? ["French"] : [])];
  return notes.length > 0 ? `${name} (${notes.join(", ")})` : name;
}
