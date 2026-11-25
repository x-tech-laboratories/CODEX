# Open questions and approaches

The assistant's open questions: how it acts on its own, what it improves domain by domain, and how it talks to the user. Questions about the harness itself (planning, reasoning, memory, models, learning) are in SmartHarness's `docs/2-open-questions-and-approaches.md`.

## How autonomous?

### Reactive assistant: target behaviour

An assistant that notices, prepares and asks, and acts alone only where the user has said it may.
- **Many sources, one queue:** mail, calendar, files, timers, webhooks post events; the same queue, scheduler and Inbox serve them.
- **Work shaped like the event:** cheap triage first; a task tree only if needed; result is a draft, filed item, calendar entry or nothing.
- **Autonomy ladder per event class:** approving moves a class up, a rejection moves it down; rules are stored as memories the user can read and delete.
- **Untrusted text never steers:** fenced, read with no tools or the narrowest set, can't widen its own permissions.
- **Model of the user's world:** people, threads, commitments with a lifecycle (open/done/overdue), so "who am I waiting on" and "what did I promise" have answers.
- **Idle time with a purpose:** meeting pre-research, stale-commitment sweep, entity profiles from past requests, daily digest; pruning/consolidation as upkeep, not the main job; budgeted.
- **Always yields to the user:** a foreground request takes the model from any background run within one call.

### Reactive assistant: planned features
- **Approval and autonomy ladder** (observe → notify → draft → act with approval → act unattended; rules learned from approvals/rejections). Until it exists no event run can change anything. The first rung for mail is built: per-sender rules and ignore-rule proposals from repeated dismissals (doc 1, "Reactive assistant").
- **Entities and commitments** (as structured facts in the world model, see "Fact and rule engine"), then idle jobs driven by them: pre-research for tomorrow's meetings, stale-commitment sweeps, entity profiles from episodes, daily digest.
- Other connectors: calendar, tasks/to-dos, bookmarks, notes, file watchers, timers, webhooks.
- Mailbox coalescing / backlog policy; rolling thread summaries; idle-work budget.

## What is the unit of improvement?

### Self-improving domains

**Goal.** Codex should not stay a pipeline where a request goes in and an answer comes out. It should get better at its work over time, unprompted.

**What exists and what is missing.** Codex already does work nobody asked for: the scheduler, idle research, consolidation and `learnFromEpisodes`. What it learns is facts. Nothing makes it *better at its job*, because nothing measures how well a job went or changes behaviour in response.

**Why domains.** Each domain (mail, calendar, tasks, research, code) serves one function, so each can have a concrete success signal and a set of past cases to test against. A generic "be better" has neither. Mail triage has approvals and rejections in the Inbox; drafting has how much the user edited the draft; research has whether facts later turn out disputed; code has tests.

**Why the cognitive processes are not copied per domain.** A domain × process grid of agents (a mail planner, a mail auditor, a calendar planner...) means N × 9 agents to maintain, most near-identical. What actually differs per domain is data: memory scope, tools, instructions, validators, goals and success signal. So each process is written once and the scheduler runs it for a domain, which keeps the specialisation without the copies.

**Why one prompt at a time is enough.** One 4B model on a 4 GB GPU behind one lock cannot run agents in parallel; parallel agents would only queue. The scheduler is where initiative lives: it picks the most valuable job next, and goal-driven jobs let a domain start work on its own.

**Why not fully separate domains.** Real requests cross domains, and the same person appears in mail, calendar and tasks. The task tree stays the coordinator and shared memory stays shared.

**Risks:**
- **Self-reinforced errors.** A 4B model reflecting on its own failures can entrench a wrong lesson. Every change is tested on the domain's past cases before it is kept, and stays a readable, removable row.
- **Weak or gamed signals.** Approval rate rises if the system proposes less; edit distance falls if drafts get blander. Each domain needs more than one signal, and the user can see the trend.
- **Too few cases.** A new domain has no history to test against; until it has some, changes go to the Inbox instead of being kept automatically.
- **Idle cost.** Reflection and replay cost model calls on a GPU shared with foreground work; the per-domain budget bounds it.

A domain pack becomes the unit the system gets better at, not only the unit it is configured by.

**Cognitive processes are job types, written once.** Planner, researcher, executor, auditor, pruner, collator and reflection are each one implementation that the scheduler runs *for* a domain: `audit(mail)`, `prune(calendar)`, `research(projects)`. The domain supplies the data (memory scope, tools, instructions, validators, goals, success signal); the process supplies the method. No per-domain copies of the processes. Already in place: each step of a task is its own record with status and timing (doc 1, "Steps are records") and its own module under `core/steps/`, still run inside one task-tree run.

| Process | Built today as | Per-domain job |
| --- | --- | --- |
| Planner | `decide` / `decompose`, blueprints (proposed) | plans with the domain's blueprints and tools |
| Memory | `recall`, `searchWithMemory` | recalls from the domain's scope plus the shared store |
| Researcher | gather tool loop, `researchOneTopic` | researches topics the domain's goals name |
| Executor | `act`, MCP tools | only the domain's tools, on the autonomy ladder |
| Auditor | `check`, `checks.ts`, `mailChecks.ts` | the domain's validators, plus re-reading real state after an action |
| Pruner / collator | consolidation, `tidy` | consolidates the domain's memory scope |
| Reflection | `learnFromEpisodes` (generic) | turns recorded outcomes into proposed changes (below) |

**Improvement loop per domain:**
1. **Record:** every run and event outcome is stored with the domain's success signal once it is known (an Inbox approval, the sent text of a draft, a test result). Built for mail: see doc 1, "Reactive assistant" (`mail_outcomes`).
2. **Reflect:** a reflection job reads recent failures and proposes one change: a rule, an instruction line, a memory, a validator or a skill.
3. **Test:** the change is replayed on that domain's stored past cases (a held-out set kept per domain) against the current setup.
4. **Keep or drop:** kept only if it scores better and breaks no passing case; otherwise dropped, or put in the Inbox for the user to decide. Every kept change is a readable row with its origin, score and date, so it can be rolled back.

Improvements live in data (rules, instructions, memories, validators, skills), never in weights. This is "Verified self-authored skills" and "Refinement across runs" generalised to everything a domain holds, with the domain's past cases as the gate.

**Scheduler.** One model runs one prompt at a time; the scheduler decides which. Jobs come from three sources: reactive (events), goal-driven (a domain's standing goals, checked against the store) and maintenance (research, consolidation, reflection). Priority = urgency × expected value × staleness, with a budget per domain per day so one busy domain cannot starve the rest. A foreground request still pre-empts everything, as today.

**What stays shared.** Requests cross domains ("the email from Sam about Thursday" touches mail, calendar and contacts), so domains are not silos:
- The task tree stays the top-level coordinator: it routes a request to one or more domains and combines their results. Domains nest at most one or two levels; each hand-off loses detail.
- User memory, entities (people, organisations, threads) and the world model are shared; a domain's scope holds only what is specific to it. This matches "Memory layers and domain rule sets" above: facts shared, rule modules per domain.

### Projects above domains

Domains say *how* Codex does a kind of work; nothing yet says *why*. Proposed: projects as the top layer, holding the user's goals, the tasks that serve them, and their context. Three separate axes:

| Axis | Answers | Examples |
| --- | --- | --- |
| Projects | why and what: the user's goals, persistent | Fitness, House move, CODEX |
| Domains | how: capabilities with tools, validators, signals | research, mail, calendar, notes |
| Cognitive processes | method: written once, run as jobs | plan, research, audit, prune, reflect |

A project uses domains rather than being one: in a fitness project, "research a diet strategy to lose weight" uses research, "book gym sessions" uses calendar, "log weekly weight" uses notes. Making each project a domain would need tools and validators per project.

**A project is a goal, a persistent task DAG and a context:**
- **Goals are not tasks.** "Lose weight" can never be marked done, so it is a goal with a metric (weight, by when). A task is an atomic item with a checkable output ("research diet strategies → summary with sources"). The harness refuses a goal as a task.
- **Tasks persist.** Today's task tree lives for one request (`task_runs` only checkpoints it for resume). Project tasks are the same nodes made long-lived: status, `depends_on`, due date, result kept. Working one project task is one task-tree run.
- **The scheduler pulls ready tasks.** A task whose dependencies are done is a goal-driven job, which gives "Self-improving domains" and "Cognitive loop" a concrete source of goals.
- **Context is the project's memory scope.** `user_memory` has a `project` store keyed to a folder; keyed to a project instead, "fitness" recalls its findings, constraints and results from any folder.

**Graph: linked, not merged.** The topic hierarchy says what the world is ("nutrition → caloric deficit"); the project hierarchy says what the user wants ("fitness → lose weight → research diet"). Merged, consolidation would re-file goals as world knowledge. Two trees joined by edges: `project —uses→ topic`, `task —produced→ fact`, `task —involves→ person`. Topics are a tree (one `parent_id`); project tasks need a real DAG, since a task can wait on several.

**Who plans.** Breaking a goal into tasks is long-horizon planning, the 4B model's weakest skill (doc 1, "Why a 4B model"). The model proposes a few tasks into the Inbox; the user accepts, edits or rejects them. Those decisions, tasks completed and the goal's metric over time are the project's success signals, beside each domain's.

**Risks:** goal-shaped tasks that never finish; plans that look sensible and lead nowhere (the metric shows it); health and similar project data is sensitive, so it stays in the local store like everything else.

**Not built.** First version: projects as plain records the user creates by hand, worked by the scheduler; model-proposed tasks only once that loop works. See doc 3, "Projects".

## How should it talk to the user?

Open for debate; nothing here is decided. Codex is meant to be a long-running personal assistant (doc 0), not only a request-in, answer-out tool, which argues for a stable voice and for remembering the conversation it is in.

### Persona for user-facing replies

A short persona block, a few sentences naming the assistant and setting its personality and tone, added only to calls whose output the user reads: the final answer (`ROOT_WRITE_PROMPT`, `ROOT_COMBINE_PROMPT`), questions back to the user, notifications and Inbox summaries. Not added to `decide`, routing, research, extraction, triage or checks, where it costs context and adds nothing.
- **Owned by the user:** a user settings file of its own, not one of the shipped prompts in `share/prompts/` (those are not user-editable; doc 1, "Prompt bundle"), shipped with a plain default and editable in the window, with a change applying from the next call (Nexus showed its bootstrap prompt in a panel editable while the loop ran); the model cannot edit it, matching the limits in "Cognitive loop".
- **Not the user's voice:** drafts written on the user's behalf (mail replies) keep the user's voice, not the persona's.
- **Contrast with Nexus:** Nexus's bootstrap prompt gave the model no identity and asked it to invent one; here the user sets the identity and the model keeps to it.
- **Open:** whether mood or drive levels may tint the tone of a reply (the drives themselves start jobs, not tone; see "Cognitive loop"); how long the block can be before it crowds a 4B model's context.
- **Risk:** personality text can make a small model chattier or less exact, or invent feelings and actions. **How to test:** run `evals/tasks.json` with and without the persona on the final-answer stage over repeated rounds; keep it only if the pass rate holds, and rate tone by hand on a sample.

### Conversational continuity

Each request is a standalone run today; a follow-up such as "and the one before that?" has nothing to refer to except recalled memory. Proposed for debate: the final-answer stage (and `decide`, so a follow-up is planned as one) sees the last few turns of the current conversation, capped by the context budget, with older turns reached through recall and the conversation archive ("Conversation archive"). **Open:** how many turns, whether a turn is passed as text or a short summary, and when a new conversation starts in an always-on assistant. **How to test:** a set of two- and three-turn eval tasks whose later turns cannot be answered without the earlier ones.

## Other proposals

### Mascot: more moods

**Not built:** more states mapped to moods. Candidates (state in `src/renderer/runState.ts`): a clarification or approval waiting (`clarifications` not empty; curious), background research working (`backgroundStatus` not `Idle`; focused), daemon unreachable (`connection: 'unavailable'`; worried, today `asleep`), the user cancelling (`cancelling`; startled), resuming from suspend or connecting at launch (waking), a final answer arriving (`phase: 'final'`; excited). Needs a priority order when several hold at once (e.g. worried, asleep, startled, curious, thinking, focused, calm), with happy/sad/excited as brief moments rather than states. The removed CSS mascot also had an antenna pulse while thinking, floating z's while asleep and a slow head bob (git history); RoboBuddy draws none of these.

**Mood from content, not only run state:** the moods above follow what the harness is doing; none reflects what the conversation says. Proposed: one schema call with an enum of moods at the end of a run, or when an event arrives, reading the request and the reply (or the event summary). It drives the mascot and, later, the voice ("Speech output"), and could feed the drives in "Cognitive loop". A fixed stage, not an agent; skipped when the run is cancelled. Cost: one short call per run. Cheaper alternative once drives exist: compute the mood without a model call from drive levels and recent outcomes (approvals, rejections, failed checks), so drives set the mood rather than the mood setting drives; Nexus kept emotions and drives as one internal state.

### Speech output

Give the mascot a voice: a TTS engine feeds RoboBuddy' `speakVisemes` with real phonemes and durations, and a mood value drives eyes, mouth and voice together. Engine choice and trade-offs follow. Chatterbox would be an optional backend behind a small local server on a machine with enough VRAM; the dev laptop's 4 GB GPU is shared with the main model (see GPU lock), so voice must not compete for it. Not built.

Gathered 2026-11-05 **from memory, not fresh searches**: check licences, versions and memory figures before relying on them.

**Recommendation**
- **Kokoro** (82M params, Apache-2.0) as default: far better than its size suggests, runs on CPU or in the browser (`kokoro-js`, ONNX, WebGPU/WASM), many voices (best in English), ~300 MB at full precision (less quantised), real time or faster on CPU.
- **Piper** for small hardware (e.g. Raspberry Pi): fastest, 15–75 MB per voice, many languages, but flatter and more robotic; newer builds are GPL and each voice has its own licence.
- **Chatterbox** (MIT) when the voice itself must carry emotion: needs a GPU with ~8 GB.

**Others:** StyleTTS2 (MIT) and Orpheus (Apache) are more expressive but heavy/GPU-bound; F5-TTS and XTTS sound very good but have non-commercial weights, so avoid for anything shipped; Bark and Parler are older/slower, no longer the best choice.

**Emotion control:** Kokoro and Piper have none (only voice and speed). Chatterbox: "exaggeration" control and voice cloning from a reference clip. Orpheus: inline tags (`<laugh>`, `<sigh>`), infers tone from text. Dia (Apache): non-verbal tags, GPU-hungry. StyleTTS2: copies a reference clip's style (keep one clip per emotion). Parler-TTS (Apache): voice described in text ("sad, slow, quiet"); flexible, less polished.

**Chatterbox cost:** ~0.5B params, 2–3 GB weights, ~6–8 GB VRAM in the default setup; real time or faster on a recent GPU; on CPU several seconds per sentence (too slow for conversation); needs Python + PyTorch/CUDA so it can't run in the browser and would sit behind a small local server. A ~350M "Turbo" variant exists (availability/memory unchecked). **A 4 GB GPU (the dev laptop) is probably too small** for the standard model at full precision.

**Face integration:** Kokoro and Piper both expose espeak-ng phonemes and timing, so either can feed RoboBuddy' `speakVisemes` with real phonemes and durations instead of spelling rules guessing both (Kokoro predicts a duration per phoneme). A mood value could drive eyes, mouth and voice together: with Kokoro only speed and mouth change; with Chatterbox the voice changes too.
