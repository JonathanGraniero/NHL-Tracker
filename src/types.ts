export type TransactionType = "trade" | "waiver" | "signing";

export const ALL_TYPES: readonly TransactionType[] = ["trade", "waiver", "signing"];

/** What a channel can subscribe to: news about moves, the daily game schedule, and injuries. */
export type PostType = TransactionType | "games" | "injuries";

export const ALL_POST_TYPES: readonly PostType[] = [...ALL_TYPES, "injuries", "games"];

const PLURAL: Record<PostType, string> = {
  trade: "trades",
  waiver: "waivers",
  signing: "signings",
  games: "the daily schedule",
  injuries: "injuries",
};

/** ["trade", "waiver"] → "trades and waivers" */
export function describeTypes(types: readonly PostType[]): string {
  const words = ALL_POST_TYPES.filter((t) => types.includes(t)).map((t) => PLURAL[t]);
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** Countries NHL.com lists TV channels for. */
export type Country = "US" | "CA";

export function isCountry(value: string): value is Country {
  return value === "US" || value === "CA";
}
