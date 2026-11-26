// The Inbox: everything that waits on the user, newest first, each opening its conversation or thing, with Approve and
// Reject (or Accept and Reject, or Set aside for a run that ended badly) in place, and several decided at once after
// asking. Deciding goes through the same page-only calls as everywhere else.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { CalendarClock, Inbox as InboxGlyph, Newspaper, ScrollText, Shapes, Waypoints } from "lucide-react";
import { Chip, Chips } from "@x-tech-laboratories/x-libs/web/react/badges";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Icon, type IconGlyph } from "@x-tech-laboratories/x-libs/web/react/icons";
import { FormGroup, PageHeading, SelectionBar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded } from "@x-tech-laboratories/x-libs/web/react/states";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { MessageSquare } from "lucide-react";

import type { InboxEntry, InboxKind } from "../../shared/inbox/model.ts";
import { open_conversation } from "../assistant/selection.ts";
import { Evidence } from "../assistant/AssistantPane.tsx";
import { calls, show_error, use_data } from "../api.ts";
import { ProposalText } from "../blueprints/ProposalCard.tsx";

// ── Deciding ─────────────────────────────────────────────────────────────────

const icons: Record<InboxKind, IconGlyph> = { change: MessageSquare, link: Waypoints, entity: Shapes, blueprint: ScrollText, blueprint_change: ScrollText, job_run: CalendarClock, digest: Newspaper };

// Entries that are only read, then set aside: a run that ended badly, and the daily digest.
const read_only_kinds: InboxKind[] = ["job_run", "digest"];

// The words on an entry's two buttons: a change is approved, a proposal accepted, a run or digest set aside.
function words_of(kind: InboxKind): { yes: string; no: string | null } {
  if (kind === "change") return { yes: "Approve", no: "Reject" };
  if (read_only_kinds.includes(kind)) return { yes: "Set aside", no: null };
  return { yes: "Accept", no: "Reject" };
}

// Decides the entries given, yes or no, by kind, through each feature's page-only calls; gives back how many were decided.
export async function decide(entries: InboxEntry[], yes: boolean): Promise<number> {
  const of = (kinds: InboxKind[]) => entries.filter((entry) => kinds.includes(entry.kind)).map((entry) => entry.id);
  let decided = 0;
  for (const id of of(["change"])) {
    await calls().resolve_proposal(id, yes ? "approve" : "reject");
    decided++;
  }
  const graph = of(["link", "entity"]);
  if (graph.length) {
    const report = yes ? await calls().accept_graph_proposals(graph) : await calls().reject_graph_proposals(graph);
    decided += report.accepted + report.rejected;
  }
  const blueprints = of(["blueprint", "blueprint_change"]);
  if (blueprints.length) decided += (yes ? await calls().accept_blueprint_proposals(blueprints) : await calls().reject_blueprint_proposals(blueprints)).decided.length;
  const runs = of(read_only_kinds);
  if (runs.length && yes) decided += await calls().dismiss_job_runs(runs);
  return decided;
}

async function decide_and_tell(entries: InboxEntry[], yes: boolean): Promise<void> {
  try {
    const decided = await decide(entries, yes);
    toast(`${decided} ${decided === 1 ? "thing" : "things"} decided.`, { tone: "good" });
  } catch (error) {
    show_error(error);
  }
}

// ── Rows ─────────────────────────────────────────────────────────────────────

// A change opens its conversation in the pane; anything else, and a change background maintenance proposed, its own page.
function open_entry(entry: InboxEntry): void {
  if (entry.kind === "change" && entry.conversation_id) {
    open_conversation(entry.conversation_id, [], null);
    return;
  }
  window.location.hash = entry.route.slice(1);
}

function EntryRow({ entry, picked, on_pick }: { entry: InboxEntry; picked: boolean; on_pick: (on: boolean) => void }) {
  const [busy, set_busy] = useState(false);
  const words = words_of(entry.kind);
  const run = async (yes: boolean) => {
    set_busy(true);
    await decide_and_tell([entry], yes);
    set_busy(false);
  };
  return (
    <li className="item-row inbox-row">
      <input type="checkbox" aria-label={`Pick ${entry.title}`} checked={picked} onChange={(event) => on_pick(event.target.checked)} />
      <Icon icon={icons[entry.kind]} />
      <div className="item-text">
        <div className="item-title">
          <a
            href={entry.route}
            onClick={(event) => {
              event.preventDefault();
              open_entry(entry);
            }}
          >
            {entry.title}
          </a>
        </div>
        {entry.kind === "digest" && entry.run ? (
          <ul className="digest-lines">
            {entry.run.applied.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          entry.detail && <span className="muted item-snippet">{entry.detail}</span>
        )}
        <span className="muted small">
          By {entry.made_by}, <Age epoch={Date.parse(entry.created_at) / 1000} />
          {entry.job_title && !read_only_kinds.includes(entry.kind) ? `, in the background job “${entry.job_title}”` : ""}
        </span>
        {entry.conversation_title && (
          <Chips inline>
            <Chip title="Open the conversation" on_click={() => open_conversation(entry.conversation_id, [], null)}>
              {entry.conversation_title}
            </Chip>
          </Chips>
        )}
        {entry.proposal && (
          <FormGroup class_name="proposal-why" summary={<span className="muted small">Why, and from what</span>}>
            <Evidence proposal={entry.proposal} asked={null} label_of={(source) => source} />
          </FormGroup>
        )}
        {entry.blueprint && (
          <FormGroup summary={<span className="muted small">{entry.blueprint.kind === "new" ? "Its whole text" : "What would change"}</span>}>
            <ProposalText proposal={entry.blueprint} />
          </FormGroup>
        )}
      </div>
      <span className="row-actions">
        <button type="button" className={read_only_kinds.includes(entry.kind) ? undefined : "accent solid"} disabled={busy} onClick={() => void run(true)}>
          {words.yes}
        </button>
        {words.no && (
          <button type="button" disabled={busy} onClick={() => void run(false)}>
            {words.no}
          </button>
        )}
      </span>
    </li>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function ask_then(entries: InboxEntry[], yes: boolean, after: () => void): void {
  const proposals = entries.filter((entry) => !read_only_kinds.includes(entry.kind)).length;
  const runs = entries.length - proposals;
  const what = yes ? [proposals > 0 ? `approve or accept ${proposals} ${proposals === 1 ? "proposal" : "proposals"}` : "", runs > 0 ? `set ${runs} ${runs === 1 ? "run" : "runs"} aside` : ""].filter(Boolean).join(" and ") : `reject ${proposals} ${proposals === 1 ? "proposal" : "proposals"}`;
  confirm_dialog({
    title: yes ? "Decide these at once?" : "Reject these at once?",
    message: `This will ${what}. Approved changes are made now, each recorded in its conversation and History.`,
    confirm_label: yes ? "Yes, all of them" : "Reject all of them",
    busy_label: "Deciding…",
    danger: !yes,
    run: async () => {
      await decide_and_tell(entries, yes);
      after();
    },
  });
}

function List({ entries }: { entries: InboxEntry[] }) {
  const [picked, set_picked] = useState<Set<string>>(new Set());
  const chosen = entries.filter((entry) => picked.has(entry.key));
  const pick = (key: string, on: boolean) => set_picked((before) => new Set(on ? [...before, key] : [...before].filter((each) => each !== key)));
  const clear = () => set_picked(new Set());
  const proposals = chosen.filter((entry) => !read_only_kinds.includes(entry.kind));
  return (
    <>
      {chosen.length > 0 && (
        <SelectionBar count={chosen.length} total={entries.length} on_clear={clear} on_select_all={() => set_picked(new Set(entries.map((entry) => entry.key)))}>
          <button type="button" className="accent solid" onClick={() => ask_then(chosen, true, clear)}>
            Approve or set aside the ticked
          </button>
          <button type="button" disabled={proposals.length === 0} onClick={() => ask_then(proposals, false, clear)}>
            Reject the ticked
          </button>
        </SelectionBar>
      )}
      <ul className="item-list">
        {entries.map((entry) => (
          <EntryRow key={entry.key} entry={entry} picked={picked.has(entry.key)} on_pick={(on) => pick(entry.key, on)} />
        ))}
      </ul>
    </>
  );
}

export function InboxPage() {
  const inbox = use_data((api) => api.list_inbox());
  return (
    <>
      <PageHeading
        title="Inbox"
        icon={<Icon icon={InboxGlyph} />}
        subtitle="What waits for you: changes the assistant proposed, in conversations and in background jobs; proposed links, entities and blueprints; background runs that failed or stopped at a limit; and each day's digest of background work."
      />
      <Loaded resource={inbox}>{(entries) => (entries.length === 0 ? <Empty title="Nothing waits for you" hint="What the assistant proposes, and background runs that need a look, show here." /> : <List entries={entries} />)}</Loaded>
    </>
  );
}
