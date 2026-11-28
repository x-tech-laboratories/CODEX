# Instructions for AI agents

## X-Tech standards

- Follow the [Application Standard](https://x-tech-laboratories.github.io/standards/application/) and the
  [Design Guidelines](https://x-tech-laboratories.github.io/standards/design/), whose source is `src/content/docs/standards/`
  in [x-tech-laboratories.github.io](https://github.com/x-tech-laboratories/x-tech-laboratories.github.io). Ask before
  changing either, since a change applies to every X-app.
- Use [X-App](https://github.com/x-tech-laboratories/X-App) and Halon ([X-Themes](https://github.com/x-tech-laboratories/X-Themes))
  before writing your own code: check the module table in the X-App README first.
- A feature another app could use belongs in X-App, or Halon for styling, with tests and a README row. If that is out
  of reach, add it to the candidates in X-App's `docs/TODO.md`.

## This repository

CODEX gathers tasks, notes, files, emails and links from other apps into contexts, keeping only pointers to them, and is
growing back into a personal assistant. It is a React page that runs in a browser against its own server and in
Electron with its own daemon and database, syncing through the server. Its Thunderbird add-on lives in X-Mail.
Read `README.md` first, then `docs/1-architecture.md`, then `docs/4-merge-with-x-context.md` for where it is going.

- **Skeleton:** the code in `src/` came from X-Context, and 0.3.0 is the first CODEX built on it. It follows the Application Standard: one SQLite
  store built from features, sync, History, backups, a server host and an Electron window and daemon, every call
  served over REST, OpenAPI and MCP.
- **`legacy/`:** the pre-merge assistant on SmartHarness. Nothing builds, tests, lints or measures it, and its
  dependencies are not installed. Port a feature from it onto the store and the X-App widgets, with tests, rather
  than reviving it in place; delete what has been ported. Its mail code is frozen for a separate mail application.
- **Engines and assistant features** come back as plugins and features of this store, in the order of doc 4. A change
  to SmartHarness's task tree, agents, prompts or evals belongs in SmartHarness.

### Setup and checks

- `nix-shell nix/shell.nix` (or `nix develop ./nix`) gives Node 24 and an Electron that runs on NixOS; then `npm install`.
- `npm run typecheck`, `npm test` and `npm run lint` must pass before you propose a change.
- While working, run only the tests for what you changed (`npx vitest run tests/<side>/<feature>/<file>`); CI runs the full suite.
- The coverage floor in `vitest.config.ts` sits a point under the measure and only rises; `npm run coverage` writes a
  raised floor, which is committed with the change.
- To look at the app, build it and run it under its own Xvfb display with `--mute-audio`, never on the user's screen.

### Rules

- Every feature lives in `src/shared/<feature>/` (store, types) and `src/web/<feature>/` (views); `src/shared/store.ts`
  only lists features.
- CODEX never keeps an item's content as its own: an item is a pointer and what its collector last said of it. What it
  derives (indexes, embeddings, links) can be rebuilt.
- A collector is an X-App plugin providing a `collector`; one that needs Node goes in `src/server/collectors/`, any other
  in `src/shared/collectors/`.
- Code in `src/shared/` runs on the server and in the desktop daemon, and its types in the page: no DOM, no `node:` imports.
- The desktop app's work goes in `src/daemon`; `src/main` keeps only what needs Electron: the window, the tray and the login entry.
- A store call that only reads is named `list_`, `get_`, `search_`, `lookup_` or `export_`; any other name announces a change.
- Text CODEX writes for a model to read (instructions, specialists' prompts, tool results) lives in
  `src/shared/prompts/prompts.json`, filled in with `fill`; tool and call descriptions stay with their specs.
- Every store call has a spec in its feature's `api` saying what it does and its arguments, so the API and MCP
  offer it too; describe it for someone who has never seen the page.
- A released migration step is never edited; add a new step after it. For a feature on Drizzle, change `schema.ts` and run `npm run db:generate`.
- Queries go through X-App `drizzle` (`drizzle_of(database)`), never an import of `drizzle-orm` itself.
- Use X-App widgets and Halon classes; `app.css` holds layout only and never a colour. A widget two apps could use goes into X-App.
- Tests use a throwaway database (`:memory:` or a temp file), never `dev-data/` or a real profile.
- Comments are one plain line saying what the code does now; names are snake_case, components PascalCase.
- Commit messages follow Conventional Commits and end with an `Assisted-by:` trailer naming the tool.
- When a task is ambiguous, stop and ask rather than guess.
