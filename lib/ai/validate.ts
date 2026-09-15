// lib/ai/validate.ts
//
// The only place a raw model response becomes trusted data. AGENTS.MD:
// "DeepSeek has no schema enforcement, so my validation is not a
// backstop - it is the only check." Nothing downstream of
// validateExtractorResponse() should ever read an unvalidated response.

import { z } from "zod";
import { ExtractorResponseSchema, type Review } from "./schema";

export type ValidationFailureReason =
  | "empty"
  | "not_json"
  | "shape_invalid"
  | "out_of_range"
  | "hallucinated_quote";

export type ValidationResult =
  | { valid: true; reviews: Review[] }
  // error is written for two audiences at once, per AGENTS.MD: fed back to
  // the model as retry context, and stored in RawModelResponse.validationError
  // for a human reading the row. One string does both jobs here.
  | { valid: false; reason: ValidationFailureReason; error: string };

// ---------------------------------------------------------------------------
// Quote comparison
//
// "Literal substring" is enforced strictly, with exactly two narrow,
// mechanical normalizations before comparing - both about how text is
// *encoded*, never about what it *says*:
//
// 1. Whitespace runs (spaces, tabs, newlines) collapse to one space, and
//    both sides are trimmed. A review that wraps across lines in the
//    uploaded file and gets reproduced as one line by the model hasn't
//    been paraphrased - it's the same text, differently wrapped. Without
//    this, routine reformatting the model doesn't control would fail the
//    check the same as an actual fabrication would.
// 2. Curly/smart quotes and apostrophes normalize to their straight ASCII
//    equivalents. Models frequently "prettify" punctuation like this even
//    while reproducing the surrounding words exactly - a well-known,
//    single-character-class substitution, not a change to what was said.
//
// Deliberately NOT normalized: case, spelling, or any other punctuation.
// A model that "corrects" a misspelling or changes capitalization has
// changed what the text says - a review in ALL CAPS is not the same
// statement in lowercase, and the extractor's own system prompt already
// tells it not to do this (lib/ai/prompts/extractor.ts). This check is
// what actually enforces that instruction rather than trusting it.
//
// What this costs: in principle, a fabricated quote that happened to
// differ from real source text only by whitespace or quote-style could
// slip through as "close enough." In practice a hallucinated quote is
// invented content, not a reformatted real one - normalizing two cosmetic
// dimensions doesn't hand a model a way to fabricate content, only a way
// to reformat real content without being wrongly flagged. The cost is
// theoretical, not an observed failure mode.
// ---------------------------------------------------------------------------

function normalizeForComparison(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function isLiteralSubstring(quote: string, normalizedSource: string): boolean {
  const normalizedQuote = normalizeForComparison(quote);
  // Guards a degenerate case the schema's min(1) can't: a quote that is
  // only whitespace passes min(1) (length >= 1) but normalizes to
  // nothing, and an empty needle is trivially "found" in any source text.
  if (normalizedQuote.length === 0) {
    return false;
  }
  return normalizedSource.includes(normalizedQuote);
}

// ---------------------------------------------------------------------------
// Shape-failure classification
//
// zod v4 issue codes (node_modules/zod/v4/core/errors.d.ts): invalid_type
// and unrecognized_keys mean the response isn't shaped like the schema at
// all (a missing field, a field of the wrong type, an object where an
// array was expected). too_small / too_big / invalid_value mean the shape
// is right but a value inside it isn't (a rating outside 1-5, a sentiment
// outside the three allowed values). These get different retry guidance -
// "match this shape" versus "use a valid value" - so they're classified
// separately instead of being reported as one generic "invalid".
// ---------------------------------------------------------------------------

function classifyZodError(error: z.ZodError): "shape_invalid" | "out_of_range" {
  const isStructural = error.issues.some(
    (issue) => issue.code === "invalid_type" || issue.code === "unrecognized_keys" || issue.code === "invalid_union",
  );
  return isStructural ? "shape_invalid" : "out_of_range";
}

export function validateExtractorResponse(content: string, sourceText: string): ValidationResult {
  if (!content || content.trim() === "") {
    return {
      valid: false,
      reason: "empty",
      error:
        'You returned an empty response. Return the JSON object described in your instructions: {"reviews": [...]}, with one entry per review found in the input.',
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      reason: "not_json",
      error: `Your response could not be parsed as JSON (${message}). Return only the JSON object described in your instructions - no other text, and no markdown code fences, before or after it.`,
    };
  }

  const parsed = ExtractorResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const reason = classifyZodError(parsed.error);
    const issues = z.prettifyError(parsed.error);
    const guidance =
      reason === "shape_invalid"
        ? 'Return a JSON object of the exact shape: {"reviews": [{"sentiment": "positive" | "negative" | "mixed", "rating": <integer 1-5>, "themes": [...], "complaints": [...], "quotedEvidence": "..."}]}.'
        : 'sentiment must be exactly one of "positive", "negative", or "mixed"; rating must be a whole number from 1 to 5; quotedEvidence, and every theme and complaint, must be non-empty.';
    return {
      valid: false,
      reason,
      error: `Your response did not pass validation:\n${issues}\n${guidance}`,
    };
  }

  const normalizedSource = normalizeForComparison(sourceText);
  const { reviews } = parsed.data;
  for (let i = 0; i < reviews.length; i++) {
    const review = reviews[i];
    if (!isLiteralSubstring(review.quotedEvidence, normalizedSource)) {
      return {
        valid: false,
        reason: "hallucinated_quote",
        error: `Review ${i}'s quotedEvidence - "${review.quotedEvidence}" - does not appear anywhere in the source text you were given. quotedEvidence must be copied exactly from the input, not paraphrased, summarized, or invented. Re-check this review against the actual input text and use a passage that genuinely appears in it.`,
      };
    }
  }

  return { valid: true, reviews };
}
