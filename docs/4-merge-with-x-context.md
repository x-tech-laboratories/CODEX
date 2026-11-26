# Merge with X-Context

The plan to make CODEX one application: a personal knowledge base, a knowledge management tool and a personal assistant. [X-Context](https://github.com/x-tech-laboratories/X-Context) moves into this repository and is archived afterwards. Decided 2026-11-26; where this doc and docs 0–3 disagree, this one is newer.

## What it becomes

- **Gathers:** an engine reads notes, tasks, bookmarks, files, contacts and mail from the apps that hold them, through MCP, plugins and APIs.
- **Relates:** it links related items and groups them into contexts, guided by the user.
- **Learns:** a knowledge graph of its own, with embeddings and retrieval, holds what it has learned about the user's world.
- **Works with the user:** each context has a conversation stream of its own, and there is a general one for when no context is open; the assistant has a face and a mood.
- **Keeps itself up:** in idle time it re-reads the graph, researches, and proposes new links.
- **Remembers how:** schedules for its own recurring jobs, and blueprints for workflows the user has taught it.

**Window:** the context tree on the left, the workspace in the middle (the items of a context, opened and edited), and the mascot with the context's conversation on the right.

## Decisions

1. **CODEX owns the knowledge.** The graph, embeddings, schedules, conversations and blueprints live in CODEX's store. SmartHarness keeps a store of its own for its evals and is one engine among several. An engine can be swapped without moving what CODEX knows.
2. **Items stay where they live.** X-Context's rule holds: CODEX keeps a pointer to an item, never its content. What CODEX stores is derived (search index, embeddings, entities, links) and can be rebuilt, plus the assistant's own records (conversations, memories, blueprints). The workspace edits an item through its source app.
3. **One application, named CODEX.** X-Context's code is the skeleton: one SQLite store built from features, sync, History, backups, and every call served over REST and MCP. CODEX's daemon socket protocol is retired in the port.
4. **Engines are plugins.** An engine plugin takes the conversation so far and the tools CODEX offers, and streams events back. Planned: the Anthropic API, OpenAI-compatible endpoints, a Claude subscription through its command-line client, and SmartHarness's task tree. An engine may run its own tool loop.
5. **Tools belong to CODEX.** Every engine reaches CODEX's data through CODEX's own calls, the same ones served over MCP. Approval, the action policy and the rule that a run which read outside content cannot change anything are enforced there, once, for every engine. Tools come from four places, all under the same policy:
   - **CODEX's own calls** (contexts, items, links, jobs, blueprints).
   - **The sources' MCP servers.**
   - **Tool plugins:** prebuilt tools installed like any other plugin, beside collector and engine plugins.
   - **Tools the engine writes:** a script saved by proposal, read by the user before its first use, and run in a sandbox where it can call only CODEX's tools.
6. **Sources are other apps' MCP servers,** chosen during setup, each marked for whether its content may be sent to a hosted engine. The X-apps follow one shared convention for this (proposed for the Application Standard), so one collector reads them all.
7. **It runs on the desktop,** on the machine with the GPU. Embeddings stay local whichever engine answers, so changing engine never forces a re-embed.
8. **Recurring work is split.** The user's recurring tasks live in X-Tasks. The assistant's recurring jobs are CODEX's own, and the engine may create and delete them during a conversation.
9. **Mail leaves.** Mail belongs in an application of its own with an MCP server; CODEX reads it like any other source. The mail code here (`src/assistant/mail*.ts`, `imap.ts`, `triage.ts`, `draftReply.ts`) is frozen and seeds that application; it is not ported.

## Action policy

Every function that changes something has a level, set by the user per function. From least to most permissive:

| Level | Meaning |
| --- | --- |
| Restricted | Never permitted. |
| Proposal only | The change waits in the Inbox for the user to approve. |
| Auto allowed | Applied without asking, while the user is in the conversation. |
| Background allowed | Also applied by background jobs with nobody present. The most dangerous level. |

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

## Mood and curiosity

RoboBuddy is the face. The mood is a small state the user can see and switch off.

- **Appraisal:** what CODEX knows sets a short-lived emotion: the user's birthday, a project finished, a person the graph records as having died coming up in conversation. It drives the face and the tone of a reply.
- **Drives:** levels that drift toward a baseline and move with events (a run failing, a proposal rejected, a backlog growing, a long idle spell), after Nexus's drive model. A drive over its threshold starts a job instead of colouring a prompt.
- **Curiosity:** the assistant keeps interests of its own, started by conversations with the user, and researches them in idle time within a budget. What it finds goes in a context of its own that the user can read.
- **Limits:** a mood never changes a fact, a permission or an action policy level; it never asks for attention or blames the user; research queries carry no personal data.

## Order of work

1. **Engine interface:** replace the interim one (`src/engine/engine.ts`, which has the task tree's signature) with conversation in, CODEX's tools in, events out. The hosted model adapters and the direct loop carry over.
2. **Skeleton and conversation:** X-Context's code moves in; conversations per context; the right pane with the mascot; engines as plugins. Needs a three-pane shell in X-Libs.
3. **Inbox and background queue** ported onto the new store, with the action policy.
4. **Index and graph:** content extraction, embeddings, fused search, entities, links, proposals, the graph view.
5. **Workspace:** an editor per kind of item, writing back through collectors.
6. **Jobs and blueprints.**
7. **Self-maintenance:** jobs chosen by what changed, each with a budget, skipped when there is nothing to do.
8. **Mood and curiosity.**
9. **SmartHarness as an engine:** conversation history and CODEX's tools in the task tree; a recorded set of real assistant jobs as the eval, with a hosted engine as the baseline. SmartHarness takes over one class of job at a time once it matches the baseline there.

**Sources to start with:** X-Tasks and Trilium, read-only until the bugs are ironed out.

## Later, as separate projects

- **A mail application** with an MCP server, seeded by the mail code frozen here.
- **X-Contacts.**

## Risks

- **Injected instructions** in mail, pages and files: the trust rule under "Action policy".
- **Wrong links trusted:** every model-made link is a proposal with its evidence until accepted.
- **Hosted engines see personal data:** the per-source mark in decision 6, and a log of what was sent.
- **Background cost:** budgets per job, and no model call when nothing changed.
- **Mood that flatters:** the limits under "Mood and curiosity".
