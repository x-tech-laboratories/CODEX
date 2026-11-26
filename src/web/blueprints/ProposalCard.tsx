// A proposed blueprint, or a proposed change to one, with its whole text or what it would change, for the user to read
// and accept or reject: the only way a blueprint an engine or a program wrote becomes one the assistant follows.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Markdown } from "@x-tech-laboratories/x-libs/web/react/markdown";

import { line_diff } from "../../shared/blueprints/diff.ts";
import { blueprint_route, type BlueprintProposal } from "../../shared/blueprints/model.ts";
import { calls, succeeds } from "../api.ts";

// ── Text ─────────────────────────────────────────────────────────────────────

// The body's lines, each kept, added or taken away, with the line's sign for a screen reader.
export function BodyDiff({ before, after }: { before: string; after: string }) {
  return (
    <pre className="blueprint-diff" aria-label="What would change">
      {line_diff(before, after).map((line, at) => (
        <div key={at} className={line.kind === "added" ? "tone-fill-good" : line.kind === "removed" ? "tone-fill-bad" : undefined}>
          {line.kind === "added" ? "+ " : line.kind === "removed" ? "− " : "  "}
          {line.text}
        </div>
      ))}
    </pre>
  );
}

function maker_words(proposal: BlueprintProposal): string {
  if (proposal.made_by === "program") return "Written by a program through a token or MCP.";
  return `Written by the assistant${proposal.engine ? ` (${[proposal.engine, proposal.model].filter(Boolean).join(" · ")})` : ""}.`;
}

// The proposal's text: the whole blueprint when new, what differs when a change.
function ProposalText({ proposal }: { proposal: BlueprintProposal }) {
  const before = proposal.before;
  if (!before) {
    return (
      <>
        <p className="small">
          <span className="muted">Applies when: </span>
          {proposal.applies_when}
        </p>
        <div className="blueprint-body">
          <Markdown text={proposal.body} />
        </div>
      </>
    );
  }
  return (
    <>
      {before.title !== proposal.title && (
        <p className="small">
          <span className="muted">Title: </span>
          <del>{before.title}</del> → {proposal.title}
        </p>
      )}
      {before.applies_when !== proposal.applies_when ? (
        <p className="small">
          <span className="muted">Applies when: </span>
          <del>{before.applies_when}</del> → {proposal.applies_when}
        </p>
      ) : (
        <p className="small">
          <span className="muted">Applies when: </span>
          {proposal.applies_when}
        </p>
      )}
      {before.body !== proposal.body ? <BodyDiff before={before.body} after={proposal.body} /> : <p className="muted small">The rules and steps stay as they are.</p>}
    </>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────────

export function BlueprintProposalCard({ proposal, show_open = true }: { proposal: BlueprintProposal; show_open?: boolean }) {
  const [busy, set_busy] = useState(false);
  const decide = async (accept: boolean) => {
    set_busy(true);
    const ids = [proposal.id];
    await succeeds(() => (accept ? calls().accept_blueprint_proposals(ids) : calls().reject_blueprint_proposals(ids)), accept ? (proposal.kind === "new" ? "The blueprint is active." : "The blueprint is changed.") : undefined);
    set_busy(false);
  };
  const heading = proposal.kind === "new" ? `Proposed blueprint: ${proposal.title}` : `Proposed change to the blueprint “${proposal.before?.title ?? proposal.title}”`;
  return (
    <article className="card tone-edge-warn proposal-card" aria-label={heading}>
      <p>
        <strong>{heading}</strong>
      </p>
      {proposal.reason && <p className="small">Why: {proposal.reason}</p>}
      <ProposalText proposal={proposal} />
      <p className="muted small">{maker_words(proposal)} Nothing is followed until you accept it.</p>
      <div className="proposal-actions">
        <button type="button" className="accent solid" disabled={busy} onClick={() => void decide(true)}>
          Accept
        </button>
        <button type="button" disabled={busy} onClick={() => void decide(false)}>
          Reject
        </button>
        {show_open && (
          <a className="button" href={blueprint_route(proposal.blueprint_id)}>
            Open
          </a>
        )}
      </div>
    </article>
  );
}
