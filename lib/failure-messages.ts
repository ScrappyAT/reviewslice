// lib/failure-messages.ts
//
// Maps a stored Job.errorMessage to what a user actually reads. Pure
// string logic, no imports from lib/ai/config.ts or anywhere else - safe
// to call from a client component, unlike lib/jobs.ts.
//
// Every errorMessage the worker actually stores (worker/index.ts) is
// either addressed to the *model* ("Your response did not pass
// validation:\n<zod dump>...") or is a raw provider/system string ("The
// model provider returned an error: 400 ..."). None of that is fit to
// show a person - AGENTS.MD: "Never a raw stack trace, never a blank
// screen." This function is what actually enforces that at display time,
// the same way lib/ai/validate.ts's quote check enforces "no paraphrasing"
// instead of just asking the model nicely.
//
// This is a deliberate coupling to the exact wording worker/index.ts and
// lib/ai/validate.ts produce - matched by stable prefix, not by an error
// code, because Job.errorMessage is free text, not a structured column.
// If that wording changes, this mapping has to change with it. The
// fallback branch exists exactly for the day that coupling breaks: an
// unrecognized message still gets a safe, honest, generic answer, never
// the raw string.
export function describeFailureForUser(errorMessage: string): string {
  if (errorMessage.startsWith("Could not read the uploaded file")) {
    return "We couldn't find your uploaded file. Please upload it again.";
  }
  if (errorMessage.startsWith("The request to the model timed out")) {
    return "This took longer than expected to process. Please try uploading it again.";
  }
  if (errorMessage.startsWith("The model provider returned an error:")) {
    return "Our AI provider had a temporary problem. Please try uploading this file again in a few minutes.";
  }
  if (
    errorMessage.startsWith("You returned an empty response") ||
    errorMessage.startsWith("Your response could not be parsed as JSON") ||
    errorMessage.startsWith("Your response did not pass validation:")
  ) {
    return "The AI didn't return a usable result for this file. Please try uploading it again.";
  }
  if (errorMessage.includes("does not appear anywhere in the source text")) {
    return "We couldn't verify part of what the AI found in your file, so we didn't save the result. Please try uploading it again.";
  }
  // Includes the "Unexpected error: ..." catch-all, and anything else
  // that doesn't match a known shape.
  return "Something unexpected went wrong while processing this file. Please try uploading it again.";
}
