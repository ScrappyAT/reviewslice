// lib/ai/validate.test.ts
//
// Run with `npm test`. Covers the five failure cases AGENTS.MD names, each
// distinguished by `reason` because the retry prompt differs per case, plus
// a valid response and the two normalization decisions documented in
// lib/ai/validate.ts (whitespace/line-wrap tolerated, case not).

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateExtractorResponse } from "./validate";

const SOURCE_TEXT =
  "The blender arrived on time and works great. Very happy with this purchase.\n" +
  'The battery life on this thing is genuinely disappointing, but I love the screen.\n' +
  "Terrible. Broke after a week and support never replied.";

function validResponseJson(): string {
  return JSON.stringify({
    reviews: [
      {
        sentiment: "positive",
        rating: 5,
        themes: ["delivery", "quality"],
        complaints: [],
        quotedEvidence: "The blender arrived on time and works great.",
      },
      {
        sentiment: "mixed",
        rating: 3,
        themes: ["battery life", "display"],
        complaints: ["short battery life"],
        quotedEvidence: "The battery life on this thing is genuinely disappointing",
      },
    ],
  });
}

test("valid response: parses and returns the reviews, unmodified", () => {
  const result = validateExtractorResponse(validResponseJson(), SOURCE_TEXT);
  assert.equal(result.valid, true);
  if (!result.valid) return; // narrows for TS below
  assert.equal(result.reviews.length, 2);
  assert.equal(result.reviews[0].sentiment, "positive");
  assert.equal(result.reviews[1].rating, 3);
});

test("failure 1: empty content", () => {
  const result = validateExtractorResponse("", SOURCE_TEXT);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.reason, "empty");
  assert.match(result.error, /empty response/i);

  // Whitespace-only counts as empty too - it's not meaningfully different
  // from "" for a caller that only cares whether there's content to parse.
  const whitespaceOnly = validateExtractorResponse("   \n\t  ", SOURCE_TEXT);
  assert.equal(whitespaceOnly.valid, false);
  if (!whitespaceOnly.valid) assert.equal(whitespaceOnly.reason, "empty");
});

test("failure 2: content is not JSON at all", () => {
  const result = validateExtractorResponse(
    "I'm sorry, I can't help with that request.",
    SOURCE_TEXT,
  );
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.reason, "not_json");
  assert.match(result.error, /could not be parsed as JSON/i);
});

test("failure 3: JSON parses but the shape is wrong", () => {
  // Valid JSON, but no "reviews" array at all - a structurally different
  // response, not a value problem within an otherwise-correct shape.
  const result = validateExtractorResponse(
    JSON.stringify({ result: "here are the reviews" }),
    SOURCE_TEXT,
  );
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.reason, "shape_invalid");
  assert.match(result.error, /exact shape/i);
});

test("failure 4: shape is right but a value is out of range", () => {
  const result = validateExtractorResponse(
    JSON.stringify({
      reviews: [
        {
          sentiment: "ecstatic", // not one of the three allowed values
          rating: 7, // outside 1-5
          themes: ["quality"],
          complaints: [],
          quotedEvidence: "The blender arrived on time and works great.",
        },
      ],
    }),
    SOURCE_TEXT,
  );
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.reason, "out_of_range");
  assert.match(result.error, /must be a whole number from 1 to 5/i);
});

test("failure 5: everything valid but a quotedEvidence is not in the source (hallucination)", () => {
  // The flagship case: fluent, plausible, entirely schema-valid - and
  // never said. The source reviews above are positive/mixed/negative
  // about a blender; this invents a complaint about customer service that
  // does not appear anywhere in SOURCE_TEXT.
  const result = validateExtractorResponse(
    JSON.stringify({
      reviews: [
        {
          sentiment: "negative",
          rating: 1,
          themes: ["customer service"],
          complaints: ["unhelpful support", "no refund offered"],
          quotedEvidence:
            "I called customer service three times and they refused to offer a refund even though the product was clearly defective.",
        },
      ],
    }),
    SOURCE_TEXT,
  );
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.reason, "hallucinated_quote");
  assert.match(result.error, /does not appear anywhere in the source text/i);
  assert.match(result.error, /Review 0/);
});

test("quote comparison: tolerates a line-wrap the model joins with a space", () => {
  // SOURCE_TEXT's third line is "Terrible. Broke after a week and support
  // never replied." on its own line, preceded by a newline. A model
  // reproducing this across what was originally two visually-wrapped
  // lines, joined with a single space instead of the source's exact
  // whitespace, has not invented anything.
  const wrappedSource = "Terrible. Broke after\na week and support never replied.";
  const result = validateExtractorResponse(
    JSON.stringify({
      reviews: [
        {
          sentiment: "negative",
          rating: 1,
          themes: ["reliability"],
          complaints: ["broke quickly"],
          quotedEvidence: "Terrible. Broke after a week and support never replied.",
        },
      ],
    }),
    wrappedSource,
  );
  assert.equal(result.valid, true);
});

test("quote comparison: tolerates curly quotes the model straightens", () => {
  const sourceWithCurlyQuotes = "The reviewer said “this is the best purchase I’ve made all year.”";
  const result = validateExtractorResponse(
    JSON.stringify({
      reviews: [
        {
          sentiment: "positive",
          rating: 5,
          themes: ["satisfaction"],
          complaints: [],
          // Straight quotes here; curly quotes in the source.
          quotedEvidence: 'this is the best purchase I\'ve made all year.',
        },
      ],
    }),
    sourceWithCurlyQuotes,
  );
  assert.equal(result.valid, true);
});

test("quote comparison: does NOT tolerate a case change - this is the line, not the exception", () => {
  const result = validateExtractorResponse(
    JSON.stringify({
      reviews: [
        {
          sentiment: "negative",
          rating: 1,
          themes: ["reliability"],
          complaints: ["broke quickly"],
          // Real source text is "Terrible." - capitalized differently here.
          quotedEvidence: "terrible. Broke after a week and support never replied.",
        },
      ],
    }),
    SOURCE_TEXT,
  );
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, "hallucinated_quote");
});
