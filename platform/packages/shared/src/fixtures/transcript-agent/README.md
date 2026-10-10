# The golden set

One JSON file per case. Each is a `GoldenFixture` (`../../agent-eval.ts`): a
transcript, the model output a correct build returns for it, and what the
platform must then do with that output.

## What this set is for

`golden-set.test.ts` (this package) and `golden-replay.test.ts` (the worker)
replay every file on every run. Between them they gate everything that happens
**after** the model: evidence verification, the date and amount resolvers, the
cross-checks, scoring, tier rules and the planner. That is §13.2's release gate
for a change to "resolvers, schema or policy", and it needs no provider, no
database and no network.

It does **not** gate the model or the prompt. A prompt change that makes the
model read a call differently produces a different `understanding` than the one
recorded here, and no amount of fixture-replaying will notice. The half that
catches the model is §13.3's running measurement over each tenant's own
reviewed decisions (`agent_eval_cases`, `sweepAgentAccuracy`), which needs real
traffic.

## Why the transcripts are invented

§13.1 asks for "real, anonymized transcripts" and 300+ of them. Every
transcript here is written by hand and no customer's words are in this
repository — it is public, and anonymising a phone conversation properly is
harder than it looks: the names come out and the circumstances stay in.

So this folder is a **regression** set, sized to cover each category §19 lists
exactly once. The accuracy set §13.1 describes lives per tenant in
`agent_eval_cases`, grown from their own corrections, and is the one that
reaches 300+. The two share the schema on purpose, so a tenant's corrected case
that turns out to be general rather than theirs can be exported into this
folder.

## Adding a case

1. Copy the closest existing file and change the `id` to match the filename.
2. Write the transcript as `Agent:` / `Customer:` lines. Every `evidence.quote`
   must be a span that really appears in it — `verifyIntents` discards an intent
   whose quote it cannot find, so a mistyped quote makes the fixture test
   nothing.
3. Put **phrases** in the slots (`when_text`, `amount_text`), never timestamps
   or numbers. The resolvers produce those, and `expected.intents[].dueAt` is
   where you say what they should produce.
4. Tag it. If it covers a category not yet in `REQUIRED_FIXTURE_TAGS`, add the
   tag there too — the test asserts the list is covered, so the list is the
   specification and this folder is the implementation.
5. Run `npx vitest run src/golden-set.test.ts` here and the worker's
   `golden-replay.test.ts`. A new case that fails is either a wrong expectation
   or a real defect; work out which before changing either side.

`reference` is the call's END, not "now" — every relative phrase in the
transcript resolves against it, which is what makes these cases stable forever.
All of them use `2026-10-06T13:00:00.000Z`, a Tuesday at 18:30 in
`Asia/Kolkata`, so "tomorrow" is a working day and "next week" is unambiguous.
