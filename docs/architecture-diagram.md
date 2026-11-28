# CODEX: modules and how they interact

Drawn from `docs/1-architecture.md` and `src/` as of 2026-11-28.

## 1. Hosts and the store

```mermaid
flowchart LR
  subgraph Page["src/web — React page (same tree in browser and window)"]
    Views["Views<br/>contexts · cards · graph · search<br/>inbox · history · settings"]
    Pane["Assistant pane<br/>(RoboBuddy face, mood)"]
    PageApi["PageApi<br/>calls() / use_data / data_watch"]
    Views --> PageApi
    Pane --> PageApi
  end

  subgraph Desktop["Desktop app"]
    Main["src/main<br/>window · tray · login entry"]
    Preload["src/preload"]
    Daemon["src/daemon<br/>owns codex.db, sync, backups,<br/>refreshing, local MCP"]
  end

  subgraph Server["src/server"]
    App["app.ts<br/>REST api/call/method<br/>OpenAPI · MCP · accounts/tokens"]
    Refresh["refreshing.ts<br/>refresh every N min"]
    Declared["declared.ts<br/>keep_declared / watch_config"]
  end

  Store[("Store — src/shared<br/>SQLite via Drizzle<br/>(codex.db / server DB)")]
  Index[("Search index<br/>separate SQLite<br/>FTS5 + vectors<br/>never synced")]
  Sync["X-Libs sync server"]
  DeclFile[/"declared.json<br/>/etc/codex or CODEX_DECLARED_FILE"/]

  PageApi -- "web host: POST api/call" --> App
  PageApi -- "desktop host: IPC" --> Preload --> Main
  Main -- "HTTP over daemon.sock" --> Daemon

  App --> Store
  Daemon --> Store
  Refresh --> Store
  Daemon -. "sync_client" .-> Sync
  Store --> Index
  DeclFile --> Declared --> Store
  DeclFile --> Daemon
```

## 2. Inside the store (src/shared)

```mermaid
flowchart TB
  subgraph Core["Contexts and items"]
    Contexts["contexts/<br/>contexts · items · context_items<br/>Global root, feeds, card layout"]
    History["history/<br/>versions of contexts, entities, links"]
    Items["items/<br/>answers item calls (scheme codex)<br/>for other apps"]
  end

  subgraph Knowledge["Knowledge"]
    Search["search/<br/>documents · indexer · keep_indexing"]
    Graph["graph/<br/>entities · typed links<br/>rules, similarity, proposals"]
    Guidance["guidance/ + prompts/<br/>Global notes, instructions"]
  end

  subgraph Assistant["Assistant"]
    Conv["conversations/<br/>conversations · messages · runs<br/>engine_tools · specialists"]
    Policy["policy/<br/>action levels · proposals · undo"]
    Privacy["privacy/<br/>source marks · screen per run"]
    Blueprints["blueprints/<br/>workflow memory"]
    Jobs["jobs/<br/>scheduled background runs"]
    Maint["maintenance/<br/>8 built-in jobs: index, embed,<br/>rules, similarity, tidy, suggest…"]
    Interests["interests/<br/>curiosity · findings"]
    Mood["mood/<br/>mood.current, fades hourly"]
    Inbox["inbox/<br/>reads everything waiting"]
  end

  subgraph Plugins["Plugin host (X-Libs plugins)"]
    Collectors["collectors/<br/>search · resolve · read · content · feeds"]
    Sources["sources/<br/>codex.items: one collector<br/>per app answering item calls"]
    Engines["engines/<br/>engine.run → event stream<br/>direct loop · context fitting"]
    Embedders["embedders/"]
    Tools["tools/ + mcp/<br/>tool plugins, MCP connector"]
  end

  Contexts -- "every write" --> History
  Contexts -- "after_write" --> Search
  Conv -- "conversation = item" --> Contexts
  Blueprints -- "blueprint = item" --> Contexts
  Interests -- "finding = item" --> Contexts
  Search -- "changed docs" --> Graph
  Graph --> History

  Collectors -- "refresh / content" --> Contexts
  Collectors -- "text for index" --> Search
  Sources --> Collectors
  Embedders -- "vectors" --> Search

  Conv -- "run request" --> Engines
  Engines -- "tool call()" --> Conv
  Conv -- "screen results" --> Privacy
  Conv -- "change asked" --> Policy
  Policy -- "auto: run call" --> Contexts
  Policy -- "proposal" --> Inbox
  Graph -- "proposed links" --> Inbox
  Blueprints -- "proposed" --> Inbox
  Interests -- "proposed" --> Inbox
  Jobs -- "failed / limit runs" --> Inbox
  Conv -- "ask_ specialist tools" --> Tools
  Guidance -- "instructions" --> Conv
  Blueprints -- "applies in context" --> Conv
  Conv -- "set_mood" --> Mood
  Jobs -- "start_run (background level only)" --> Conv
  Maint --> Jobs
  Maint -- "index / embed" --> Search
  Maint -- "rules / similarity / tidy" --> Graph
```

## 3. The outside world

```mermaid
flowchart LR
  CODEX(["CODEX store<br/>(server or desktop daemon)"])

  subgraph Read["Apps CODEX reads (collectors)"]
    XTasks["X-Tasks"]
    Trilium["Trilium (ETAPI)"]
    XApps["Any X-app with item calls"]
    Files["Files (server/collectors/files.ts)"]
    Bookmarks["Firefox places.sqlite<br/>(desktop only)"]
    Links["Links · Email"]
  end

  subgraph Models["Model endpoints"]
    Anthropic["Anthropic API"]
    OpenAI["OpenAI-compatible<br/>Ollama · llama.cpp"]
    SH["SmartHarness package<br/>(experimental engine)"]
    Emb["Embedding endpoint"]
  end

  subgraph Callers["Programs calling CODEX"]
    MCPClients["MCP clients<br/>(server MCP, desktop local MCP)"]
    Tokens["REST with tokens · OpenAPI"]
    Thunderbird["Thunderbird add-on<br/>add_item, collector email"]
    OtherApps["Other X-apps<br/>reading context/conversation/entity items"]
  end

  MCPServers["MCP servers<br/>X-Fitness, X-Budget, …"]
  Web["Web tool plugin"]

  CODEX -- "search / resolve / read" --> Read
  CODEX -- "engine runs<br/>(hosted gets only marked sources)" --> Models
  CODEX -- "tool calls via specialists" --> MCPServers
  CODEX --> Web
  Callers -- "calls (page-only calls refused,<br/>writes from programs proposed)" --> CODEX
```

**What the three pictures show**

1. One React page runs on two hosts. In a browser it calls the server over `POST api/call/<method>`. In the desktop
   app it goes through IPC to Electron's main process, then over HTTP to the daemon's socket. The server or the daemon
   owns the SQLite store. The search index is a separate SQLite file that can be rebuilt at any time, and only the
   daemon syncs.
2. Conversations, blueprints and findings are all items in contexts, so History, search and the graph handle them the
   way they handle a task or a note. An engine never touches the store directly. Every tool call goes back through the
   conversation run, which screens results by source mark and sends any change through the action policy. Anything
   that waits for a decision ends up in the Inbox.
3. Collectors only read other apps and keep pointers to their items. Engines and embedders send text to a hosted
   endpoint only from sources marked for it. Outside programs reach CODEX through REST, MCP or the item calls, and
   none of them can make a page-only call.
