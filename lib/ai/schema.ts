// lib/ai/schema.ts
//
// The per-review shape, declared once. AGENTS.MD: "The schema is declared
// once and validated in my own code on receipt." Both the validation
// layer (lib/ai/validate.ts) and, later, the worker import from here -
// nothing redeclares this shape.

import { z } from "zod";

export const ReviewSchema = z.object({
  sentiment: z.enum(["positive", "negative", "mixed"]),
  rating: z.number().int().min(1).max(5),
  // Non-empty: a theme or complaint that's "" carries no information, and
  // letting it through would mean the schema accepted output nothing
  // downstream could actually display.
  themes: z.array(z.string().min(1)),
  complaints: z.array(z.string().min(1)),
  // min(1): the empty string is trivially a substring of every string, so
  // an empty quote would sail through the hallucination check in
  // lib/ai/validate.ts without ever really being checked. Rejecting it
  // here means that check never has to special-case it.
  quotedEvidence: z.string().min(1),
});

export const ExtractorResponseSchema = z.object({
  reviews: z.array(ReviewSchema),
});

export type Review = z.infer<typeof ReviewSchema>;
export type ExtractorResponse = z.infer<typeof ExtractorResponseSchema>;
