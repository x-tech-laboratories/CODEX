// The first page: a search across everything kept, by words and meaning, and each top-level context with what is inside it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Layers, MessageSquare, Shapes } from "lucide-react";
import { Chip, Chips } from "@x-tech-laboratories/x-libs/web/react/badges";
import { SearchBox } from "@x-tech-laboratories/x-libs/web/react/controls";
import { AddIcon, Icon, type IconGlyph } from "@x-tech-laboratories/x-libs/web/react/icons";
import { Card, Cards, PageHeading, Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded } from "@x-tech-laboratories/x-libs/web/react/states";

import type { ContextSummary } from "../../shared/contexts/model.ts";
import { blueprint_collector, blueprint_of_item, blueprint_route } from "../../shared/blueprints/model.ts";
import { conversation_of_item, conversation_route } from "../../shared/conversations/model.ts";
import type { HitKind, SearchHit } from "../../shared/search/model.ts";
import { open_conversation } from "../assistant/selection.ts";
import { use_data } from "../api.ts";
import { context_href, new_context } from "./actions.tsx";
import { seed_dialog } from "./FeedDialogs.tsx";
import { look_of } from "./kinds.tsx";

// ── Search ───────────────────────────────────────────────────────────────────

const hit_icons: Record<Exclude<HitKind, "item">, IconGlyph> = { context: Layers, message: MessageSquare, entity: Shapes };

function go_to(context_id: string): void {
  window.location.hash = context_href(context_id).slice(1);
}

// A conversation's messages found, gathered in one row where the first of them ranked.
interface FoundConversation {
  conversation: { id: string; title: string };
  where: SearchHit["where"];
  messages: SearchHit[];
}

export type FoundEntry = { hit: SearchHit } | FoundConversation;

// The conversation a hit belongs to: a message's, or a conversation's own item; null for anything else.
function conversation_of_hit(hit: SearchHit): { id: string; title: string } | null {
  if (hit.kind === "message") return hit.conversation;
  if (hit.kind === "item" && hit.item_kind === "conversation") return { id: conversation_of_item(hit.id) ?? "", title: hit.title };
  return null;
}

// The hits in their order, each conversation's messages, and the conversation itself, gathered where the first of
// them ranked; a message whose conversation is unknown stays a row of its own.
export function group_hits(hits: SearchHit[]): FoundEntry[] {
  const entries: FoundEntry[] = [];
  const gathered = new Map<string, FoundConversation>();
  for (const hit of hits) {
    const conversation = conversation_of_hit(hit);
    if (!conversation) {
      entries.push({ hit });
      continue;
    }
    const found = gathered.get(conversation.id);
    const messages = hit.kind === "message" ? [hit] : [];
    if (found) {
      found.messages.push(...messages);
      continue;
    }
    const entry = { conversation, where: hit.where, messages };
    gathered.set(conversation.id, entry);
    entries.push(entry);
  }
  return entries;
}

function Places({ where }: { where: SearchHit["where"] }) {
  return (
    <Chips inline>
      {where.map((place) => (
        <Chip key={place.id || place.name} on_click={place.id ? () => go_to(place.id) : undefined}>
          {place.name}
        </Chip>
      ))}
    </Chips>
  );
}

// A conversation with the messages in it that matched, each with who wrote it and the words around the match.
function ConversationHit({ entry }: { entry: FoundConversation }) {
  const { conversation, messages } = entry;
  const where = entry.where.length === 0 ? [{ id: "", name: "In no context" }] : entry.where;
  return (
    <li className="item-row">
      <Icon icon={MessageSquare} />
      <div className="item-text">
        <div className="item-title">
          <a
            href={conversation_route(conversation.id)}
            onClick={(event) => {
              event.preventDefault();
              open_conversation(conversation.id, entry.where.map((place) => place.id), null);
            }}
          >
            {conversation.title}
          </a>
          {messages.length > 0 && (
            <span className="muted small">
              {messages.length} {messages.length === 1 ? "message" : "messages"}
            </span>
          )}
        </div>
        {messages.map((message) => (
          <span key={message.id} className="muted item-snippet">
            {message.title}: {message.excerpt}
          </span>
        ))}
        <Places where={where} />
      </div>
    </li>
  );
}

// One thing found: its title, opening in its app or on its context's page, the words around the match and where it is.
function Hit({ hit }: { hit: SearchHit }) {
  const icon = hit.kind === "item" ? look_of(hit.item_kind).icon : hit_icons[hit.kind];
  const where = hit.kind === "message" && hit.where.length === 0 ? [{ id: "", name: "In no context" }] : hit.where;
  const title =
    hit.kind === "item" && hit.collector === blueprint_collector ? (
      <a href={blueprint_route(blueprint_of_item(hit.id) ?? "")}>{hit.title}</a>
    ) : hit.kind === "item" && hit.uri ? (
      <a href={hit.uri} target="_blank" rel="noreferrer">
        {hit.title}
      </a>
    ) : hit.kind === "context" ? (
      <a href={context_href(hit.id)}>{hit.title}</a>
    ) : (
      <span>{hit.kind === "message" ? `${hit.title}, in a conversation` : hit.title}</span>
    );
  return (
    <li className="item-row">
      <Icon icon={icon} />
      <div className="item-text">
        <div className="item-title">{title}</div>
        {hit.excerpt && <span className="muted item-snippet">{hit.excerpt}</span>}
        <Places where={where} />
      </div>
    </li>
  );
}

function Found({ query }: { query: string }) {
  const found = use_data((api) => api.search_index(query, null, 30), [query]);
  return (
    <Section title="Found">
      <Loaded resource={found}>
        {(hits) =>
          hits.length === 0 ? (
            <Empty title="Nothing matches" hint="Items in your contexts, their text from their apps, your contexts' notes and the conversations are searched; add new items from a context's page." />
          ) : (
            <ul className="item-list">
              {group_hits(hits).map((entry) => ("hit" in entry ? <Hit key={`${entry.hit.kind}:${entry.hit.id}`} hit={entry.hit} /> : <ConversationHit key={`conversation:${entry.conversation.id}`} entry={entry} />))}
            </ul>
          )
        }
      </Loaded>
    </Section>
  );
}

// ── Contexts ─────────────────────────────────────────────────────────────────

function ContextCards({ contexts }: { contexts: ContextSummary[] }) {
  const top = contexts.filter((context) => context.parent_id === null);
  if (top.length === 0) return <Empty title="No contexts yet" hint="Make one for each project or area of your life, then add the tasks, notes, files, emails and links that belong to it." />;
  const inside = (id: string) => contexts.filter((context) => context.parent_id === id);
  return (
    <Cards>
      {top.map((context) => (
        <Card key={context.id} title={context.name} subtitle={`${context.item_count} ${context.item_count === 1 ? "item" : "items"}`} href={context_href(context.id)}>
          {inside(context.id).length > 0 && <span className="muted">{inside(context.id).map((child) => child.name).join(" · ")}</span>}
        </Card>
      ))}
    </Cards>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function HomeView() {
  const [query, set_query] = useState("");
  const contexts = use_data((api) => api.list_contexts(false));
  return (
    <>
      <PageHeading
        title="Contexts"
        actions={
          <>
            <button type="button" onClick={seed_dialog} title="Make a context for each tag or project picked in another app, such as X-Tasks">
              From another app…
            </button>
            <button type="button" className="accent solid" onClick={() => new_context(null)}>
              <Icon icon={AddIcon} /> New context
            </button>
          </>
        }
      />
      <SearchBox label="Search everything kept" value={query} on_input={set_query} />
      {query.trim() ? <Found query={query.trim()} /> : <Loaded resource={contexts}>{(list) => <ContextCards contexts={list} />}</Loaded>}
    </>
  );
}
