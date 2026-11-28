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

- `contexts`: the tree, by `parent_id` and `position`, with notes and an archived flag. Its root is Global ("Global"
  below).
- `items`: one row per thing in another app. Its id is the collector's id and the source's own id, such as
  `x-tasks:<task id>` or `email:<Message-ID>`, so two devices adding the same item make the same row and sync merges them.
  It keeps only what the collector last said: title, snippet, where it opens, a state and a few facts.
- `context_items`: which contexts hold which items, with a note each.

A conversation with the assistant is an item too, of kind `conversation`, kept by CODEX itself rather than another app
("Conversations and runs" below). `add_item_to_contexts` puts any kept item in more contexts and `move_item` moves one
between contexts with its note; `remove_item` refuses to take a conversation out of its last context, which
`delete_conversation` deletes instead.

Taking an item out of a context leaves its row, so History can put a deleted context back with its items.

### Global

Global is the root of the tree, a `contexts` row with the fixed id `global` (`global_context_id` in
`src/shared/contexts/model.ts`), named "Global" until the user renames it. Every other context sits under it;
`move_context`, `remove_context` and `set_context_archived` refuse it with a plain message, and `rename_context` and
`set_context_notes` take it like any context. It is what is open when nothing else is: the page's pane and tree fall
back to it, and every call that took `context_id: null` for "no context" still takes null, which now means Global
(`context_or_global`), so tokens, MCP clients and engines made before it keep working. `add_context` and
`move_context` with a null parent put a context directly under Global. Conversations and blueprints made with no
context are Global's, and any item can be added to it, so it is the catch-all. Where Global stands for everything,
`scope_of` turns it into null: search, the graph and its proposals, and `refresh_items` cover everything kept, as null
did before; inside any other context the scope stays that context and those under it. A blueprint in Global applies
everywhere. Global's notes go into the instructions of every conversation, wherever it was started ("Conversations and
runs" below).

The contexts migration `20261127152615_global` (a custom drizzle-kit step after the released ones) makes Global with
`INSERT OR IGNORE`, puts every context with no parent under it, and gives Global a membership of every conversation and
blueprint in no context that is not deleted. `ensure_global` (`src/shared/contexts/store.ts`) does the same on every
open and every write, writing only what is out of place, so what a device not yet updated syncs in (a context at the
top level, a conversation in none) is taken in at the next write; until then `list_contexts`, `get_context`, search's
tree and the blueprints' climb read a context with no parent as under Global. It also puts Global back at the top,
unarchived, should sync bring it otherwise.

Under sync: the row's fixed id makes every device's create the same row, merged column by column by the sync
engine; re-parenting writes the same value, `global`, on every device, and the membership keys are the context and the
item, so two devices migrating apart converge on one Global, one tree and one membership each, with no cycle, since
Global's own parent is always null (tested in `tests/global_context.test.ts`). History's install gives Global a first
version with the id `first_seen:global`, the same on every device, and the store records what the upgrade changed when
it opens, so each context taken in shows as edited on the device that did it. A device not yet updated sees Global as an
ordinary top-level context holding everything; deleting Global there would delete everything under it on that device,
and the deletion would sync, so every device should be updated (History can bring the contexts back, and `ensure_global`
remakes an empty Global).

## Collectors

A collector is an X-Libs plugin providing a `collector` (`src/shared/collectors/collector.ts`): `search` finds items in
its app, `resolve` says what became of the ones kept, `read` gives one item's whole current content and attributes
(`ReadItem`: `content` and `attributes`, each a label, relation or tag with its value), `manual` takes an item typed in
by hand, and `pushed_from` says how items reach it from elsewhere. `content` gives items' text for the local search
index alone. What `read` gives goes to the run that asked through `get_source_content` and is never stored, by the
pointer rule: the item keeps only what `resolve` says of it.

The bundled X-Tasks collector's `read` gives a task's full notes as content, its tags by path (such as `Home/Garden`)
as `tag` attributes, and its due date, parent id and parent title in `detail`. Trilium's `resolve` and `read` take the
note's labels and relations from ETAPI's note object (`attributes`): `resolve` puts them in `detail.attributes` as
Trilium writes them (`#todo #priority=high ~template=<note id>`), and `read` adds each as an attribute, a relation's
value being the note it points to, beside a text note's words or a code note's text. The store's calls open a plugin host for each use (`src/shared/collectors/host.ts`),
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

### Apps answering the item calls

`src/shared/sources/` reads any app answering the Application Standard's item calls, read-only, with no plugin of
its own. The apps are the synced `item_sources` setting, a list of `{ id, name, address, token, kinds }`: the id is
made once from the first name (`x-tasks`, `x-tasks-2`) and never changes, since kept items carry it; `kinds` is what
`list_item_kinds` answered when the app was last saved, each with `has_text` when the app says so. `add_item_source`, `change_item_source` and
`remove_item_source` check the app answers before saving, and are page-only like `set_source_mark`, the setting being
one of `user_only_settings` (it holds tokens and says what CODEX reads); `list_item_sources` and
`get_item_source_status` read. `get_settings` puts the hidden mark in place of every token and `set_setting` keeps the
stored token when the hidden one comes back, as for plugin keys (`records.ts`).

The bundled plugin `codex.items` (`collector.ts`), which `open_plugin_host` adds for the database it opens beside the
conversations' own, provides one collector per app, `app.<id>`, so its items are `app.<id>:<the app's id>` and two
apps cannot collide; its label is the app's name and its kinds the app's. It is `marked_alone`: its marks are kept
under `codex.items/app.<id>` rather than its plugin's id (`mark_key_of` in `privacy/screen.ts`, which every screen
uses), and `list_source_marks` lists each app as an entry of its own; every other collector keeps its plugin's marks
as before. `search` is `search_items`. `content` asks `list_item_kinds` which kinds have text, then `get_item_texts`
for the items of those kinds, and gives the snippet for the rest and for an app that does not answer that call (it
answers 404 on both paths). `resolve` reads `list_item_changes` from the cursor kept
in `item_source_cursors` (this device's alone, never synced), a page of 100 at a time up to 20 pages: an item changed
is taken as the app now gives it, one deleted is left out so the refresh marks it missing, one unchanged is answered
from what is kept (still missing if it was), and one not kept yet is read with `get_items`. With no cursor, or after
20 full pages, every item asked about is read with `get_items`. The cursor moves on only when the refresh asked about
every item kept from that app, so refreshing one context never skips a change to another's item. Each item `resolve`
reads from the app, by `get_items` or `list_item_changes`, leaves its `changed_at` in `item_source_stamps` (this
device's alone, never synced, keyed by the kept item's id, holding no text); `documents.ts` puts the stamp into the
item's `source_hash`, so the index asks `content` again only for an item whose `changed_at` moved, even when its
snippet did not. Removing the app forgets its cursor and stamps.

X-Libs `item_client` (moved there from `client.ts`) makes the calls with the arguments as a JSON list, which every X-app's API takes (an X-Libs call table
takes nothing else), at `POST /api/call/<method>`, the Application Standard's path for every app, falling back to
`POST /api/<method>` only for an older X-Tasks server that answers nowhere else, remembering per address the one that
answered. Its failures are plain: an address nothing answers at, or
that does not answer in 15 seconds, named by host and port; a token refused (401, or 403 with no 404); a call missing
(404, naming the call); an answer that is not a JSON list. The token goes only into the `Authorization` header.

The Settings rows are `src/web/sources/ItemSources.tsx`: one `SettingsDialogRow` per app, its dialog holding the name,
address and token (left empty to keep it), whether it answers now, its two marks and Remove, and an **Add an app…**
row.

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
  facts) changed, or for an app read through the item calls its `changed_at`, and kept only in the index. Files gives plain text and Markdown files up to 256 KB, X-Tasks a task's
  notes, Trilium a text note's words or a code note's text through ETAPI, an app read through the item calls its
  `get_item_texts` (256 KB at most, cut by the app) or its snippet.
- **Change detection** (`indexer.ts`): each document's text is hashed; a pass writes only documents whose hash changed
  (FTS5 row, overlapping pieces of 1200 characters with 200 of overlap, and no vectors), updates where an unchanged
  one sits, and removes documents gone. A pass runs at start and a moment after any write (the search feature's
  `after_write`), embedding nothing and reading at most 50 items' text from their apps (`texts_after_write`); the
  maintenance jobs "Refresh the index" and "Embed documents" do the rest within their budgets, catching what came by
  sync (see "Self-maintenance"). `index_now()` with no options still indexes and embeds everything, as Rebuild does. Each
  pass notes the documents it wrote or removed, and each embedding the items given vectors, in the index's own
  `changed` table, for the rules and similarity jobs.
- **Embedders** are a third plugin provider beside `collector` and `engine` (tool plugins are a fourth; see "Tool plugins") (`src/shared/embedders/embedder.ts`):
  label, `model()`, `dimensions()`, optional `is_local()`, and `embed(texts)`. The bundled one
  (`src/server/embedders/openai.ts`) posts to an OpenAI-compatible `/embeddings` endpoint, Ollama's on this computer
  by default, with an optional key command. The `embedder` setting names the one in use, none by default. Vectors are
  kept as Float32 blobs scaled to length one, tagged with the embedder and model; vectors of any other are let go, so
  changing either embeds everything again. Embedding runs in batches of 16 in the background, waits while a reply is
  written (`conversations/activity.ts`), and calls nothing when no piece waits. A hosted embedder is never sent an
  item from a source not marked for hosted engines.
- **Search** (`search.ts`): FTS5 by bm25 (title weighted over text, every word as a prefix, any word when not all
  match) and cosine over the vectors in process, the query embedded by the same embedder (through its optional
  `embed_query`, which puts the bundled embedder's query prefix before a search alone); each list's best 50 fused
  by reciprocal rank (k = 60). A vector hit is judged against every document's score for the same query
  (`meaning_floor`), so no model's scale matters: the best must stand 1.2 times the middle half's spread above the
  upper quartile or the query matches nothing by meaning, and a hit must reach a quarter of the way from the upper
  quartile to the best; under eight documents, three quarters of the way from the lowest. A message's fused score
  counts 0.85 of an item's, context's or entity's. A context given scopes it to that context and every context
  inside it.
- **Calls** (`store.ts`): `search_index(query, context_id?, limit?)` gives items, contexts and messages with an
  excerpt and where each is, a message with the conversation it is in (its id and title) and that conversation's
  `codex://conversation/<id>` link as its `uri`; `get_index_state` the counts, pending and withheld pieces, the embedder and the last
  problem in plain words (an embedder's failure names its endpoint by host and port and says what to do, written by
  `explain_embedder_failure` beside the engines' `explain_failure`) with its raw text as `last_error_detail`, cleared as
  soon as a later attempt embeds a batch; `rebuild_index` starts again from nothing. A change to the `embedder` or
  `plugins` setting clears the last problem, ends the embedding in hand, and the next pass tries the new settings. The
  engine is offered `search_index`, screened by source like every other read (PR A's withholding and trust), and
  never given the messages of the conversation it answers in. The first page's search uses it, gathering each
  conversation and its messages in one row, and Settings → Index shows the state, the embedder and Rebuild.

## The knowledge graph

Built 2026-11-26 on doc 4's "Knowledge graph". `src/shared/graph/` keeps three synced tables (`schema.ts`):

- `graph_entities`: a person, organisation, topic, place or other, with a name and other names (`alt_names`).
- `graph_links`: a typed link between two nodes, each end a kind (`context`, `item`, `entity`; a conversation is an
  item) and an id. Its `type` is one of `mentions`, `about`, `related_to`, `part_of`, `depends_on` and `same_as`, with
  an optional free `label`. Both tables record who made the row (`made_by`: `user`, `rule`, `similarity`, `engine` or `program`,
  with the `rule`, or the `engine` and `model`), its evidence (`evidence_ref`, an `item:<id>` or `message:<id>`, and
  `evidence_excerpt`), a `status` of `proposed`, `accepted` or `rejected`, and a `sources` list like the conversations'.
  A link also has `valid_from` and `valid_until` (a link that stops being true is closed, never deleted) and
  `recorded_at`.
- `graph_decisions`: each accept and reject, with who made what was decided; `list_graph_decision_counts` totals them
  per maker, the signal later work learns from. They stay when the link or entity goes.

Who decides: what the user at the page makes (`add_graph_link`, `add_entity`, `join_entities`) is accepted at once, and
so is what a rule makes. The same calls from a token on the server's API or from either MCP endpoint are a program's:
`bind_methods` takes the caller (`src/shared/caller.ts`, `page` unless the server's call route sees a bearer token or the
call came through MCP), and a program's link or entity is kept as proposed with `made_by` `program`, one already
waiting is given back, and one the user rejected is refused; a `propose_*` call from a program with no engine behind it
is a program's too. What an engine or similarity makes is proposed, and only the user at the page accepts or rejects it:
`accept_graph_proposals` and `reject_graph_proposals` are page-only like `resolve_proposal`. An engine is never offered
the first, and is offered the second only as a proposal (`approval_only_calls` in `policy.ts`): each call it makes waits
for the user whatever any level says, has no level of its own, and approving it rejects as the user. A rejected proposal stays as a rejected row, so the same two nodes are never proposed the same type of link
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
end, `list_graph_proposals(context_id?, limit?, after?)` what waits, links then entities, a page at a time when a limit
or the id of the last one seen is given, with how many are `left` (an engine naming no limit gets one at a time,
`engine_page_sizes` in the policy), and `list_link_counts(context_id)` each held item's
open links.

Writing: `change_graph_link`, `close_graph_link`, `remove_graph_link`, `rename_entity` and `remove_entity`, which takes
its links along. After every write the feature removes any link whose end no longer exists: a removed context or
entity, or a deleted conversation. An item merely in no context keeps its links, which show again when it is back.
History keeps an entity with its links and each link with what its ends were called (`graph/history.ts`), so a removed
entity comes back with its links and a removed link while both ends exist.

### Links without a model

`rules.ts` runs in the maintenance job "Links from rules", for the documents index passes wrote since it last ran and those
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

`similarity.ts` runs in the maintenance job "Similar items" for the items given new vectors since it last ran: an item given new vectors (their mean, scaled to length
one) is compared with every other item's, and those standing clearly above what it scores against the rest, judged
by search's `meaning_floor` so the rule holds on any embedder's scale (`standing_out`), become proposed `related_to` links
labelled "similar", made by `similarity` with the embedder and model, at most three waiting per item, never between two
items already linked in any way or a pair once rejected.

A job that made or closed links tells the maintenance host (`on_change`), which records History and announces the change.

### Engines and the graph

Engines are offered `get_node_links`, `list_graph_proposals`, the three proposing calls, `propose_entity`,
`propose_link` and `propose_link_drop`, and `reject_graph_proposals` as a proposal; the core set takes all six. The proposing
calls only make proposals, so they run without approval and are not changes under the action policy
(`proposing_calls` in `policy.ts`); the run passes them the engine, the model and the sources it has read, which the
proposal carries. Evidence names an item or a message; its excerpt is kept only when every source it carries is marked
"May be sent to a hosted engine", the mark under which the user lets that source's words leave this computer, and
otherwise only the reference is kept. `get_node_links` and `list_graph_proposals` are screened like every other read,
and both taint the run as outside content: for a hosted engine a node carrying a source not marked for it is withheld
whole, and each link whose own sources, or either end's, carry one, and each proposed entity on its own sources.

`propose_link_drop(id, reason, evidence?)` asks for a link to go. It never changes the graph: it adds a proposal to the
policy's `proposals`, in the run's conversation, with reason `drop`, the engine and model in its evidence
(`proposed_by`), and a summary naming the link's ends, the reason and the evidence's excerpt (kept on the same marks as
above). An accepted link is proposed as `close_graph_link`, so approving closes it as what was once so; one still
proposed as `reject_graph_proposals` for that one id, so approving rejects it and it is never proposed again. A closed,
rejected or unknown link, or a call with no reason, is refused; a drop already waiting for that link (maintenance's
own close included) is given back instead of a second, and one the user rejected is refused. A program with no
conversation behind it is refused, since it may close or remove the link itself. Approving runs the call through
`resolve_proposal` like any other proposal; `reject_graph_proposals` is in the policy's `drop_api`, a call a proposal
may be for with no level and never offered. `close_graph_link`, `remove_graph_link`, `accept_graph_proposals` and
`reject_graph_proposals` stay off the offered list, so whatever the action policy, every drop waits for the user. The
card and the Inbox say it was asked for by the assistant and its model.

`suggest_links(context_id)` starts a conversation in the context, named Suggest links, shaped so a small model can
finish it: its instructions hold the context's items (kind, title, snippet) as every run's do, and also the context's
entities and links so far (`graph_part`, screened by source and capped like the other listings); its message says to
propose from those, read at most three items for detail, and propose dropping a listed link that is wrong (each link is
listed with its id); it is offered only `propose_entity`, `propose_link`, `propose_link_drop`, `get_item`,
`search_index` and `list_graph_proposals` (`RunOptions.tools`), for six rounds, the last without tools; and its answer ends with a
notice saying how many entities and links it proposed, and how many drops. No background job proposes links yet.

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

`src/shared/items/` answers the Application Standard's item calls through X-Libs `item_calls`, scheme `codex`, for
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
names the contexts holding it, its detail when it was last used and how many messages it has. `get_item_texts` gives
a context's notes and a blueprint's body as Markdown, dated as `get_items` dates them, and `list_item_kinds` says
`has_text` for those two kinds alone; a conversation or an entity has no text. The calls are in
`context_api`, so REST, OpenAPI, the server's MCP and the desktop's local MCP serve them as reads; the server's
sign-in is given `is_read_only`, so a read-only token makes them (and the other reads) over REST as over MCP. They are
not in the policy's `offered_api`, so no engine is offered them. `route_of_link` opens `codex://entity/<id>` on the
Graph page at that entity.

## The Thunderbird add-on

The add-on is in X-Mail (`../X-Mail`, `src/thunderbird/`). Its popup reads the email shown, lists the contexts from the
server with the ones already holding it ticked, and calls `add_item` with collector `email`. It talks to the server's
API with a token like any other program, so CODEX holds nothing of it but the `email` collector.

## Declared configuration

Built 2026-11-27 (`src/shared/declared/`, `src/server/declared.ts`). A machine's configuration can declare engines,
the embedder, the engine that answers, the X-Tasks and Trilium collectors, the Web plugin and MCP servers in a JSON
file: `/etc/codex/declared.json` for the user's own desktop daemon (the window passes an empty `CODEX_DECLARED_FILE`
to a daemon on another profile, so a dev run reads none) and the file `CODEX_DECLARED_FILE` names for the server,
which the NixOS module's `programs.codex.declared` writes. `read_declarations` (`model.ts`) checks it against the
plugins' manifests: an entry's settings must be its manifest's and fit their fields; a secret field is taken only as
`<key>_file` and an engine's or the embedder's key only as `key_file`, never `api_key_command`; an MCP server gets the
id `cfg-<id>` so it never meets one the user added. What is wrong goes into `problems`, on the entry or the whole,
and only that part is left out. `keep_declared` reads the file at start and with X-Libs `watch_config` when it changes,
then lists each declared MCP server's tools in the background.

Where the store runs, `use_declared` (`current.ts`) sets the declarations and the reader of secret files
(`read_secret_from`: the file trimmed, refused when missing, unreadable, a folder, empty or longer than a secret,
naming the file and never its content). Nothing declared is stored or synced:

- **Plugins**: the plugin host's storage lays each declared plugin over the stored records as it reads them
  (`with_declared`: on, its settings, each secret field read from its file now, an empty `api_key_command` when it has
  a `key_file`), and puts every declared plugin's record back as stored before it writes (`without_declared`), so a
  toggle or a settings change never writes a declared value or a secret. A file that cannot be read leaves its field
  empty, and the plugin says it is not set up. An engine's or the embedder's key comes from `plugin_key`: the declared
  `key_file`, read for each run or batch, else the key command; a file that cannot be read fails the run with its own
  plain words (`DeclaredKeyFailure`).
- **A declared engine's model** is only its default. `set_engine_model` keeps the owner's choice for a declared
  engine in `job_device`, this device's own unsynced table (`engine_model:<plugin id>`, `src/shared/engines/choices.ts`),
  and the plugin host's storage lays it over the declared `model` as it reads (`with_declared`'s `chosen_models`), so
  it holds from the next reply and after a restart; choosing the declared model again, or an empty one, removes it.
  No other declared field can be overridden, and no declared option turns this on: the model's name only picks among
  what the declared endpoint serves with the declared key.
- **Choices**: the declared engine is only where the choice starts: `find_engine` takes the synced `engine` setting
  when the user has chosen one, else the declared engine (a lone declared engine when none is named), and Answering
  lists it with every other engine. `find_embedder` takes the declared embedder over the synced setting.
- **A server linked to a collector**: a declared MCP server may name the collector for the same app by its id
  (`collector`, such as `x-tasks` or `trilium`; the NixOS module's `mcpServers.*.collector`). That field is the only
  link, never the address or the name: `open_collector_sources` gives the collector the server's tool key
  (`tools_key`, `codex.mcp/mcp_cfg-<id>`), and its specialist gets the server's tools (see "Specialists"). A
  collector named by a second server, or a value that is not a collector id, is a problem and links nothing; a
  server's own `collector` that names no running collector links nothing either, and the server keeps a specialist of
  its own. Servers the user adds in Settings carry no link.
- **MCP servers**: `codex.mcp` provides each declared server's tools beside the user's, its record made at each use
  with the token read from its file (`server_record`), so a changed token reconnects. Its tools, as listed, are kept in
  memory on this device alone; `refresh_declared_mcp_server` lists them again. `change_mcp_server`,
  `remove_mcp_server`, `refresh_mcp_server` and `move_mcp_server_here` refuse a declared id, and `list_mcp_servers`
  and `get_settings` never show one. Its tools are tool plugins like any other: marks, offers and levels in the synced
  `tool_plugins` and policy settings, off and at `proposal` until the user sets them.
- **The page**: `get_declared_config` (page-only, like `refresh_declared_mcp_server`) gives `declared_summary`: each
  entry's settings, which fields are read from files, the declared servers' tools and every problem, never a file's
  content. `src/web/declared.tsx` shows a declared plugin's settings read-only in place of its controls, the declared
  engine and embedder in place of their choices, a row per declared MCP server with Refresh and its tools' switches,
  and the file's own problems under Plugins, each marked "Set by this computer's configuration".

## The desktop daemon

As in every X-app: `src/daemon/main.ts` is plain Node on Electron's own binary, owning the database, sync, backups,
refreshing, missing-item notices and the local MCP endpoint, and serving the page's calls on
`$XDG_RUNTIME_DIR/codex/daemon.sock`. `src/main/index.ts` keeps the window, the tray (`src/main/tray_menu.ts`) and
the login entry.

## History

`src/shared/history/store.ts` keeps a version of a context, its row, its memberships, its feeds and the graph's links to
it, and of each entity and link of the graph, after every write through X-Libs `create_history`. Restoring a removed
context brings back each of its links that is gone while both its ends exist, leaving a link still there as it is. Versions sync; writes that arrive by sync are recorded by the device that made them.

## The assistant

Built 2026-11-26 on [doc 4](4-merge-with-x-context.md)'s decisions 4 and 5: conversations kept as items, answered by
an engine plugin that reaches CODEX's data only through CODEX's own calls, under the action policy.

### Engines

An engine is an X-Libs plugin providing an `engine` (`src/shared/engines/engine.ts`), beside the collectors in the
same plugin host. It has a label and a `model()`, and `run(request, signal)` gives back an async iterable of events:
text, reasoning (a reasoning model's thinking, shown while it streams and kept with the reply, never sent back), a notice for the user (such as their message
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
the engine reports what a request cost; from then on the estimate follows what that engine, endpoint and model report:
a smaller ratio is taken at once, a larger one moves it halfway, and it is used at 92% of the ratio so followed. A
request refused as too large counts at 90% of what it measured (or a quarter fewer characters a token when the engine
does not say), so it is fitted tighter at once and loosens again as reports show room. It is kept in memory while the
store runs (engine settings are the user's alone, so it is not written there). When the conversation does not fit: tool
results of earlier rounds are blanked, oldest first, each to a line naming its tool and call id and, when
`read_tool_result` is offered, how to read it again with that tool; then over-long earlier messages are shortened in their middle,
longest first and alike, each keeping at least 1,500 characters, with the same marker; only when that is not enough do
whole turns go, oldest first, with one line added to the instructions saying so; then the latest round's tool results;
then the newest user message is shortened in its middle, with a marker saying how much, for that request alone. The reply asked for is the most wanted capped by what is left. Below 512 tokens left, or
when the newest message would keep under 200 characters, nothing is sent and the user is told to raise the context size
or start a new conversation. A request the engine still refuses as too large is fitted again once, with the size the
engine counted (or a quarter fewer characters a token); the loop tells the user, as notices, what was shortened and
what was left out. The
stored messages never change, so an over-long message cannot keep a conversation failing.

Tools offered: when every offered call's definition and the instructions would take half the context or more (estimated as
`fitting.ts` does), or when the plugin's **Tools offered** is **Core set**, the engine offers
the core set (`core_tools` in `policy.ts`: the four reads `list_contexts`, `get_context`, `get_item`, `search_index`,
the source reads `search_collector` and `get_source_item`, `add_item` and seven other changes, the graph's reads `get_node_links` and `list_graph_proposals` and its three proposing calls, `get_blueprint`, the blueprints' two proposing calls, `propose_interest` and `set_mood`, each with a one-line description and its fields' descriptions left
out); otherwise every offered call.
The core set is the same calls under the same policy, and a test holds it to a written list as it does the whole set.

Failures (`src/server/engines/errors.ts`) are put in plain words with the raw text as `detail`, shown under Details:
an endpoint that cannot be reached or does not answer in time (named by host and port only), a request too large, an
unknown model, a refused key, rate limiting, a key command that failed (never what it printed) and a reply cut off at
its limit (or one that spent it all thinking); anything else says the engine could not answer, with the raw text behind
Details. Text shaped like an API key, and the key itself, never reach a message.

Choosing the model (`src/shared/engines/store.ts`, the `engines` feature, with no tables): an `Engine` may give
`list_models(signal)`, which `codex.openai` and `codex.smartharness` do with `list_endpoint_models`
(`src/server/engines/models.ts`): `GET <endpoint>/models` (OpenAI's own when the endpoint is empty), the key read as
for a run (`plugin_key`) and sent only as a bearer token, five seconds at most, at most 500 ids. Each model keeps a
`state` when the server says one: a llama.cpp router's `status` (`{ value: "loaded" | "loading" | "unloaded" |
"failed" }`, or a plain word), or a `loaded` switch; empty otherwise. Any failure (unreachable, a refused key, another
status, not `{ data: [{ id }] }`, an empty list, a key command that fails) is an empty list with a plain `problem`
naming the endpoint by host and port, never the key. `list_engine_models(plugin_id)` gives the list with the model in
use and the declared one; it is open to tokens like `get_assistant_status`, and no engine is offered it.
`set_engine_model(plugin_id, model)` is page-only: one line of at most 200 characters, kept in the engine's synced
settings for the user's own engine, or on this device for a declared one (under Declared configuration). The page
writes the user's own engine's model through its plugin host (`choose_model`), as every other plugin setting, so the
records it writes whole keep it. Settings shows the engines' rows with `EngineSettings` (`src/web/engines/`), laid out
as X-Libs `PluginSettings` but with Model as an X-Libs `ComboField` over the list, kept on Enter, a pick or leaving
the field; a declared engine's row shows its model the same way, with a button back to the declared one. The pane's
head (`PaneModel`) shows a compact `Select` of the list beside the engine when there is one, the model as text when
not, and, while the chosen model is listed as not loaded (or was just chosen where the server does not say), that the
first reply may take a minute or more to load it. The list is asked when the model changes and when a reply ends, not
on every change. Each kept answer records its engine and model, which the transcript shows under it.

### The SmartHarness engine

Built 2026-11-27 on doc 4's step 9, experimental. `codex.smartharness` (`src/server/engines/smartharness.ts`), bundled
by `load_collectors` beside the two direct engines and off until its row is turned on (`enabled_by_default: false`),
provides the engine `smartharness`, labelled SmartHarness. Its settings: endpoint and model, as for `codex.openai`;
context size; the longest step (`max_tokens`, at most half the context); levels of subtasks, most tasks and tool calls a
task, each held within what SmartHarness accepts (`harness_limits`); the tools offered; and an API key command, read
for each run as for the others. `is_local()` is `is_local_endpoint` of its endpoint.

- **SmartHarness is loaded on first use.** The package (`@x-tech-laboratories/smartharness`, a git dependency pinned
  to a commit, with its `dist/` committed) is imported by `run`, so CODEX starts without loading it, and a failed import
  is an error saying it is not installed. Its dependency `node-llama-cpp` is overridden by the stub in
  `stubs/node-llama-cpp` (root dependency `file:./stubs/node-llama-cpp`, override `$node-llama-cpp`), which throws if
  loaded: the harness imports it only to run a GGUF file, which this engine never asks, so CODEX's install grows by
  about 9 MB and 70 packages rather than the 775 MB of llama.cpp builds (linux x64 with its CUDA and Vulkan builds).
  `package.json` also lists SmartHarness's own runtime dependencies (`@modelcontextprotocol/sdk` 1.x, `sqlite-vec`,
  `yaml`), since the nix builds prune with importNpmLock's patched lock and copy each linked dependency out of its store
  path, and prune keeps only what a root package names.
- **The model** is CODEX's `ChatModel` from `make_openai` (the `codex.openai` client), adapted by `harness_model` to
  SmartHarness's `ChatModel`: messages and tool calls converted both ways, `tool_choice: "none"` sending no tools, and a
  step's `response_format.schema` sent as the request's `json_schema`, which `openai_request` puts in
  `response_format: { type: "json_schema" }` for llama.cpp's server and Ollama to hold as a grammar. Each completion's
  usage is a `usage` event, so every model call is a round to a background job's limits.
- **The run** is SmartHarness's exported `TaskTreeRun`, not `executeTaskTree`, which always builds SmartHarness's own
  toolbox and knowledge store from its settings. It is given: the newest user message as its request; CODEX's
  instructions followed by as many earlier turns as fit, newest kept first and each shortened to 1,500 characters, in
  `instructions` (`harness_input`; both take at most 40% of the context at 2.5 characters a token, and instructions
  alone over that are an error asking for a larger context, with a notice when turns are left out); no knowledge store
  (`null`), so it recalls, records and queues nothing; no agents; mode `auto`, trust `user` (CODEX's policy lowers a
  tainted run itself), file writes and tests off, `confirmActions` off and no clarification callback, so a question the
  tree would ask becomes a stated assumption; and the abort signal. A subclass returns no skills for any task, so no
  guide file under the user's config folder is read, and no search results, so its automatic web search never runs.
- **Tools** reach the tree only as one MCP server, `codex` (`tool_bridge.ts`): the run's offered tools
  (`offered_tools` with the plugin's tool set) served by `@modelcontextprotocol/server` on `127.0.0.1` at a port the
  system picks, behind a bearer token of 32 random bytes made for the run, refusing any other path, and closed when the
  run ends. SmartHarness names them `mcp__codex__<name>` and offers them to tasks that act; each call goes through the
  run's `call`, so the action policy, fencing, tainting, screening and the hosted log apply as for every engine, and is
  streamed as `tool_call` and `tool_result` events, the call reaching the run's record before the policy decides it. In
  place of SmartHarness's toolbox the run gets a stand-in with no tools (`no_builtin_toolbox`) that refuses any name
  (`web_search` finds nothing), so its web, file and test tools are never offered and cannot run; a test fails if any
  model request offers a tool not in the run's list, and another that the model naming each built-in runs nothing.
- **Events:** each step's label (`Task 1.2 · Deciding`) and what it streams are `reasoning`, so the Thinking row shows
  the tree working; a reasoning model's own thinking is too. The answer is one `text` and `done`, after a `notice`
  saying how many tasks met their deliverable and how many model calls it took. A stop is "Stopped."; a model failure is
  put in plain words by `explain_failure`, with keys hidden; SmartHarness's own refusals are said as they are.

### Conversations and runs

`src/shared/conversations/` keeps two synced tables: `conversations` (an id, the title the user gave, empty while it
goes by its first message clipped to 80 characters, and when it was made) and `conversation_messages`. Each
conversation is an item (`records.ts`): `items` holds `conversation:<id>` from the `conversation` collector, kind
`conversation`, its title, its latest exchange clipped as the snippet, `codex://conversation/<id>` as where it opens and
when it was last used in its detail, rewritten whenever a message is kept or it is renamed; `context_items` holds its
place in each context, with a note, so every view, History, "also in" and search take it as they take any item. One
started with no context named is Global's. A message is the user's, an answer (with the engine, model, tool calls with their
results, thinking, error in plain words and its raw detail, notices and token counts) or an event, such as an approved change.

A reasoning model's thinking streams to open pages as `reasoning` events and gathers in the run's state as `thinking`,
a list of stretches `{ text, text_at, calls_before }` (`ThinkingPiece` in `model.ts`): a new stretch begins whenever
text or a tool call came since the last one (`add_thinking`, which the page's `next_run` uses too), so each keeps how far
into the reply's text it came, as a call's `text_at` does, and how many of the reply's calls came before it, which
orders it among calls made at the same place. When the run ends the stretches are kept on the answer's `thinking`
column (a JSON list, migration `20261127230412_thinking`), moved back by the spaces the kept text lost at its start
(`thinking_placed_in`), whole and with no size cap, so they sync with the message and go wherever it goes. The synced
setting `keep_thinking` (on unless set to false; Settings → Assistant → Engine → **Keep thinking**) turns that off:
thinking still streams and stands in the run, but the answer keeps none. A specialist's thinking is kept the same way
on its `ask_` call's own `thinking`, placed among its nested calls (its text is not kept, so `text_at` is 0). While it
runs, open pages hear it start (`specialist_started`, with its label) and its thinking and text stream to them as
`specialist_reasoning` and `specialist_text` events tagged with the ask call's id and how many of its calls came
before; `stream_throttle` (`specialists.ts`) joins the pieces and sends them at most every 200 ms, the thinking kept on
the ask's call as each piece is sent and all of it sent before the ask's next `tool_result`, so a page loading the
run and the events after it agree. The text only ever reaches the page: nothing of it is stored or sent to an engine. Thinking is never sent back: `screened_turns` builds every engine's
conversation from the messages' text alone, which a test holds for the Anthropic, OpenAI-compatible and SmartHarness
engines. It is not indexed for search, and, being the model's own text derived from the conversation, it carries the
answer's `sources` like the text beside it.

The calls: `list_conversations(context_id?)` lists a context's conversations, Global's for null, most
recently used first, each with whether a reply is being written in it; `get_conversation(id)` gives the messages, the
proposals and the run still going, so a page opened mid-reply catches up; `send_message(context_id, message,
conversation_id?)` keeps the user's message and starts a run (`run.ts`), answering at once with both ids, where
`context_id` is the context the user has open, which the engine is told about, and the conversation is the one named,
a new one in that context for null (Global for a null context), or, left out, the context's most recently used one that is not a background
job's; `stop_reply`,
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
or in Global, so the general one and those of removed contexts are kept and empty ones were never rows. The same
adoption takes in what a device still on that shape syncs.

The instructions (`instructions.ts`) say who the engine is, today's date and the context the pane is open on: its
name, its place in the tree, its notes, the contexts inside it (at most 20, in 1,000 characters) and its items (at most
30, in 3,000 characters), each listing ending with how many more there are and which call lists them, whose titles, snippets and notes go inside
an `<untrusted-data>` fence (`src/shared/engines/untrusted.ts`, which also blanks sentences that give orders), then its
other conversations by title alone, as CODEX's own items. With no context named it is Global, described as the root
from which search and the tools cover everything. In any other context, Global's notes come first, after the date, as
the user's standing guidance for every conversation; like a context's own notes they are the user's text, so they go
outside the fence, and past 1,500 characters (`longest_global_notes`) they are cut with a line saying `get_context`
with id `global` gives the rest, in Global itself as well, so long notes still fit. A run never sees a conversation item's latest exchange: the
screened reads give it the title and notes only, and the `conversation` collector counts as sendable and trusted.

### Sources: privacy and trust

`src/shared/privacy/` gives each collector plugin two marks, kept by plugin id in the synced `source_marks` setting
(each app read through the item calls by its own key, `codex.items/app.<id>`; see "Apps answering the item calls") and
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
`engine`, `embedder`, `hosted_log.keep_days`, `plugins` and `item_sources`) are written only from the page: `is_user_only_setting_write`
is the rule CODEX gives X-Libs `page_only_calls`, so the server's sign-in refuses `set_setting` on any of them to every
token and both MCP endpoints refuse it, as they refuse the page-only calls. Sync honours the same list: the server's
`register_sync_routes` takes a change to one of these rows (`device_only`) only from the user's own devices, a token
the device sign-in made, and refuses the whole exchange, and any replace, to a program's token. Full tokens made
before X-Libs 0.84.0 kept their kind cannot be told apart and count as devices; Your account marks each device's token,
so an older program token can be revoked. Backups honour the same rule: the server serves them at `/api/backup/<method>`
through X-Libs' call table, for an admin, and a hook on that route (`user_only_backup_calls` in `page_api.ts`:
`restore_backup`, `remove_backup` and `set_backup_schedule`) refuses them, by the route's decoded name, to every
request not made by a session or the trusted proxy, so no token, an admin's or a device's included, can restore a
crafted backup over the settings above, delete backups or schedule fewer kept. Listing, taking a backup and reading the
schedule stay open to an admin's token. No backup call is in the api spec, so neither MCP endpoint offers one, and
the desktop daemon serves its backups only over its socket to the window.

A conversation keeps the assistant's task list for the job in hand (`conversations/task_list.ts`, the `task_list`
column): its steps in order, each with its status (`todo`, `doing`, `done` or `skipped`) and a short note of what was
decided. A run neither isolated nor kept to a few named tools is offered `set_task_list`, which replaces the list
through `set_conversation_task_list` and gives it back; a specialist it asks keeps the same list, told in its
instructions how to work through it and what it holds so far. A run starts with any list an earlier
reply left open in its instructions, and after each of its other calls is told where the list stands, or, a few calls
into a job with none, to write one. Every run's and specialist's instructions say to work one step at a time and to
decide on one entry of a list before reading the next. A reply that stops short with steps open says to send "carry
on". The pane shows the list above the message box, with Clear.

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
| `background` | as auto; the only level a background job with nobody present may act on |

Once a run has read outside content, every change it asks for becomes a proposal whatever its level; a drop of a
graph link (`propose_link_drop`, under Engines and the graph) is one at every level, with reason `drop`. Approving
(`resolve_proposal`) runs the call through the store as the page would, so History records it, and adds an event to the
conversation saying the user approved it and what came back; rejecting adds one saying so. `resolve_proposal` and
`set_action_level` (and the privacy feature's `set_source_mark`) answer only the page: `page_only_methods` in `page_api.ts` marks their specs `page_only` (X-Libs `api_spec`), so the server's sign-in refuses them to every bearer token, the
daemon takes them over its socket from the window, neither MCP endpoint lists them, and the OpenAPI document marks them `x-page-only`. The engine reads those
events at the start of the user's next message. The policy's own calls and the conversations' are never offered.

**Tool results** (`src/shared/conversations/results.ts`). Each `ToolContext` keeps every call's whole result in memory
for the life of the run, by call id (the engine's own, which `EngineTools.call` is handed, made unique; the direct loop
also numbers repeated server ids apart), with whether it was fenced, the sources it carried and whether it lowered the
run. Nothing more is written to the store: the message keeps each call's result as the engine was shown it, as before.
What is kept is the result after screening, so a hosted engine never gets back what it was not sent. A result longer
than `max_result_chars` (12,000) is shown cut, with
`[Cut at 12,000 of 48,213 characters. For the rest call read_tool_result with call_id "…" and offset 12000, or call … again with narrower arguments.]`
after the fence. `read_tool_result(call_id, offset?, length?)` is offered to every run and every specialist, in the
full and the core set, with a one-line description; it is not a store call and asks no level. It gives a slice of at
most 12,000 characters, fenced as the original was, and a line with the next offset or saying it is the end; it
lowers the run when the original did and is noted as a read for proposal evidence. An unknown id is an error listing
the ids kept. A specialist's context keeps its own results, so it reads only its own calls', and the run asking it
reads only its own (the ask's answer among them).

A proposal keeps its `evidence` (a JSON column): the user's message that asked for it (`asked_by`), the run, and each
read the run made before proposing, by its tool call's id with its name and arguments, the sources it carried, and an
excerpt of what came back only when every one of those sources is marked for hosted engines, as graph evidence is
kept, and `seen`, the sources whose content the run had in front of it, in its instructions or through a read. The
card folds it under "Why, and from what", whose "From" line names only `seen` and is left out when it is empty.

Every applied change, approved or made at auto, keeps an `undo` on its tool call (`policy/undo.ts`): the contexts
History recorded it touching, each by the version it made and the version before (none for a context it made), with
its summary. `list_change_undos(conversation_id)` says for each whether it can still be undone: not once a context it
touched has changed since (its own rows; a link to it does not count), nor once History has pruned a version it needs,
nor when it touched nothing History keeps, such as a refresh, which the row says instead of offering Undo.
`undo_change(message_id, call_id)` restores each version before, parent contexts first, or removes a context the change
made, marks the call undone and adds an event saying so. It is page-only like `resolve_proposal` and never offered.

### Tool plugins

Built 2026-11-27 on doc 4's decision 5. `tools` is a fourth plugin provider beside `collector`, `engine` and `embedder`
(`src/shared/tools/tool.ts`): a label, an optional `own_words`, an optional `description` of the whole plugin (shown
by its specialist's `ask_` tool), `tools()` giving the tools offered now (each a name, a
plain-words description, a JSON Schema for its arguments, `changes` and `sends_outside`; a tool that leaves either out
is taken to change something and to send outside), and `call(name, args, signal)` answering with text. Like engines,
tool plugins need Node and are bundled where the store runs, by `load_collectors`; the page has their manifests only.

`open_tool_plugins` (`tools/offered.ts`) reads every tool provider through the plugin host, each under its key
`<plugin id>/<provider id>`, and names each tool `<namespace>__<tool>`: the provider's id made safe as the namespace,
the tool's own name made safe, cut with a hash at 64 characters. CODEX's own calls never hold `__`, so a tool cannot
shadow one, and of two tools named alike the first is kept. A plugin whose `tools()` throws or takes over 15 seconds is
listed with its problem and no tools. The synced setting `tool_plugins`, one of `user_only_settings`, holds per key the
marks `send_to_hosted`, `trusted` and `after_private` and, per tool, `off` and `small`; `send_to_hosted` left unset
reads as on only for the bundled Web plugin's key, `codex.web/web` (`hosted_by_default` and `marks_of` in
`tools/offered.ts`), and as off for every other plugin and every MCP server, and the others as off; levels go in `action_policy` under the tool's
name. The feature's calls (`tools/store.ts`) are `list_plugin_tools` and the page-only `set_tool_plugin_mark`,
`set_plugin_tool_offer` and `set_plugin_tool_level`.

A run (`start_run`) opens the tools turned on, leaving out those a task's `RunOptions.tools` does not name, and
`engine_tools` adds them after CODEX's calls: every one in `definitions`, and in `core` only those marked `small`. A
description is shown as its plugin's own words only when the plugin sets `own_words`; otherwise it is clipped to 1,000
characters (120 in the core set) and fenced, and either way followed by what the tool does ("It changes something…",
"It sends its arguments outside this computer."). The instructions gain a line naming the outside-sending tools and
telling the engine never to put personal details from the user's items into their arguments. Every call goes through
the same `call` as CODEX's own, so it is recorded with its arguments and result:

- Arguments must be an object holding every `required` field.
- A tool with `sends_outside` is refused, for the rest of the run, once the run's screen has included anything from a
  source whose mark lacks `send_to_hosted` (`has_read_private` in `privacy/screen.ts`: the open context's items, a
  read, an earlier answer replayed, or `*`), unless the plugin is marked `after_private`. The refusal says why and
  names the mark.
- A read runs at once (`run_tool`, stopped by the run's signal or after 120 seconds whatever the plugin does). A change
  is decided by `decide` with its level (`proposal` until set), so it is refused, proposed with a summary naming the
  plugin, the tool and its arguments clipped, or run at `auto` (and in the background only at `background`); a run that
  read outside content proposes it. `resolve_proposal` runs an approved plugin tool through `find_plugin_tool`, and
  its event carries the plugin's source. Undo says it cannot be undone, as History keeps nothing of it.
- What comes back is always fenced and noted on the screen as the source `tool:<key>`, which marks the answer's
  `sources`, so replaying it later counts again; it lowers the run unless the plugin is marked trusted. `open_screen`
  gives each tool source its plugin's `send_to_hosted` and `trusted`, and a tool source of no plugin running is
  unmarked, so a hosted engine is never replayed an answer or event, shown a search hit or sent a proposal's evidence
  excerpt that carries what an unmarked plugin gave back, and a hosted embedder never embeds it; a withheld line says
  so, as for a source. A hosted engine is not offered an unmarked plugin's tools at all (`engine_tools` and `start_run`
  leave them out), and reading one in a local run counts for `has_read_private`. A plugin's error is fenced too.
- Each use of an outside-sending tool, whatever engine asked, and each approved one, adds a `hosted_sends` row of
  `kind` `tool` (`record_tool_send` in `privacy/store.ts`): the tool by its plugin's label and name, the engine, the
  run, and how many arguments of how many characters, never their content.

The bundled `codex.web` plugin (`src/server/tools/web.ts`, manifest in `tools/manifests.ts`, off by default) provides
`web` with `web_fetch` and, once its `search_endpoint` is set, `web_search`, both reads that send outside, in its own
words. `web_fetch` takes a public `http` or `https` address (`address_guard.ts`): no user name or password, port 80 or
443 unless listed in `allowed_ports`, and a host whose every address is public, judged by `is_public_address` against
IPv4's and IPv6's non-public ranges with an IPv4 address mapped into IPv6 or under 64:ff9b::/96 judged as itself. It
checks the host before each request and again in the connection's own `lookup`, so the connection reaches only
addresses just checked, and again after each of at most five redirects; it reads at most 2 MB in 15 seconds, only
HTML, XHTML, plain text and Markdown, and gives the address, the title and the text (`tools/html_text.ts`: a block to a
line, scripts and styles out, a link's address after its text) cut at 10,000 characters. The guard takes an injected
resolver and a test-only `allow_address`, which only code can pass, so tests reach a fake server on loopback without
weakening it. `web_search` sends `GET <endpoint>/search?q=<query>&format=json` to the user's SearXNG instance and gives
the first eight results' titles, addresses and snippets.

The bundled `codex.mcp` plugin (`src/shared/mcp/`) turns each MCP server the user added into a tool plugin of its own.
The servers are the synced setting `mcp_servers`, one of `user_only_settings`, a list of `{ id, name, transport,
address, token, command, args, variables, device, enabled, tools, listed_at }`: `transport` is `http` (streamable HTTP at
`address`, with `token` as a bearer token, hidden by `get_settings` and kept by `set_setting` when the hidden mark comes
back, as the apps' tokens are) or `stdio` (`command` started with `args`, passing the variables of CODEX's own
environment that `variables` names, on the device whose id is `device` alone). The id is made once from the first name.
`device` is this device's own id (`device_id_of`, never synced) when a stdio server is added or a server becomes stdio
here, and empty for `http`; `runs_on(server, device_id)` in `mcp/model.ts` holds for an address anywhere and for a
command only on its device, and one with no device recorded runs nowhere. `tools` is what the server listed when it
was added or refreshed, each with its name, description (2,000 characters at most), `read_only` (the server's
`readOnlyHint`) and input schema, so opening the plugin host starts no server. `mcp_plugin(database)`, which
`open_plugin_host` adds beside the apps' plugin, provides `tools` under `mcp_<id>` for each server that is on and runs on this device, labelled
with its name, without `own_words`, so its descriptions reach the engine fenced and clipped; a tool changes something
unless it is read-only, and sends outside unless the server is a command or its address is a loopback one
(`sends_outside` in `mcp/model.ts`). Its key for marks and tool choices is `codex.mcp/mcp_<id>`.

The calls (`mcp/store.ts`): `list_mcp_servers` reads (tokens never, only `has_token`), and the page-only
`add_mcp_server(fields)`, `change_mcp_server(id, fields)`, `refresh_mcp_server(id)`, `move_mcp_server_here(id,
{ command, args })` and `remove_mcp_server(id)` check the fields, list the tools before keeping a new or newly reached
server (a server that cannot answer is not kept), and close a connection whose server changed or went. A command on
another device is never started here: refreshing it, or changing how it starts, is refused, while its name and On switch
can still change; `move_mcp_server_here` takes the program and arguments the page showed, refuses them unless they are
the stored ones, lists the tools here and records this device. `list_mcp_servers` gives each `runs_here` and the
`device_name` it runs on, from the background devices. They reach servers through an `McpConnector` (`mcp/connector.ts`) set
where the store runs by `load_collectors`, since a command needs Node: `src/server/tools/mcp_client.ts`, on the
official SDK's client (`@modelcontextprotocol/client`). It keeps one connection a server, closed after two minutes
unused; starts a command through the SDK's stdio transport, without a shell, with the SDK's safe variables (`HOME`,
`LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`) and those named, keeping the last 600 characters of its stderr for errors;
reaches an address over streamable HTTP with the token from an auth provider and same-origin redirects only; gives
connecting and listing 20 seconds and a call 60; and closes a connection whose call failed, timed out or was stopped, so
the next call starts afresh. Failures are plain words naming the server (not found, may not be run, could not be
reached at host and port, refused the token, stopped with what it wrote, did not answer in time), never the token. A
tool's answer is its text parts, a resource's text and the rest named in brackets; one marked `isError` fails the call.

Settings: each tool plugin's row under Plugins shows its three marks, the first saying a hosted engine is not offered
the tools while it is off, and each tool with its facts, an on switch and "Also
offer to small models" (`src/web/tools/ToolSettings.tsx`); Action policy lists the plugin tools that change something
after CODEX's own; the hosted log shows tool uses in words. MCP servers have a row each under Plugins
(`src/web/mcp/McpServers.tsx`): its On switch, how it is reached, Save, its tools with Refresh, its marks and each
tool's switches, and Remove, then **Add an MCP server…**. A command on another device shows **Runs on** that device in
its row and dialog, no tools, and **Move to this device…**, whose confirmation shows the program, arguments and
variables before `move_mcp_server_here` runs.

### Specialists

Built 2026-11-27 and 2026-11-28 as doc 4's step 10: tool plugins (MCP servers among them), the source apps' collectors
and then CODEX's own calls as specialists, each told how its part or app works, so with specialists in use the
orchestrator holds only `ask_` tools, `set_mood` and `set_task_list`. **Why:** with the owner's MCP servers connected, every tool described is about
92,000 tokens, so a gpt-oss-20b at 32,768 tokens got only the core set and could not use those apps at all;
SmartHarness measured the same split on a 4B model at 0/66 tasks with one flat list of 116 tools against 54/66 with
specialists (its doc 1, "Agents").

- **The orchestrator's tools.** When a run has a specialist host (every `start_run` does), `engine_tools` groups the
  plugin tools it would offer (turned on, and for a hosted engine only those of plugins marked for it) by plugin
  (`specialist_groups` in `src/shared/conversations/specialists.ts`) and adds `specialists` to the `EngineTools`: the
  same definitions and core set with each plugin's tools taken out and one `ask_<label>` tool per plugin put in, in
  both, whatever the tools' "Also offer to small models" switches say; and `delegated`, the plugin tools' full
  definitions. The name is `ask_` and the label made safe (`ask_x_budget`), cut at 64 characters with a hash of the
  plugin's key when too long or taken, never one of CODEX's calls. The tool takes `request`; its description says who
  answers, gives the plugin's own `description` fenced unless `own_words`, lists up to 30 of its tools by name, says
  whether some change something or send outside, and that the specialist sees nothing of the conversation but the
  user's latest message. The run's instructions say what `ask_` tools are.
- **CODEX's own calls.** In a run offered every call (no `only`), `engine_tools` also groups the offered calls by feature
  (`own_groups`, from `own_specialists` in `specialists.ts`): `ask_contexts` (every contexts call, `add_item` and the
  feeds included, and `search_index`), `ask_graph` (`get_node_links`, `list_graph_proposals`, `propose_entity`,
  `propose_link`, `propose_link_drop`), `ask_blueprints`, `ask_interests` and `ask_jobs`. Every offered call is in
  exactly one; once any source app has an ask, its three read calls are that app's specialist's and not the contexts'.
  These five names are reserved, so a plugin labelled Contexts gets a hashed name. Each ask's description lists its
  calls by name and says when to use it, which is where the identity lines on proposing an entity, a blueprint or an
  interest went; its specialist's instructions say how its part works (proposals wait for the user, interests carry
  nothing personal, Global is the root). All their calls leave the `specialists` view and join `delegated`, so the view
  holds only the asks and `set_mood`, which stays with the orchestrator since the mood is its own reply's. A source
  app's ask then says to have `ask_contexts` add what it found. A run offered few calls, such as Suggest links or a
  research run, keeps CODEX's calls as they are and only its plugin and app asks.
- **Instructions with specialists.** `start_run` writes a second set of instructions for a conversation's run
  (`instructions_with_specialists` on the `EngineRequest`), which the engine uses when it chooses the specialists view
  (`chosen_request` in `direct.ts`, used by the direct loop and SmartHarness). It keeps who CODEX is, the rules, the
  date, Global's and the open context's notes and items, the source apps by id, recalled blueprints and the mood, and
  says once that each `ask_` tool hands one request to a specialist that sees only the user's latest message and the
  request; it leaves out the lines on the graph, blueprint and interest calls, the plugin tools' line and the plugins'
  and apps' shortened guidance, which their specialists are given whole. The `ask_` descriptions no longer repeat that
  a specialist sees nothing else, and every ask's `request` has one short description.
- **Source apps.** Each collector running that can search, resolve, read or list feeds, other than CODEX's own conversations,
  blueprints and findings (`open_collector_sources` in `run.ts`, passed as the `ToolContext`'s `collectors`), gets an
  `ask_<label>` tool too (`collector_groups`), named after the plugins' asks so a plugin of the same label keeps its name
  and the app's takes the hash. Its group holds the read calls the app answers and the run is offered:
  `search_collector`, `get_source_item`, `get_source_content` and `list_collector_feeds` (`collector_reads`; nothing
  lists a feed's items without following it). Once any app has an ask, those calls leave the `specialists`
  view's full and core sets and join `delegated`, so the Automatic rule weighs them as it weighs plugin tools; with the
  view not chosen nothing changes. The ask's description says what it can read, that it answers with each item's
  `source_id`, kind, title and details as `add_item` takes them, and that it changes nothing: `add_item`, `follow_feed`
  and every other change stay with the orchestrator, which adds what the specialist reported. Its specialist's child
  context has `only` those calls and `bound_collector` set, so their schemas lose `collector` and every call reads that
  app whatever it names; `add_item`, other calls and every `ask_` answer "There is no tool named …". Its reads go through
  the same `run` as the orchestrator's (screening by the app's own marks, `marked_alone` included, tainting through
  `brings_outside_content`, the reads kept as evidence), count toward `max_calls_here` like plugin tool calls, and its
  answer is noted as the app's source and lowers the run unless the app is marked trusted. A hosted engine gets no ask
  for an app not marked for it, and the run's instructions say to ask an app's specialist when offered one.
- **An app with its MCP server.** When the declared configuration links an MCP server to the collector (`collector`
  on the server, under "Declared configuration"), the app still has one ask: its group takes every tool of that server
  turned on and offered (`tools_key`, `linked_keys`), which then get no `ask_` of their own, beside the read calls with
  the collector bound. The ask's description lists the server's tools and says a change may wait for the user's
  approval; the specialist's instructions say it has both sets, that a change may wait and must then be reported as
  proposed, that it cannot add to contexts or follow feeds, and give the app's and then the server's guidance (fenced)
  and the plugin tools' line. The server's tools run through the same wrapper as any plugin tool's: a change is a
  proposal at the default `proposal` level and whenever the run has read outside content, refused at `restricted`; an
  outside-sending tool is refused once the run has had a private source in front of it unless the server is marked
  "May be used after reading private sources"; a hosted engine is offered none it may not be sent, and when the app
  itself may not be sent to it, the server's tools keep an ask of their own. The ask's answer
  lowers the run unless the app and the server are both marked trusted. Without that field nothing links: a server
  whose address or name matches an app's stays a plugin with its own ask, and the app's ask stays read-only.
- **Whole reads.** `get_source_content` (contexts feature) calls the collector's `read` for one item, live, and answers
  with its content, attributes and the contexts holding it; nothing of it is stored. It is a read that brings outside
  content, screened like `get_source_item` (`screen_source_item`), fenced, kept as a read for evidence, and it lowers
  the run unless the app is marked trusted.
- **Guidance.** Each group carries a `Guidance`: what the plugin or app says of how it works (`guidance` on a
  `ToolPlugin` or `Collector`, the author's own words when `own_words`, else fenced), then the user's. An MCP server's
  `instructions` from its initialize answer are that text, kept on its record (`instructions`, capped at 2,000
  characters) when its tools are listed and fenced like its descriptions; the bundled X-Tasks, Trilium and Web plugins
  give guidance of their own written from what their code does. The user's is Markdown in each tool plugin's and source
  app's dialog under Plugins (`GuidanceField`, an X-Libs `RichText`), kept by source in the synced, user-only setting
  `plugin_guidance` (`set_plugin_guidance`, page-only, at most 4,000 characters), and holds where the two differ. The
  specialist's instructions get both whole (`guidance_text`); the run's own instructions get each offered plugin's and
  app's shortened to 300 characters a part (`guidance_part`), whether or not the engine then chooses specialists, since
  that choice is made inside the engine; the `ask_` descriptions add none.
- **Choosing.** `with_specialists` (`direct.ts`) gives the engine the `specialists` view or the plain one, by the
  engine's **Specialists** setting (`specialists`: `auto`, `on`, `off`, default `auto`, in all three engine manifests,
  so it can be declared like `tool_set`): `on` always, `off` never, `auto` for a context of 32,768 tokens or less
  (`small_context`), and above that when `delegated`'s definitions, CODEX's own calls among them, and the instructions,
  estimated as for **Tools offered**, take half the context or more. A small local model reads every prompt slowly
  (about 10 tokens a second on Odin), so it always gets the shorter request; a large hosted one keeps CODEX's calls
  unless the plugins crowd it. On the Odin-like setup in `tests/orchestrator_size.test.ts` (32,768 tokens, core set,
  three servers of 23 to 130 tools, X-Tasks, Trilium and Web) the instructions and tool definitions come to about
  3,900 tokens against 7,000 when CODEX's calls went to the model directly. **Tools offered** then picks the full
  or core set of the view chosen. The direct loop and the SmartHarness engine both call it before `offered_tools`; the
  `call` is the same either way.
- **The specialist's run.** Calling `ask_<label>` (`ask_specialist` in `run.ts`) runs the same engine afresh
  (`run_specialist`): instructions saying it serves another assistant, has only that plugin's tools, answers briefly
  with what it found or did and plainly what it could not do, and asks no questions; one user turn holding the user's
  own latest message unchanged under `user_request_label` (SmartHarness's `USER_REQUEST_LABEL`) and then the request; no
  history, context, blueprint or mood; and tools from `engine_tools` on a child of the run's `ToolContext` whose `only`
  names that plugin's tools (or that part's calls of CODEX's, fully described), whose `plugin_tools` are that plugin's,
  with no own tools and no specialist host. So any other call, `set_mood`, other plugins' tools and every `ask_` tool
  answer "There is no tool named …", and a specialist never asks another (depth 1); it still has `read_tool_result`
  for its own calls' results. A specialist of CODEX's own is told
  it serves another assistant with CODEX's calls for its part, then how that part works. Its final text comes back fenced as outside data; a failure or a stop
  comes back as an error saying the specialist could not finish, with what it wrote before, fenced.
- **Safeguards inside.** The child shares the run's screen, its list of reads, the user's message id and run id
  (proposal evidence), presence and signal, so every call goes through the same wrapper: the action policy (a change
  is proposed at `proposal`, refused at `restricted`), fencing, the outside-sending refusal once anything private was in
  front of the run, the hosted log's tool rows and the hosted screening. The run starts lowered when the run asking was,
  and what it read lowers the run asking it; the answer is noted on the screen as the plugin's source (`tool:<key>`), so
  the reply's `sources`, the hosted log's counts and later replays carry it, and it lowers the run unless the plugin is
  marked trusted. A specialist of CODEX's own adds no source of its own: what it read was noted by its sources as it
  read it and lowers the run asking it the same way, and its answer comes back fenced. A hosted engine is offered no
  `ask_` tool for a plugin it is not offered. Its model's thinking is kept on the ask's call, as under "Conversations
  and runs".
- **Limits.** A specialist takes at most 8 model rounds (fewer when a background job allows fewer) and 12 tool calls,
  plugin tools or an app's reads (`specialist_limits`, `max_calls_here`); its calls count toward the run's `max_plugin_calls` (`used`), and its
  usage events add to the run's rounds and tokens, so a background job's limits stop the whole run. The run's abort
  signal stops it. Its instructions name its limits and say, for a request larger than they allow, to do what fits
  and answer with what it did and what is left as a ready-to-send follow-up request. One that is refused a call for
  its call limit, or ends in an error after using all its rounds, comes back not as a failure but as a partial result:
  a line saying which limit it hit and to ask again for the remainder or split it, then, fenced, its calls that ran
  with their arguments and what it wrote. The run's instructions with specialists say each ask is one bounded piece
  of a big job, and both the run's instructions and every specialist's say to try one other way at most when a tool
  or specialist cannot help, then say plainly what was found, what failed and why, never repeating a call unchanged
  (`give_up_line`).
- **The record.** The ask's `ToolCallRecord` holds its specialist's calls in `calls`, each with its outcome, proposal
  and result as for the run's own; open pages hear each change as a `tool_result` event for the ask, and its thinking
  and text as they stream (see "Conversations and runs"). The pane lists
  them as rows under the ask's row in the reply's call tree (`CallTree.tsx`), a proposal shown as the user decided it.
  A change a specialist of CODEX's own made is undone like the run's own: `list_change_undos` names it by its id path,
  the ask's call id and its own joined by `/` (`o1/specialist_6`), which `undo_change` takes, and its row offers Undo; a
  plugin tool's change cannot be undone anyway.
- **SmartHarness** gets the `ask_` tools as ordinary tools through its bridge. Native delegation would need SmartHarness
  to take agents and their tools from the caller instead of its own folders: CODEX would pass one agent per plugin
  (description and tool list as above) with that plugin's tools served on its own bridge, and SmartHarness's routing,
  re-routing and pinned request would replace the ask.

### The pane

`src/web/assistant/` is the Shell's `side_pane`, titled Assistant, its open state kept by `use_side_pane`. At its head
is RoboBuddy's face (`Mascot.tsx`, moods in `mascot.ts`: asleep with no engine or no store, thinking while a reply is
written, happy or sad for three seconds when one ends while the mood is on, and otherwise the assistant's mood through
`face_of`: neutral as RoboBuddy's `default`, happy, celebrating as `laughing`, sad, curious and concerned as `worried`,
all RoboBuddy's own), a button whose hover text and tapped popover say the mood and why (`mood_summary`), the engine and model answering, and the switcher: the title of
the conversation shown, opening a menu of the context's conversations (Global's when no other is open) with
when each was used and which are being written, then Rename, New conversation and a menu to move it, add it to more
contexts, copy its link or delete it, asking first; a background job's conversations (each summary's `job`) are listed
last, under a Background jobs heading. The pane shows the context's most recently used conversation that is not a
job's unless one was picked or asked for (`selection.ts`: an item's title, a search hit, or a `#/conversation/<id>` route,
which a `codex://conversation/<id>` link opens, go to a context holding it and open the pane on it); New
conversation leaves the box sending to a new one. `use_conversation` loads the one shown and lays the streamed events
over it until the kept answer arrives; a reply keeps being written while the user looks at another. Tool calls are
rows of an X-Libs `Tree` (`CallTree.tsx`), each run of calls made one after another one tree where it was made in the
reply (`grouped_parts`; a call keeps `text_at`, how far into the reply's text it came; one kept before that was
recorded shows ahead of the text): CODEX's own calls at the top, an ask's row naming the specialist it asked and
folding open onto that specialist's calls, each row named by its id path (`call_nodes`) with its outcome, a proposed
one reading as the user decided it and an applied change with its Undo. Picking a row shows under the tree who made
the call, its arguments, its result and, for an ask, what the specialist thought and wrote among its calls; waiting proposals are cards with Approve and Reject; the message box sends on Enter. While a reasoning model
thinks, a folded Thinking… row opens to about ten lines of its thinking, scrolling and following the newest text
unless the user has scrolled up, and never handing its scroll on to the messages; each stretch stays where it happened
(`reply_parts` places it among the text and calls), folded under Thinking once the reply ends and after a reload, and a
specialist's stretches show among its calls in the ask's detail. While a specialist works its ask's row is picked
until the reader picks another or closes it, the row says "Asking the <label> specialist…" with the time so far, the
detail shows an indeterminate X-Libs `ProgressBar`, and its thinking and text so far stream in among its calls (`nested_parts`, the text after the
thinking before each call); the page keeps the text in the live run's `specialists`, by the ask's id, and drops it once
the kept answer arrives. The messages, and each Thinking box, follow new content only while the reader is at their
bottom (`use_pinned_scroll` in `pinned_scroll.ts`): only scrolling up lets go, so content growing or the box's own
scroll never does, and once let go nothing moves the reader until they come back to the bottom or press **Jump to
latest**; another conversation opens at its end. A reply's notices show as
banners above it, and an error says what happened in plain words with the raw detail under Details. Settings gains an
Assistant category: Engine (which engine answers, whether it is local or hosted, and each engine plugin's own settings
in its row), Action policy (each change's level, the two riskier levels badged) and Sent to hosted engines (the log).
Each collector's row under Plugins holds its two marks, explained in plain words (`src/web/privacy/`), and the pane's
head badges the engine local or hosted.

### Blueprints

Built 2026-11-26 on doc 4's "Blueprints". `src/shared/blueprints/` keeps three synced tables (`schema.ts`):
`blueprints` (a title, `applies_when`, a Markdown `body`, a `status` of `proposed`, `active` or `retired`, `made_by`
`user`, `engine` or `program` with the engine and model, the `sources` the run that wrote it had read, and the
conversation it was proposed in), `blueprint_changes` (a proposed new version with its reason, `waiting`, `accepted`
or `rejected`) and `blueprint_uses` (each run given it, kept apart so a use leaves no version in History).

A blueprint is an item as a conversation is (`records.ts`): `items` holds `blueprint:<id>` from the internal
`blueprint` collector (`codex.blueprints`, `collector.ts`, never listed under Plugins and without marks), kind
`blueprint`, its title, `applies_when` as the snippet, `codex://blueprint/<id>` as where it opens, its status when not
active, and in its detail the uses and, for one carrying sources, those sources. Its memberships say where it applies:
a context and those inside it, or, in Global, everywhere. `remove_item` refuses to take it out of its last context;
`place_blueprint` moves it, to Global for null, and a removed context deletes the
blueprints no other context holds. History keeps its row and memberships (`history.ts`), and the item calls answer
for it as kind `blueprint`.

Calls: `list_blueprints(context_id?, status?)` (all, Global's, which apply everywhere, for null, or those applying in a context:
its own, the contexts above it and the global ones), `get_blueprint`, `list_blueprint_proposals(conversation_id?)` (new
ones and changes, each with its whole text and a change with the blueprint as it reads), `add_blueprint`,
`change_blueprint`, `retire_blueprint`, `remove_blueprint`, `save_as_blueprint(conversation_id)` (a message in that
conversation asking the engine to propose one), and the page-only `restore_blueprint`, `place_blueprint`,
`accept_blueprint_proposals` and `reject_blueprint_proposals`. The user's `add_blueprint` and `change_blueprint` hold
at once and make a proposed blueprint active; from a token or MCP they only propose, made by a program. Accepting
puts the text in place and clears its `sources`, so it is the user's own; rejecting deletes a proposed blueprint
(History keeps it) or sets a change aside.

Engines are offered `list_blueprints`, `get_blueprint`, `propose_blueprint` and `propose_blueprint_change`; the core
set takes the last three. The proposing calls are in `proposing_calls`, so they run without approval and carry the
engine, model, sources read and conversation, as the graph's do. Both reads are screened (`privacy/results.ts`): a
blueprint or change carrying a source not marked for hosted engines is withheld from one, and an active blueprint
carries no source, so it is neither fenced nor tainting. Kept items are screened by `item_sources`, which gives a
blueprint's item its sources as well as its collector.

Recall (`recall.ts`), at the start of every run, by CODEX before the engine is called: the active blueprints applying
in the open context are matched against the user's message by words (two content words shared with the title and
"applies when", stop words left out and endings such as -ing taken off; one when the message or the description has
hardly any more) and, through `meaning_matches` in `search.ts`, by meaning (each blueprint's vectors in the index,
judged by `meaning_floor` against every document's score for the message), fused by reciprocal rank, at most three and
4,000 characters, the last cut short with a line naming `get_blueprint`. Their whole text goes after the instructions
under "Blueprints to follow", unfenced, asking the engine to follow the steps in order and to say which it follows;
the run keeps a notice per blueprint recalled and a use each. The index holds each blueprint as an item document of
its own (title, applies when, body, notes), held in its contexts or none, with its sources. The instructions also
ask the engine to offer to save or amend a blueprint when the user has just taught it rules or an order of steps.

The page (`src/web/blueprints/`): the **Blueprints** page (`#/blueprints`) with what waits, those that apply
everywhere and those in contexts, and **New blueprint**; a blueprint in the workspace (`#/blueprint/<id>`) with its
fields (the title, "applies when" and the body in X-Libs' `RichText`), Save (Save and make active for a proposed one),
where it applies, Retire or Bring back, Delete and History; and `BlueprintProposalCard`, the whole text of a new one or
a line diff (`diff.ts`) of a change, with Accept and Reject, shown on both pages and under its conversation in the
pane, whose ⋮ menu has **Save as blueprint**. A context's menu has **New blueprint…**, and its items list blueprints
with their own icon.

### Jobs and background runs

Built 2026-11-26 on doc 4's decision 8. `src/shared/jobs/` keeps two synced tables (`schema.ts`): `jobs` (a title, the
`instruction` each run sends, a `context_id` or none, a `schedule` as JSON, `{ kind: "every", every, unit }` or
`{ kind: "at", time, weekdays }`, `only_when_changed`, the limits `max_rounds`, `max_tokens` and `max_runs_per_day`,
`is_on`, `made_by` `user`, `engine` or `program`, and the conversation its runs are kept in), versioned in History, and
`job_runs` (when, the device by name, engine, model, rounds, tokens, what it applied and proposed in plain words, its
`outcome`, `running`, `done`, `error`, `limit` or `gave_way`, a note, the conversation and run, the context mark it saw
and when it was set aside, and, for a maintenance job's run, how many things it handled) and `background_devices`
(each desktop daemon or server that can run background work, by the id it made for itself, its name and kind, as it
last said when it started). Two tables are this device's alone, never synced: `job_device` (this device's own id) and
`job_checks` (when a job was last found unchanged here). The settings are synced and among `user_only_settings`:
`background.enabled` (the assistant's jobs, off), `background.daily_runs` (24) and `background.daily_tokens` (200,000),
`background.paused` (off), `background.device` (the device that runs background work), `background.tick_minutes` (30)
and `background.hosted` (off).

**One device does the work** (built 2026-11-27). `register_device` (`records.ts`), called by `keep_maintaining` as the
server or the daemon starts, records the device and, when `background.device` is empty, names it, so the first desktop
app or server to start is the one; another starting later leaves the choice alone. `runs_here` compares the setting
with this device's own id; only that device runs the assistant's jobs, the maintenance jobs that write synced data, and
the background refresh (`keep_refreshing` in `src/server/refreshing.ts`), and none of them while `background.paused`
is on. The user changes it with the page-only `set_background_device(device_id)`.

Calls: `list_jobs(context_id?)`, `get_job` (with its runs), `list_job_runs`, `get_background_state` (the switches, caps,
today's use and whether a job runs), `add_job(fields)`, `change_job(id, fields)`, `remove_job`, `dismiss_job_runs(ids)`,
and the page-only `set_job_on`, `run_job_now` and `set_background_device`. `list_job_runs(null)` leaves the maintenance
jobs' runs out, and `counted_today` counts them only against their own budgets. A job a program adds through a token or
MCP starts off. Engines are offered `list_jobs` (CODEX's own words, not fenced), `add_job`, `change_job` and
`remove_job`, changes at `proposal` until the user sets another level; their summaries say the job in plain words
(`describe_schedule`). A change the engine applies itself runs as the `engine` caller (`caller.ts`), which `add_job`
records as its maker.

The runner (`runner.ts`), started by the server and the daemon with `keep_running_jobs` (a check every 30 seconds, the
clock passed in), does nothing unless the assistant's jobs are on, background work is not paused and this device runs it. A check takes the first job that
is on and due (`schedule.ts`: "every" counts from its last run or check, "at" takes the latest slot at or before now
on a chosen weekday; either way due once however much was missed), within its runs a day and the global caps
(`counted_today`, every device's runs since local midnight, a run that gave way not counting), while no live reply is
written (`has_live_runs`). A job that runs only on change hashes its context, the contexts inside it and what they hold,
its own conversation left out (`context_mark`); the same mark as its last run or check is noted in `job_checks` and
makes no engine call. A run makes or finds the job's conversation, named after it in its context, and calls `start_run`
with the instruction as the message, presence `background` and its limits: rounds go to the engine as
`request.limits.max_rounds`, which the direct loop honours, and the run stops itself past them or once its tokens reach
the job's limit (lowered to what today's token cap leaves), ending with a plain note. One job runs at a time; Run now
answers why not when it cannot. A live run, or the user writing in the job's conversation, makes a background run give
way (`give_way`): it stops, is recorded as `gave_way` and runs again at its next check. The run's end (`on_end` in
`RunOptions`) records what it applied (calls applied at the background level, with their undo summary) and proposed.
The daemon is told whether a window is in front (`set_window_in_front`, from the main process on focus and blur) and,
when a finished run proposed something, failed or stopped at a limit while none is, shows a notification keyed
`inbox` linking `codex://inbox`, unless the device's `notify_inbox` is off (`notify_missing` likewise for missing items),
both in Settings → This device → Notifications.

The page: the **Jobs** page (`#/jobs`, `#/jobs/<id>` for one job's runs) with each job's schedule, next turn, latest
run and device, an on switch, Run now, Change, History and Remove; a context's jobs under its notes; the job dialog
(`JobDialog.tsx`); and Settings → Assistant → The assistant's jobs (`BackgroundSettings.tsx`).

### Self-maintenance

Built 2026-11-27 on doc 4's step 7. `src/shared/maintenance/` keeps CODEX's own upkeep as eight built-in jobs
(`model.ts`), which the user can turn on or off and budget but not remove, apart from the jobs the assistant makes:

| Job | Where | What it does |
| --- | --- | --- |
| `index` Refresh the index | every device | `sync_documents` with at most `items_per_run` items' text read from their apps (`get_item_texts` for an app read through the item calls); its check, `count_out_of_step`, compares the store's documents with the index without asking any app. |
| `embed` Embed documents | every device | `embed_pending` with at most `items_per_run` pieces; its check counts pieces without a vector from the embedder in use, those it may not be sent left out. |
| `rules` Links from rules | chosen device | `run_rules` for the documents waiting in the index's `changed` table under `rules`. |
| `similarity` Similar items | chosen device | `propose_similar` for the items waiting under `similarity`. |
| `tidy` Tidy the graph | chosen device | Ends (sets `valid_until`, never deletes) open links touching an item whose app no longer has it (`status` `missing`); proposes `same_as` between accepted entities of one kind sharing a name or other name (made by the rule `same_name`), never twice and never once rejected. No model call. |
| `suggest` Suggest links | chosen device | The only model job, off until turned on: for contexts holding items whose `context_mark` changed since it last ran on them (`maintenance_contexts`), longest waiting first, a background `start_run` shaped like Suggest links (its message, tools, instructions and closing note) in one conversation per context named "Suggest links (background)". |
| `research` Research interests | chosen device | Off until turned on, calling a model: for the accepted interest researched longest ago, an isolated background run (see Curiosity) in the conversation `research-<interest id>`, within its model calls and tokens a day and `web_requests_per_run`. |
| `digest` Daily digest | chosen device | Once a day, plain lines (`digest_lines`) of what each job applied and proposed since the last digest, failures, budgets used up, and how much waits in the Inbox; kept as the run's `applied`, listed in the Inbox as kind `digest` until set aside. Nothing to say, no entry. |

The index and its vectors are never synced, so every device keeps its own: `index` and `embed` run on every device,
and the rest only on the chosen one. Runs are kept in `job_runs` under `maintenance:<key>` with `items` (let go after
30 days); what each device found when it last looked is the synced `maintenance_checks` (per job and device: when, the
day, how many looks found nothing that day, the last reason and what part of the budget is used up). The setting
`maintenance.jobs` holds each job's `on` and budget where the user changed them, read through `job_on` and `budget_of`
(a value outside `budget_bounds` falls back to the default). Calls: `list_maintenance_jobs` and the page-only
`set_maintenance_job(key, { on?, budget? })`.

**The loop** (`loop.ts`). `keep_maintaining(host)` registers the device and looks each minute whether
`background.tick_minutes` have passed; a tick (`tick()`) does nothing while paused, and otherwise takes each job in
order that is on and this device's, waiting first while a reply the user waits for is written (`has_live_runs`) and
giving up at a pause. `run_maintenance_job` checks the budget (runs a day, and for `suggest` model calls, counted as
rounds, and tokens a day; on this device for `index` and `embed`, on every device together for the rest), then the
job's cheap check, which makes no model call and asks no app; nothing to do, a reason such as no embedder, or a used-up
budget is only noted in `maintenance_checks`, with no run. A job with work runs with a signal that aborts at
`seconds_per_run`, when background work is paused (looked at every two seconds) and when the loop stops; it is kept as
`done`, `error` (listed in the Inbox, opening Settings) or `gave_way`, with what it applied and proposed. A run that
used the day's budget notes that at once, for Settings and the digest.

**The action policy holds** (`jobs.ts`). The rules' links and the ending of links a rule or similarity made are CODEX's
own derived data, made and ended as the rules always did. Ending a link the user, a program or an engine made is
`close_graph_link`, a call with a level under the action policy though never offered to an engine (`maintenance_api`
in `policy/policy.ts`, listed in Settings → Action policy after the engine's calls): at `background` it is applied and
listed in the run; at `restricted` it is left and the run says so; otherwise it is proposed, once (a waiting or rejected
proposal for that link stops another), in the conversation "Background maintenance" (`maintenance`, in Global,
marked as a background job's so it is never the pane's default), where approving or rejecting it is recorded.
Similarity, `same_as` and Suggest links make proposals by nature. No job changes another app; Suggest links runs at
presence `background` under the same screen and taint rules as any run.

**Hosted engines.** `background_engine` lets Suggest links run only when the engine in use is local (the hosting test
of "Engines", a Tailscale address counting as hosted), unless `background.hosted` is on; otherwise the job is skipped
with the reason shown in Settings. When it runs on a hosted engine the source and tool marks and the hosted log apply
as in any run.

**Settings** (`src/web/jobs/BackgroundSettings.tsx`): Settings → Assistant → Background work (the pause, the device,
how often to look, and the hosted switch), Maintenance (each job's row with its state, where it runs and what it last
did or why it last did nothing; its dialog holds the switch, each part of its budget with today's use, the last run
and the last skip) and The assistant's jobs (their switch and caps).

### The Inbox

`src/shared/inbox/` reads, and keeps nothing: `list_inbox()` gives every waiting proposal of the policy (with its
evidence and conversation), every proposed graph link and entity, every proposed blueprint and blueprint change, and
every proposed interest (kind `interest`, carrying the interest), every job run that ended in an error or at a limit
and was not set aside, and each daily digest not set aside, newest first, each with plain words, who made it, the
conversation and job it came from and the route that opens it; `get_inbox_count()` counts them. The **Inbox** page
(`src/web/inbox/`) decides in place through the features' own page-only calls (`resolve_proposal`,
`accept_graph_proposals`, `reject_graph_proposals`, `accept_blueprint_proposals`, `reject_blueprint_proposals`,
`set_interest_state`) and `dismiss_job_runs`, and ticked entries together after a confirmation. An interest has no tick
box and is never decided with others: its **Accept…** opens the interests' own dialog (`open_topic_dialog`), showing the
exact topic as an editable field, and calls `accept_interest` from there; **Drop** sets it dropped. A mood never makes
an entry (a test holds it). The sidebar's Inbox entry carries the count in its
label, and the tray an Inbox row and tooltip with it.

### Mood

`src/shared/mood/` keeps one record in the synced setting `mood.current`: `{ mood, strength, reason, set_at, by,
conversation_id, run_id, sources }`, the mood one of neutral, happy, celebrating, sad, curious and concerned, `by` the
engine, a date or an event. Only CODEX's code writes it (`mood.ts`); `mood.enabled`, `mood.tone`, `mood.dates` and
`mood.current` are all in `user_only_settings`, so no token or MCP client writes them and only the user's devices sync
them. `record_in_force` fades the stored record to half each `half_life_minutes` (60) and sets it beside today's date
mood (`date_mood`: a listed month and day gives celebrating, or sad for a `remember` date, at 0.9 all day), the stronger
winning, neutral under 0.25; `get_mood` gives that as `MoodState`, neutral while the mood is off. `list_mood_dates` reads
the dates and the page-only `set_mood_dates` checks and replaces them.

Three things set it. `engine_tools` offers every run but one with a narrower `only` the tool `set_mood(mood, reason)`
(and in the core set), handled in the run itself rather than as a store call, so no program can call it: it writes an
`engine` record at strength 1 with the conversation, run and the sources read so far, and the call is kept with the
reply as `ran`, with no level, proposal or undo. When a reply ends, `settle_reply_mood` gives a mood it set the sources
the whole reply read, and ends a sad or celebrating mood an earlier reply in that conversation set. `note_event_mood`
writes a mild `event` record (0.4) only when the mood in force is no stronger: the maintenance loop calls it when a run
fails (concerned) and when Links from rules, Similar items, Tidy the graph or Suggest links applied or proposed
something (curious), and the jobs' runner when a job's run ends in an error (concerned).

`mood_part` adds to a run's instructions, while the mood is on, two lines of rules (a mood is a display, never a feeling
claimed; it never changes a fact or an assessment, never flatters, never asks for attention, never blames the user, and
is never a reason given to do something), and, while `mood.tone` is on and the mood is not neutral, "Your mood right now
is X; let it colour your tone only. Why:" and the reason, fenced when it carries sources. Its sources join the
instructions' sources, so they taint the run and reach the hosted log like any other; a hosted engine a source may not
reach is told neither the mood nor why, and the log counts it withheld. The identity lines always say that agreeing with
the user is not a mood. Nothing in `src/shared/mood/` imports the policy, the jobs, the Inbox, runs or a notifier (a test
holds its imports to a list), the tool list and `decide()` are tested unchanged under every mood, and the Mood section
under Settings → Assistant (`src/web/mood/MoodSettings.tsx`) has the two switches, the mood now and the dates.

### Curiosity

`src/shared/interests/` keeps the assistant's interests in the synced table `interests` (`topic`, `reason`, `state`
proposed, accepted, paused or dropped, `made_by`, engine and model, `conversation_id`, the `sources` its proposing run
had read, the `context_id` of its findings and `researched_at`). `propose_interest(topic, reason)` is one of
`proposing_calls`, offered to engines (and in the core set) and to programs, and only ever proposes; a topic already
listed, a dropped one included, is not proposed again. `list_interests` is offered too, screened by each interest's
sources (`screen_interests`). The page-only calls are `add_interest` (the user's own, accepted as typed),
`accept_interest(id, topic)` (with the topic as the user read and edited it), `set_interest_state` (paused, dropped or
proposed) and `set_max_interests`; the cap (`interests.max_accepted`, 5) and the findings' root context
(`interests.context`) are `user_only_settings`.

A finding is an item of CODEX's own, collector `codex.findings`, kind `finding`, answered for by the internal
`findings_plugin` from its own row, refused by `add_item`: its title, its text as the snippet, its first address as the
uri, and in `detail` the interest, topic, addresses, date, run and `sources` holding the Web plugin's source
(`finding_source`). `item_sources` gives a finding that source as well as its own, so the context listing in the
instructions, the tool results, search documents and graph nodes fence it as the web's text and keep it from a hosted
engine while Web is unmarked. `save_finding` puts it in the interest's context inside "The assistant's interests", each
made when first needed (`findings_context`).

The `research` maintenance job (`maintenance/research.ts`) checks for an accepted interest, the Web plugin's
`web__web_search` turned on (offered only with a search endpoint), and `background_engine` (a hosted engine also needs
Web marked for hosted engines). Its run is `start_run` with `isolated: true`: the instructions are only
`research_instructions` (how to work, the topic, and the titles of its earlier findings, fenced) plus the plugin tools'
line, the conversation sent is only the research message, and there is no identity, date, context, blueprint recall or
mood; `tools` is `research_tools` (`web__web_search`, `web__web_fetch`) and `own_tools` the run's own `save_finding`,
handled in `engine_tools` and kept with the reply like `set_mood`; `max_plugin_calls` is the budget's
`web_requests_per_run`; and `reads_nothing_private` keeps the run's outside-sending tools from being refused for what
it read, since it holds nothing private. The web's text taints the run as usual, but it has no change to make, so
nothing becomes a proposal. `save_finding` keeps at most three findings a run and proposes at most one `next_topic` as
an interest, made by the engine with the web as its source. The run's `applied` lines name each finding, so the digest
lists them, and the maintenance loop's `note_finding_mood` leaves the mood mildly curious. The identity lines tell the
engine when to propose an interest and to mention a finding only when it bears on what the user asks.

A proposed interest is listed in the Inbox too (see "The Inbox"). Settings → Assistant → Interests
(`src/web/interests/InterestSettings.tsx`) lists each interest with its state, who
made it, why and its findings, with Accept… (a dialog showing the exact topic as an editable field and what it is sent
to), Pause and Drop, then Add an interest… and Most accepted at once.

### Still to come

The rest of doc 4's step 10: a measured comparison on a real model (the owner's local model with the X-Fitness,
X-Budget and X-Media-Tracker servers), previewing a feed's items without following it, and SmartHarness's native
delegation.

The eval of doc 4's step 9: recorded assistant jobs replayed against SmartHarness with a hosted engine as the
baseline. Nothing records jobs yet.
