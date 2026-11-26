// The popup on an email's Add to context button: tick the contexts it belongs in, add a note, and send it.

// ── Imports ──────────────────────────────────────────────────────────────────

import "@x-tech-laboratories/halon/halon-tokens.css";
import "@x-tech-laboratories/halon/halon.css";
import "./addon.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe_error } from "@x-tech-laboratories/x-libs/web/errors";
import { FormRow } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Skeleton } from "@x-tech-laboratories/x-libs/web/react/states";

import type { ContextSummary } from "../src/shared/contexts/model.ts";
import { call_server, context_rows, contexts_holding, email_item, plain_text_of, type ServerSettings } from "./capture.ts";

// ── Loading ──────────────────────────────────────────────────────────────────

interface Loaded {
  settings: ServerSettings;
  message: ThunderbirdMessageHeader;
  contexts: ContextSummary[];
  held: string[];
}

async function load(): Promise<Loaded | "not_set_up" | "no_message"> {
  const stored = await browser.storage.local.get(["address", "token"]);
  const settings = { address: String(stored.address ?? ""), token: String(stored.token ?? "") };
  if (!settings.address || !settings.token) return "not_set_up";
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const message = tab?.id === undefined ? null : await browser.messageDisplay.getDisplayedMessage(tab.id);
  if (!message) return "no_message";
  const [contexts, held] = await Promise.all([call_server<ContextSummary[]>(settings, "list_contexts", {}), contexts_holding(settings, message)]);
  return { settings, message, contexts, held };
}

// ── Popup ────────────────────────────────────────────────────────────────────

function Picker({ loaded }: { loaded: Loaded }) {
  const [picked, set_picked] = useState<Set<string>>(new Set());
  const [note, set_note] = useState("");
  const [state, set_state] = useState<"idle" | "sending" | "sent">("idle");
  const [problem, set_problem] = useState("");

  const send = async () => {
    set_state("sending");
    set_problem("");
    try {
      const body = plain_text_of(await browser.messages.getFull(loaded.message.id));
      await call_server(loaded.settings, "add_item", { context_ids: [...picked], collector: "email", item: email_item(loaded.message, body), note });
      set_state("sent");
      setTimeout(() => window.close(), 900);
    } catch (error) {
      set_problem(describe_error(error));
      set_state("idle");
    }
  };

  if (loaded.contexts.length === 0) return <Empty title="No contexts yet" hint="Make one in CODEX first." />;
  if (state === "sent") return <p role="status">Added to {picked.size === 1 ? "the context" : `${picked.size} contexts`}.</p>;
  return (
    <form
      className="addon-form"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <p className="muted addon-subject">{loaded.message.subject || "(no subject)"}</p>
      <ul className="addon-contexts" aria-label="Contexts">
        {context_rows(loaded.contexts).map(({ context, depth }) => {
          const is_held = loaded.held.includes(context.id);
          return (
            <li key={context.id} style={{ paddingInlineStart: `calc(${depth} * var(--space-6))` }}>
              <label>
                <input
                  type="checkbox"
                  checked={is_held || picked.has(context.id)}
                  disabled={is_held}
                  onChange={(event) => {
                    const next = new Set(picked);
                    if (event.target.checked) next.add(context.id);
                    else next.delete(context.id);
                    set_picked(next);
                  }}
                />{" "}
                {context.name}
                {is_held && <span className="muted"> · already here</span>}
              </label>
            </li>
          );
        })}
      </ul>
      <FormRow label="Note" id="addon-note">
        <input id="addon-note" value={note} placeholder="Why it belongs there" onChange={(event) => set_note(event.target.value)} />
      </FormRow>
      {problem && <p className="field-error" role="alert">{problem}</p>}
      <button type="submit" className="accent solid" disabled={picked.size === 0 || state === "sending"}>
        {state === "sending" ? "Adding…" : "Add to context"}
      </button>
    </form>
  );
}

function Popup() {
  const [loaded, set_loaded] = useState<Awaited<ReturnType<typeof load>> | null>(null);
  const [problem, set_problem] = useState("");
  useEffect(() => void load().then(set_loaded, (error: unknown) => set_problem(describe_error(error))), []);

  if (problem) return <p className="field-error" role="alert">{problem}</p>;
  if (!loaded) return <Skeleton lines={4} />;
  if (loaded === "no_message") return <Empty title="No email shown" hint="Open an email, then add it to a context." />;
  if (loaded === "not_set_up") {
    return (
      <div className="addon-form">
        <p>Give the add-on your CODEX server and a token first.</p>
        <button type="button" className="accent solid" onClick={() => void browser.runtime.openOptionsPage()}>
          Open the options
        </button>
      </div>
    );
  }
  return <Picker loaded={loaded} />;
}

createRoot(document.getElementById("app")!).render(<Popup />);
