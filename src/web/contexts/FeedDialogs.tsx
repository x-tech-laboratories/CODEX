// Following other apps' groups, such as X-Tasks tags: a context follows one from its page, and the first page makes a
// context for each one picked, or for every one in a larger group such as an X-Tasks filter group.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Segmented, SearchBox } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Dialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Empty, Loaded } from "@x-tech-laboratories/x-libs/web/react/states";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";

import type { CollectorSummary, Feed, FeedGroup } from "../../shared/collectors/collector.ts";
import type { RefreshReport } from "../../shared/contexts/model.ts";
import { attempt, calls, use_data } from "../api.ts";
import { context_href } from "./actions.tsx";

// ── Picking ──────────────────────────────────────────────────────────────────

// The tab of the larger groups, beside one tab per kind of feed.
export const groups_tab = "groups";

// A kind of feed's name as a tab, such as "Tags" or "Tasks with subtasks".
export function plural_of(kind: string): string {
  const [first = "", ...rest] = kind.split(" ");
  return [first.endsWith("s") ? first : `${first}s`, ...rest].join(" ");
}

// The kinds of feed a collector offers, in the order it gives them.
export function kinds_of(feeds: Feed[]): string[] {
  return [...new Set(feeds.map((feed) => feed.kind))];
}

// The larger groups a collector's feeds belong to, such as X-Tasks filter groups, with how many contexts each makes:
// one per feed, but for a feed inside another of the group, such as a tag under another.
export function groups_of(feeds: Feed[]): (FeedGroup & { count: number })[] {
  const found = new Map<string, FeedGroup & { count: number }>();
  for (const feed of feeds) {
    if (!feed.group) continue;
    if (feeds.some((other) => other !== feed && other.group?.id === feed.group?.id && feed.label.startsWith(`${other.label}/`))) continue;
    const known = found.get(feed.group.id);
    if (known) known.count++;
    else found.set(feed.group.id, { ...feed.group, count: 1 });
  }
  return [...found.values()].sort((first, second) => first.label.localeCompare(second.label));
}

interface FeedListProps {
  collector: CollectorSummary;
  // The feeds already followed, by id, shown ticked and fixed.
  followed: Set<string>;
  picked: Map<string, Feed>;
  on_picked: (picked: Map<string, Feed>) => void;
  // Set where a whole group can be picked, which then gets a tab of its own.
  on_group?: (group: FeedGroup | null) => void;
  on_tab?: (tab: string) => void;
}

// The feeds a collector offers, a tab for each kind and one for its groups where they can be picked, narrowed as the
// filter is typed; each feed is ticked to pick it, or one group chosen.
function FeedList({ collector, followed, picked, on_picked, on_group, on_tab }: FeedListProps) {
  const feeds = use_data((api) => api.list_collector_feeds(collector.id), [collector.id]);
  const [filter, set_filter] = useState("");
  const [tab, set_tab] = useState<string | null>(null);
  const [group, set_group] = useState("");
  return (
    <Loaded resource={feeds}>
      {(list) => {
        if (list.length === 0) return <Empty title="Nothing to follow" hint={`${collector.label} has no tags or tasks with subtasks yet.`} />;
        const groups = on_group ? groups_of(list) : [];
        const tabs = [...kinds_of(list).map((kind) => ({ value: kind, label: plural_of(kind) })), ...(groups.length > 0 ? [{ value: groups_tab, label: "Filter groups" }] : [])];
        const current = tabs.find((each) => each.value === tab)?.value ?? tabs[0]!.value;
        const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
        const fits = (label: string) => words.every((word) => label.toLowerCase().includes(word));
        return (
          <>
            {tabs.length > 1 && (
              <Segmented
                label={`What ${collector.label} offers`}
                choices={tabs}
                value={current}
                on_change={(next) => {
                  set_tab(next);
                  on_tab?.(next);
                }}
              />
            )}
            <SearchBox label={`Filter ${collector.label}`} value={filter} on_input={set_filter} auto_focus />
            {current === groups_tab ? (
              <ul className="feed-list" aria-label={`${collector.label} filter groups`}>
                {groups
                  .filter((each) => fits(each.label))
                  .map((each) => (
                    <li key={each.id}>
                      <label>
                        <input
                          type="radio"
                          name="feed-group"
                          checked={group === each.id}
                          onChange={() => {
                            set_group(each.id);
                            on_group?.(each);
                          }}
                        />{" "}
                        {each.label}{" "}
                        <span className="muted">
                          · {each.count} {each.count === 1 ? "context" : "contexts"} inside
                        </span>
                      </label>
                    </li>
                  ))}
              </ul>
            ) : (
              <ul className="feed-list" aria-label={`${collector.label} ${plural_of(current).toLowerCase()}`}>
                {list
                  .filter((feed) => feed.kind === current && fits(feed.label))
                  .map((feed) => {
                    const is_followed = followed.has(feed.id);
                    return (
                      <li key={feed.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={is_followed || picked.has(feed.id)}
                            disabled={is_followed}
                            onChange={(event) => {
                              const next = new Map(picked);
                              if (event.target.checked) next.set(feed.id, feed);
                              else next.delete(feed.id);
                              on_picked(next);
                            }}
                          />{" "}
                          {feed.label}
                          {feed.group && <span className="muted"> · {feed.group.label}</span>}
                        </label>
                      </li>
                    );
                  })}
              </ul>
            )}
          </>
        );
      }}
    </Loaded>
  );
}

interface FeedPickerProps {
  followed_by_collector: (collector: string) => Set<string>;
  on_ready: (collector: CollectorSummary, picked: Map<string, Feed>) => void;
  // Set where a whole group can be picked instead, with its collector.
  on_group?: (choice: { collector: string; group: FeedGroup } | null) => void;
  on_tab?: (tab: string) => void;
}

// The collectors that offer feeds, one picked at a time, and what the chosen one offers.
function FeedPicker({ followed_by_collector, on_ready, on_group, on_tab }: FeedPickerProps) {
  const collectors = use_data(async (api) => (await api.list_collectors()).filter((collector) => collector.can_follow));
  const [chosen, set_chosen] = useState<string | null>(null);
  const [picked, set_picked] = useState<Map<string, Feed>>(new Map());
  return (
    <Loaded resource={collectors}>
      {(list) => {
        const collector = list.find((each) => each.id === chosen) ?? list[0];
        if (!collector) return <Empty title="Nothing to follow" hint="Turn on a collector that offers feeds, such as X-Tasks, under Settings → Plugins." />;
        return (
          <div className="add-item">
            {list.length > 1 && (
              <Segmented
                label="Collector"
                choices={list.map((each) => ({ value: each.id, label: each.label }))}
                value={collector.id}
                on_change={(id) => {
                  set_chosen(id);
                  set_picked(new Map());
                  on_ready(list.find((each) => each.id === id)!, new Map());
                  on_group?.(null);
                  on_tab?.("");
                }}
              />
            )}
            <FeedList
              key={collector.id}
              collector={collector}
              followed={followed_by_collector(collector.id)}
              picked={picked}
              on_picked={(next) => {
                set_picked(next);
                on_ready(collector, next);
              }}
              on_group={on_group && ((group) => on_group(group ? { collector: collector.id, group } : null))}
              on_tab={on_tab}
            />
          </div>
        );
      }}
    </Loaded>
  );
}

// ── Following from a context ─────────────────────────────────────────────────

export function report_text(report: RefreshReport): string {
  const said = `${report.joined} joined, ${report.left} left.`;
  return report.problems.length ? `${said} ${report.problems.join(" ")}` : said;
}

function FollowDialog({ context_id, context_name, followed, on_close }: { context_id: string; context_name: string; followed: { collector: string; feed_id: string }[]; on_close: () => void }) {
  const [choice, set_choice] = useState<{ collector: CollectorSummary; picked: Map<string, Feed> } | null>(null);
  const [busy, set_busy] = useState(false);
  const follow = async () => {
    if (!choice) return;
    set_busy(true);
    for (const feed of choice.picked.values()) {
      const report = await attempt(() => calls().follow_feed(context_id, choice.collector.id, feed.id, feed.label));
      if (report) toast(`${feed.label}: ${report_text(report)}`, { tone: report.problems.length ? "bad" : "good" });
    }
    on_close();
  };
  return (
    <Dialog
      title="Follow"
      subtitle={`${context_name} gathers what each one holds, now and as it changes.`}
      on_close={on_close}
      wide
      form={{
        submit_label: busy ? "Following…" : "Follow",
        submit_disabled: busy || !choice || choice.picked.size === 0,
        on_submit: (event) => {
          event.preventDefault();
          void follow();
        },
      }}
      buttons={<button type="button" onClick={on_close}>Cancel</button>}
    >
      <FeedPicker
        followed_by_collector={(collector) => new Set(followed.filter((feed) => feed.collector === collector).map((feed) => feed.feed_id))}
        on_ready={(collector, picked) => set_choice({ collector, picked })}
      />
    </Dialog>
  );
}

export function follow_dialog(context_id: string, context_name: string, followed: { collector: string; feed_id: string }[]): void {
  open_dialog((close) => <FollowDialog context_id={context_id} context_name={context_name} followed={followed} on_close={close} />);
}

// ── Contexts from feeds ──────────────────────────────────────────────────────

function SeedDialog({ on_close }: { on_close: () => void }) {
  const [tab, set_tab] = useState("");
  const way = tab === groups_tab ? "group" : "feeds";
  const [choice, set_choice] = useState<{ collector: CollectorSummary; picked: Map<string, Feed> } | null>(null);
  const [group, set_group] = useState<{ collector: string; group: FeedGroup } | null>(null);
  const [busy, set_busy] = useState(false);
  const make_from_group = async () => {
    if (!group) return;
    set_busy(true);
    const id = await attempt(() => calls().add_contexts_from_feed_group(group.collector, group.group.id, null));
    if (id) {
      toast(`Made ${group.group.label} with a context for each in it.`, { tone: "good" });
      window.location.hash = context_href(id).slice(1);
      on_close();
    } else set_busy(false);
  };
  const make = async () => {
    if (way === "group") return make_from_group();
    if (!choice) return;
    set_busy(true);
    const feeds = [...choice.picked.values()].map((feed) => ({ id: feed.id, label: feed.label }));
    const ids = await attempt(() => calls().add_contexts_from_feeds(choice.collector.id, feeds, null));
    if (ids) {
      toast(`Made ${ids.length} ${ids.length === 1 ? "context" : "contexts"}.`, { tone: "good" });
      if (ids.length === 1) window.location.hash = context_href(ids[0]!).slice(1);
      on_close();
    } else set_busy(false);
  };
  return (
    <Dialog
      title="Contexts from another app"
      subtitle={way === "feeds" ? "Each one ticked becomes a context that follows it." : "The group becomes a context, with a context inside it following each of its tags."}
      on_close={on_close}
      wide
      form={{
        submit_label: busy ? "Making…" : "Make contexts",
        submit_disabled: busy || (way === "feeds" ? !choice || choice.picked.size === 0 : !group),
        on_submit: (event) => {
          event.preventDefault();
          void make();
        },
      }}
      buttons={<button type="button" onClick={on_close}>Cancel</button>}
    >
      <FeedPicker followed_by_collector={() => new Set()} on_ready={(collector, picked) => set_choice({ collector, picked })} on_group={set_group} on_tab={set_tab} />
    </Dialog>
  );
}

export function seed_dialog(): void {
  open_dialog((close) => <SeedDialog on_close={close} />);
}
