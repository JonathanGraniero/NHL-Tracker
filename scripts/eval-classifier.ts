// Runs the labelled real headlines through the classifier with the real
// Claude, and lists every wrong answer. Run it before and after changing the
// prompt in src/news/model.ts: a fix for one wording can break another.
//
//   ANTHROPIC_API_KEY=... npm run eval
//
// About 490 of the ~730 headlines pass the code checks and reach Claude
// (roughly $0.15 a run). The labels are in test/fixtures/labelled-headlines.json:
// "known" are the old classifier tests and NHL.com fixture, "fresh" are real
// NHL.com stories and r/hockey insider posts from July–October 2026, labelled
// by hand. Headlines marked debatable are listed but not scored.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, type Verdict } from "../src/news/classify";
import { claudeReader, type Reading } from "../src/news/model";

interface Labelled {
  set: "known" | "fresh";
  origin: string;
  title: string;
  links: string[];
  expected: { post: boolean; type?: string; players?: string[]; debatable?: string };
}

const CONCURRENCY = 6;

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY to run the eval.");
  process.exit(1);
}

const headlines: Labelled[] = JSON.parse(readFileSync(join(import.meta.dirname, "../test/fixtures/labelled-headlines.json"), "utf8"));
const read = claudeReader(apiKey);
const results: { h: Labelled; verdict: Verdict; reading?: Reading }[] = [];

const queue = [...headlines];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let h = queue.shift(); h; h = queue.shift()) {
      let reading: Reading | undefined;
      const verdict = await classify(h, async (headline) => (reading = await read(headline)));
      results.push({ h, verdict, reading });
    }
  }),
);

const answer = (v: Verdict) => (v.confirmed ? `posts ${v.type}` : "unavailable" in v ? "unavailable" : "skips");
const right = (h: Labelled) => (h.expected.post ? `posts ${h.expected.type}` : "skips");
const why = (r: (typeof results)[number]) => (r.reading?.ok ? r.reading.reason : r.verdict.confirmed ? "" : r.verdict.reason);

for (const set of ["known", "fresh"] as const) {
  const scored = results.filter((r) => r.h.set === set && !r.h.expected.debatable);
  const asked = scored.filter((r) => r.reading).length;
  const wrong = scored.filter((r) => answer(r.verdict) !== right(r.h));
  const falsePosts = wrong.filter((r) => r.verdict.confirmed && !r.h.expected.post).length;
  const missed = wrong.filter((r) => !r.verdict.confirmed && r.h.expected.post).length;
  console.log(`\n## ${set}: ${scored.length} headlines, ${asked} reached Claude, ${wrong.length} wrong (${falsePosts} false posts, ${missed} missed, ${wrong.length - falsePosts - missed} other)`);
  for (const r of wrong) console.log(`- ${r.h.title}\n    right: ${right(r.h)} · got: ${answer(r.verdict)} · ${why(r)}`);
}

const debatable = results.filter((r) => r.h.expected.debatable);
console.log(`\n## debatable (not scored): ${debatable.length}`);
for (const r of debatable) console.log(`- ${r.h.title}\n    ${r.h.expected.debatable} · got: ${answer(r.verdict)}`);
