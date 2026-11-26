# Roadmap

Order and status of the assistant's work. The harness's own roadmap, including the eval loop and model choice, is SmartHarness's `docs/3-roadmap.md`.

## Merge with X-Context

Doc 4, "Order of work", comes first from 2026-11-26. The mail work below is frozen: mail moves to an application of its own (doc 4, decision 9).

## Reactive assistant

### Status

All landed and unit-tested with fake models/servers only. **Never tried live:** a real mailbox, a real IMAP server, the real model drafting a reply, or the Inbox in the Electron window (typechecked only). The first live run may show differences.

- Durable `events`/`actions` queues; scheduler with reactive before maintenance; handler registry, `notify`, `post_event`/`events`/`actions`/`resolve_action`.
- Maildir connector + parser; triage (header heuristics, then one schema-constrained call).
- Inbox page, tray entry, desktop notification.
- Trust taint (external runs can't act, write, test, call MCP, fetch pages or read files).
- Events as task trees: `email.draft`, `user.request`.
- IMAP connector (read-only, password from a command; fake-server tests only).
- `queue_request` daemon method (window may call it; no button yet).
- Mail outcomes, sender rules checked before the triage model, ignore-rule proposals, lexical draft checks (2026-11-07; see "Self-improving domains" steps 1 and 3).

Today: mail arrives → automatic mail dropped without the model → rest summarised and ranked → mail awaiting reply gets a drafted reply → all land in the Inbox to read, mark done or dismiss. Nothing is sent; no event run changes anything.

### Remaining work (in order)

1. **Look at it running:** real window + Maildir/IMAP account + real model; check Inbox layout, notification, tray, draft quality and length. Cheapest way to find what tests can't.
2. **Request box in the Inbox:** input for `queue_request` and a way to show a result beside its request.
3. **Act with approval:** an approved `draft`/`result` action can carry out a change (send reply via a user-named mail command, file an item, write a note). Approval names the exact change; the executing step runs with `user` trust and only that tool. File changes are staged as a diff and the old file is backed up before applying (doc 2, "Verified self-authored skills", Staged, not written).
4. **Learned rules:** ~~record approvals/rejections per event class and sender; skip triage for always-ignored senders~~ (built for mail: `mail_outcomes`, `mail_sender_rules`, ignore-rule proposals after repeated dismissals; doc 1, "Reactive assistant"); promote reliable classes up the ladder.
5. **Entities and commitments:** structured facts in the world model (see Core structure ideas, item 3), filled from mail and user requests, with lifecycle and an overdue sweep as a rule.
6. **Goal-driven idle jobs:** replace the fixed research/index/learn/consolidate chain with jobs chosen by what the store says is stale or upcoming, each with a budget.
7. **More sources:** calendar and a file watcher first (they feed commitments and meeting pre-research).
8. **Upkeep:** prune finished events and old actions; mail settings page; coalesce a large mailbox backlog instead of one message per pass; clean up resumable checkpoints left by stopped event runs.

### Known limits

- One model/lock: events are handled serially; a draft run holds the model for the whole tree, so a foreground request waits until the next stop check, and the event is retried from the start.
- A 6,144-token window can't hold a long thread; only one message body (≤4,000 chars) is used.
- Triage/drafting rely on a small model; the taint limits a fooled model to a wrong summary or poor draft that the user reads first.
- IMAP: one folder per account, new-mail check at most every 2 min, TLS on the given port only (no STARTTLS).
- ~~`write_file` can rewrite Codex's own instructions~~ Closed (2026-11-07): `writeFile` (`core/tools.ts`) refuses paths inside `.codex/`, files named `CODEX.md` or `AGENTS.md`, and anything under `configDirectory()`, with a test for each (doc 1, "Shared machinery", Tools). `/init` writes through the harness, not the tool, so it is unaffected. Cost: the user edits those files by hand.
- Possible tool-call injection, unconfirmed: `textToolCalls` (`core/toolStage.ts`) runs `<tool_call>` text in the model's reply as real calls to known tools, so a user run whose model copies a fetched page containing that text could call a tool the page chose. Event runs are already blocked by the trust taint. Test: a fake page with an embedded `write_file` call, read in a user run; if it fires, accept text calls only before any untrusted text is echoed, or only when the reply is nothing but calls.

## Mascot

Built: see doc 1, "Mascot emotions". Still open:

1. Try other placements (top bar, an empty workbench, the answer area) once the sidebar one has been lived with.
2. Map more states to moods (clarification waiting, background research, unreachable daemon, cancelling, waking): see doc 2, "Mascot: more moods".
3. Mood from content: one enum-schema call at the end of a run or on an event (doc 2, "Mascot: more moods"). Check by hand on a sample of runs that the mood fits the reply, and time the extra call. Compare with the no-call alternative there (mood computed from drive levels and recent outcomes) once drives exist.

## Persona and conversation (open for debate)

Doc 2, "How should it talk to the user?". Nothing decided; settle the open points there before building.

1. **Decide:** which stages get a persona, whether mood may tint its tone, and how many conversation turns a request sees.
2. **Persona eval:** run `evals/tasks.json` with and without a short persona on the final-answer stage over repeated rounds; keep it only if the pass rate holds, and rate tone by hand.
3. **Follow-up eval:** add two- and three-turn tasks whose later turns need the earlier ones, and measure them with turns carried forward against standalone runs.

## Speech output

1. Browser-only Kokoro (`kokoro-js`) demo feeding `speakVisemes`.
2. Optional Chatterbox server backend for machines with ≥ ~8 GB VRAM.
3. First re-verify licences, versions and memory figures (the research was written from memory).

## Self-improving domains: mail slice first

Design and rationale in doc 2 ("Self-improving domains"). Build one domain end to end before generalising; mail first, because connectors, triage, drafting and the Inbox's approve/reject signal already exist. Shares work with Core structure ideas item 3 (mail pack) and Reactive assistant items 4 and 6.

Status (2026-11-07): steps 1 and 3 built (doc 1, "Reactive assistant": `mail_outcomes`, `mail_sender_rules`, draft checks, rule proposals); unit-tested only, never run on real mail.

1. ~~**Record outcomes:** store each mail event's triage class and draft beside what the user then did (approved, rejected, edited and sent, ignored). This is the success signal and the past-case set.~~ Built. Remains: edits are not captured (`edited_draft`/`edit_distance` stay null until the window can return an edited draft, which needs Reactive assistant item 3); the window's only answers are Done and Dismiss, and Dismiss may mean "seen, not useful" as well as "should not have been shown", so agreement is a noisy signal until a clearer choice exists.
2. **Mail memory scope:** memories and lessons tagged with the domain, recalled for mail runs beside the shared store.
3. ~~**Mail validators:** non-LLM checks for drafts (recipient and subject match the thread, no date or name absent from the thread) and for triage (class consistent with the learned sender rules).~~ Built (`core/mailChecks.ts`). Triage consistency is a replay count (`rule_conflicts`) rather than a live check, since a matching rule now decides before the model. Remains: measure the draft checks' false-positive rate on real drafts; a user-facing rules page (rules are edited over the socket or in SQLite today); a general rule engine only if the rules move the agreement number.
4. **Reflection job:** reads recent rejected or heavily edited outcomes and proposes one change (rule, instruction line, memory, validator).
5. **Replay gate:** test the proposed change on the stored mail cases against the current setup; keep only if better and nothing that passed breaks, otherwise send to the Inbox. Keep a log of kept changes with score and origin, and a way to roll one back.
6. **Scheduler:** add goal-driven jobs and a per-domain budget beside the reactive and maintenance classes in `core/scheduler.ts`.

**Validation:** over a few weeks of real mail, track triage agreement with the user's actions and draft edit distance, before and after kept changes. The agreement number is `summary.agreement` from the daemon call `{"method": "mail_outcomes", "params": {"since": <epoch seconds>}}`, or in SQLite: `SELECT mail_class, SUM(resolution IN ('approved','done')) AS kept, SUM(resolution = 'rejected') AS dismissed FROM mail_outcomes WHERE mail_class != 'ignore' AND triaged_at >= <epoch seconds> GROUP BY mail_class` (agreement = kept / (kept + dismissed)). Mail triage ignored has no user answer, so it is not in the number. Check that a deliberately wrong change is rejected by the replay gate. If mail improves, generalise the shape to calendar and tasks; if it doesn't, find out whether the signal, the reflection or the gate is at fault before adding domains.

## Projects

Design in doc 2 ("Projects above domains"). After the mail slice's outcome recording and scheduler steps, which projects reuse.

1. **Records:** `projects` (goal, metric, status) and project tasks (prompt, deliverable, `depends_on`, due date, status, result), linked to topics, facts and entities by graph edges; created by hand from the interfaces or CLI.
2. **Refuse goals as tasks:** a task needs a checkable deliverable; one without is kept as a goal.
3. **Scheduler:** ready project tasks (dependencies done) become goal-driven jobs; working one is one task-tree run whose result is stored on the task.
4. **Project memory scope:** move the `project` memory store from folder keys to project keys, folder as one optional link.
5. **Model-proposed tasks:** the model suggests a few next tasks into the Inbox; the user accepts, edits or rejects; record those decisions as the project's signal.

**Validation:** first project: fitness, mostly research tasks. Check that ready tasks get worked in idle time without blocking foreground runs, that results are recalled in later project tasks, and the share of proposed tasks the user accepts.
