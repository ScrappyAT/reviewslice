# Assessment 3 — The AI Integration Slice

Time budget: 18 to 22 hours.
Deadline: Wednesday 17 September 2026.

## Deliverables

1. A GitHub repository containing the working slice
2. A `DOCUMENTATION.md` at the repository root, eight sections, same structure as the
   other assessments
3. A LinkedIn post about what was built and the concepts behind it

The documentation carries as much weight as the code.

## What to build

A single AI-powered flow: a user uploads something, a background job processes it through
a model, and the result appears.

Choose your own domain. Receipts to expense summaries, handwritten notes to structured
text, job descriptions to structured requirements, product photos to descriptions. It does
not matter what it is. It matters that it runs through a real model, in the background,
with structured output.

### Screens

- An upload view accepting one or more files, with size and type restrictions enforced
- A processing state that honestly reflects what is happening, showing pending,
  processing, done, or failed
- A result view showing the output
- One user-triggered follow-up action on the result, such as summarise, rephrase, or
  expand

### Behaviour

- Upload triggers a background job rather than blocking the request
- Two models are used, routed by task, or one model with two distinct system prompts
  serving two distinct roles
- The output is structured data, not free text your code has to guess at
- Failures are recorded and visible, and the user is told the truth

## Do not build

No landing page. No account system beyond what is needed to have a user, and reusing
Assessment 1 is fine. No editing, sharing, or exporting features. One flow, done properly.

## Engineering requirements

- Official SDKs only. Where a provider has none for your platform, use a compatible
  official SDK pointed at their endpoint, and explain that in your documentation
- API keys written into `.env` by hand, never by an agent, with an `.env.example` carrying
  commented placeholders
- A configuration file holding every changeable value: model identifiers, timeouts, output
  token caps, temperature, rate limits, and concurrency
- A written system prompt per role, with each parameter you set justified in one line
- Structured output, requested with a schema and validated in your own code on receipt,
  with a defined retry and a defined graceful failure
- A job record in the database for each unit of work, holding status, attempts, and the
  error message on failure
- A queue or concurrency cap so uploading many files does not fire many simultaneous
  provider calls
- Rate limiting on the endpoint that triggers processing and on the follow-up action
- Files in object storage or a documented local development equivalent, with only the
  storage key in the database, never the file itself
- A timeout on every model call, with a defined fallback

## Concepts to document in Section 5

- What an API endpoint is
- SDKs versus raw HTTP, and why official SDKs
- System prompts versus user prompts
- Model parameters, covering the ones you set and why
- Structured output and schema validation, including what you do when validation fails
- Jobs and workers
- Queues, FIFO, and why concurrency is capped
- Rate limiting as a cost control
- Why files live in object storage rather than the database
- Your cost model, meaning what one run costs you approximately and what caps the total

## Prove it works

- A screenshot of your jobs table showing a successful run and a failed run, with the
  error message visible on the failure
- The raw model output for one request alongside your validated, parsed result
- Evidence of what happens when validation fails, produced by deliberately breaking the
  schema or the response
- Your concurrency cap holding, demonstrated by uploading enough files at once and showing
  the provider request pattern
- A screenshot showing the database holds only a storage key, not the file

## Grading bands

**Pass:** upload triggers a background job, two roles are served by models, output is
structured and validated, failures are recorded, keys and config are handled correctly.

**Excellent:**
- Validation happens in your own code rather than relying only on the provider's schema
  enforcement
- The failure path is a designed user experience rather than an error string
- The cost model in Section 5 has real numbers in it
- The concurrency cap is demonstrated rather than asserted

## Traps

- Letting an agent write your API keys
- Hardcoding the model name and the token limit in the handler
- Parsing prose with string operations instead of requesting structured output
- Testing with three clean inputs and never with an empty file, a corrupted file, or one
  at the size limit
- Storing the uploaded file in the database
- Believing a 200 response means the work succeeded, when the work happens in a job and
  the job is where the failure lives

## Defence questions

These will be asked exactly as written.

1. Justify your temperature setting and your output token cap.
2. Show me what a user sees when the provider times out.
3. Your model returns something that fails validation. Trace what happens next, line by
   line.
4. I upload fifty files and press the button. What exactly happens, and what stops it
   costing you fifty simultaneous calls?

---

# The Documentation Template

Same eight sections as the other assessments.

**Section 1: What This Is** — two paragraphs. What the slice does, and what is
deliberately excluded and why.

**Section 2: How To Run It** — numbered steps from fresh clone to working local instance.
What to install. Environment variables listed by name with where each comes from. Database
setup and migration command. Start command. URL. Include `.env.example`, never commit real
keys. A reviewer who cannot run the project in under ten minutes will assume it does not
run.

**Section 3: The Flow, Step By Step** — narrative, not a list of endpoints. For each step:
what the user does, what the frontend sends, what the server does with it, and the actual
route or file where it lives.

**Section 4: The Data Model** — every table, one line on what it holds, and the decision
behind each column that carries one. Why that type, why that constraint, why nullable or
not. Then answer explicitly: which constraints make an invalid state impossible?

**Section 5: The Concepts** — the most heavily graded section. Each concept gets its own
subheading and four questions in order: what it is, why it is needed, how I implemented
it, what I chose against and why. No skipping the fourth. Code excerpts are ten lines
maximum; if the point needs more, explain it in prose.

**Section 6: What Went Wrong** — minimum three problems, each with symptom, investigation
including the dead ends, cause, and fix. Do not sanitise.

**Section 7: What This Slice Does Not Handle** — honest limitations. What breaks at scale.
What would be needed before real users. Distinguish what was left out because it was
outside the brief from what was left out because time ran out.

**Section 8: If I Built This Again** — one paragraph, one thing, chosen deliberately.

---

# The LinkedIn Post

200 to 400 words. Open with the problem or the surprise, not a progress update. Name what
was built in one sentence. Teach one concept properly in three or four sentences. Include a
real detail with a number or a specific behaviour. Link the repository.

Avoid: progress updates, lists of technologies, pretending it was easy or hard.

Test: would someone who does not know you learn something from this post?

---

# Submission Checklist

**Repository**
- [ ] Runs from a fresh clone using only the steps in Section 2
- [ ] `.env` is not committed — confirm in a private browser window
- [ ] `.env.example` present with commented placeholders
- [ ] Commit history shows incremental work, not one commit
- [ ] Nothing outside the brief was built

**Documentation**
- [ ] `DOCUMENTATION.md` at repository root
- [ ] All eight sections present, in order
- [ ] Every required concept has its own subheading in Section 5
- [ ] Every concept answers all four questions, including the fourth
- [ ] Section 6 contains at least three real problems with real investigations
- [ ] All required evidence screenshots included and readable

**LinkedIn**
- [ ] Posted, with the repository linked
- [ ] Teaches one concept properly rather than announcing completion
- [ ] Contains at least one specific number or behaviour
- [ ] Passes the test: a stranger learns something from it

**Yourself**
- [ ] You can open any file in the repository and explain why it exists
- [ ] You have read the defence questions and answered each one out loud
