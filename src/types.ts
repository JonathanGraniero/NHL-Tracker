export type TransactionType = "trade" | "waiver" | "signing";

export const ALL_TYPES: readonly TransactionType[] = ["trade", "waiver", "signing"];

/** What a channel can subscribe to: news about moves, plus the daily game schedule. */
export type PostType = TransactionType | "games";

export const ALL_POST_TYPES: readonly PostType[] = [...ALL_TYPES, "games"];

const PLURAL: Record<PostType, string> = {
  trade: "trades",
  waiver: "waivers",
  signing: "signings",
  games: "the daily schedule",
};

/** ["trade", "waiver"] → "trades and waivers" */
export function describeTypes(types: readonly PostType[]): string {
  const words = ALL_POST_TYPES.filter((t) => types.includes(t)).map((t) => PLURAL[t]);
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
