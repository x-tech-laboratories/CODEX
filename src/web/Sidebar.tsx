// The sidebar: Contexts, the Inbox, Graph, Blueprints, Jobs and History on top, the tree of contexts below them, and Sync above the Shell's own foot.

// ── Imports ──────────────────────────────────────────────────────────────────

import { HistoryIcon, HomeIcon } from "@x-tech-laboratories/x-libs/web/react/icons";
import { CalendarClock, Inbox, ScrollText, Waypoints } from "lucide-react";
import type { ShellView } from "@x-tech-laboratories/x-libs/web/react/shell";
import { SyncButton } from "@x-tech-laboratories/x-libs/web/react/sync_settings";

import { data_watch, page } from "./api.ts";

// ── Views ────────────────────────────────────────────────────────────────────

// The views, the Inbox's label carrying how many things wait in it.
export function sidebar_views(waiting: number): ShellView[] {
  return [
    { id: "overview", label: "Contexts", href: "#/overview", icon: HomeIcon },
    { id: "inbox", label: waiting > 0 ? `Inbox · ${waiting}` : "Inbox", href: "#/inbox", icon: Inbox },
  { id: "graph", label: "Graph", href: "#/graph", icon: Waypoints },
    { id: "blueprints", label: "Blueprints", href: "#/blueprints", icon: ScrollText },
    { id: "jobs", label: "Jobs", href: "#/jobs", icon: CalendarClock },
    { id: "history", label: "History", href: "#/history", icon: HistoryIcon },
  ];
}

// Sync on a device that syncs, and Users for an admin signed in on the server, above the Shell's own theme, account and Settings rows.
export function SidebarFoot({ section, show_users = false }: { section: string; show_users?: boolean }) {
  const { device } = page();
  const row = (id: string, label: string) => (
    <a href={`#/${id}`} className={section === id ? "tree-row active" : "tree-row"} aria-current={section === id ? "page" : undefined}>
      <span className="tree-label">{label}</span>
    </a>
  );
  return (
    <>
      {device && <SyncButton device={device} subscribe={data_watch.subscribe} on_open_settings={() => (window.location.hash = "/settings")} />}
      {show_users && row("users", "Users")}
    </>
  );
}
