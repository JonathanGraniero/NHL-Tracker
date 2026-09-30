export type TransactionType = "trade" | "waiver" | "signing";

export const ALL_TYPES: readonly TransactionType[] = ["trade", "waiver", "signing"];

const PLURAL: Record<TransactionType, string> = { trade: "trades", waiver: "waivers", signing: "signings" };

/** ["trade", "waiver"] → "trades and waivers" */
export function describeTypes(types: readonly TransactionType[]): string {
  const words = ALL_TYPES.filter((t) => types.includes(t)).map((t) => PLURAL[t]);
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
