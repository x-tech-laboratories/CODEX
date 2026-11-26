# How CODEX is put together

CODEX runs on X-Context's code, which merged into it on 2026-11-26 ([doc 4](4-merge-with-x-context.md)); X-Context was a separate
application, and its repository no longer exists. This doc
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

A conversation with the assistant is an item too, of kind `conversation`, kept by CODEX itself rather than another app
("Conversations and runs" below). `add_item_to_contexts` puts any kept item in more contexts and `move_item` moves one
between contexts with its note; `remove_item` refuses to leave a conversation in no context, which
`delete_conversation` deletes instead.

Taking an item out of a context leaves its row, so History can put a deleted context back with its items.

## Collectors

A collector is an X-Libs plugin providing a `collector` (`src/shared/collectors/collector.ts`): `search` finds items in
its app, `resolve` says what became of the ones kept, `manual` takes an item typed in by hand, and `pushed_from` says
how items reach it from elsewhere. The store's calls open a plugin host for each use (`src/shared/collectors/host.ts`),
so turning a plugin on, or giving it a key, holds at once on every device.

One collector is CODEX's own: `codex.conversations` (`src/shared/conversations/collector.ts`), which
`open_plugin_host` adds last for the database it opens, answers `resolve` for conversation items from the conversations
themselves. It is never listed under Plugins, has no marks, and the Add dialog leaves it out.

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
  user's notes on it; a conversation's title and notes alone, carrying no source) and every user and assistant
  message, placed in the contexts holding its conversation. An item's text from its app comes from the collector's
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
  excerpt and where each is, a message with the conversation it is in (its id and title) and that conversation's
  `codex://conversation/<id>` link as its `uri`; `get_index_state` the counts, pending and withheld pieces, the embedder and the last
  error; `rebuild_index` starts again from nothing. The engine is offered `search_index`, screened by source like
  every other read (PR A's withholding and trust). The first page's search uses it, and Settings → Index shows the
  state, the embedder and Rebuild.

## The knowledge graph

Built 2026-11-26 on doc 4's "Knowledge graph". `src/shared/graph/` keeps three synced tables (`schema.ts`):

- `graph_entities`: a person, organisation, topic, place or other, with a name and other names (`alt_names`).
- `graph_links`: a typed link between two nodes, each end a kind (`context`, `item`, `entity`; a conversation is an
  item) and an id. Its `type` is one of `mentions`, `about`, `related_to`, `part_of`, `depends_on` and `same_as`, with
  an optional free `label`. Both tables record who made the row (`made_by`: `user`, `rule`, `similarity` or `engine`,
  with the `rule`, or the `engine` and `model`), its evidence (`evidence_ref`, an `item:<id>` or `message:<id>`, and
  `evidence_excerpt`), a `status` of `proposed`, `accepted` or `rejected`, and a `sources` list like the conversations'.
  A link also has `valid_from` and `valid_until` (a link that stops being true is closed, never deleted) and
  `recorded_at`.
- `graph_decisions`: each accept and reject, with who made what was decided; `list_graph_decision_counts` totals them
  per maker, the signal later work learns from. They stay when the link or entity goes.

Who decides: what the user makes (`add_graph_link`, `add_entity`, `join_entities`) is accepted at once, and so is what
a rule makes. What an engine or similarity makes is proposed, and only the user at the page accepts or rejects it:
`accept_graph_proposals` and `reject_graph_proposals` are page-only like `resolve_proposal`, and never offered to an
engine. A rejected proposal stays as a rejected row, so the same two nodes are never proposed the same type of link
again; removing a link a rule, similarity or an engine made keeps it as rejected for the same reason, while the user's
own link goes. Accepting a link accepts a proposed entity at its end; rejecting an entity rejects the links proposed
to it.

Two entities found to be one are joined by an accepted `same_as` link (`join_entities`); nothing is merged, and
removing that link undoes it. Reads (`records.ts`, `read_joins`) treat a joined group as its earliest-made entity,
carrying the others' names and links. Nothing is joined on a name alone: `propose_entity` gives back an entity of the
same kind already known by that name (or one of its other names) instead of making a second, and refuses one the user
rejected; only a `same_as` link the user accepts joins two.

Reading (`reading.ts`): `get_graph(context_id?, filter?)` gives a context, every context inside it, the items they hold
and the entities linked to those, or the whole graph (contexts not archived, the items they hold, conversations in no
context and every entity), with the links among them and the `structure` (each context to its children and items,
drawn but not links). The filter takes node kinds or types, link types, statuses (accepted and proposed by default)
and closed links; it caps the nodes at 300 (up to 5000), contexts first, then by link count, and says how many nodes
and links were not shown. `get_node_links(node)` lists every link of a node of any status with the node at its other
end, `list_graph_proposals(context_id?)` what waits, `list_link_counts(context_id)` each held item's open links.

Writing: `change_graph_link`, `close_graph_link`, `remove_graph_link`, `rename_entity` and `remove_entity`, which takes
its links along. After every write the feature removes any link whose end no longer exists: a removed context or
entity, or a deleted conversation. An item merely in no context keeps its links, which show again when it is back.
History keeps an entity with its links and each link with what its ends were called (`graph/history.ts`), so a removed
entity comes back with its links and a removed link while both ends exist.

### Links without a model

`rules.ts` runs after each index pass (`when_indexed` in the indexer), for the documents the pass wrote and those
whose text holds the address of one written or whose parent it is, so it runs only for what changed; every document
when the index was empty. Each rule makes accepted links with an id every device gives alike (`rule:<rule>:<from>><to>`),
so two devices make one link:

- `links_to`: an item or context whose title, snippet, notes or text from its app holds another kept item's address
  exactly (trailing punctuation and slashes aside), `related_to` labelled "links to".
- `app_link`: a `codex://context/<id>`, `codex://conversation/<id>` or other app's item link (`scheme://kind/id`) to
  a context or item CODEX holds, `related_to` labelled "links to".
- `parent`: an item whose app gives its parent in its detail (`parent`, which X-Tasks gives for a subtask), `part_of`
  that parent.

A link a rule no longer finds is closed; one that comes back opens again. A link the user rejected, or one of that
type someone else made, stands in its place.

`similarity.ts` runs after a pass that embedded something: an item given new vectors (their mean, scaled to length
one) is compared with every other item's, and those at a cosine of 0.8 or more become proposed `related_to` links
labelled "similar", made by `similarity` with the embedder and model, at most three waiting per item, never between two
items already linked in any way or a pair once rejected.

A pass that made or closed links tells the host (`on_change`), which records History and announces the change.

### Engines and the graph

Engines are offered `get_node_links` and the two proposing calls, `propose_entity` and `propose_link`. The proposing
calls only make proposals, so they run without approval and are not changes under the action policy
(`proposing_calls` in `policy.ts`); the run passes them the engine, the model and the sources it has read, which the
proposal carries. Evidence names an item or a message; its excerpt is kept only when every source it carries is marked
"May be sent to a hosted engine", the mark under which the user lets that source's words leave this computer, and
otherwise only the reference is kept. `get_node_links` is screened like every other read: for a hosted engine a node
carrying a source not marked for it is withheld whole, and each link whose own sources, or its other end's, carry one.
`suggest_links(context_id)` starts an ordinary conversation in the context with a message asking the engine to read
its items and propose; no background job proposes links yet.

### The views

`src/web/graph/` draws the graph with X-Libs' `GraphView` (on force-graph), every colour from Halon's tokens:
contexts as squares in the accent, items as circles by kind, entities as hexagons, proposed links dashed, and lines
labelled "holds" for where contexts and items sit. The same `GraphPanel` is a context's **Graph** view (`set_context_view`
takes `graph`), with a switch to show everything, and the **Graph** page in the sidebar (`#/graph`, or
`#/graph/<node key>` to open on a node), with a box that finds a node by name and centres on it. Filters choose
contexts, items and entities, one link type, and accepted or proposed links; a filter change keeps the last drawing
until the next arrives. The selected node shows beside the drawing (`NodePanel`): what it is, opening it, its links
with who made each and its evidence, Accept and Reject on proposals, Close and Remove, a link to another node picked
through `search_index`, and for an entity Rename, Remove, Join with another and Undo join. A selected link shows its two
ends with the same buttons. **Proposed links** lists what waits with its evidence and maker, and accepts or rejects a
ticked selection after asking. **New entity…** adds one by hand. On a context's page, **Suggest links** starts the run
and opens the pane on it, and each linked item shows its count of links, which opens the Graph page on it.

Entities are documents of the search index too (`entity:<id>`, their name, kind and other names), placed in the
contexts they are linked to, directly or through an item, so `search_index` finds them with their sources screened.

## Items for other apps

`src/shared/items/` answers the Application Standard's four item calls through X-Libs `item_calls`, scheme `codex`, for
CODEX's own things alone: `context`, `conversation` and `entity`, each id the kind and CODEX's id (`context:<id>`),
since a conversation kept from before conversations were items has its context's id. Search matches every word of the
query in a context's name and notes, a conversation's title (its first message clipped, until named) and the notes on
its memberships, and an entity's name and other names, titles that hold the query first. `get_items` reads the rows as
they are now. `list_item_changes` reads contexts and entities from their History versions (`history_item_changes`), a
context's version changing with its memberships, and conversations, which History does not keep, from `item_marks`: a
table of this device's alone, never synced, holding what other apps were last told of each conversation (title,
snippet, detail) and when that changed, brought up to date whenever these calls read conversations; a new mark is
dated by the conversation's own record, a changed or deleted one by when it was first noticed, always later than any
time given before, so a caller's moment misses nothing. A conversation's item never carries a message: its snippet
names the contexts holding it, its detail when it was last used and how many messages it has. The calls are in
`context_api`, so REST, OpenAPI, the server's MCP and the desktop's local MCP serve them as reads; the server's
sign-in is given `is_read_only`, so a read-only token makes them (and the other reads) over REST as over MCP. They are
not in the policy's `offered_api`, so no engine is offered them. `route_of_link` opens `codex://entity/<id>` on the
Graph page at that entity.

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

`src/shared/history/store.ts` keeps a version of a context, its row and its memberships, and of each entity and link of
the graph, after every write through X-Libs `create_history`. Versions sync; writes that arrive by sync are recorded by the device that made them.

## The assistant

Built 2026-11-26 on [doc 4](4-merge-with-x-context.md)'s decisions 4 and 5: conversations kept as items, answered by
an engine plugin that reaches CODEX's data only through CODEX's own calls, under the action policy.

### Engines

An engine is an X-Libs plugin providing an `engine` (`src/shared/engines/engine.ts`), beside the collectors in the
same plugin host. It has a label and a `model()`, and `run(request, signal)` gives back an async iterable of events:
text, reasoning (a reasoning model's thinking, shown while it streams), a notice for the user (such as their message
shortened to fit), a tool call started, its result, usage, done with the final text, or an error with a plain message
and the raw `detail` behind it. The request holds CODEX's instructions, the conversation so far as user and assistant
turns, and the tools: their definitions, a `core` set of the same calls for a small context, and a
`call(name, args)`. An engine never touches the store, MCP or the settings; it may run its own tool loop, as long as
every tool call goes through that `call`. The `engine` setting names the one that answers, by the id it is provided
under.

Both bundled engines (`src/server/engines/`) run on one direct loop (`src/shared/engines/direct.ts`), ported from the
pre-merge assistant: it streams each round, gives up after 20 rounds with a last one offered no tools, and fails a reply
that repeats itself. `codex.anthropic` reaches Claude through the official SDK, never sends a temperature (nor asks
for thinking, so it streams no reasoning), and turns a refusal into an error; `codex.openai` reaches any
OpenAI-compatible endpoint and streams a reasoning model's `reasoning_content` as reasoning. Each plugin's settings hold
its model, context size, the tools offered and an API key command, whose first line of output is the key, read for
each run and kept nowhere. They need Node, so they are bundled where the store runs, by `load_collectors`, and never in
the page.

Fitting (`src/shared/engines/fitting.ts`), before every round: the room for the conversation is the context size, less
the instructions, the tool definitions as sent, a reserve for the reply (the most wanted, 4,096 tokens, or a quarter of
the context, never under 512) and a margin (5%, at least 256 tokens). Tokens are estimated at 2.5 characters each until
the engine reports what a request cost; that engine and model's measured ratio, a little under what was measured and
never above the most cautious seen, is used from then on, in memory while the store runs (engine settings are the
user's alone, so it is not written there). When the conversation does not fit: tool results of earlier rounds are
blanked, oldest first; then whole turns are left out, oldest first, with one line added to the instructions saying so;
then the latest round's tool results; then the newest user message is shortened in its middle, with a marker saying how
much, for that request alone. The reply asked for is the most wanted capped by what is left. Below 512 tokens left, or
when the newest message would keep under 200 characters, nothing is sent and the user is told to raise the context size
or start a new conversation. A request the engine still refuses as too large is fitted again once, with the size the
engine counted (or a quarter fewer characters a token); the loop tells the user, as notices, what was left out. The
stored messages never change, so an over-long message cannot keep a conversation failing.

Tools offered: below 16,384 tokens of context, or when the plugin's **Tools offered** is **Core set**, the engine offers
the core set (`core_tools` in `policy.ts`: the four reads `list_contexts`, `get_context`, `get_item`, `search_index`,
seven changes and the graph's two proposing calls, each with a one-line description and its fields' descriptions left
out); otherwise every offered call.
The core set is the same calls under the same policy, and a test holds it to a written list as it does the whole set.

Failures (`src/server/engines/errors.ts`) are put in plain words with the raw text as `detail`, shown under Details:
an endpoint that cannot be reached or does not answer in time (named by host and port only), a request too large, an
unknown model, a refused key, rate limiting, a key command that failed (never what it printed) and a reply cut off at
its limit (or one that spent it all thinking); anything else says the engine could not answer, with the raw text behind
Details. Text shaped like an API key, and the key itself, never reach a message.

### Conversations and runs

`src/shared/conversations/` keeps two synced tables: `conversations` (an id, the title the user gave, empty while it
goes by its first message clipped to 80 characters, and when it was made) and `conversation_messages`. Each
conversation is an item (`records.ts`): `items` holds `conversation:<id>` from the `conversation` collector, kind
`conversation`, its title, its latest exchange clipped as the snippet, `codex://conversation/<id>` as where it opens and
when it was last used in its detail, rewritten whenever a message is kept or it is renamed; `context_items` holds its
place in each context, with a note, so every view, History, "also in" and search take it as they take any item. One in
no context has no membership. A message is the user's, an answer (with the engine, model, tool calls with their
results, error in plain words and its raw detail, notices and token counts) or an event, such as an approved change. A
reasoning model's thinking streams to open pages as `reasoning` events and lives in the run's state while it writes;
it is never kept, sent back to the engine or indexed.

The calls: `list_conversations(context_id?)` lists a context's conversations, or for null those in no context, most
recently used first, each with whether a reply is being written in it; `get_conversation(id)` gives the messages, the
proposals and the run still going, so a page opened mid-reply catches up; `send_message(context_id, message,
conversation_id?)` keeps the user's message and starts a run (`run.ts`), answering at once with both ids, where
`context_id` is the context the user has open, which the engine is told about, and the conversation is the one named,
a new one in that context for null, or, left out, the context's most recently used one; `stop_reply`,
`rename_conversation` (an empty title goes back to the first message) and `delete_conversation`, which takes it out of
every context with its messages and proposals and keeps its item marked missing, so History can still put a context
back. One run at a time per conversation, held in memory where the store runs. As the engine streams, the run sends
`conversation` events on the host's event stream: the server's `api/events` for a browser, and the daemon's, which the
main process passes to the window as a `conversation` event (`PageApi.on_conversation`). When the run ends its answer
is kept, unless the conversation was deleted meanwhile, and `changed` is announced.

Removing a context removes the conversations no other context holds, with their messages, proposals and any reply
being written there (`when_items_left` in the contexts store tells the conversations feature which items a removal left
in no context); a conversation also held elsewhere stays. History brings a context back without the deleted ones.

Before conversations were items, there was one per context, keyed by the context's id, and `general` for when none was
open. Opening the store, and every write after, adopts any messages or proposals whose conversation has no row
(`adopt_stray_conversations`): each becomes a conversation under the same id, in the context of that id when it exists,
or in no context, so the general one and those of removed contexts are kept and empty ones were never rows. The same
adoption takes in what a device still on that shape syncs.

The instructions (`instructions.ts`) say who the engine is, today's date and the context the pane is open on: its
name, its place in the tree, its notes, the contexts inside it (at most 20, in 1,000 characters) and its items (at most
30, in 3,000 characters), each listing ending with how many more there are and which call lists them, whose titles, snippets and notes go inside
an `<untrusted-data>` fence (`src/shared/engines/untrusted.ts`, which also blanks sentences that give orders), then its
other conversations by title alone, as CODEX's own items. A run never sees a conversation item's latest exchange: the
screened reads give it the title and notes only, and the `conversation` collector counts as sendable and trusted.

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
feeds, a refresh's problem line, messages found by search) and one line after the result says how many were withheld,
of what (items, messages, feeds and so on), from which source and why. The screen notes what each read let through, and only a source without `trusted` marks the run as having read
outside content; a result with none of it left is not fenced and lowers nothing. At the end of a hosted run,
`hosted_sends` keeps its time, engine, model and the counts per source sent and withheld (never the items),
pruned to `hosted_log.keep_days`, 90 by default, and `list_hosted_sends` reads it for Settings.

Each `conversation_messages` and `proposals` row has a `sources` column, a JSON list of the collector ids whose
content its run had read (the screen's included sources, which take in the sources of the earlier answers it was
replayed; a proposal adds the collector its arguments name and the collector of an item it names by id, whose title
its summary quotes). `["*"]`, the column's default, means not recorded, as on every row kept before 2026-11-26; the
user's own messages are written with `[]` and are always theirs. `turns_of` replaces, for a hosted engine, any answer
or event carrying a source it may not be sent with one line saying so, and notes it on the run's screen for the log; an
answer or event it is replayed whole counts as reading its sources again, so one that drew on a source not marked
trusted taints the run as reading that source would;
the index stores each document's sources, so `search_index` screens message hits the same way and a hosted embedder
is never sent them.

The settings that keep the user in charge (`user_only_settings` in `page_api.ts`: `action_policy`, `source_marks`,
`engine`, `embedder`, `hosted_log.keep_days` and `plugins`) are written only from the page: `is_user_only_setting_write`
is the rule CODEX gives X-Libs `page_only_calls`, so the server's sign-in refuses `set_setting` on any of them to every
token and both MCP endpoints refuse it, as they refuse the page-only calls. Sync honours the same list: the server's
`register_sync_routes` takes a change to one of these rows (`device_only`) only from the user's own devices, a token
the device sign-in made, and refuses the whole exchange, and any replace, to a program's token. Full tokens made
before X-Libs 0.84.0 kept their kind cannot be told apart and count as devices; Your account marks each device's token,
so an older program token can be revoked.

### Tools and the action policy

The tools are the contexts feature's calls (contexts, items, collectors and feeds, `move_item` and
`add_item_to_contexts` among them, at `proposal` until the user sets another level), built from their api specs, less
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
`set_action_level` (and the privacy feature's `set_source_mark`) answer only the page: `page_only_methods` in `page_api.ts` marks their specs `page_only` (X-Libs `api_spec`), so the server's sign-in refuses them to every bearer token, the
daemon takes them over its socket from the window, neither MCP endpoint lists them, and the OpenAPI document marks them `x-page-only`. The engine reads those
events at the start of the user's next message. The policy's own calls and the conversations' are never offered.

### The pane

`src/web/assistant/` is the Shell's `side_pane`, titled Assistant, its open state kept by `use_side_pane`. At its head
is RoboBuddy's face (`Mascot.tsx`, moods in `mascot.ts`: asleep with no engine or no store, thinking while a reply is
written, happy or sad for three seconds when one ends), the engine and model answering, and the switcher: the title of
the conversation shown, opening a menu of the context's conversations (those in no context when none is open) with
when each was used and which are being written, then Rename, New conversation and a menu to move it, add it to more
contexts, copy its link or delete it, asking first. The pane shows the context's most recently used conversation
unless one was picked or asked for (`selection.ts`: an item's title, a search hit, or a `#/conversation/<id>` route,
which a `codex://conversation/<id>` link opens, go to a context holding it and open the pane on it); New
conversation leaves the box sending to a new one. `use_conversation` loads the one shown and lays the streamed events
over it until the kept answer arrives; a reply keeps being written while the user looks at another. Tool calls are
folded rows, a proposed one reading as the user decided it; waiting proposals are cards with Approve and Reject; the message box sends on Enter. While a reasoning model
thinks, a folded Thinking row opens to its thinking streaming, and the answer replaces it; a reply's notices show as
banners above it, and an error says what happened in plain words with the raw detail under Details. Settings gains an
Assistant category: Engine (which engine answers, whether it is local or hosted, and each engine plugin's own settings
in its row), Action policy (each change's level, the two riskier levels badged) and Sent to hosted engines (the log).
Each collector's row under Plugins holds its two marks, explained in plain words (`src/web/privacy/`), and the pane's
head badges the engine local or hosted.

### Still to come

The Inbox and background queue, jobs and blueprints, in doc 4's order.
