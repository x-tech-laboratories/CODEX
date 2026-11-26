# CODEX

<a href="https://liberapay.com/BeatLink/donate"><img alt="Donate using Liberapay" src="https://liberapay.com/assets/widgets/donate.svg"></a> <a href="https://ko-fi.com/I4V52ANK6N"><img alt="Support me on Ko-fi" src="https://ko-fi.com/img/githubbutton_sm.svg"></a>

A personal assistant that runs on a local LLM: it reads your mail, triages it,
drafts replies for you to approve, works requests you leave for later, and
answers questions from what it has researched and remembers.

CODEX is built on [SmartHarness](https://github.com/x-tech-laboratories/SmartHarness), which makes small,
locally run models capable by working each request as a tree of narrow tasks
over a knowledge store that grows in idle time. SmartHarness's README explains
how a request is handled, the agents, standing instructions, commands,
long-term memory, the tools and their safety rules, and the evals; this one
covers what the assistant adds: the daemon and its interfaces, mail, backups,
installation and configuration.

By default models run through `node-llama-cpp` from a local GGUF file and
nothing leaves the computer. A hosted model, such as Claude or a GPT model, is
something you choose, for requests, for background work, or both; see
[Hosted models](#hosted-models). The engine that works a request is a choice
too: SmartHarness's task tree, or a direct tool-calling loop for a model able
enough not to need one; see [Engines](#engines).

See [docs/0-goal.md](docs/0-goal.md) for what the assistant is for.

## Daemon and interfaces

CODEX is split into a daemon and the interfaces that talk to it. The
daemon (`codex-daemon`) owns the loaded model, runs requests, and runs
background research. Interfaces connect to it over a Unix socket at
`$XDG_RUNTIME_DIR/codex/daemon.sock` and only show what it reports, so
several can be open at once and all see the same run, queue, and settings.

- The window starts the daemon if none is running. A daemon
  started this way exits 30 seconds after the last interface disconnects, which
  also frees the model's memory; its output goes to
  `~/.local/state/codex/daemon.log`. Run `codex-daemon` yourself
  to keep one running, and background research with it, until it gets
  `SIGTERM`. `--exit-when-unused SECONDS` gives it the same timeout.
- A one-shot CLI run uses the daemon when one is running, so the model is
  already loaded, and otherwise runs the request in its own process.
- One request runs at a time. A run belongs to the interface that started it:
  only that interface is asked clarification questions, and the run is
  cancelled if that interface disconnects.
- Loading a model with layers on the GPU takes the lock file
  `$XDG_RUNTIME_DIR/codex-gpu.lock` and holds it until that model is
  unloaded, so two programs never fill the GPU at once (llama.cpp aborts the
  whole process when the GPU runs out of memory). A child `flock` process
  from util-linux holds the lock, so it is let go even if the daemon dies. A
  load waits up to 30 minutes for another holder, and an interface shows
  "Waiting for the GPU" meanwhile. Other programs can share the GPU the same way with
  `flock "$XDG_RUNTIME_DIR/codex-gpu.lock" command`; CODEX
  started under such a command uses the lock it was given. Models with no GPU
  layers, such as the embedding model, never take it.
  `CODEX_GPU_LOCK` names another lock file, or turns the lock off when
  set empty.
- The daemon reads `settings.json` when it starts. Relative paths in settings
  are resolved from the directory the daemon started in; the CLI sends its
  paths already resolved.

The protocol is one JSON object per line. A request is
`{"id", "method", "params"}` and gets `{"id", "result"}` or `{"id", "error"}`
back; the daemon also sends `{"event", "data"}` lines at any time. Methods are
`status`, `get_settings`, `apply_settings`, `save_settings`,
`set_background_enabled`, `run`, `cancel`, `answer_clarification`,
`queue_topic`, `research_now`, `queue_status`, `knowledge`, `unfinished_runs`,
`resume_run`, `discard_run`, `suspend`, `resume`, and `shutdown`, plus the mail
methods under "Mail" and the backup methods under "Backups".
Events are `run.started`, `run.progress`, `run.input` (the full system prompt
and input of each step), `run.token`, `run.tree` (every task's state, with
its step records, sent whenever one changes), `run.clarification`,
`run.finished`, `run.failed`, `run.cancelled`, `background.status`,
`background.token`, `queue.changed`, `knowledge.changed`, `runs.changed` (the
list of unfinished task tree runs changed), `settings.changed`, and
`suspended.changed`.

### Watching a run

The daemon sends every event to every client, so a second connection can log
a run started from the window or the CLI: each step's full prompt, the tokens
it streamed, the task tree and any failure. `~/.local/state/codex/daemon.log`
and the `codex-daemon` journal hold only startup lines, and the knowledge
store's `task_runs` table keeps finished trees but no prompts or tokens.

1. Connect to `$XDG_RUNTIME_DIR/codex/daemon.sock` and send one request first,
   such as `{"id":"watch","method":"status","params":{}}`: a connection is
   registered for events on its first request, so a silent one hears nothing.
2. Read newline-delimited JSON. Lines with an `event` key are events; the line
   with your `id` answers your request. Keep `run.started` (`run_id`,
   `prompt`), `run.progress` (`label`), `run.input` (`label`, `system`,
   `input`), `run.token` (`label`, `token`; join the tokens by label),
   `run.tree`, `run.finished` (`result`) and `run.failed` (`message`); skip
   `queue.changed`, which arrives every 10 seconds.
3. Write two files: the raw lines with a timestamp, for searching, and a
   readable one that prints `----- <label> -----` whenever the label changes,
   followed by the step's system prompt, its input and its joined output. Follow
   the readable one with `tail -f`.

Stop the listener when done: while any client is connected, the daemon's
`--exit-when-unused` timer never starts. Kill it by its exact process ID, since
`pkill -f` on the script's name also matches the shell that started it. A
daemon restart (for example by a service that restarts it when `src/` changes)
closes the connection; reconnect afterwards. `suspend` and
`resume` are sent the same way, but suspending cancels the window's running
request, so ask whoever is using the window first.

## Installation

With Nix, which builds the CUDA version of llama.cpp and supplies the CUDA
runtime that `node-llama-cpp`'s prebuilt CUDA build needs:

```bash
nix build                    # result/bin: codex, codex-daemon, codex-gui
nix run                      # open the window
nix run .#cli -- "your prompt"
```

The package also installs an application launcher
(`share/applications/org.codex.CODEX.desktop`) and its icon, so installing it
into a profile, for example with `nix profile install`, adds CODEX to the
desktop's application menu.

To work on it, enter the dev shell, which provides Node 24 and Electron:

```bash
nix develop
npm ci
npm run build        # typechecks, builds the CLI and daemon to dist/ and the window to out/
npm test
npm run coverage   # raises the coverage floor in vitest.config.ts; commit it
npm run lint
npm run dev          # open the window on the dev server, reloading as the page changes
npm start            # open the built window
```

The window is a React page on the X-Libs widgets and Halon's stylesheets,
built with electron-vite; its rendered tests live in `tests/` and start with
`// @vitest-environment jsdom`.

The one-shot CLI also runs from the dev shell after a build, with
`npm run cli -- "your prompt"`. The `flock` command from util-linux must be
on `PATH`; the Nix package and dev shell provide it.

The Nix build reads its npm packages straight from `package-lock.json`, so a
lock file change needs nothing else in `flake.nix`.

If node-llama-cpp reports that its prebuilt CUDA build "is not compatible"
and falls back to the CPU, check the driver before the package: call
`cuInit` against `/run/opengl-driver/lib/libcuda.so.1`. A result of 100 (no
device) system-wide means the loaded kernel driver does not match the
user-space library, which can happen after a NixOS rebuild; a reboot fixes it.

Then put a GGUF model at `./models/model.gguf`, or point `model_path` at one,
and optionally an embedding model at `./models/embedding.gguf` (see
[Search by meaning](https://github.com/x-tech-laboratories/SmartHarness#search-by-meaning)). The reference model, the one the
evals are measured on, is
[Spark-X2.6-4B](https://huggingface.co/XHToken/Spark-X2.6-4B-GGUF) at
`Q4_K_M`; why is in SmartHarness's `docs/1-architecture.md`, "Reference model".

## Usage

```bash
codex "Explain how to design a local event logging daemon"
echo "Summarize this design" | codex
codex            # asks for a prompt when run in a terminal
codex-gui        # open the window
codex-daemon     # run the daemon in the foreground
codex --resume   # carry on the newest unfinished task tree run
codex eval       # SmartHarness's eval: compare the bare model and the task tree
codex recall-benchmark  # SmartHarness's recall benchmark, with no chat model
```

### The window

`codex-gui` opens an Electron window with four pages:

- **Workbench**: write a request, pick a mode, and run it with **Ctrl+Enter**,
  **Ctrl+R**, or the Run button, and stop it with the Cancel button. The list
  on the left shows the live task tree with each task's state (WAIT, NOW, DONE,
  WARN for unverified, FAIL). The Steps page streams every step under its own
  heading, and choosing a task in the tree shows its deliverable, state, note,
  and result. The Final answer page shows the Markdown answer, with headings,
  emphasis, code, and lists styled; web links open in the browser when clicked,
  and **Copy answer** copies it. Typing `/` suggests the commands. Clarification
  questions appear as a dialog. When a task tree run was left unfinished, a bar
  under the Run button names it by its title (or the start of its request until
  it has one) and how many of its tasks are done, with Resume and Discard
  buttons.
- **Background**: queue topics, start research now, pause or resume the worker,
  and watch its output and queue.
- **Knowledge**: a graph of every topic with its subtopics, articles and
  findings, plus the things the store has learned about and the named
  relationships between them; dashed lines join each finding and relationship
  to the article that supports it. The graph is drawn with force-graph, the
  library behind Trilium's note map: it follows the panel's size, keeps
  settling as nodes are dragged, and double-clicking a topic folds its branch. Choosing a node shows its sources
  and summaries, facts and relationships in the panes beside and below, and the
  stored evidence can be searched.
- **Options**: every setting, including model, task tree limits, folder access,
  tool limits, background research, and the MCP server list, which is edited as
  JSON. **Apply** uses the changes now and **Save settings** writes them back to
  the settings file. **Auto size** reads the model file and free GPU memory (or
  RAM without a GPU) and fills in the context size and both token limits; apply
  or save them.

The window also lives in the system tray (a StatusNotifierItem, so it needs a
tray host such as KDE Plasma or the AppIndicator extension on GNOME). Clicking
the icon shows or hides the window, and closing the window hides it instead of
quitting, which keeps the daemon and its background research running. The tray
menu shows or hides the window, turns background research on or off, turns
**Launch at login** on or off, and quits; Options has the same Launch at login
switch. Launch at login writes `~/.config/autostart/org.codex.CODEX.desktop`,
which runs `codex-gui --background` to start in the tray without opening the
window. It uses `codex-gui` from the PATH, or else the packaged launcher the
window was started from, and the window rewrites the entry each time it starts
so an update never leaves it pointing at a removed path. If no tray appears within 15 seconds the window opens anyway, and
without a tray closing the window quits as usual.

### Suspending

`codex suspend` frees the GPU for another program, and `codex resume` takes
work up again. A suspended daemon cancels the running request (an unfinished
task tree can be resumed afterwards), unloads the main and background models
so the GPU and its lock are free, pauses background research, and refuses new
requests; the interfaces show "Suspended", and models load on the next request
after a resume. Both commands do nothing, and succeed, when no daemon is
running, so a launcher can call them without checking. The daemon status
carries `suspended`, and the `suspended.changed` event reports each change.
A suspended daemon still holds about 112 MiB of CUDA context, so on a 4 GB
card another program loading the 4B model with a 6,144-token context can fail
in cuBLAS while it is suspended; 4,096 tokens fits.

## Configuration

Settings are read from `settings.json` in the current directory, then from the
one beside the package, then from `~/.config/codex/settings.json` (under
`$XDG_CONFIG_HOME` when it is set). Use `--settings path/to/file.json` to pick
another. Unknown keys are rejected.

```json
{
	"model_path": "./models/model.gguf",
	"context_size": 6144,
	"gpu_layers": -1,
	"max_tokens": 2048,
	"temperature": 0.1,
	"filesystem_root": ".",
	"allow_file_writes": false,
	"max_tool_calls": 5,
	"max_search_results": 5,
	"enable_test_execution": false,
	"confirm_actions": true,
	"show_thinking": true,
	"mode": "auto",
	"max_task_depth": 3,
	"max_task_nodes": 20,
	"knowledge_db_path": "~/.local/share/codex/knowledge.sqlite3",
	"embedding_model_path": "./models/embedding.gguf",
	"background_research_enabled": true,
	"background_model_path": "",
	"background_context_size": 0,
	"background_gpu_layers": 0,
	"background_poll_interval_seconds": 10,
	"background_refresh_interval_hours": 168,
	"background_max_tokens": 512,
	"background_max_pending_jobs": 100,
	"background_prune_after_days": 90,
	"background_max_store_megabytes": 1024,
	"mail_maildir_paths": [],
	"mail_max_age_days": 7,
	"mail_imap_accounts": [],
	"mail_draft_replies": true,
	"mail_rule_proposal_threshold": 3,
	"engine": "task_tree",
	"model_provider": "local",
	"model_endpoint": "",
	"model_name": "",
	"model_api_key_command": [],
	"background_model_provider": "local",
	"background_model_endpoint": "",
	"background_model_name": "",
	"background_model_api_key_command": [],
	"mcp_servers": []
}
```

`max_task_depth` (0 to 6) is how many levels of subtasks may sit below the top
task, and `max_task_nodes` (1 to 60) caps the tasks in one tree, the top task
included. Each task takes three to six model calls, so these bound how long a
request can run.

With `confirm_actions` on, the default, an interactive run asks you before it
changes a file, runs tests, or calls an MCP tool. It shows the first task
that would act, with the outline of the whole tree, and your answer covers the
rest of the run. A reply starting with yes, ok, go, or sure approves; any other reply
declines, nothing is run, and the answer says so. A run with no one to ask,
such as piped CLI input, goes ahead as `allow_file_writes` and
`enable_test_execution` allow.

Precedence, lowest first: built-in defaults, the settings file, the
`MODEL_PATH` environment variable, then command-line options.

| Option                                                                                      | Effect                                                                        |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `--model-path`, `--context-size`, `--gpu-layers`, `--max-tokens`, `--temperature` | Override the matching setting                                                 |
| `--allow-file-writes`                                                                     | Let the model create or replace files                                         |
| `--enable-test-execution`                                                                 | Let the model run the project's tests                                         |
| `--show-thinking` / `--no-show-thinking`                                                | Stream or hide each step's output                                             |
| `--mode auto\|answer\|draft\|execute`                                                        | Limit what the request may do; only `auto` and `execute` may change files |
| `--settings PATH`                                                                         | Use another settings file                                                     |

`max_tokens` is reserved for the reply in most steps, so it must leave room
for input within `context_size`. **Auto size** in Options picks the largest
context that fits in memory, up to 32768 tokens, then gives a quarter of it to
`max_tokens` and an eighth to `background_max_tokens`. With a separate
background model, it sizes that model on its own device as well and sets
`background_context_size` and `background_max_tokens` from it.

### Engines

`engine` picks how a request is worked. `task_tree`, the default, is
SmartHarness's: the request is split into narrow tasks, each decided, written
and checked, which is what makes a small local model capable, and an
unfinished run can be resumed. `direct` hands the whole request to one model
in a tool-calling loop: it gets the same tools and safety rules (web search
and fetch, reading files, and writing files, running tests and MCP tools only
as the settings allow, approved first when `confirm_actions` is on), plus a
`recall` tool that searches the knowledge store. It suits a hosted model or a
large local one, takes fewer calls, and keeps no task tree, so the window
shows the run as a single task and it cannot be resumed. A direct run stops
after `max_task_nodes` rounds of tool calls.

The engine also works a request left for later and a drafted mail reply.
Background research, titling and learning stay SmartHarness's whichever engine
runs. The `status` method reports the engine and its features, and
`run.started` names it.

### Hosted models

`model_provider` picks where requests run: `local` (the GGUF file at
`model_path`), `openai` (any OpenAI-compatible chat completions endpoint:
OpenAI itself, or a server such as Ollama, vLLM or llama-server) or `anthropic`
(Claude, through Anthropic's SDK). A hosted model needs `model_name`, such as
`claude-opus-5-5`, `gpt-5` or `llama3.1`; `model_endpoint` is the server's
address (`http://localhost:11434/v1` for Ollama), or empty for the provider's
own. `model_api_key_command` is the program and arguments that print the key,
as with an IMAP account's `password_command`; the key is read when the model
loads and never stored. With no command, Anthropic's SDK looks for a key the
usual way, such as `ANTHROPIC_API_KEY`, and the OpenAI client uses
`OPENAI_API_KEY` or none for a local server. A hosted model keeps the
`context_size` you set, and Auto size leaves it alone.

The `background_model_` settings do the same for research, titling and mail.
With `background_model_provider` `local` and no `background_model_path`,
background work shares the main model, hosted or not; set a local
`background_model_path` to keep mail and research on this computer while
requests go to a hosted model. Everything a hosted model is asked, mail
included when background work runs on it, is sent to that provider.

Each run names its model in the `run.started` event (`model`) and in the
window's status line. A request a hosted model declines fails with the reason
the provider gives.

The model's prompts ship with SmartHarness in its `share/prompts/`, and the
assistant's own (mail triage and drafted replies) in `share/assistant/prompts/`,
one text file per prompt. They are not a settings file: there is no user copy to override
them, because a prompt changes only when the eval shows the new wording does
better. To try a variant, point the eval at a folder of replacement files with
`--prompts DIR` (see SmartHarness's [Evaluation](https://github.com/x-tech-laboratories/SmartHarness#evaluation)).

## Backups

The daemon backs up the knowledge database once a day into `backups` beside it
(`~/.local/share/codex/backups` by default), keeping the last 14, and checks
again every hour while it runs. Options → Backups backs up by hand, changes how
many are kept or turns daily backups off, and restores a backup. A restore
backs up the current database first, then puts the backup in place while the
daemon keeps running; it is refused while a task or a background job is
running, since either may still write what it read before. The daemon methods
are `list_backups`, `create_backup`, `restore_backup` (`name`),
`remove_backup` (`name`), `get_backup_schedule` and `set_backup_schedule`
(`schedule`: `{"automatic", "to_keep"}`), and the schedule is kept in
`backup-schedule.json` beside the database.

## Mail

List Maildir folders (the ones a mail syncer such as mbsync fills) in `mail_maildir_paths`
in `settings.json` to have the daemon read new messages. Mail from lists and automatic
senders is skipped, and the model looks at the rest and proposes a notification for what
a person needs to see. Messages older than `mail_max_age_days` are not read, and the
daemon only reads files; it never holds a mail password. The proposals appear on the
window's **Inbox** page, where **Done** and **Dismiss** clear them. The tray menu lists
`Inbox (n)` while any are waiting, and a desktop notification announces new ones while
the window is not in front.

A message that waits for a reply also gets a drafted answer (`mail_draft_replies`), which
appears in the Inbox as a draft; CODEX never sends mail. To read an IMAP mailbox directly,
add it to `mail_imap_accounts` with a `host`, `username` and a `password_command`, the
program and arguments that print the password (for example your password manager's
command); the password is never stored in settings. The `queue_request` daemon method
leaves a request for the assistant to work while idle, and its answer waits in the Inbox.

A drafted reply that mentions a date, time, amount or name the email never does, or
that names another recipient or subject, ends with a `Check:` line saying what to look
at; it is still only a draft. These checks are word matches, so they sometimes flag a
name you meant to use.

Sender rules decide how mail from an address or a whole domain is handled, without the
model: `ignore` drops it, `notify` shows it, and `reply` shows it and drafts an answer.
A rule for an address beats one for its domain. They live in the `mail_sender_rules`
table of the knowledge store, and the daemon methods `sender_rules`,
`set_sender_rule` (`pattern`, `mail_class`) and `delete_sender_rule` (`pattern`) list,
add and remove them, for example:

```bash
echo '{"id": 1, "method": "set_sender_rule", "params": {"pattern": "news.example.org", "mail_class": "ignore"}}' \
  | socat - "UNIX-CONNECT:$XDG_RUNTIME_DIR/codex/daemon.sock"
```

After you dismiss `mail_rule_proposal_threshold` (default 3, 0 for never) messages in a
row from one sender, the Inbox asks whether to ignore that sender: **Done** adds the
rule and **Dismiss** declines it for good. What triage decided and what you did with
each message is kept in `mail_outcomes`; the `mail_outcomes` daemon method returns the
recent rows and how often you kept what was shown.

Background work runs on the main model unless `background_model_path` names
another GGUF file. That model gets its own cache, so the two never evict each
other, and loads with `background_gpu_layers` (default 0, the CPU) and
`background_context_size` (0 uses `context_size`). It still stops as soon as a
request starts, and it is unloaded after five minutes without background work.

## Project layout

| Path                                                 | Contents                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/assistant/mail.ts`, `src/assistant/imap.ts`     | Reading new mail from Maildir folders and IMAP mailboxes as events                                          |
| `src/assistant/triage.ts`                            | Triage of incoming email: sender rules, bulk mail, and the model's verdict                                  |
| `src/assistant/draftReply.ts`                        | Drafting a reply to mail that waits for one, as a task tree                                                 |
| `src/assistant/mailChecks.ts`                        | Sender-rule matching and the checks on drafted mail replies                                                 |
| `src/assistant/mailStore.ts`                         | The mail tables beside the knowledge store: triage outcomes, drafts and sender rules                        |
| `src/assistant/eventHandlers.ts`                     | The event handlers the daemon runs: the harness's own plus mail                                             |
| `src/assistant/identity.ts`                          | CODEX's names for the harness's folders and instructions file, set when imported                    |
| `src/assistant/settings.ts`                          | The assistant's settings: the harness's plus mail and model providers, and where the files live            |
| `src/engine/engine.ts`                               | The engines a request can run on, chosen by the `engine` setting                                            |
| `src/engine/directEngine.ts`, `share/assistant/prompts/direct.txt` | The direct engine: one model working the request in a tool-calling loop                     |
| `src/assistant/models.ts`                            | Which model requests and background work run on, local or hosted, as SmartHarness model sources           |
| `src/assistant/openaiModel.ts`, `src/assistant/anthropicModel.ts` | Hosted models behind an OpenAI-compatible endpoint and Anthropic's Messages API                |
| `src/assistant/secretCommand.ts`                     | Reading a password or API key from a command, so settings never hold it                                    |
| `src/assistant/prompts.ts`, `share/assistant/prompts/` | The assistant's own prompts                                                                               |
| `src/daemon/daemon.ts`                               | The daemon: model, runs, background worker, and socket server                                               |
| `src/daemon/backups.ts`                              | Daily backups of the knowledge database, and restoring one                                                  |
| `src/daemon/client.ts`, `src/shared/protocol.ts`     | Connecting to the daemon and the message format                                                             |
| `src/cli/index.ts`                                   | The one-shot command line, with SmartHarness's `eval` and `recall-benchmark` as subcommands                  |
| `src/main/tray.ts`, `src/main/autostart.ts`          | The system tray icon and menu, and the login autostart entry                                                |
| `src/main`, `src/preload`, `src/shared/ipc.ts`       | The Electron main process that starts the daemon and relays its messages, and the bridge the page calls it through |
| `src/web`                                            | The window's React page: the workbench, inbox, background, knowledge and options views on X-Libs' widgets   |

The task tree, knowledge store, background research, agents, prompts and evals
are [SmartHarness](https://github.com/x-tech-laboratories/SmartHarness), imported as
`@x-tech-laboratories/smartharness/<module>` and pinned to a commit in
`package.json`.

Test files named `*.test.ts` sit beside the files they cover; the page's tests live in `tests/`.

See [docs/1-architecture.md](docs/1-architecture.md) for how these parts fit together.

Run the tests with `npm test`, which uses vitest.

The coverage floor in `vitest.config.ts` only rises: CI fails when coverage drops below it or a raised floor is not committed.

## License

GPL-3.0; see `LICENSE`.
