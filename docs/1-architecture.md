# How CODEX is put together

CODEX runs on X-Context's code, which merged into it on 2026-11-26 ([doc 4](4-merge-with-x-context.md)). This doc
describes what runs today. The pre-merge assistant's design is in `done/done-assistant-architecture.md`, and its code
in `legacy/`, where nothing builds it.

## One page, two hosts

The page in `src/web` is the same React tree in a browser and in the desktop app. At start, `src/web/main.tsx` picks
the host it runs on and hands the page a `PageApi` (`src/shared/page_api.ts`):

| Host    | Where the data is                         | How a call travels                                                              | Sync                               |
| ------- | ----------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------- |
| web     | the server's SQLite file                  | `POST api/call/<method>` with the arguments as JSON                             | none; the browser is online        |
| desktop | `codex.db` in Electron's profile folder | IPC through the preload to the main process, then HTTP over the daemon's socket | X-Libs `sync_client` in the daemon |

Views call `calls().<method>(...)` from `src/web/api.ts` and load with `use_data`, which reloads quietly whenever
`data_watch` is bumped: after this page writes, and when another page or device changed something.

## Contexts and items

`src/shared/contexts/` holds three tables (`schema.ts`), written once as a Drizzle schema with drizzle-kit's
migrations beside it:

- `contexts`: the tree, by `parent_id` and `position`, with notes and an archived flag.
- `items`: one row per thing in another app. Its id is the collector's id and the source's own id, such as
  `x-tasks:<task id>` or `email:<Message-ID>`, so two devices adding the same item make the same row and sync merges them.
  It keeps only what the collector last said: title, snippet, where it opens, a state and a few facts.
- `context_items`: which contexts hold which items, with a note each.

Taking an item out of a context leaves its row, so History can put a deleted context back with its items.

## Collectors

A collector is an X-Libs plugin providing a `collector` (`src/shared/collectors/collector.ts`): `search` finds items in
its app, `resolve` says what became of the ones kept, `manual` takes an item typed in by hand, and `pushed_from` says
how items reach it from elsewhere. The store's calls open a plugin host for each use (`src/shared/collectors/host.ts`),
so turning a plugin on, or giving it a key, holds at once on every device.

The plugins live where they can run. The network ones (X-Tasks, Trilium, links, email) are in
`src/shared/collectors/bundled.ts`; Files needs `node:fs`, so it is in `src/server/collectors/files.ts`, and Firefox
bookmarks reads a copy of a Firefox profile's `places.sqlite` in `src/server/collectors/bookmarks.ts`. The server and
the daemon hand the store every plugin at start with `load_collectors`, the plugins folder's included; only the daemon
adds the desktop plugins, Firefox bookmarks among them, since a server has no Firefox profile. The page runs
its own plugin host over the same records only to show each plugin's settings (`src/web/plugins.tsx`).

A collector may also offer `feeds`: groups in its app a context can follow. `context_feeds` records what each context
follows, and each membership's `via` names the feed that brought it, empty for one added by hand. Before a refresh
resolves items, it brings each followed feed in step: new items join with `via` set, and items whose feed answered
without them leave. Giving an item a note, or adding it by hand, clears its `via`, so it stays. A feed that fails to
answer takes nothing away.

A feed may name a `group` in its app, such as the X-Tasks filter group a tag is in. `add_contexts_from_feed_group`
makes a context for the group with one inside following each of its outer feeds, and records the group in
`context_seeds`; `list_feed_group_news` then offers the group's feeds that no context inside it follows yet.

Plugin keys are kept in the synced `plugins` setting. `get_settings` hides them with X-Libs `hide_secrets`, and
`set_setting` puts the stored key back when the hidden one returns, so the page, the API and MCP never read a key.

`src/server/refreshing.ts` refreshes every item once `refresh_minutes` have passed, checking each minute, on the server
and in the desktop daemon. A refresh writes only the `items` table, which History does not watch.

## The search index

`src/shared/search/` keeps a search index in a SQLite file of its own beside the store's database (`codex-index.db`
in the desktop profile, `<database>-index.db` on the server): never synced, never in backups, and rebuilt from the
store and the sources whenever it is lost. It is a derived cache, so it is reached with plain SQL rather than through
Drizzle, which FTS5 and vector blobs need. The server and the daemon open it and start `keep_indexing`.

- **Documents** (`documents.ts`): every context (name, notes), every item some context holds (title, snippet, the
  user's notes on it) and every user and assistant message. An item's text from its app comes from the collector's
  optional `content(source_ids)`, read only when what its app said of the item (title, snippet, address, state,
  facts) changed, and kept only in the index. Files gives plain text and Markdown files up to 256 KB, X-Tasks a task's
  notes, Trilium a text note's words or a code note's text through ETAPI.
- **Change detection** (`indexer.ts`): each document's text is hashed; a pass writes only documents whose hash changed
  (FTS5 row, overlapping pieces of 1200 characters with 200 of overlap, and no vectors), updates where an unchanged
  one sits, and removes documents gone. A pass runs at start, a moment after any write (the search feature's
  `after_write`) and every minute, catching what came by sync.
- **Embedders** are a third plugin provider beside `collector` and `engine` (`src/shared/embedders/embedder.ts`):
  label, `model()`, `dimensions()`, optional `is_local()`, and `embed(texts)`. The bundled one
  (`src/server/embedders/openai.ts`) posts to an OpenAI-compatible `/embeddings` endpoint, Ollama's on this computer
  by default, with an optional key command. The `embedder` setting names the one in use, none by default. Vectors are
  kept as Float32 blobs scaled to length one, tagged with the embedder and model; vectors of any other are let go, so
  changing either embeds everything again. Embedding runs in batches of 16 in the background, waits while a reply is
  written (`conversations/activity.ts`), and calls nothing when no piece waits. A hosted embedder is never sent an
  item from a source not marked for hosted engines.
- **Search** (`search.ts`): FTS5 by bm25 (title weighted over text, every word as a prefix, any word when not all
  match) and cosine over the vectors in process, the query embedded by the same embedder; each list's best 50 fused
  by reciprocal rank (k = 60). A vector hit counts only above a cosine of 0.3 and within three quarters of the
  nearest. A context given scopes it to that context and every context inside it.
- **Calls** (`store.ts`): `search_index(query, context_id?, limit?)` gives items, contexts and messages with an
  excerpt and where each is; `get_index_state` the counts, pending and withheld pieces, the embedder and the last
  error; `rebuild_index` starts again from nothing. The engine is offered `search_index`, screened by source like
  every other read (PR A's withholding and trust). The first page's search uses it, and Settings → Index shows the
  state, the embedder and Rebuild.

## The Thunderbird add-on

`thunderbird/` is a WebExtension built by `vite.thunderbird.config.ts`. Its popup reads the email shown, lists the
contexts from the server with the ones already holding it ticked, and calls `add_item` with collector `email`. It talks
to the server's API with a token like any other program; `thunderbird/capture.ts` holds everything that does not need
Thunderbird, and is tested.

## The desktop daemon

As in every X-app: `src/daemon/main.ts` is plain Node on Electron's own binary, owning the database, sync, backups,
refreshing, missing-item notices and the local MCP endpoint, and serving the page's calls on
`$XDG_RUNTIME_DIR/codex/daemon.sock`. `src/main/index.ts` keeps the window, the tray (`src/main/tray_menu.ts`) and
the login entry.

## History

`src/shared/history/store.ts` keeps a version of a context, its row and its memberships, after every write through
X-Libs `create_history`. Versions sync; writes that arrive by sync are recorded by the device that made them.

## The assistant

Built 2026-11-26 on [doc 4](4-merge-with-x-context.md)'s decisions 4 and 5: a conversation per context, answered by
an engine plugin that reaches CODEX's data only through CODEX's own calls, under the action policy.

### Engines

An engine is an X-Libs plugin providing an `engine` (`src/shared/engines/engine.ts`), beside the collectors in the
same plugin host. It has a label and a `model()`, and `run(request, signal)` gives back an async iterable of events:
text, a tool call started, its result, usage, done with the final text, or an error. The request holds CODEX's
instructions, the conversation so far as user and assistant turns, and the tools: their definitions and a
`call(name, args)`. An engine never touches the store, MCP or the settings; it may run its own tool loop, as long as
every tool call goes through that `call`. The `engine` setting names the one that answers, by the id it is provided
under.

Both bundled engines (`src/server/engines/`) run on one direct loop (`src/shared/engines/direct.ts`), ported from the
pre-merge assistant: it streams each round, drops the oldest tool results when the conversation outgrows the context
size, gives up after 20 rounds with a last one offered no tools, and fails a reply that repeats itself. `codex.anthropic`
reaches Claude through the official SDK, never sends a temperature, and turns a refusal into an error; `codex.openai`
reaches any OpenAI-compatible endpoint. Each plugin's settings hold its model, context size and an API key command,
whose first line of output is the key, read for each run and kept nowhere. They need Node, so they are bundled where
the store runs, by `load_collectors`, and never in the page.

### Conversations and runs

`src/shared/conversations/` keeps `conversation_messages`, synced: one conversation per context, keyed by the
context's id, and `general` for when none is open. A message is the user's, an answer (with the engine, model, tool
calls with their results, error and token counts) or an event, such as an approved change. `send_message` keeps the
user's message, starts a run (`run.ts`) and answers at once; one run at a time per conversation, held in memory where
the store runs. As the engine streams, the run sends `conversation` events on the host's event stream: the server's
`api/events` for a browser, and the daemon's, which the main process passes to the window as a `conversation` event
(`PageApi.on_conversation`). When the run ends its answer is kept and `changed` is announced; `get_conversation`
gives the messages, the proposals and the run still going, so a page opened mid-reply catches up. Removing a context
removes its conversation and proposals, and stops a reply being written there; History brings the context back
without them.

The instructions (`instructions.ts`) say who the engine is, today's date and the open context: its name, its place in
the tree, its notes, the contexts inside it and its items, whose titles, snippets and notes go inside an
`<untrusted-data>` fence (`src/shared/engines/untrusted.ts`, which also blanks sentences that give orders).

### Sources: privacy and trust

`src/shared/privacy/` gives each collector plugin two marks, kept by plugin id in the synced `source_marks` setting and
set with `set_source_mark`, which answers only the page: `send_to_hosted` and `trusted`, both off until turned on.
An `Engine` says whether it is local with `is_local()`; one that does not say is hosted. `codex.anthropic` is always
hosted, and `codex.openai` is local while its endpoint's host is loopback or a private-network address
(`src/shared/engines/hosting.ts`).

Each run opens a screen (`privacy/screen.ts`) with the marks as they stand and whether its engine is hosted. The
instructions and every offered read that can carry other apps' text pass through it (`privacy/results.ts` holds one
screener per such call, and a test holds that list to the policy's): for a hosted engine, entries from a source
without `send_to_hosted` are taken out (items, followed feeds, a context's source group, a collector's search or
feeds, a refresh's problem line) and one line after the result says how many were withheld from which source and
why. The screen notes what each read let through, and only a source without `trusted` marks the run as having read
outside content; a result with none of it left is not fenced and lowers nothing. At the end of a hosted run,
`hosted_sends` keeps its time, engine, model and the counts per source sent and withheld (never the items),
pruned to `hosted_log.keep_days`, 90 by default, and `list_hosted_sends` reads it for Settings.

### Tools and the action policy

The tools are the contexts feature's calls (contexts, items, collectors and feeds), built from their api specs, less
export, import and the card layout calls (`src/shared/policy/policy.ts`). A read runs at once; what it gives back is
fenced unless it is only the user's own words (`list_contexts`, `list_collectors`) or holds no other app's text once
screened, and holding text from a source not marked trusted marks the run as having read outside content, as does
such an item in the open context's instructions. Every call that changes something has a level in the synced `action_policy` setting,
`proposal` until the user sets another:

| Level | In a conversation |
| --- | --- |
| `restricted` | refused; the engine is told it is not permitted |
| `proposal` | kept in `proposals` with a plain-words summary, for the user to approve or reject; the engine is told it waits |
| `auto` | run, recorded on the call as made by the engine at auto |
| `background` | as auto; the only level a background job with nobody present may act on (no such jobs exist yet) |

Once a run has read outside content, every change it asks for becomes a proposal whatever its level. Approving
(`resolve_proposal`) runs the call through the store as the page would, so History records it, and adds an event to the
conversation saying the user approved it and what came back; rejecting adds one saying so. `resolve_proposal` and
`set_action_level` (and the privacy feature's `set_source_mark`) answer only the page (`is_page_only` in `page_api.ts`): the server refuses them to a bearer token, the
daemon takes them over its socket from the window, and neither MCP endpoint lists them (`program_api`). The engine reads those
events at the start of the user's next message. The policy's own calls and the conversations' are never offered.

### The pane

`src/web/assistant/` is the Shell's `side_pane`, titled Assistant, its open state kept by `use_side_pane`. At its head
is RoboBuddy's face (`Mascot.tsx`, moods in `mascot.ts`: asleep with no engine or no store, thinking while a reply is
written, happy or sad for three seconds when one ends) and the engine and model answering. `use_conversation` loads
the open context's conversation and lays the streamed events over it until the kept answer arrives. Tool calls are
folded rows; waiting proposals are cards with Approve and Reject; the message box sends on Enter. Settings gains an
Assistant category: Engine (which engine answers, whether it is local or hosted, and each engine plugin's own settings
in its row), Action policy (each change's level, the two riskier levels badged) and Sent to hosted engines (the log).
Each collector's row under Plugins holds its two marks, explained in plain words (`src/web/privacy/`), and the pane's
head badges the engine local or hosted.

### Still to come

The Inbox and background queue, the knowledge graph, jobs and blueprints, in doc 4's order.
