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
gives the messages, the proposals and the run still going, so a page opened mid-reply catches up.

The instructions (`instructions.ts`) say who the engine is, today's date and the open context: its name, its place in
the tree, its notes, the contexts inside it and its items, whose titles, snippets and notes go inside an
`<untrusted-data>` fence (`src/shared/engines/untrusted.ts`, which also blanks sentences that give orders).

### Tools and the action policy

The tools are the contexts feature's calls (contexts, items, collectors and feeds), built from their api specs, less
export, import and the card layout calls (`src/shared/policy/policy.ts`). A read runs at once; what it gives back is
fenced unless it is only the user's own words (`list_contexts`, `list_collectors`), and a fenced result marks the run
as having read outside content. Every call that changes something has a level in the synced `action_policy` setting,
`proposal` until the user sets another:

| Level | In a conversation |
| --- | --- |
| `restricted` | refused; the engine is told it is not permitted |
| `proposal` | kept in `proposals` with a plain-words summary, for the user to approve or reject; the engine is told it waits |
| `auto` | run, recorded on the call as made by the engine at auto |
| `background` | as auto; the only level a background job with nobody present may act on (no such jobs exist yet) |

Once a run has read outside content, every change it asks for becomes a proposal whatever its level. Approving
(`resolve_proposal`) runs the call through the store as the page would, so History records it, and adds an event to the
conversation saying the user approved it and what came back; rejecting adds one saying so. The engine reads those
events at the start of the user's next message. The policy's own calls and the conversations' are never offered.

### Still to come

The window's right pane with the mascot (the next step), the Inbox and background queue, the knowledge graph, jobs and
blueprints, in doc 4's order.
