import { describe, expect, it } from "vitest";

import { fewest_for_spread, meaning_floor } from "../src/shared/search/search.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Scores spread evenly from low to high, for the documents a query has nothing to do with.
function spread(count: number, low: number, high: number): number[] {
  return Array.from({ length: count }, (_, at) => low + ((high - low) * at) / Math.max(1, count - 1));
}

interface Fixture {
  // The documents that answer the query, and those that should not count.
  right: number[];
  wrong: number[];
  // Right ones the rule may miss.
  may_miss?: number[];
}

// Scores measured with Qwen3-Embedding-0.6B over 37 home-renovation documents; the unrelated rest, which the run did not
// list one by one, spread over the range it gave for unrelated text.
const measured: Record<string, Fixture> = {
  "government revenue declaration": { right: [0.734, 0.673, 0.584, 0.551], wrong: spread(33, 0.3, 0.5) },
  "who wires the electrical sockets": { right: [0.677, 0.627], wrong: [0.509, ...spread(34, 0.3, 0.5)] },
  "growing vegetables": { right: [0.737, 0.712], may_miss: [0.436], wrong: spread(34, 0.3, 0.5) },
  "how to bake sourdough bread": { right: [], wrong: [0.475, ...spread(10, 0.4, 0.47), ...spread(26, 0.25, 0.355)] },
};

// Weak hits near 0.56 that the rule keeps, after the right ones.
const countertop = { right: [0.747, 0.653], weak: [0.565, 0.561, 0.556], wrong: spread(32, 0.3, 0.5) };

function kept(scores: number[]): number[] {
  const floor = meaning_floor(scores);
  return floor === null ? [] : scores.filter((score) => score >= floor).sort((first, second) => second - first);
}

// ── Rule ─────────────────────────────────────────────────────────────────────

describe("the meaning rule", () => {
  for (const [query, { right, wrong, may_miss = [] }] of Object.entries(measured)) {
    it(`keeps the right documents and none of the wrong ones for "${query}"`, () => {
      const found = kept([...right, ...wrong, ...may_miss]);

      expect(found.filter((score) => !may_miss.includes(score))).toEqual(right);
    });
  }

  it("keeps the two right countertop documents first, and the weak ones near 0.56 after them", () => {
    const found = kept([...countertop.right, ...countertop.weak, ...countertop.wrong]);

    expect(found.slice(0, 2)).toEqual(countertop.right);
    expect(found.slice(2).every((score) => countertop.weak.includes(score))).toBe(true);
  });

  it("does not depend on one model's scale: any rescaling keeps the same documents", () => {
    const rescalings = [(score: number) => score, (score: number) => 0.2 + 0.5 * score, (score: number) => 3 * score - 1.4];
    for (const { right, wrong, may_miss = [] } of Object.values(measured)) {
      const scores = [...right, ...wrong, ...may_miss];
      const expected = kept(scores).map((score) => scores.indexOf(score));
      for (const rescale of rescalings) {
        const moved = scores.map(rescale);
        expect(kept(moved).map((score) => moved.indexOf(score))).toEqual(expected);
      }
    }
  });

  it("finds nothing when every document scores alike, and judges a handful by their range", () => {
    expect(meaning_floor([])).toBeNull();
    expect(meaning_floor(Array.from({ length: 20 }, () => 0.45))).toBeNull();
    expect(meaning_floor([0.9])).toBeNull();
    expect(kept([0.9, 0.1, 0.12, 0.05])).toEqual([0.9]);
    expect(fewest_for_spread).toBeGreaterThan(4);
  });
});
