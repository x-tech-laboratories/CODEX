# Architecture

What the assistant adds on top of [SmartHarness](https://github.com/x-tech-laboratories/SmartHarness): the daemon and its interfaces, mail and the other event sources, the Inbox, and the mascot. The task tree, knowledge store, background research, agents and evals are SmartHarness's, and its own `docs/1-architecture.md` covers them. Paths are under `src/`.

## Daemon and interfaces

```
Electron window (main+renderer) / one-shot CLI
        └── Unix socket $XDG_RUNTIME_DIR/codex/daemon.sock (newline-delimited JSON) ──┐
codex-daemon: one Node process, one event loop                                       ◄┘
  socket server | active run (one at a time) | background loop (only when no run)
        └── model lock + ModelCache → node-llama-cpp (one GGUF) → KnowledgeStore (node:sqlite, WAL)
```

- **Daemon** (`daemon/daemon.ts`) owns model, settings, active run, background worker. Interfaces are stateless renderers of broadcast events (`run.token`, `run.tree`, ...), so several can watch one run. Protocol (`shared/protocol.ts`): requests `{id, method, params}`, replies `{id, result|error}`, events `{event, data}`.
- **Interfaces:** Electron window (`main/`, `renderer/`; main starts a daemon if none answers) and CLI (`cli/index.ts`; with no daemon it runs in-process and never starts the background worker). Both use `daemon/client.ts`.
- **One model, one async-mutex lock.** A run holds it throughout. The background worker takes it per model call and checks before every step and streamed token whether a run started; if so it throws `BackgroundPaused`, requeues its job and releases the lock. Foreground waits at most one token.
- **ModelCache** (`core/model.ts`) reloads only when model path, context size or GPU layers change. Optional `background_model_path` gets its own cache and lock (never evicts the main model, yields to runs, unloaded after 5 min idle).
- **GPU lock** (`core/gpuLock.ts`): exclusive `flock` on `$XDG_RUNTIME_DIR/codex-gpu.lock`, shared with other programs, held by a child `flock` process so the kernel frees it if the daemon dies. `CODEX_GPU_LOCK` overrides the path or disables (empty). Inherited descriptor is reused under `flock`. The lock is held for as long as a GPU model stays loaded, so a job queued on it can be waiting on an idle daemon, not a busy one; `codex suspend` frees it.
- **Suspend/resume** (`codex suspend|resume`): cancel run, unload both models (frees GPU lock), pause background, refuse runs, broadcast `suspended.changed`. Triggers are left to the user's launcher.
- **Tray** (`main/tray.ts`, `main/inbox.ts`, in Electron main not the daemon): menu from daemon status/events; `Inbox (n)` from `actions.changed`; desktop notification for new actions unless the window is in front. `Restart daemon` (tray, window menu, and a button under Options > Desktop) sends `shutdown` and reconnects on the disconnect, which starts a fresh daemon from the window's settings path. Window hides to tray only if a StatusNotifierWatcher exists (checked via `busctl`); a hidden window stays connected so the daemon's unused-exit timer never starts.

## Reactive assistant

The built plumbing (queue, scheduler, handler registry) is already summarised under "Background worker" above; this adds detail. Target behaviour and planned features: doc 2, "How autonomous?".

### Data

- `events`: source, type, dedupe key, trust (`user`|`external`), priority, JSON payload, status (`pending`, `running`, `done`, `ignored`, `failed`), outcome, error, times. Unique per (source, dedupe key) when a key exists, so a connector can post the same message twice safely.
- `actions`: kind, title, body, JSON payload, status (`proposed`, `approved`, `rejected`, `done`), source event.
- `mail_outcomes`: one row per triaged message: event, notify action and draft action ids, sender address, subject, message id, triage class (`ignore`, `notify`, `reply`), who decided it (`heuristic` = bulk headers, `rule`, `model`, `fallback` = model failed), reason (rule, or category, importance and summary), the user's resolution (`pending`, `ignored` for mail triage dropped, then `approved`/`rejected`/`done` from `resolve_action`), the draft text, the names of the draft checks it failed, the draft's resolution, and timestamps. `edited_draft` and `edit_distance` exist but stay null: no path returns an edited draft yet. Written by triage and the draft handler; `resolve_action` fills in the answer in the same transaction as the action. This is the mail domain's success signal and past-case set (doc 2, "Self-improving domains").
- `mail_sender_rules`: pattern (a whole address or a bare domain, lower-cased), class, origin (`user`|`learned`), created, hit count. A user-visible table, not a rule engine.
- Planned: entities, commitments, observations.

### Scheduler

A job = name + class + step (same signature as existing background steps). The daemon builds the list from its dependencies so tests can replace any. Order when not suspended/paused/running: reactive (`handle_events`) first, then maintenance (research, index, learn, consolidate). Event handling claims one event, runs the handler registered for its type, records the outcome; a handler paused by a foreground run puts its event back.

### Daemon methods
`post_event`, `events`, `actions`, `resolve_action`, `queue_request` (queues a `user.request` event with `user` trust).
Mail: `mail_outcomes` (`limit`, `since` in epoch seconds) returns recent outcome rows and a summary: per class how many were decided, kept (`approved`/`done`), dismissed (`rejected`) and pending; draft counts and how many failed a check; `agreement`, the share of shown mail kept rather than dismissed; and `rule_conflicts`, past decisions not made by a rule that today's rules would class otherwise. `sender_rules`, `set_sender_rule` (`pattern`, `mail_class`; returns the rule and how many past decisions it disagrees with), `delete_sender_rule` (`pattern`). None of these are on the window's allowed list; the window only shows rule proposals in the Inbox.

### Mail
- **Maildir** (`core/mail.ts`): polls `new/` of each `mail_maildir_paths` entry every background pass. Message → `email.received`, `external` trust, dedupe key = Maildir name minus client flags, payload = sender, recipient, subject, date, message id, `bulk` reason, ≤4,000 chars body. Skips mail older than `mail_max_age_days`; ≤25 queued per poll.
- **IMAP** (`core/imap.ts`): each `mail_imap_accounts` entry at most every 2 min, TLS with certificate checked, keyed by UIDVALIDITY + UID (queued once). A failed login reports only that the server refused it.
- **Triage** (`core/triage.ts`): (0) sender rules: the sender's address is looked up in `mail_sender_rules`, the exact address before its domain (no subdomain matching); a match decides the class without the model, even for bulk mail, counts a hit, and is the recorded reason (`ignore` → `ignored`; `notify` → a `notify` action; `reply` → a `notify` action and a draft). (1) no model: mail marked automatic/bulk/list/no-reply → `ignored` with reason. (2) one model call (email inside the untrusted fence, no tools, schema-constrained): summary, category, whether a person awaits a reply, importance. Low importance and no reply wanted → `ignored`; else a `notify` action with the summary. Model failure or bad reply → still a `notify` action, marked not triaged. A hostile email can at worst mislabel itself.
- **Drafting:** if `mail_draft_replies` is true, triage queues one `email.draft` event (lower priority than triage; dedupe key from message id, payload carries the outcome row id) for mail awaiting reply; the handler runs a task tree on the mail inside the untrusted fence and proposes a `draft` action whose payload names the recipient (the sender's address) and subject (`Re: <subject>`). Nothing is sent.
- **Draft checks** (`core/mailChecks.ts`, no model): the recipient is the sender or another address in From/To; the subject equals the thread's after stripping `Re:`/`Fwd:`; no date, weekday, time, money amount or capitalised mid-sentence word (mostly names) that appears nowhere in the thread's headers and body, reusing `unsupportedValues` from `checks.ts` for full dates. A `To:` or `Subject:` line the model wrote at the top of its draft is checked in place of the ones the harness sets. A failing draft is still proposed; its body ends with a `Check:` line naming what failed, and the outcome row lists the failed checks. Known false positives: the owner's own name in a sign-off within a sentence, product or place names, a time written differently (`3pm` vs `15:00`), a relative date the thread implied. Missed: a wrong name that happens to occur in the thread, numbers without a currency, dates written as `5/11`.
- **Rule proposals:** when the user dismisses (`rejected`) a shown message and the sender's last `mail_rule_proposal_threshold` (default 3; 0 turns it off) resolved messages were all dismissed, `resolve_action` proposes a `rule` action, "Ignore mail from <address>?", saying how many past decisions it would change. Marking it Done adds a `learned` rule; Dismiss declines, and that address is never proposed again. Nothing is written without the user's answer (doc 2, "Fact and rule engine": a rule is stored only after user approval). Only `ignore` is proposed; keeping mail does not propose a rule.

### Trust taint

`executeTaskTree` takes `trust: 'user' | 'external'` (`core/taskTree.ts`). An external run:
- can't write files, run tests or call MCP tools whatever the settings (`act` never offered);
- is held to `draft` mode, and ignores a memory command or `/do`-style prefix in its prompt's first words (they came from outside);
- passes the taint to every agent it delegates to, and saves it in its checkpoint so a resume isn't widened;
- may search the web but not fetch pages or read local files, so nothing it read can leak in a URL.

Event runs (`core/eventTree.ts`) additionally never act, even for `user` events. A `user.request` may use the web and local files; its answer waits in the Inbox.

### Why

Goal: turn Codex from a request-answerer with idle-time knowledge work into an assistant that reacts to events (e.g. an email arrives) and uses idle time to prune, research, restructure and consolidate. The task tree stays the work engine; this changes what starts work, what work produces, and what the assistant may do alone.

**Problem.** Only the user could start work; the background loop was a fixed chain with no way to be told something happened. The store was topic-centred, but an assistant needs people, threads and commitments with a lifecycle (open/done/overdue). Work always ended in a reply, whereas a reactive result is a proposal (draft, calendar entry, notification, filed item, or nothing).

| Decision | Why |
| --- | --- |
| Events are rows in a durable SQLite queue, not callbacks; connectors only append | Survives restarts; dedupe, prioritise, inspect. |
| One scheduler, three priority classes: interactive > reactive (events) > maintenance (research, index, learn, consolidate); `BackgroundPaused` preemption lets a higher class take the model | Reuses existing preemption. |
| Event needing real work becomes a task tree (request = event + recalled context); cheap triage first | Don't spend a tree on a newsletter. |
| Results are `actions` (proposed → approved/rejected/done), not replies | Assistant proposes; user decides. |
| Trust follows provenance: events are `user` or `external` trust; external runs may not use side-effecting tools without approval | Third-party text (email body) is the main prompt-injection route. Only the user, or a user-written rule, widens trust. |
| Autonomy ladder per event class: observe, notify, draft, act with approval, act unattended; rules learned from approvals/rejections, stored as memories | Graduated, learnable trust. |
| Entities and commitments get their own tables, not folded into the graph | They have a lifecycle topic/fact/memory tables don't model. *Proposed instead: structured facts in the world model, see doc 2, "Memory layers and domain rule sets".* |
| Maildir before IMAP | A synced Maildir (mbsync, offlineimap) needs no credentials in Codex; the daemon never holds a mail password. |
| IMAP password comes from running `password_command` (program + args, never a shell string) at poll time; mailbox opened read-only (`EXAMINE`), `BODY.PEEK` | Settings and DB never hold the password; polling changes nothing on the server. |
| Event runs never act, even for `user` events | Nobody is there to approve; acting stays in the foreground until approval exists. |
| Drafts are only proposed, never sent | Safety. |
| Mail outcomes are their own table, not columns on `actions` | A message has zero to two actions (none when ignored, a notify, maybe a draft), and an ignored message still needs a row; `actions` serves every event kind. One row per message keeps the triage decision, draft and both answers together for replay. |
| Sender rules are a small table checked before the model, not a rule engine | Doc 2's decision: build the data and plain-predicate checks first, and build a general engine only if they move triage agreement. |
| Draft checks note, never block or fix | They are lexical and have false positives; the user reads every draft anyway. |

**Design limits.**
- One model + one lock: events are handled one at a time. A mailbox sync needs coalescing and a backlog policy, not one call per message.
- A 6,144-token window can't hold a long thread; needs rolling summaries in the store plus the condense-then-trim path.
- Idle work needs a budget or it becomes noise.
- Event handling shares the background pause: paused background means events wait.

## Mascot emotions

The robot from the CODEX icon sits at the foot of the workbench sidebar, above the run status, at about two thirds of the sidebar's width.

- **CODEX** draws only the robot: head border, ears and antenna in the theme colour (`--primary`) (the X-Tech blue, `#00acff`) around a black screen with a thin border, with a canvas over the screen (`src/renderer/index.html`). The black screen keeps RoboBuddy' white face visible on both themes.
- **RoboBuddy** (github.com/x-tech-laboratories/RoboBuddy, an npm git dependency pinned to a commit) draws the eyes and mouth on that canvas exactly as it ships: its own moods, colours and settings. The canvas is RoboBuddy' 130 by 90 screen, drawn at twice that and shrunk into the head's 26 by 18 unit screen, so it stays sharp.

**Moods** are RoboBuddy' own, chosen by state, most urgent first (`src/renderer/mascot.ts`): `asleep` (daemon unavailable or suspended), `thinking` (run in progress), `default` otherwise. When a run ends, `happy` (completed) or `sad` (failed) shows for 3 seconds through RoboBuddy' `setMood(mood, { for })`, unless the daemon is unavailable.

**Loading:** the renderer has no bundler, so an import map in `index.html` points `@x-tech-laboratories/robobuddy` at `node_modules` beside `dist`; the content security policy allows the map by its hash. RoboBuddy follows `prefers-reduced-motion` itself. The tray icon stays a still image. More moods: doc 2, "Mascot: more moods".

### Why

- **CODEX draws only the robot, in the theme colour around a black screen; RoboBuddy draws the eyes and mouth unchanged** (its own moods, colours and settings). The screen is black, not see-through, because a transparent head showed the light theme's pale background and hid the white face; white on black was chosen over a blue face after comparing both. The icon's hexagon was dropped as wasted space. The CSS-only mascot this replaces is gone.
- **RoboBuddy as an npm git dependency pinned to a commit,** loaded through an import map whose hash the content security policy allows. It isn't on npm; Nix builds it with `makeCacheWritable`.
- **RoboBuddy' built-in moods follow the run state** (`asleep` when the daemon is unavailable or suspended, `thinking`, else `default`), with `happy` or `sad` for a few seconds when a run ends. Placement: the foot of the workbench sidebar, beside the run status.
