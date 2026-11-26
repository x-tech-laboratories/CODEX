# Merge with X-Context

The plan to make CODEX one application: a personal knowledge base, a knowledge management tool and a personal assistant. X-Context, a separate application, moved into this repository: its code became CODEX's skeleton on 2026-11-26, and its repository no longer exists. Decided 2026-11-26; where this doc and docs 0–3 disagree, this one is newer.

## What it becomes

- **Gathers:** an engine reads notes, tasks, bookmarks, files, contacts and mail from the apps that hold them, through MCP, plugins and APIs.
- **Relates:** it links related items and groups them into contexts, guided by the user.
- **Learns:** a knowledge graph of its own, with embeddings and retrieval, holds what it has learned about the user's world.
- **Works with the user:** conversations are items: a context holds as many as the user starts, listed with its other items, and conversations in no context are kept for when none is open; the assistant has a face and a mood.

*Conversations are items by the owner's decision of 2026-11-26, replacing one conversation stream per context, and
built the same day (doc 1, "Conversations and runs"): each is an item of kind `conversation` owned by CODEX, answered
for by an internal collector, with a per-membership note, History of its memberships, "also in", search, and a
`codex://conversation/<id>` link that opens it in the pane. It can be moved, sit in several contexts, or in none; the
pane shows the open context's most recently used one, with a switcher and New conversation. Removing a context deletes
the conversations no other context holds.*
- **Keeps itself up:** in idle time it re-reads the graph, researches, and proposes new links.
- **Remembers how:** schedules for its own recurring jobs, and blueprints for workflows the user has taught it.

**Window:** the context tree on the left, the workspace in the middle (the items of a context, opened and edited), and the mascot with the context's conversations on the right.

## Decisions

1. **CODEX owns the knowledge.** The graph, embeddings, schedules, conversations and blueprints live in CODEX's store. SmartHarness keeps a store of its own for its evals and is one engine among several. An engine can be swapped without moving what CODEX knows.
2. **Items stay where they live.** X-Context's rule holds: CODEX keeps a pointer to an item, never its content. What CODEX stores is derived (search index, embeddings, entities, links) and can be rebuilt, plus the assistant's own records (conversations, memories, blueprints). The workspace edits an item through its source app.
3. **One application, named CODEX.** X-Context's code is the skeleton: one SQLite store built from features, sync, History, backups, and every call served over REST and MCP. CODEX's daemon socket protocol is retired in the port.
4. **Engines are plugins.** An engine plugin takes the conversation so far and the tools CODEX offers, and streams events back. Planned: the Anthropic API, OpenAI-compatible endpoints, a Claude subscription through its command-line client, and SmartHarness's task tree. An engine may run its own tool loop.
5. **Tools belong to CODEX.** Every engine reaches CODEX's data through CODEX's own calls, the same ones served over MCP. Approval, the action policy and the rule that a run which read outside content cannot change anything are enforced there, once, for every engine. Tools come from four places, all under the same policy:
   - **CODEX's own calls** (contexts, items, links, jobs, blueprints).
   - **The sources' MCP servers.**
     *Built 2026-11-27 as the bundled `codex.mcp` tool plugin (`src/shared/mcp/`, described in doc 1): the user adds any
     MCP server in Settings, at an address over streamable HTTP with an optional bearer token or as a local command over
     stdio, and its tools become plugin tools under the same rules, each server with its own marks; adding, changing
     and removing servers, and the command a server runs, are the user's alone at the page.*
   - **Tool plugins:** prebuilt tools installed like any other plugin, beside collector and engine plugins.
     *Built 2026-11-27 (`src/shared/tools/`, described in doc 1): a `tools` provider whose tools are offered beside
     CODEX's calls through the same wrapper, under the action policy (a change at `proposal` until set, set in Settings
     → Action policy), fenced and lowering the run unless the plugin is marked "Trusted content", and kept from hosted
     engines, as an unmarked source is, unless marked "May be sent to a hosted engine". A tool that sends its
     arguments outside is refused once the run has had a source not marked for hosted engines in front of it, unless
     the plugin is marked "May be used after reading private sources", and each use is in the hosted log. Each tool can
     be turned off, and the core set takes one only when the user ticks it. The bundled Web plugin reads public pages
     behind an address guard and searches a SearXNG instance the user names. MCP servers are tool plugins too (above).*
   - **Tools the engine writes:** a script saved by proposal, read by the user before its first use, and run in a sandbox where it can call only CODEX's tools.
6. **Sources are other apps' MCP servers,** chosen during setup, each marked for whether its content may be sent to a hosted engine. The X-apps follow one shared convention for this (proposed for the Application Standard), so one collector reads them all.
   *Built 2026-11-26: the convention is the Application Standard's four item calls, and one collector reads every app
   answering them, each app added in Settings with an address and read-only token and marked on its own
   (`src/shared/sources/`, described in doc 1).*
   *Built 2026-11-26 for the collector plugins (`src/shared/privacy/`, described in doc 1): each has two marks in its
   row under Settings → Plugins, both off until turned on. "May be sent to a hosted engine": an engine is hosted unless
   it says it is local (Anthropic never is; an OpenAI-compatible endpoint is when its host is loopback or a
   private-network address), and a hosted engine is never given an unmarked source's items, titles included, in its
   instructions or any tool result, only a line saying how many were withheld and why. "Trusted content": reading
   that source's items no longer counts as outside content (see "Action policy"). A log under Settings → Assistant
   lists each reply a hosted engine wrote, with its engine, model and the items sent and withheld per source as counts,
   kept 90 days unless changed.*
7. **It runs on the desktop,** on the machine with the GPU. Embeddings stay local whichever engine answers, so changing engine never forces a re-embed.
8. **Recurring work is split.** The user's recurring tasks live in X-Tasks. The assistant's recurring jobs are CODEX's own, and the engine may create and delete them during a conversation.
   *Built 2026-11-26 (`src/shared/jobs/`, described in doc 1): the engine lists, adds, changes and removes jobs as
   changes under the action policy; each run is an ordinary run in the job's own conversation with nobody present.*
9. **Mail leaves.** Mail belongs in an application of its own with an MCP server; CODEX reads it like any other source. The mail code here (`legacy/src/assistant/mail*.ts`, `imap.ts`, `triage.ts`, `draftReply.ts`) is frozen and seeds that application; it is not ported.

## Action policy

Every function that changes something has a level, set by the user per function. From least to most permissive:

| Level | Meaning |
| --- | --- |
| Restricted | Never permitted. |
| Proposal only | The change waits in the Inbox for the user to approve. |
| Auto allowed | Applied without asking, while the user is in the conversation. |
| Background allowed | Also applied by background jobs with nobody present. The most dangerous level. |

Built 2026-11-26 for conversations (`src/shared/policy/`, described in doc 1): the four levels in a synced setting, a
proposal kept on the conversation it was asked for in (the Inbox comes later), and a run that read outside content
proposing every change. An applied change records whether the user approved it or the engine made it at auto. Since
2026-11-26 a proposal carries its evidence (the message that asked, what the run read first, excerpts only where the
source's marks allow), and an applied change can be undone from its conversation through History, by the user alone,
while nothing has changed it since; one History keeps nothing of, such as a refresh, says it cannot be.

Built 2026-11-26 as well: outside content is judged by source. Items from a source marked "Trusted content" do not
lower a run (they are still fenced as data); items from an unmarked source do, whether a tool read them or they came
in the open context's instructions; context names and notes the user wrote in CODEX never do. `set_source_mark`,
like `set_action_level`, answers only the user at the page.

These settings are the user's alone (built 2026-11-26): the action policy, the source marks, which engine answers and
which embedder the index uses, how long the hosted log is kept, and every plugin's on or off and settings (which hold
each engine's and embedder's endpoint and key command). Only the user at CODEX's own page, a signed-in browser or the
desktop window, can write them, through `set_setting` or the calls above; a token over the API and every MCP client are
refused, and no engine is offered any of these calls (a test holds the engine's tools to a written allow-list). They
read as before, keys hidden, and sync from the user's own devices as before. Sync honours the rule too (built
2026-11-26): the server takes a change to one of these settings only from a device that signed in for sync, so a
program's token cannot change them through the sync exchange, and it cannot replace the server's data either. The
marking lives in X-Libs (`page_only` specs, `page_only_calls`, and sync's `device_only`), so every app can use it.
Backups honour it as well (built 2026-11-26): restoring a server's backup, deleting one and changing the backup
schedule answer only the user at the page, so no token, an admin's included, can put back a crafted backup holding
other settings; MCP offers no backup call, and the desktop's backups are reached only from its window.

Withheld content has no side door (built 2026-11-26): every stored answer, event and proposal records which sources'
content its run had read, as collector ids, and a proposal also the sources its summary names. A hosted engine is not
replayed an earlier answer or event, nor shown a message found by search, that carries a source not marked for it; it
gets one line saying what was left out and why, and the log counts it. The user's own typed messages are always sent.
Answers and events kept before 2026-11-26 recorded nothing, so they count as carrying unknown sources and are withheld
from hosted engines and hosted embedders.

- **Only the user approves or raises a level.** `resolve_proposal` and `set_action_level` answer only the user at the page (a signed-in browser, or the desktop window); a token over the API is refused, and MCP and engines are never offered them.
- **New functions start at proposal only.**
- **Every applied change is recorded** with what made it (user, rule or engine), the evidence, and an undo.
- **Outside content lowers a run:** a run that has read mail, a web page or any other untrusted text is treated as proposal only, whatever the level.

## Knowledge graph

- **Nodes:** the items CODEX already points to, plus entities (people, organisations, topics) found in them.
- **Links:** typed, each with where it came from, when it was true (from, until) and when it was recorded, and a status: proposed, accepted or rejected. A fact that stops being true is closed, not deleted.
- **Cheap first:** structured data becomes nodes with no model call; entities are matched by exact keys (address, URL, id) before any model is asked; model extraction runs only on free text, in batches.
- **Never merged on a name alone:** two records of one person are joined by an alias link that can be undone.
- **Learning signal:** the user's accepts and rejects, which also stop a rejected proposal from coming back.
- **Search:** full-text and vector results fused, scoped to a context and its children.

## Blueprints

A blueprint is a workflow the user has taught. When the user and the assistant work through a task, such as sorting mail, and the user gives rules, actions and their order, the assistant writes them up so the same task runs the same way next time.

- **Holds:** when it applies, the rules, the steps in order, and the tools each step uses.
- **Saved by proposal:** at the end of a session the assistant offers to save or amend one; the user reads it first.
- **Recalled at the start of a task** by matching the request against each blueprint's description.
- **The user's to edit:** opened in the workspace like any note, versioned in History, attached to a context or global.

*Built 2026-11-26 (`src/shared/blueprints/`, described in doc 1): blueprints are items of kind `blueprint`, written by
the user (active at once) or proposed by an engine through `propose_blueprint` and `propose_blueprint_change` (and by a
program through a token or MCP), accepted or rejected only at the page after reading the whole text or the change's
diff; **Save as blueprint** in the pane asks for one. CODEX recalls them itself at the start of each run, by words and,
with an embedder, by meaning, at most three in 4,000 characters, and puts them in the instructions unfenced, with a
notice naming each.*

## Mood and curiosity

RoboBuddy is the face. The mood is a small state the user can see and switch off.

- **Appraisal:** what CODEX knows sets a short-lived emotion: the user's birthday, a project finished, a person the graph records as having died coming up in conversation. It drives the face and the tone of a reply.
- **Drives:** levels that drift toward a baseline and move with events (a run failing, a proposal rejected, a backlog growing, a long idle spell), after Nexus's drive model. A drive over its threshold starts a job instead of colouring a prompt.
- **Curiosity:** the assistant keeps interests of its own, started by conversations with the user, and researches them in idle time within a budget. What it finds goes in a context of its own that the user can read.
- **Limits:** a mood never changes a fact, a permission or an action policy level; it never asks for attention or blames the user; research queries carry no personal data.

## Order of work

1. **Engine interface:** replace the interim one (`legacy/src/engine/engine.ts`, which has the task tree's signature) with conversation in, CODEX's tools in, events out. The hosted model adapters (`legacy/src/assistant/*Model.ts`, `models.ts`) and the direct loop carry over. *Done 2026-11-26: `src/shared/engines/engine.ts`, with the Anthropic and OpenAI-compatible engine plugins on the ported direct loop; the legacy files are deleted.*
2. **Skeleton and conversation:** X-Context's code moves in (done 2026-11-26: it is `src/`, under CODEX's name, and the old code is in `legacy/`); conversations; the right pane with the mascot; engines as plugins. Needs a three-pane shell in X-Libs. *Done 2026-11-26: conversations, engines as plugins, the action policy for them, and the right pane with RoboBuddy's face, on X-Libs' `side_pane`.*
3. **Inbox and background queue** ported onto the new store, with the action policy. *Built 2026-11-26
   (`src/shared/inbox/`, `src/shared/jobs/runner.ts`): one Inbox page lists every proposal, graph proposal, blueprint
   proposal and job run that ended badly, decided in place or several at once; the background queue is the jobs'
   runner, on one device the user chooses, behind a global switch and daily caps.*
4. **Index and graph:** content extraction, embeddings, fused search, entities, links, proposals, the graph view. *Built
   2026-11-26. Index
   built 2026-11-26 (`src/shared/search/`, described in doc 1): content read through an optional `content` on each
   collector and held only in a local index file beside the database, never synced or backed up; FTS5 and vectors from
   an `embedder` plugin, fused by reciprocal rank and scoped to a context and those inside it; only changed documents
   indexed again, embedding in the background and waiting for replies; the engine searches it as a tool under the
   source marks. Entities, links and their proposals built 2026-11-26 (`src/shared/graph/`, described in doc 1): rules on
   exact keys and similarity of embeddings make links without a model, engines propose through two tools, and only the
   user accepts or rejects. The graph views built the same day on X-Libs' `GraphView`: a context's Graph view, a
   Graph page for the whole graph, the selected node's links in the workspace, proposals accepted or rejected from the
   graph and a Proposed links list, and Suggest links on a context.*
5. **Workspace:** an editor per kind of item, writing back through collectors.
6. **Jobs and blueprints.** *Built 2026-11-26: blueprints (proposed, accepted at the page, recalled into each run) and
   the assistant's jobs (scheduled, limited, run in the background), both described in doc 1.*
7. **Self-maintenance:** jobs chosen by what changed, each with a budget, skipped when there is nothing to do.
8. **Mood and curiosity.**
9. **SmartHarness as an engine:** conversation history and CODEX's tools in the task tree; a recorded set of real assistant jobs as the eval, with a hosted engine as the baseline. SmartHarness takes over one class of job at a time once it matches the baseline there.

**Sources to start with:** X-Tasks and Trilium, read-only until the bugs are ironed out.

## Known gaps

As of 2026-11-26 (closed on 2026-11-26: CODEX answers the four standard item calls; a reply's tool calls show where each
was made in it; a token can no longer restore or delete the server's backups; proposals carry their evidence and
applied changes can be undone; a link or entity added through a token or MCP is a program's proposal; History brings a
removed context back with its links; blueprints, jobs and the Inbox are built; closed on 2026-11-27, after a second run
on a local 4B model: the token estimate follows what the engine reports instead of keeping its most cautious ratio,
over-long earlier messages are shortened before whole turns are left out, the Thinking row opens to ten lines and
follows the stream, an absolute `CODEX_USER_DATA` and `CODEX_SOCKET` are honoured, the index's last problem is in plain
words and clears when the embedder answers or its settings change, a proposal's "From" names only what its run had in
front of it, Suggest links is shaped for a small model, similar items are judged against the rest rather than a fixed
cosine, a job's conversation is no longer the pane's default, and each tool plugin has a "May be sent to a hosted engine"
mark, without which a hosted engine is not offered its tools and is sent nothing that drew on them):

- No real model has run a background job: a scripted fake engine has, in tests and in the desktop app. How a real model
  keeps to a job's instruction with nobody to ask, and how many rounds and tokens real jobs need, is unknown.
- A job the engine asked for and the user approved is recorded as made by the user; only one the engine made at a level
  that let it is recorded as made by the engine.
- Background runs apply only `background`-level changes and propose the rest; a `restricted` change is still refused,
  not proposed.
- Which device runs jobs is the user's choice per device; nothing stops two devices both being switched on, and then
  both run each due job (each run is recorded with its device, so it shows).
- "Every so many" schedules count from the last run or check, and times of day are in the local time of the device that
  runs jobs, so moving that switch to a device in another time zone moves the times.
- The server sends no notifications; only the desktop daemon notifies, through `agent/desktop_notify`.

- No background job proposes links yet: rules and similarity run after each index pass, and an engine proposes only
  when the user asks with Suggest links.
- How well a real model extracts entities and proposes links is unverified; only a scripted fake engine has proposed.
  Suggest links in its new shape (its graph in the instructions, four tools, six rounds) has not been run on a real
  model.
- The Claude-subscription engine and the SmartHarness engine are not built.
- Engine-written tools (decision 5's fourth place) are not built. No real model has used a plugin tool: a scripted fake
  engine has, in tests and in the desktop app, and only fake MCP servers have been added.
- An MCP server's command runs wherever a reply is written, the desktop daemon or the server, since the servers sync
  between the user's devices; a command that exists on one only fails plainly on the other. MCP servers that ask for
  OAuth, prompts and resources are not supported; only tools, with a bearer token at most.
- A tool plugin's "May be sent to a hosted engine" starts on for a plugin whose tools all send outside, which takes in
  an MCP server at a remote address; such a server reading private data held elsewhere (a hosted notes service with a
  token) has it sent to a hosted engine until the user turns the mark off.
- No hosted model has been tried. A local 4B reasoning model (llama.cpp's server, 8,192 tokens of context, on a CPU)
  answered end to end on 2026-11-26, and again after the first fixes: tool calls, proposals, trusted sources and
  stopping worked. What the second run found (requests settling far under the context, a huge message costing every
  older turn, a cramped Thinking row, an unclear index problem, a "From" line naming sources never read, Suggest links
  reading without proposing) is fixed, but not yet tried on a real model again.
- An app read through the item calls is reached over HTTP with a token, not over its MCP server as decision 6 says;
  the item calls are the shared convention it names, so MCP would add nothing for reading.
- An app's kinds are read when it is saved, not on each refresh, so a kind an app adds later shows once the app is
  saved again.
- CODEX's own items (`codex://entity/<id>` among them) are not read by the index's `app_link` rule as links to
  entities, and the graph gives an entity node no `uri`; the item calls' links open entities on the Graph page.
- The backup guard is CODEX's own hook around X-Libs' generic call table; X-Libs' `register_backup_routes` has no such
  option yet, so another app on it still lets an admin's token restore.
- A device still on the shape before conversations were items deletes, after any write of its own, the messages of
  every conversation whose id is not a context's, and syncs those deletions; every device should be updated together.
- Undo covers contexts only: a change's effect on the graph (its links closed or removed with a context) comes back
  with the context, but an item row a change made stays, as items always do.
- A change applied while another write runs at the same moment (an index pass or sync on the desktop) could count that
  write's context versions as its own; changes are synchronous, so only a slow call, such as following a feed, can.
- No real model has written, amended or followed a blueprint; a scripted fake engine has. Recall by words is a rule of
  shared content words with an English stop list, so a blueprint written in another language matches by meaning only.
- Search's meaning rule (`meaning_floor`) was set on one real run's scores, with the unrelated documents' scores filled
  in from the range it gave; a run with a real model should check it on a larger set. Search's scores with real
  embeddings, the embedder's query prefix, and similar-item proposals, which now use the same rule, are all still
  untested on a real model.

## Later, as separate projects

- **A mail application** with an MCP server, seeded by the mail code frozen here.
- **X-Contacts.**

## Risks

- **Injected instructions** in mail, pages and files: the trust rule under "Action policy".
- **Wrong links trusted:** every model-made link is a proposal with its evidence until accepted.
- **Hosted engines see personal data:** the per-source mark in decision 6, and a log of what was sent (both built).
- **Background cost:** budgets per job, and no model call when nothing changed.
- **Mood that flatters:** the limits under "Mood and curiosity".
