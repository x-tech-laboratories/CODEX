# CODEX

<a href="https://liberapay.com/BeatLink/donate"><img alt="Donate using Liberapay" src="https://liberapay.com/assets/widgets/donate.svg"></a> <a href="https://ko-fi.com/I4V52ANK6N"><img alt="Support me on Ko-fi" src="https://ko-fi.com/img/githubbutton_sm.svg"></a>

A personal knowledge base on its way to being a personal assistant as well. Today CODEX keeps contexts: a context is a
project or an area of your life, such as a kitchen renovation or this year's taxes, and it gathers the tasks, notes,
files, emails and links that belong to it, from the apps that keep them. CODEX never keeps the items themselves: each
is a pointer with what was last seen of it, and it opens in its own app.

**The assistant is coming back.** CODEX was an assistant on [SmartHarness](https://github.com/x-tech-laboratories/SmartHarness)
until version 0.2.1; from 0.3.0 it is built on the code of X-Context, a separate application whose code became CODEX's
skeleton on 2026-11-26 and whose repository no longer exists. The conversation pane, its
engines and the action policy are back; the Inbox, background queue and knowledge view return one by one, as
[docs/4-merge-with-x-context.md](docs/4-merge-with-x-context.md) sets out. Until then the rest of the old assistant's
code sits in [`legacy/`](legacy/README.md), where nothing builds or tests it.

- **Contexts** nest, so Home holds Kitchen and Garden. Each has notes in Markdown and its items grouped by kind, each
  with a note on why it is there and the other contexts that hold it too; a task shows an empty circle while open and a
  ticked one once done. **Move to…** and **Also add to…** on any
  item's menu move it to another context or put it in more; the conversations with the assistant are items too.
- **Collectors** are plugins that bring items from other apps. Each searches its app, or takes items typed in by hand,
  or is sent items from elsewhere, and says what became of them: a refresh keeps new titles and states, and marks
  missing an item its app no longer has.
- **Cards:** a context's items show as a list grouped by kind, as a **Graph** (see below), or switched to **Cards**, as cards in a grid you drag
  by their handle and resize from their corner (or move with the arrow keys, and resize with Shift and the arrows).
  **Grouped** puts a card per kind instead, such as one holding every task and one every link, each listing its items.
  Where each card sits is kept with the context, for each view, and syncs, but leaves no version in History.
- **The first page** searches everything kept, and shows each context with what is inside it.

## Search

The search on the first page, and the assistant's `search_index` tool, look through a search index CODEX keeps beside
its data: every item in a context with your notes on it and, where its app can give it cheaply, its text (plain text
and Markdown files up to 256 KB, an X-Tasks task's notes, a Trilium text or code note), every context's name and notes,
and the conversations. It finds by words at once. To find by meaning too, run an embedding model, such as Ollama's
(`ollama pull nomic-embed-text`), and under **Settings → Index** pick **OpenAI-compatible embeddings** as the
embedder; its row holds the endpoint (`http://localhost:11434/v1` unless changed), the model, its dimensions (768 for
nomic-embed-text), an optional query prefix and an optional API key command. Some models, such as Qwen3-Embedding,
want an instruction before a search but not before what is searched; give it as the **Query prefix**, writing `\n`
for a new line (`Instruct: Given a search query, retrieve relevant notes and tasks\nQuery: `). Changing it embeds
nothing again. Embedding runs in the background and waits while the assistant writes a reply. A hosted embedder is
never sent text from a source not marked **May be sent to a hosted engine**. Settings → Index shows the last error
until a later attempt gets past it, and a change to the embedder's settings is tried at once.

A document counts as found by meaning only when it stands out from how near everything else is to the same search,
since every model rates unrelated text somewhat near and each on its own scale: a search whose best match does not
stand clearly above the rest finds nothing by meaning, and words alone answer it. Items, contexts and entities rank
ahead of messages that score about the same; the first page gathers a conversation's matching messages under the
conversation, and the assistant's own search never finds the conversation it is answering in.

The index is a file of its own (`codex-index.db` in the desktop app's profile, `<database>-index.db` beside the
server's), never synced and never in backups. It is safe to delete, and **Rebuild** builds it again from nothing.

## The knowledge graph

CODEX keeps a graph of what it holds: contexts, items (conversations among them) and entities, the people,
organisations, topics and places found in them, joined by typed links (mentions, about, related to, part of, depends
on, or same as for two entities that are one). Each link says who made it, where it came from, and when it was true; a
link that stops being true is closed rather than deleted.

- **Without a model:** an item whose text holds another kept item's address, or a `codex://` or other app's link to
  something CODEX holds, is linked to it, and an X-Tasks subtask to its parent task. These links are made as the index
  reads what changed, and accepted at once.
- **By meaning:** with an embedder set up, items very close in meaning are proposed as related, a few per item.
- **By the assistant:** **Suggest links** on a context starts a conversation asking the assistant to read its items
  and propose entities and links, each with where it found it.
- **Yours to decide:** a proposal waits until you accept or reject it, only from CODEX's own page; a rejection is
  remembered, so the same link is never proposed again. Two entities found to be one are joined, never merged, and
  the join can be undone.
- **By other programs:** a link or entity added through a token or MCP is proposed, made by a program, and waits for
  you like the assistant's; what you add at CODEX's own page is yours and accepted at once.

**Seeing it:** **Graph** beside List, Cards and Grouped on a context's page draws the context, what it holds, their
entities and links, with proposed links dashed; **Show everything** widens it to the whole graph, which the **Graph**
page in the sidebar also draws, with a box to find a node by name. Choosing a node shows what it is and its links
beside the drawing: open it, link it to another node found by search, close or remove a link, accept or reject a
proposal, or rename, remove or join an entity (and undo a join). **Proposed links** under the drawing lists what waits,
with where each came from, to accept or reject one by one or a ticked selection at once. Every node and link is also
in a list under the drawing, worked by keyboard. An item's row shows how many links it has; the count opens the graph
on it.

An excerpt of where a proposal came from is kept only when its source is marked **May be sent to a hosted engine**;
otherwise the proposal names the item without quoting it.

## The assistant

The **Assistant** pane on the right, opened and closed from the robot button in the top bar, holds conversations with
CODEX about the context that is open. A context can hold as many conversations as you start: each is an item of the
context, listed with its tasks and notes in every view, with its title (its first message until you rename it), its
latest exchange and when it was last used, and like any item it takes a note, moves to another context and can sit in
several. The pane shows the context's most recently used conversation; the title under the face opens a list of the
others, showing which have a reply being written, and **+** starts a new one. A reply keeps being written while you look
at another. Its ⋮ menu renames, moves, adds to more contexts, copies the conversation's `codex://conversation/<id>`
link, or deletes it. With no context open, the pane holds the conversations that are in no context. Taking a
conversation out of the last context holding it deletes it, after asking; deleting a context deletes the conversations
no other context holds.

Its face sleeps until an engine is set up, thinks while it writes, and smiles or frowns for a moment when a reply ends.
Enter sends, Shift+Enter starts a new line, and **Stop** ends a reply early. Each tool call it made shows where in the reply it
was made, and folds open to show its arguments and what came back. Wide tables and code in a reply scroll sideways on
their own. While a reasoning model thinks, a folded **Thinking…** row opens to show its thinking
as it streams; the answer replaces it, and the thinking is never kept. When a reply fails, the pane says what happened
and what to do in plain words, with the raw message folded under **Details**.

**Setting up an engine,** under **Settings → Assistant → Engine**: pick the engine under **Answering**, then open its row
and fill in its settings.

| Engine | Settings |
| ------ | -------- |
| Anthropic | the model (`claude-opus-5-5` unless changed), the context size, the tools offered, and an API key command |
| OpenAI-compatible | the endpoint, ending in `/v1` (empty for OpenAI's own), the model's name there, the context size, the tools offered, and an API key command |

Embedders, which give the search index its sense of meaning, are plugins too; see [Search](#search).

The **API key command** is a program whose first line of output is the key, such as `pass show anthropic/api-key`. It
runs each time the engine answers, where CODEX's data is (the desktop app's daemon, or the server), and the key is kept
nowhere: not in the database, a log or what the page reads. On a NixOS server the service has no home folder and a
bare `PATH`, so give the command by its full path.

**A local model** needs no key: run an OpenAI-compatible server such as Ollama (`ollama serve`, then
`ollama pull qwen3`) or llama.cpp's `llama-server -m model.gguf --port 8080 --jinja`, choose **OpenAI-compatible**, and
give its endpoint (`http://localhost:11434/v1` for Ollama, `http://localhost:8080/v1` for llama-server), the model's
name and its context size. The model has to support tool calls to read or change your contexts.

**Running a small local model.** Give the engine the context size the server really has (llama-server's `-c`, Ollama's
`num_ctx`); CODEX fits every request into it. It counts its instructions, the tools as sent and a reply, estimates
tokens cautiously at first and more closely once the server has reported what a request cost, and when the
conversation is too long it leaves out the oldest messages, then shortens the middle of your newest one for that
request alone, saying so in the pane. Below 16,384 tokens of context it offers the model a core set of sixteen tools
(the reads, the most-used changes and the proposing calls, briefly described) instead of all of them, which keeps the prompt to about a
quarter; **Tools offered** in the engine's settings chooses **Automatic**, **Core set** or **All tools**. Expect a
4B model on a CPU at 8,192 tokens to spend a minute or more reading the prompt before its first word, longer on a
cold start, and a reasoning model to think for a while first, which the pane shows as it goes. If the context is too
small for the instructions, the tools and a reply, nothing is sent and the pane says to raise the context size or
start a new conversation.

**What it can do:** read and change contexts and their items, search the collectors and follow feeds, through the same
calls the API and MCP serve; never your settings, plugins, accounts, sync, backups or History. Each kind of change has
a level under **Settings → Assistant → Action policy**: **Never**, **Ask me first** (the default for every change),
**Allowed while I'm in the conversation**, or **Allowed, even in the background** (for its jobs, below). A change that has to ask shows as a card in the conversation with **Approve** and **Reject**, and under
**Why, and from what** the message that asked for it and what the assistant read first, quoting another app's text only
when that app is marked **May be sent to a hosted engine**. Every change it made, by your approval or on its own, has
**Undo** on its row in the conversation for as long as nothing has changed those contexts since; the undo goes through
History and is noted in the conversation, and only you can do it, from CODEX's own page. A change History keeps nothing
of, such as a refresh, says on its row that it cannot be undone. Once a reply
has read text that came from another app, such as an item's title or a search, every change it asks for waits for you,
whatever its level, since that text could carry someone else's instructions.

**Blueprints** are the workflows you teach it. When you work through a task together, such as sorting mail, and give
it rules and an order of steps, ask it to save them (or pick **Save as blueprint** from the pane's ⋮ menu): it proposes
a blueprint, a title, a sentence saying when it applies, and the rules and steps in Markdown. A proposed blueprint, or
a proposed change to one, shows as a card in its conversation and on the **Blueprints** page with its whole text, or,
for a change, what it adds and takes away, and does nothing until you **Accept** it; only you can, from CODEX's own
page. Each time you send a message, CODEX itself matches it against the active blueprints that apply where you are
(the open context, the contexts above it, and those that apply everywhere): by its words, and by meaning too once an
embedder is set up, picking only those that stand out, at most three and about 4,000 characters. The ones that match
are put in the assistant's instructions with a note above the reply saying which were recalled, and the assistant is
asked to say which it follows. A blueprint is an item: it lists in its context with its own icon, moves like any other
item, opens in the workspace at `codex://blueprint/<id>`, where you edit its title, "applies when" and steps, choose
where it applies, retire it so it is no longer recalled, or delete it; History keeps each version. Those that apply
everywhere are on the **Blueprints** page in the sidebar, and **New blueprint…** in a context's menu writes one there.
What you write or edit yourself is active at once; one added through a token or MCP is only proposed. A proposed
blueprint written after reading another app's text carries that app as its source, so a hosted engine is not shown it
until you accept it, after which it is your own.

**Jobs** are the assistant's own recurring work (your own recurring tasks belong in X-Tasks): a title, what it does,
written as you would ask it, the context it works in, when it runs (every so many minutes, hours or days, or at a time
on chosen weekdays), whether it runs only when something in its context changed since its last run, and its limits:
the most rounds and tokens one run may use and the most runs a day. Make them on the **Jobs** page or from a context's
⋮ menu, or ask the assistant in a conversation: adding, changing and removing a job are changes under the action
policy like any other, so by default its request is a card you approve. Each run is an ordinary reply in a
conversation of the job's own, named after it in its context, with nobody present: only changes set to **Allowed, even
in the background** are made, everything else waits for you as a proposal, and text from other apps makes every change
wait as in a conversation. A run that reaches its round or token limit stops with a note saying so. The Jobs page shows
each job's schedule, next turn, latest run and the device that ran it, with **Run now**, an on switch and its runs.

Nothing runs until you turn on **Background work** under **Settings → Assistant → Background work**, which also holds
the caps on runs and tokens a day for every job together, with today's use. Since your data syncs to several devices
and a server, only the one where you turn on **This device runs background work** (on the server's page, **The server
runs background work**) runs jobs. A job never runs twice at once and runs once however many turns it missed; a
conversation you are in always goes first, and a job's run that is writing stops to make way and runs again at its
next turn; a job set to run only on change makes no call to the engine while nothing changed.

**The Inbox** in the sidebar, with its count, lists everything that waits for you, newest first: changes proposed in
conversations and jobs, with why and from what; proposed links and entities; proposed blueprints and changes to them;
and job runs that failed or stopped at a limit. Each opens its conversation or page, and each can be approved or
accepted, rejected, or for a run set aside, in place; tick several to decide them at once after a confirmation. On the
desktop the tray shows the count too, and while the window is not in front a notification says when a job left
something waiting (**Settings → This device → Notifications**).

**Privacy and trust by source:** each collector's row under **Settings → Plugins**, and each app's row under **Apps**,
has two switches, both off at first.
**May be sent to a hosted engine** lets its items, titles included, reach an engine a company runs, such as Anthropic, or
an OpenAI-compatible endpoint that is not on this computer or a private network; without it such an engine is told
only how many items were left out, so it can say so. A local engine sees everything. **Trusted content** says the app
holds only your own words, so reading its items no longer makes changes wait for you; context names and notes you write
in CODEX never do. **Settings → Assistant → Sent to hosted engines** lists every reply a hosted engine wrote, with how
many items of each source it was sent, for 90 days unless changed. An earlier answer, an approved or rejected change, or
a message found by search that drew on a source not marked for hosted engines is withheld from one the same way;
answers kept before 2026-11-26 recorded no sources and are withheld from hosted engines. An earlier answer that drew
on a source not marked **Trusted content** makes the changes of every later reply in its conversation wait for you, as
reading that source again would. Your conversations' titles are your own words, and a reply is never shown another
conversation's latest exchange.

The assistant's settings, the marks, the engine and embedder in use, every plugin's settings and the apps read through
the item calls can be changed only on CODEX's own page; a token or an MCP client can read them, with keys hidden, but not change them.

## Collectors

| Collector | Brings | Set up under Settings → Plugins |
| --------- | ------ | ------------------------------- |
| Files     | files and folders found by name, as `file://` links | the folders searched, one per line, and how deep |
| X-Tasks   | tasks, with whether each is done, as `x-tasks://task/<id>` links | the X-Tasks server's address and a read-only token from its account page |
| Trilium   | notes through Trilium's ETAPI, linked into its page | the Trilium server's address and an ETAPI token |
| Firefox bookmarks | bookmarks found by title or address, and each bookmark folder to follow | the Firefox profile folder, or nothing for Firefox's default profile |
| Web links | web pages typed in by address and title | nothing |
| Email     | emails sent from Thunderbird with the add-on below, as `mid:` links keyed by their Message-ID | nothing here; the add-on has its own options |
| Apps answering the item calls | the items of any app that answers the X-Tech item calls, such as another X-app, opening by the app's own links | each app under **Apps**: a name, its address and a read-only token |

Files reads the disk of the machine its server or daemon runs on, so on a server it finds the server's files. Firefox
bookmarks runs in the desktop app alone: it reads a copy of the profile's `places.sqlite`, since Firefox keeps the file
locked, and what it brings syncs to the server and other devices like anything else.

**Apps answering the item calls.** Every X-app answers the same four read-only calls about its items
(`list_item_kinds`, `search_items`, `get_items`, `list_item_changes`), so any of them, and any other app that answers
them, becomes a source with no plugin of its own: under **Settings → Plugins**, **Add an app…** takes a name, the app's
address (such as `https://tasks.example.org`) and a read-only token made on that app's account page, and saves it only
once the app answers. Each app is then a collector of its own, named as you named it, with the kinds the app gave,
its own row to change its address or token, see whether it answers now, or remove it, and its own **May be sent to a
hosted engine** and **Trusted content** switches. CODEX only ever reads it, calling those four calls and nothing else:
it searches with `search_items`, and a refresh asks `list_item_changes` for what changed since the last refresh, so
only changed items are read again; an item the app deleted is marked missing. The token is kept like a plugin's key:
never shown to the page, the API, MCP or a settings export, and never in a message. The index gets each item's snippet,
as the item calls give nothing more. Removing an app leaves the items it brought in their contexts as last seen.

**X-Tasks, both ways.** X-Tasks answers the item calls too, so it can be read either way. The **X-Tasks** collector
above knows X-Tasks: it offers tags and tasks with subtasks to follow, gives the graph a subtask's parent, and indexes a
task's whole notes. Use it for X-Tasks. Use **Add an app…** for any X-app with no collector of its own; an X-Tasks
added that way searches and refreshes tasks, but follows nothing and indexes only the first 200 characters of the
notes. The two keep their items apart (`x-tasks:<id>` and `app.<name>:<id>`), so nothing moves from one to the other.

A collector of your own is a plugin in a subfolder of the plugins folder (`plugins_folder` in the server's config, or
`plugins/` in the desktop app's profile) whose `package.json` names its built server entry under
`"x-plugin": { "server": "dist/server.js" }`. It provides a `collector` as `src/shared/collectors/collector.ts` describes, an `engine` as
`src/shared/engines/engine.ts` does, or an `embedder` as `src/shared/embedders/embedder.ts` does.
Plugins run with the app's full rights and are not sandboxed, so install only plugins you trust.

## Following

A context can follow a group in another app, such as an X-Tasks tag (with the tags inside it) or an X-Tasks task with
its subtasks: **Follow…** on the context's page. What the group holds joins the context, and on every refresh new items
join and items that left the group leave. An item you added by hand, or gave a note, stays. **From another app…** on
the first page makes a context for each group you tick, already following it. Both list tags and tasks with subtasks on
tabs of their own, and what you tick stays ticked as you switch. The other apps know nothing of this; CODEX only reads
them.

Its **Filter groups** tab makes contexts from a whole X-Tasks filter group: the group becomes a context, with a context
inside it following each of its tags (a tag under another tag of the group is left to its parent's context). A tag
added to the group later shows on that context's page under **New in …**, to add as a context with one click or to
stop suggesting.

X-Tasks offers the tags given by hand (not those it gives by a rule) and the open tasks that have subtasks. Done tasks
leave a followed context unless **Include done tasks** is on in the X-Tasks plugin's settings.

## The Thunderbird add-on

`npm run build:thunderbird` builds the add-on into `out/thunderbird`. In Thunderbird 128 or later, open **Add-ons and
Themes → Debug Add-ons → Load Temporary Add-on** and pick `out/thunderbird/manifest.json`. In its options, give the
CODEX server's address and a token made on **Your account** with changes allowed; Thunderbird asks leave to reach
that server. Then **Add to context** on any email ticks the contexts it belongs in, with a note.

An email added this way opens through its `mid:` link, on a desktop where Thunderbird is set to open `mid:` links;
its Message-ID finds it wherever it was filed.

## Running it

```sh
nix-shell                 # Node 24 and an Electron that runs on NixOS
npm install
npm run hash-password -- admin password.hash  # an admin in password.hash, which the dev server reads
npm run seed              # sample contexts in dev-data/, and sample files for the Files collector
npm run dev:server        # the server on http://127.0.0.1:7770, with the data in dev-data/
npm run dev:web           # the page with live reload, reaching that server
npm run dev               # the desktop app, with its profile in dev-data/desktop
```

`npm run build` type-checks and builds the page into `out/web`; `npm start` serves it. `npm run build:desktop` builds
the desktop app into `out/`. `npm run icons` draws every icon from `resources/icon.svg`.

## Configuration

The server reads a JSON file named by `CODEX_CONFIG`; `config.example.json` is the complete default:

| Field            | Means                                                     |
| ---------------- | --------------------------------------------------------- |
| `database`       | the SQLite file, made if missing                          |
| `backups_folder` | where the server's backups are kept                       |
| `plugins_folder` | optional; each subfolder a plugin, such as a collector    |

The address and port come from `CODEX_HOST` and `CODEX_PORT` (or `--host` and `--port`), 127.0.0.1:7770 unless set.
The admins are read from the accounts file `CODEX_PASSWORD_HASH_FILE` names, one `name:hash` line each;
`npm run hash-password -- <name> <file>` adds one or changes their password.

## The desktop app in the background

The desktop app runs as two processes: a daemon that holds the data and does the work, and the window that shows it.
The daemon keeps `codex.db` in the app's profile folder and serves the window on `$XDG_RUNTIME_DIR/codex/daemon.sock`.
The window first opens over most of the screen and then keeps the size and place you leave it at.
Closing the window leaves sync, backups, refreshing, the assistant's jobs and the MCP server running. A tray icon opens
the Inbox, showing how many things wait there, lists the top-level contexts to open and brings the window back; **Quit completely** there or under **Settings → Desktop** stops the
daemon too. The daemon tells you with a desktop notification when a refresh finds items gone from their apps, and
when a job left something waiting in the Inbox while the window is not in front; each kind can be turned off under
**Settings → This device → Notifications**. The server sends no notifications yet. The app
opens `codex://context/<id>` links on that context, and `codex://conversation/<id>` links on a context holding the
conversation, with it in the pane.

## Signing in, sync, backups and history

These work as in every X-app. A browser signs in with a name and password; **Your account** changes the password, turns
on a second factor and makes tokens; an admin adds users on **Users**. The desktop app syncs with a server from
**Settings → This device → Sync**, and every copy backs itself up daily, keeping the last 14. The server's backups are
an admin's to manage, but restoring one, deleting one or changing the schedule is done only on the page, signed in
with a password: every token is refused them, an admin's and a device's included, and MCP offers no backup call, since
a restored backup could rewrite the settings only you may change. Listing backups and taking one stay open to an
admin's token. Every change to a
context, its name, notes and the items it holds, is kept under **History**, where any version can be restored and a
deleted context brought back with its links to what still exists; a refresh is left out, since it changes only what
the apps said.

## Coming from X-Context

X-Context was a separate application whose code became CODEX's skeleton on 2026-11-26; its repository no longer
exists. An X-Context database moves over through the JSON files of **Settings → Import and export**: export the contexts
in X-Context, then import that file in CODEX, which reads X-Context's exports as its own. Collector settings, such as
the X-Tasks address and token, are set again under **Settings → Plugins**, since the plugins now carry CODEX's ids.
The old CODEX's knowledge database is not carried over.

## Other programs: the API and MCP

Every call the page makes is open to other programs on the server, behind a token made on **Your account** and sent as
`Authorization: Bearer <token>`: `POST /api/call/<method>` with the arguments as a JSON list or by name as a JSON
object, `GET /api/openapi.json` describing every call, and `/api/mcp` serving each as an MCP tool:

```sh
claude mcp add --transport http codex https://<server>/api/mcp --header "Authorization: Bearer <token>"
```

The desktop app serves the same tools on its own data once **Settings → MCP server** is on, at
`http://127.0.0.1:3922/mcp`. `get_context` gives an AI client everything a context holds in one call. Plugin keys,
such as a Trilium token, are left out of what the API and MCP read.

**Items for other apps.** Like every X-app, CODEX answers the four read-only item calls of the Application Standard,
so another app or an assistant reads it with the same code it reads any X-app with, a read-only token being enough:
`list_item_kinds`, `search_items(query, limit)`, `get_items(ids)` and `list_item_changes(since, limit)`. CODEX's own
items are its contexts (name, notes as the snippet, `archived` as the status), its conversations (the title, the
contexts holding it and when it was last used, never a message) and the entities of its graph (name, kind and other
names, with `proposed`, `accepted` or `rejected` as the status). Ids carry their kind, such as `context:<id>`, and
links are `codex://context/<id>`, `codex://conversation/<id>` and `codex://entity/<id>`, which the desktop app opens
on the context, on the conversation in the pane, or on the Graph page at the entity. The tasks, notes and files a
context points to are not CODEX's items; their own apps answer for them.

## Not yet

- **More of the assistant:** self-maintenance, mood and curiosity, in the order
  [docs/4-merge-with-x-context.md](docs/4-merge-with-x-context.md) gives.
- **Notifications from the server** through X-Libs' channels; only the desktop app notifies so far.
- **Android.** Collectors need Node, so a phone app would show what is kept but search nothing; it waits for collectors
  that run on the server alone.
- **CSV export.** Contexts export and import as JSON only so far.
- **A Firefox add-on.** Bookmarks are read from the profile on the desktop; an add-on, like the Thunderbird one, would
  send the page open in Firefox to a context.

## NixOS

```nix
inputs.codex.url = "github:x-tech-laboratories/CODEX";

imports = [ codex.nixosModules.default ];
services.codex = {
  enable = true;
  passwordHashFile = "/etc/codex/password-hash";
};
```

`packages.default` is the server and `packages.desktop` the desktop app. The pre-merge assistant, with its `codex`
command line and `codex-daemon`, is CODEX 0.2.1.

## Layout

```
src/
  server/      Fastify app and main.ts, the calls it shares with the daemon, the Files collector and refreshing
  daemon/      the desktop app's daemon: its database, the page's calls, sync, backups, refreshing and MCP
  main/        Electron main process: the window, the tray icon and the login entry, passing calls to the daemon
  preload/     the desktop page's bridge
  web/         the React page: contexts/, assistant/, settings/, history/ and hosts/ for web and desktop
  shared/      the store every host runs: contexts/, collectors/, engines/, embedders/, conversations/, policy/, privacy/,
               search/, graph/, history/ and settings
thunderbird/   the Thunderbird add-on: its popup, options and manifest
scripts/       seed.ts for sample data, icons.ts for the icons
tests/         one *.test.ts per behaviour
legacy/        the pre-merge assistant, kept for porting and for a future mail application; not built or tested
docs/          the goal, the architecture, open questions, the roadmap and the merge plan
nix/           package.nix, desktop-package.nix, module.nix
```

## License

GPL-3.0-or-later.
