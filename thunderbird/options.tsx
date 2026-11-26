// The add-on's options: the CODEX server it sends emails to and the token it signs in with, checked on saving.

// ── Imports ──────────────────────────────────────────────────────────────────

import "@x-tech-laboratories/halon/halon-tokens.css";
import "@x-tech-laboratories/halon/halon.css";
import "./addon.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe_error } from "@x-tech-laboratories/x-libs/web/errors";
import { FormRow } from "@x-tech-laboratories/x-libs/web/react/layout";

import type { ContextSummary } from "../src/shared/contexts/model.ts";
import { call_server, server_origin } from "./capture.ts";

// ── Options ──────────────────────────────────────────────────────────────────

function Options() {
  const [address, set_address] = useState("");
  const [token, set_token] = useState("");
  const [outcome, set_outcome] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void browser.storage.local.get(["address", "token"]).then((stored) => {
      set_address(String(stored.address ?? ""));
      set_token(String(stored.token ?? ""));
    });
  }, []);

  // The add-on may reach the server only once Thunderbird has asked for the user's leave.
  const save = async () => {
    const origin = server_origin(address);
    if (!origin) return set_outcome({ ok: false, text: "Give the server's address, starting with https://." });
    if (!(await browser.permissions.request({ origins: [`${origin}/*`] }))) return set_outcome({ ok: false, text: "Thunderbird needs your leave to reach the server." });
    await browser.storage.local.set({ address: address.trim(), token: token.trim() });
    try {
      const contexts = await call_server<ContextSummary[]>({ address, token: token.trim() }, "list_contexts", {});
      set_outcome({ ok: true, text: `Connected; ${contexts.length} contexts found.` });
    } catch (error) {
      set_outcome({ ok: false, text: describe_error(error) });
    }
  };

  return (
    <form
      className="addon-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <FormRow label="Server address" id="address" hint="Your CODEX server, such as https://context.example.org.">
        <input id="address" value={address} placeholder="https://context.example.org" onChange={(event) => set_address(event.target.value)} />
      </FormRow>
      <FormRow label="Token" id="token" hint="Make one on your account page in CODEX, with changes allowed.">
        <input id="token" type="password" value={token} autoComplete="off" onChange={(event) => set_token(event.target.value)} />
      </FormRow>
      <button type="submit" className="accent solid">
        Save
      </button>
      {outcome && (
        <p className={outcome.ok ? "muted" : "field-error"} role="status">
          {outcome.text}
        </p>
      )}
    </form>
  );
}

createRoot(document.getElementById("app")!).render(<Options />);
