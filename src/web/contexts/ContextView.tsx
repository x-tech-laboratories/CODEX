// One context's page: where it sits, its notes, and its items, as a list grouped by kind or as cards arranged in a
// grid, each opening in its own app.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Badge, Chip, Chips } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Dialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { AddIcon, ExternalLinkIcon, HistoryIcon, Icon, MoreIcon, RefreshIcon } from "@x-tech-laboratories/x-libs/web/react/icons";
import { CardGrid } from "@x-tech-laboratories/x-libs/web/react/card_grid";
import { Segmented } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Crumbs, FormRow, PageHeading, Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { open_context_menu } from "@x-tech-laboratories/x-libs/web/react/menus";
import { RichText } from "@x-tech-laboratories/x-libs/web/react/rich_text";
import { Empty, Loaded } from "@x-tech-laboratories/x-libs/web/react/states";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import type { MenuItem } from "@x-tech-laboratories/x-libs/web/menus";

import type { CardPlace, ContextDetail, ContextItem, ContextSummary, ContextView as ViewName } from "../../shared/contexts/model.ts";
import { blueprint_collector, blueprint_route } from "../../shared/blueprints/model.ts";
import { conversation_collector, conversation_route } from "../../shared/conversations/model.ts";
import { open_conversation } from "../assistant/selection.ts";
import { attempt, calls, succeeds, use_data } from "../api.ts";
import { GraphPanel } from "../graph/GraphPanel.tsx";
import { graph_href } from "../graph/GraphPage.tsx";
import { open_item_history } from "../history/HistoryView.tsx";
import { context_href, context_menu } from "./actions.tsx";
import { add_item_dialog } from "./AddItemDialog.tsx";
import { follow_dialog, report_text } from "./FeedDialogs.tsx";
import { add_to_contexts, move_to_context, remove_from_context, rename_conversation } from "./item_actions.tsx";
import { kind_order, look_of, row_icon } from "./kinds.tsx";

// ── Notes ────────────────────────────────────────────────────────────────────

const save_delay_ms = 800;

// The context's notes, saved a moment after typing stops and when the field is left.
function Notes({ context }: { context: ContextDetail }) {
  const typed = useRef(context.notes);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const save = () => {
    clearTimeout(timer.current);
    if (typed.current !== context.notes) void succeeds(() => calls().set_context_notes(context.id, typed.current));
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <RichText
      label="Notes"
      placeholder="What this context is about, what is next, anything worth keeping beside its items."
      value={context.notes}
      on_change={(markdown) => {
        typed.current = markdown;
        clearTimeout(timer.current);
        timer.current = setTimeout(save, save_delay_ms);
      }}
      on_blur={save}
    />
  );
}

// ── Items ────────────────────────────────────────────────────────────────────

function edit_note(context_id: string, item: ContextItem): void {
  open_dialog((close) => <NoteDialog context_id={context_id} item={item} on_close={close} />);
}

function NoteDialog({ context_id, item, on_close }: { context_id: string; item: ContextItem; on_close: () => void }) {
  const [note, set_note] = useState(item.note);
  return (
    <Dialog
      title="Note"
      subtitle={item.title}
      on_close={on_close}
      form={{
        submit_label: "Save",
        on_submit: (event) => {
          event.preventDefault();
          void succeeds(() => calls().set_item_note(context_id, item.id, note)).then((done) => done && on_close());
        },
      }}
      buttons={<button type="button" onClick={on_close}>Cancel</button>}
    >
      <FormRow label="Why it belongs here" id="item-note">
        <textarea id="item-note" rows={4} value={note} autoFocus onChange={(event) => set_note(event.target.value)} />
      </FormRow>
    </Dialog>
  );
}

function status_badge(status: string) {
  if (status === "missing") return <Badge tone="bad" title="Its app no longer has it">Missing</Badge>;
  if (status === "done") return <Badge tone="good">Done</Badge>;
  return status ? <Badge>{status}</Badge> : null;
}

function holders_of(context_id: string, item: ContextItem): string[] {
  return [context_id, ...item.also_in.map((other) => other.id)];
}

function is_conversation(item: ContextItem): boolean {
  return item.collector === conversation_collector;
}

function is_blueprint(item: ContextItem): boolean {
  return item.collector === blueprint_collector && item.status !== "missing";
}

function open_item_conversation(context_id: string, item: ContextItem): void {
  open_conversation(item.source_id, holders_of(context_id, item), context_id);
}

function item_menu(context_id: string, item: ContextItem): MenuItem[] {
  const conversation = { id: item.source_id, title: item.title, is_named: item.detail.is_named === "true" };
  const is_last = item.also_in.length === 0;
  return [
    ...(is_conversation(item) && item.status !== "missing"
      ? [
          { label: "Open in the pane", run: () => open_item_conversation(context_id, item) },
          { label: "Rename…", run: () => rename_conversation(conversation) },
        ]
      : []),
    ...(is_blueprint(item) ? [{ label: "Open", run: () => (window.location.hash = blueprint_route(item.source_id).slice(1)) }] : []),
    { label: item.note ? "Edit note…" : "Add note…", run: () => edit_note(context_id, item) },
    { label: "Move to…", disabled: item.status === "missing" && is_conversation(item), run: () => move_to_context(item, context_id, holders_of(context_id, item)) },
    { label: "Also add to…", disabled: item.status === "missing" && is_conversation(item), run: () => add_to_contexts(item, holders_of(context_id, item)) },
    { label: "Copy address", disabled: !item.uri, run: () => void navigator.clipboard.writeText(item.uri).then(() => toast("Address copied.")) },
    {
      label: is_conversation(item) && is_last && item.status !== "missing" ? "Delete conversation…" : is_blueprint(item) && is_last ? "Delete blueprint…" : "Remove from context",
      danger: true,
      separator_before: true,
      run: () => (item.status === "missing" ? void succeeds(() => calls().remove_item(context_id, item.id), "Removed.") : remove_from_context(context_id, item, item.also_in.length)),
    },
  ];
}

// An item's title: a conversation opens in the pane, any other item in its own app.
function ItemTitle({ context_id, item }: { context_id: string; item: ContextItem }) {
  if (is_conversation(item) && item.status !== "missing") {
    return (
      <a
        href={conversation_route(item.source_id)}
        onClick={(event) => {
          event.preventDefault();
          open_item_conversation(context_id, item);
        }}
      >
        {item.title}
      </a>
    );
  }
  if (is_blueprint(item)) return <a href={blueprint_route(item.source_id)}>{item.title}</a>;
  return item.uri && !is_conversation(item) && item.collector !== blueprint_collector ? (
    <a href={item.uri} target="_blank" rel="noreferrer">
      {item.title}
    </a>
  ) : (
    <span>{item.title}</span>
  );
}

// How many links each item of the open context has, by node key.
const LinkCounts = createContext<Record<string, number>>({});

// A small count of an item's links, opening the graph on it.
function LinkCount({ item }: { item: ContextItem }) {
  const count = useContext(LinkCounts)[`item:${item.id}`] ?? 0;
  if (count === 0) return null;
  return (
    <a className="muted small" href={graph_href(`item:${item.id}`)} title="Open the graph on it">
      {count} {count === 1 ? "link" : "links"}
    </a>
  );
}

// What a row and a card both show of an item: its title opening it, its state, a line of it, the note and where else it is.
function ItemText({ context_id, item }: { context_id: string; item: ContextItem }) {
  return (
    <div className="item-text">
      <div className="item-title">
        <ItemTitle context_id={context_id} item={item} />
        {status_badge(item.status)}
        <LinkCount item={item} />
      </div>
      {item.snippet && <span className="muted item-snippet">{item.snippet}</span>}
      {is_conversation(item) && item.detail.last_used_at && (
        <span className="muted small">
          Last used <Age epoch={Date.parse(item.detail.last_used_at) / 1000} />
        </span>
      )}
      {item.note && <span className="item-note">{item.note}</span>}
      {item.via_label && <span className="muted small">From {item.via_label}; a note keeps it here</span>}
      {item.also_in.length > 0 && (
        <Chips inline>
          {item.also_in.map((other) => (
            <Chip key={other.id} title={`Also in ${other.name}`} on_click={() => (window.location.hash = context_href(other.id).slice(1))}>
              {other.name}
            </Chip>
          ))}
        </Chips>
      )}
    </div>
  );
}

function ItemActions({ context_id, item }: { context_id: string; item: ContextItem }) {
  return (
    <span className="row-actions">
      {is_conversation(item) && item.status !== "missing" && (
        <button type="button" aria-label={`Open ${item.title}`} title="Open in the Assistant pane" onClick={() => open_item_conversation(context_id, item)}>
          <Icon icon={ExternalLinkIcon} />
        </button>
      )}
      {is_blueprint(item) && (
        <a className="button" href={blueprint_route(item.source_id)} aria-label={`Open ${item.title}`} title="Open the blueprint">
          <Icon icon={ExternalLinkIcon} />
        </a>
      )}
      {item.uri && !is_conversation(item) && item.collector !== blueprint_collector && (
        <a className="button" href={item.uri} target="_blank" rel="noreferrer" aria-label={`Open ${item.title}`} title="Open in its app">
          <Icon icon={ExternalLinkIcon} />
        </a>
      )}
      <button type="button" aria-label={`More for ${item.title}`} onClick={(event) => open_context_menu(event, item_menu(context_id, item))}>
        <Icon icon={MoreIcon} />
      </button>
    </span>
  );
}

function RowIcon({ kind, status }: { kind: string; status: string }) {
  const { icon, label, class_name } = row_icon(kind, status);
  return <Icon icon={icon} {...(label ? { label } : {})} {...(class_name ? { className: class_name } : {})} />;
}

function ItemRow({ context_id, item }: { context_id: string; item: ContextItem }) {
  return (
    <li className={item.status === "missing" ? "item-row is-missing" : "item-row"} onContextMenu={(event) => open_context_menu(event, item_menu(context_id, item))}>
      <RowIcon kind={item.kind} status={item.status} />
      <ItemText context_id={context_id} item={item} />
      <ItemActions context_id={context_id} item={item} />
    </li>
  );
}

function ItemCard({ context_id, item }: { context_id: string; item: ContextItem }) {
  return (
    <div className={item.status === "missing" ? "item-card is-missing" : "item-card"} onContextMenu={(event) => open_context_menu(event, item_menu(context_id, item))}>
      <div className="item-card-kind muted small">
        <Icon icon={look_of(item.kind).icon} /> {look_of(item.kind).singular}
      </div>
      <ItemText context_id={context_id} item={item} />
      <ItemActions context_id={context_id} item={item} />
    </div>
  );
}

// The items as cards in a grid, kept where they were put; a move shows at once and is saved behind it.
function ItemCards({ context }: { context: ContextDetail }) {
  const [places, on_places_change] = use_places(context);
  return (
    <CardGrid
      items={context.items}
      id_of={(item) => item.id}
      name_of={(item) => item.title}
      render_card={(item) => <ItemCard context_id={context.id} item={item} />}
      label="Items"
      places={places}
      on_places_change={on_places_change}
      default_size={{ w: 4, h: 4 }}
      min_size={{ w: 2, h: 3 }}
    />
  );
}

// The card places shown, and a change kept with the places of cards not on this grid, so the two card views each keep
// their own arrangement.
function use_places(context: ContextDetail): [CardPlace[], (next: CardPlace[]) => void] {
  const [places, set_places] = useState<CardPlace[]>(context.card_places);
  useEffect(() => set_places(context.card_places), [context.card_places]);
  return [
    places,
    (next) => {
      const moved = new Set(next.map((place) => place.id));
      const all = [...places.filter((place) => !moved.has(place.id)), ...next];
      set_places(all);
      void succeeds(() => calls().set_card_places(context.id, all));
    },
  ];
}

// The id of a kind's card in the grouped view, apart from any item's.
export function kind_card_id(kind: string): string {
  return `kind:${kind}`;
}

// One kind's card: its name and count, then its items as rows.
function KindCard({ context_id, kind, items }: { context_id: string; kind: string; items: ContextItem[] }) {
  return (
    <div className="kind-card">
      <div className="item-card-kind muted small">
        <Icon icon={look_of(kind).icon} /> {look_of(kind).plural} · {items.length}
      </div>
      <ul className="item-list">
        {items.map((item) => (
          <ItemRow key={item.id} context_id={context_id} item={item} />
        ))}
      </ul>
    </div>
  );
}

// The items as a card per kind, such as one holding every task, moved and resized like single cards.
function KindCards({ context }: { context: ContextDetail }) {
  const [places, on_places_change] = use_places(context);
  return (
    <CardGrid
      items={group_by_kind(context.items)}
      id_of={([kind]) => kind_card_id(kind)}
      name_of={([kind]) => look_of(kind).plural}
      render_card={([kind, items]) => <KindCard context_id={context.id} kind={kind} items={items} />}
      label="Kinds"
      places={places}
      on_places_change={on_places_change}
      default_size={{ w: 6, h: 8 }}
      min_size={{ w: 3, h: 4 }}
    />
  );
}

// The items in groups by kind, tasks first.
export function group_by_kind(items: ContextItem[]): [string, ContextItem[]][] {
  const groups = new Map<string, ContextItem[]>();
  for (const item of items) groups.set(item.kind, [...(groups.get(item.kind) ?? []), item]);
  const rank = (kind: string) => (kind_order.includes(kind) ? kind_order.indexOf(kind) : kind_order.length);
  return [...groups.entries()].sort(([first], [second]) => rank(first) - rank(second) || first.localeCompare(second));
}

// ── Page ─────────────────────────────────────────────────────────────────────

// The names from the top context down to this one's parent, each linking to its context.
function path_of(context: ContextDetail, all: ContextSummary[]): [string, string][] {
  const path: [string, string][] = [];
  let parent = all.find((each) => each.id === context.parent_id);
  while (parent) {
    path.unshift([parent.name, context_href(parent.id)]);
    const parent_id = parent.parent_id;
    parent = all.find((each) => each.id === parent_id);
  }
  return path;
}

// What was added to the group this context was made from since, offered as new contexts inside it.
function GroupNews({ context }: { context: ContextDetail }) {
  const seed = context.seeded_from!;
  const news = use_data((api) => api.list_feed_group_news(context.id), [context.id, context.feeds.length]);
  const [busy, set_busy] = useState(false);
  const fresh = news.data ?? [];
  if (fresh.length === 0) return null;
  const add = async () => {
    set_busy(true);
    const ids = await attempt(() => calls().add_contexts_from_feeds(seed.collector, fresh.map((feed) => ({ id: feed.id, label: feed.label })), context.id));
    set_busy(false);
    if (ids) {
      toast(`Made ${ids.length} ${ids.length === 1 ? "context" : "contexts"} inside ${context.name}.`, { tone: "good" });
      void news.reload(true);
    }
  };
  return (
    <div className="context-feeds">
      <span className="muted">New in {seed.label}</span>
      <Chips inline>
        {fresh.map((feed) => (
          <Chip key={feed.id}>{feed.label}</Chip>
        ))}
      </Chips>
      <button type="button" disabled={busy} onClick={() => void add()}>
        {busy ? "Adding…" : fresh.length === 1 ? "Add as a context" : "Add as contexts"}
      </button>
      <button type="button" onClick={() => void succeeds(() => calls().stop_feed_group_news(context.id), `Stopped suggesting what is new in ${seed.label}.`)}>
        Stop suggesting
      </button>
    </div>
  );
}

// Starts a conversation asking the assistant to propose links, and opens the pane on it.
async function suggest_links(context_id: string): Promise<void> {
  const started = await attempt(() => calls().suggest_links(context_id));
  if (started) open_conversation(started.conversation_id, [context_id], context_id);
}

async function refresh(context_id: string): Promise<void> {
  const report = await attempt(() => calls().refresh_items(context_id));
  if (!report) return;
  const followed = report.joined || report.left ? ` From followed: ${report_text({ ...report, problems: [] })}` : "";
  const said = `Checked ${report.checked}; ${report.updated} changed, ${report.missing} newly missing.${followed}`;
  toast(report.problems.length ? `${said} ${report.problems.join(" ")}` : said, { tone: report.problems.length ? "bad" : "good" });
}

function Page({ context, all }: { context: ContextDetail; all: ContextSummary[] }) {
  const counts = use_data((api) => api.list_link_counts(context.id), [context.id]);
  const summary = all.find((each) => each.id === context.id) ?? { ...context };
  const go_home = () => (window.location.hash = "/overview");
  return (
    <>
      <PageHeading
        title={context.name}
        subtitle={context.is_archived ? "Archived" : `${context.items.length} ${context.items.length === 1 ? "item" : "items"}`}
        actions={
          <>
            <Segmented<ViewName>
              label="Show items as"
              choices={[
                { value: "list", label: "List" },
                { value: "cards", label: "Cards" },
                { value: "grouped", label: "Grouped" },
                { value: "graph", label: "Graph" },
              ]}
              value={context.view}
              on_change={(view) => void succeeds(() => calls().set_context_view(context.id, view))}
            />
            <button type="button" className="accent solid" onClick={() => add_item_dialog(context.id, context.name)}>
              <Icon icon={AddIcon} /> Add
            </button>
            <button type="button" onClick={() => follow_dialog(context.id, context.name, context.feeds)} title="Gather what a tag or project in another app holds">
              Follow…
            </button>
            <button type="button" onClick={() => void suggest_links(context.id)} title="Ask the assistant to read these items and propose people, topics and links">
              Suggest links
            </button>
            <button type="button" onClick={() => void refresh(context.id)} title="Ask each app what became of these items">
              <Icon icon={RefreshIcon} /> Refresh
            </button>
            <button type="button" className="icon" aria-label="History" title="History" onClick={() => open_item_history("context", context.id, context.name)}>
              <Icon icon={HistoryIcon} />
            </button>
            <button type="button" className="icon" aria-label="More" onClick={(event) => open_context_menu(event, context_menu(summary, go_home))}>
              <Icon icon={MoreIcon} />
            </button>
          </>
        }
      >
        {context.parent_id && <Crumbs items={[...path_of(context, all), [context.name, null]]} />}
        {context.feeds.length > 0 && (
          <div className="context-feeds">
            <span className="muted">Follows</span>
            <Chips inline>
              {context.feeds.map((feed) => (
                <Chip
                  key={`${feed.collector}:${feed.feed_id}`}
                  title={`From ${feed.collector}`}
                  on_remove={() => void succeeds(() => calls().unfollow_feed(context.id, feed.collector, feed.feed_id), `Stopped following ${feed.label}.`)}
                  remove_label={`Stop following ${feed.label}`}
                >
                  {feed.label}
                </Chip>
              ))}
            </Chips>
          </div>
        )}
        {context.seeded_from && <GroupNews key={context.id} context={context} />}
      </PageHeading>
      <Section title="Notes" class_name="context-notes">
        <Notes key={context.id} context={context} />
      </Section>
      <LinkCounts.Provider value={counts.data ?? {}}>
      {context.view === "graph" && <GraphPanel key={context.id} context_id={context.id} label={`Graph of ${context.name}`} />}
      {context.view !== "graph" && context.items.length === 0 && <Empty title="Nothing here yet" hint="Add tasks, notes, files, emails and links from the apps that keep them, or start a conversation in the Assistant pane." />}
      {context.view === "cards" && context.items.length > 0 && <ItemCards context={context} />}
      {context.view === "grouped" && context.items.length > 0 && <KindCards context={context} />}
      {context.view === "list" && group_by_kind(context.items).map(([kind, items]) => (
        <Section key={kind} title={`${look_of(kind).plural} · ${items.length}`}>
          <ul className="item-list">
            {items.map((item) => (
              <ItemRow key={item.id} context_id={context.id} item={item} />
            ))}
          </ul>
        </Section>
      ))}
      </LinkCounts.Provider>
    </>
  );
}

export function ContextView({ id }: { id: string }) {
  const detail = use_data(async (api) => ({ context: await api.get_context(id), all: await api.list_contexts(true) }), [id]);
  return <Loaded resource={detail}>{({ context, all }) => <Page context={context} all={all} />}</Loaded>;
}
