# The pre-merge assistant

This folder holds CODEX as it was before X-Context's code became its skeleton (version 0.2.1): the assistant on
SmartHarness, with its daemon, CLI, Electron window, mail, Inbox and mascot. See `docs/4-merge-with-x-context.md`.

- **Not built or tested:** no tsconfig, vitest run, coverage, lint or build reads this folder, and the dependencies its
  `package.json` names are not installed. Its configs are kept as they were, as a record of what it built against.
- **The source for features being ported:**
  - **Inbox:** `src/main/inbox.ts`, `src/web/inbox_view.ts` and `src/web/views/inbox.tsx`.
  - **Mascot:** RoboBuddy's face in `src/web/mascot.ts` and `src/web/widgets/mascot.tsx`, and `resources/mascot-redesign/`.
  - **Background queue:** the daemon's job loop in `src/daemon/daemon.ts`, and `src/web/views/background.tsx`.
  - **Knowledge view:** `src/web/knowledge_view.ts`, `knowledge_graph.ts` and `views/knowledge.tsx`.
- **The seed of a mail application:** `src/assistant/mail*.ts`, `imap.ts`, `triage.ts` and `draftReply.ts`, with the
  prompts in `share/assistant/prompts/` and `secretCommand.ts`, which `imap.ts` reads its password with, are frozen
  here and are not ported into CODEX.
- **Ported and deleted:** the engine interface and the direct loop (`src/engine/`), the hosted model adapters
  (`anthropicModel.ts`, `openaiModel.ts`, `models.ts`) and the direct prompt became CODEX's engine plugins on
  2026-11-26 (`src/shared/engines/`, `src/server/engines/`). What still imports them here, such as the old daemon, is
  left as it was, since nothing builds it.

A feature is deleted from here once it is ported, or once the mail application has taken it.
