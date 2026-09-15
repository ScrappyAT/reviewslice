// lib/ai/provider.ts
//
// The only module in this codebase that imports the DeepSeek/OpenAI SDK.
// Both roles - extractor and responder - go through the two functions
// exported here; nothing else calls the model directly. Neither function
// validates or parses what comes back - that's the zod/quote-check layer
// (step 6), sitting on top of this module, not in it. This module's job
// ends at "here is what the provider said, and how to read that outcome."

import OpenAI from "openai";
import {
  DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL,
  MODELS,
  THINKING_ENABLED,
  TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  TEMPERATURE,
} from "./config";
import { EXTRACTOR_SYSTEM_PROMPT } from "./prompts/extractor";
import { RESPONDER_SYSTEM_PROMPT } from "./prompts/responder";

const client = new OpenAI({
  apiKey: DEEPSEEK_API_KEY,
  baseURL: DEEPSEEK_BASE_URL,
});

// DeepSeek's own field name for the cache-hit count (verified in
// DOC/deepseek-verification.md, confirmed against a real call), not the
// OpenAI SDK's own convention for the same number
// (prompt_tokens_details.cached_tokens) - inspecting the installed SDK's
// types (node_modules/openai/resources/completions.d.ts) confirms the
// SDK's types don't declare this field. This is exactly the "compatible,
// not identical" gap the brief asks to be explained rather than papered
// over, so this module reads it off the raw response with its own narrow
// type rather than trusting OpenAI.CompletionUsage to have a field for it.
// A live call showed DeepSeek actually sends the same count in both
// places at once (their own top-level field, and mirrored into OpenAI's
// nested prompt_tokens_details.cached_tokens) - this module only reads
// the one below; the nested copy is redundant, not missing.
interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

function readUsage(usage: unknown): TokenUsage {
  const u = (usage ?? {}) as DeepSeekUsage;
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    cachedTokens: u.prompt_cache_hit_tokens ?? 0,
  };
}

export type ProviderCallResult =
  | { outcome: "success"; content: string; usage: TokenUsage }
  // First-class, not a variant of "success" or "error" - DeepSeek's own
  // JSON Output guide documents this as a known behaviour, not a bug
  // report, so the caller (the validation layer, step 6) needs to be able
  // to tell "the model replied but said nothing" apart from both a normal
  // result and a transport failure. Usage is still included: tokens were
  // consumed and billed even though content came back empty.
  | { outcome: "empty_content"; usage: TokenUsage }
  // No usage here - a request that never got a response has nothing to
  // report token counts for.
  | { outcome: "timeout" }
  // status is null for a connection-level failure (no HTTP response at
  // all - DNS, connection reset) as opposed to a real error response from
  // DeepSeek. This module classifies retryable vs. terminal; it does not
  // act on that classification. Whether and when to actually retry is the
  // worker's job (AGENTS.MD, provider boundary section).
  | { outcome: "error"; status: number | null; retryable: boolean; message: string };

// Terminal per DOC/deepseek-verification.md: fixing the request is the
// only way forward, so retrying it unchanged would just fail identically
// and spend the one retry budget for nothing. Anything not in this set
// (429/500/503, or an undocumented status, or no status at all) defaults
// to retryable - safer to treat an error this taxonomy doesn't name as
// transient than to give up on a job for a reason we can't point to.
const TERMINAL_STATUSES = new Set([400, 401, 402, 422]);

function classifyError(error: unknown): ProviderCallResult {
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return { outcome: "timeout" };
  }
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? null;
    return {
      outcome: "error",
      status,
      retryable: status === null ? true : !TERMINAL_STATUSES.has(status),
      message: error.message,
    };
  }
  // Not an APIError at all - a plain network/runtime failure this SDK
  // didn't wrap (should be rare; APIConnectionError already covers most of
  // this). Treated the same as an unrecognized status: retryable.
  return {
    outcome: "error",
    status: null,
    retryable: true,
    message: error instanceof Error ? error.message : String(error),
  };
}

function toResult(response: OpenAI.Chat.ChatCompletion): ProviderCallResult {
  const usage = readUsage(response.usage);
  const content = response.choices[0]?.message?.content;
  if (!content || content.trim() === "") {
    return { outcome: "empty_content", usage };
  }
  return { outcome: "success", content, usage };
}

// thinking is a DeepSeek extension the OpenAI SDK's types don't declare
// (verified against node_modules/openai's request types) - built as a
// typed superset of the SDK's own params and passed through as a variable,
// not an inline object literal, so TypeScript's excess-property check
// (which only fires on literals) doesn't force a blanket `any` just to
// send one extra field to a compatible-but-not-identical endpoint.
type DeepSeekChatParams = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & {
  thinking?: { type: "enabled" | "disabled" };
};

// Every call disables the SDK's own default internal retry (maxRetries: 2)
// on top of ours. AGENTS.MD is explicit that this module reports whether
// an error is retryable, it does not decide to retry - that's the
// worker's job. Leaving the SDK's default in place would mean a second,
// invisible retry policy running underneath the one the worker actually
// controls.
const NO_SDK_RETRY = { maxRetries: 0 } as const;

export async function runExtractor(fileContent: string): Promise<ProviderCallResult> {
  const params: DeepSeekChatParams = {
    model: MODELS.extractor,
    temperature: TEMPERATURE.extractor,
    // max_tokens, not the newer max_completion_tokens: DeepSeek's own JSON
    // Output guide documents max_tokens (DOC/deepseek-verification.md);
    // the OpenAI-renamed parameter isn't confirmed supported by DeepSeek's
    // endpoint, and silently sending an unrecognized cap would mean no cap
    // at all.
    max_tokens: MAX_OUTPUT_TOKENS.extractor,
    // json_object mode: the "json" mode DeepSeek's docs actually support -
    // there is no json_schema mode to ask for instead (verified in
    // DOC/deepseek-verification.md). The system prompt supplies the shape;
    // this only turns on the mode.
    response_format: { type: "json_object" },
    thinking: { type: THINKING_ENABLED.extractor ? "enabled" : "disabled" },
    messages: [
      // The word "json" must appear in the prompt for json_object mode to
      // be accepted - it's in the system prompt itself (see
      // lib/ai/prompts/extractor.ts), not added here as a workaround.
      { role: "system", content: EXTRACTOR_SYSTEM_PROMPT },
      { role: "user", content: fileContent },
    ],
  };

  try {
    const response = await client.chat.completions.create(params, {
      timeout: TIMEOUT_MS.extractor,
      ...NO_SDK_RETRY,
    });
    return toResult(response);
  } catch (error) {
    return classifyError(error);
  }
}

// Takes the already-validated ReviewResult fields, not the original review
// text - deliberately. Nothing in this schema stores "this review's own
// source text" (see the quotedEvidence re-verification discussion:
// re-checking genuineness means re-reading the file at Job.storageKey, not
// trusting a second copy of review text). The responder doesn't need the
// original text either - sentiment, rating, themes, complaints, and the
// one verified quote are enough to write a specific, relevant reply, and
// they're the trusted, already-validated data, not a raw re-read.
export interface ReviewContext {
  sentiment: string;
  rating: number;
  themes: string[];
  complaints: string[];
  quotedEvidence: string;
}

function formatReviewContext(review: ReviewContext): string {
  return [
    `Sentiment: ${review.sentiment}`,
    `Rating: ${review.rating}/5`,
    `Themes: ${review.themes.join(", ") || "none"}`,
    `Complaints: ${review.complaints.join(", ") || "none"}`,
    `Quoted from the review: "${review.quotedEvidence}"`,
  ].join("\n");
}

export async function runResponder(review: ReviewContext): Promise<ProviderCallResult> {
  const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & {
    thinking?: { type: "enabled" | "disabled" };
  } = {
    model: MODELS.responder,
    temperature: TEMPERATURE.responder,
    max_tokens: MAX_OUTPUT_TOKENS.responder,
    // No response_format here - the responder writes prose, not JSON.
    thinking: { type: THINKING_ENABLED.responder ? "enabled" : "disabled" },
    messages: [
      { role: "system", content: RESPONDER_SYSTEM_PROMPT },
      { role: "user", content: formatReviewContext(review) },
    ],
  };

  try {
    const response = await client.chat.completions.create(params, {
      timeout: TIMEOUT_MS.responder,
      ...NO_SDK_RETRY,
    });
    return toResult(response);
  } catch (error) {
    return classifyError(error);
  }
}
