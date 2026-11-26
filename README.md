# CODEX

<a href="https://liberapay.com/BeatLink/donate"><img alt="Donate using Liberapay" src="https://liberapay.com/assets/widgets/donate.svg"></a> <a href="https://ko-fi.com/I4V52ANK6N"><img alt="Support me on Ko-fi" src="https://ko-fi.com/img/githubbutton_sm.svg"></a>

A personal knowledge base on its way to being a personal assistant as well. Today CODEX keeps contexts: a context is a
project or an area of your life, such as a kitchen renovation or this year's taxes, and it gathers the tasks, notes,
files, emails and links that belong to it, from the apps that keep them. CODEX never keeps the items themselves: each
is a pointer with what was last seen of it, and it opens in its own app.

**The assistant is coming back.** CODEX was an assistant on [SmartHarness](https://github.com/x-tech-laboratories/SmartHarness)
until version 0.2.1; from 0.3.0 it is built on the code of X-Context, which merged into it. The conversation pane, its
engines and the action policy are back; the Inbox, background queue and knowledge view return one by one, as
[docs/4-merge-with-x-context.md](docs/4-merge-with-x-context.md) sets out. Until then the rest of the old assistant's
code sits in [`legacy/`](legacy/README.md), where nothing builds or tests it.

- **Contexts** nest, so Home holds Kitchen and Garden. Each has notes in Markdown and its items grouped by kind, each
  with a note on why it is there and the other contexts that hold it too.
- **Collectors** are plugins that bring items from other apps. Each searches its app, or takes items typed in by hand,
  or is sent items from elsewhere, and says what became of them: a refresh keeps new titles and states, and marks
  missing an item its app no longer has.
- **Cards:** a context's items show as a list grouped by kind, or switched to **Cards**, as cards in a grid you drag
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
nomic-embed-text) and an optional API key command. Embedding runs in the background and waits while the assistant
writes a reply. A hosted embedder is never sent text from a source not marked **May be sent to a hosted engine**.

The index is a file of its own (`codex-index.db` in the desktop app's profile, `<database>-index.db` beside the
server's), never synced and never in backups. It is safe to delete, and **Rebuild** builds it again from nothing.

## The assistant

The **Assistant** pane on the right, opened and closed from the robot button in the top bar, holds a conversation with
CODEX about the context that is open, or a general one on the first page. Its face sleeps until an engine is set up,
thinks while it writes, and smiles or frowns for a moment when a reply ends. Enter sends, Shift+Enter starts a new
line, **Stop** ends a reply early, and the bin clears the conversation. Each tool call it made folds open to show its
arguments and what came back.

**Setting up an engine,** under **Settings → Assistant → Engine**: pick the engine under **Answering**, then open its row
and fill in its settings.

| Engine | Settings |
| ------ | -------- |
| Anthropic | the model (`claude-opus-5-5` unless changed), the context size, and an API key command |
| OpenAI-compatible | the endpoint, ending in `/v1` (empty for OpenAI's own), the model's name there, the context size, and an API key command |

Embedders, which give the search index its sense of meaning, are plugins too; see [Search](#search).

The **API key command** is a program whose first line of output is the key, such as `pass show anthropic/api-key`. It
runs each time the engine answers, where CODEX's data is (the desktop app's daemon, or the server), and the key is kept
nowhere: not in the database, a log or what the page reads. On a NixOS server the service has no home folder and a
bare `PATH`, so give the command by its full path.

**A local model** needs no key: run an OpenAI-compatible server such as Ollama (`ollama serve`, then
`ollama pull qwen3`) or llama.cpp's `llama-server -m model.gguf --port 8080 --jinja`, choose **OpenAI-compatible**, and
give its endpoint (`http://localhost:11434/v1` for Ollama, `http://localhost:8080/v1` for llama-server), the model's
name and its context size. The model has to support tool calls to read or change your contexts.

**What it can do:** read and change contexts and their items, search the collectors and follow feeds, through the same
calls the API and MCP serve; never your settings, plugins, accounts, sync, backups or History. Each kind of change has
a level under **Settings → Assistant → Action policy**: **Never**, **Ask me first** (the default for every change),
**Allowed while I'm in the conversation**, or **Allowed, even in the background** (for background jobs to come; none
exist yet). A change that has to ask shows as a card in the conversation with **Approve** and **Reject**. Once a reply
has read text that came from another app, such as an item's title or a search, every change it asks for waits for you,
whatever its level, since that text could carry someone else's instructions.

**Privacy and trust by source:** each collector's row under **Settings → Plugins** has two switches, both off at first.
**May be sent to a hosted engine** lets its items, titles included, reach an engine a company runs, such as Anthropic, or
an OpenAI-compatible endpoint that is not on this computer or a private network; without it such an engine is told
only how many items were left out, so it can say so. A local engine sees everything. **Trusted content** says the app
holds only your own words, so reading its items no longer makes changes wait for you; context names and notes you write
in CODEX never do. **Settings → Assistant → Sent to hosted engines** lists every reply a hosted engine wrote, with how
many items of each source it was sent, for 90 days unless changed. An earlier answer, an approved or rejected change, or
a message found by search that drew on a source not marked for hosted engines is withheld from one the same way;
answers kept before 2026-11-26 recorded no sources and are withheld from hosted engines.

The assistant's settings, the marks, the engine and embedder in use and every plugin's settings can be changed only on
CODEX's own page; a token or an MCP client can read them, with keys hidden, but not change them.

## Collectors

| Collector | Brings | Set up under Settings → Plugins |
| --------- | ------ | ------------------------------- |
| Files     | files and folders found by name, as `file://` links | the folders searched, one per line, and how deep |
| X-Tasks   | tasks, with whether each is done, as `x-tasks://task/<id>` links | the X-Tasks server's address and a read-only token from its account page |
| Trilium   | notes through Trilium's ETAPI, linked into its page | the Trilium server's address and an ETAPI token |
| Firefox bookmarks | bookmarks found by title or address, and each bookmark folder to follow | the Firefox profile folder, or nothing for Firefox's default profile |
| Web links | web pages typed in by address and title | nothing |
| Email     | emails sent from Thunderbird with the add-on below, as `mid:` links keyed by their Message-ID | nothing here; the add-on has its own options |

Files reads the disk of the machine its server or daemon runs on, so on a server it finds the server's files. Firefox
bookmarks runs in the desktop app alone: it reads a copy of the profile's `places.sqlite`, since Firefox keeps the file
locked, and what it brings syncs to the server and other devices like anything else.

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
Closing the window leaves sync, backups, refreshing and the MCP server running. A tray icon lists the top-level
contexts to open and brings the window back; **Quit completely** there or under **Settings → Desktop** stops the
daemon too. The daemon tells you with a desktop notification when a refresh finds items gone from their apps. The app
opens `codex://context/<id>` links on that context.

## Signing in, sync, backups and history

These work as in every X-app. A browser signs in with a name and password; **Your account** changes the password, turns
on a second factor and makes tokens; an admin adds users on **Users**. The desktop app syncs with a server from
**Settings → This device → Sync**, and every copy backs itself up daily, keeping the last 14. Every change to a
context, its name, notes and the items it holds, is kept under **History**, where any version can be restored and a
deleted context brought back; a refresh is left out, since it changes only what the apps said.

## Coming from X-Context

An X-Context database moves over through the JSON files of **Settings → Import and export**: export the contexts in
X-Context, then import that file in CODEX, which reads X-Context's exports as its own. Collector settings, such as
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

## Not yet

- **More of the assistant:** the Inbox, background jobs, the knowledge graph and blueprints, in the order
  [docs/4-merge-with-x-context.md](docs/4-merge-with-x-context.md) gives.
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
               search/, history/ and settings
thunderbird/   the Thunderbird add-on: its popup, options and manifest
scripts/       seed.ts for sample data, icons.ts for the icons
tests/         one *.test.ts per behaviour
legacy/        the pre-merge assistant, kept for porting and for a future mail application; not built or tested
docs/          the goal, the architecture, open questions, the roadmap and the merge plan
nix/           package.nix, desktop-package.nix, module.nix
```

## License

GPL-3.0-or-later.
