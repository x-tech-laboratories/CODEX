// The page: the sign-in in a browser, the shell around every section, and the router between them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Fragment, useEffect, useRef } from "react";
import { create_accounts_client, type Me } from "@x-tech-laboratories/x-libs/web/accounts";
import { AccountView, UsersView } from "@x-tech-laboratories/x-libs/web/react/accounts";
import { SyncCertificatePrompt } from "@x-tech-laboratories/x-libs/web/react/certificates";
import { Shell, use_route, use_side_pane } from "@x-tech-laboratories/x-libs/web/react/shell";
import { Bot } from "lucide-react";
import { SignInForm, use_account } from "@x-tech-laboratories/x-libs/web/react/sign_in";
import { theme_choice } from "@x-tech-laboratories/x-libs/web/theme";
import { use_watch } from "@x-tech-laboratories/x-libs/web/react/watch";

import { attempt, calls, data_watch, page, use_data } from "./api.ts";
import { AssistantPane } from "./assistant/AssistantPane.tsx";
import { BlueprintsPage } from "./blueprints/BlueprintsPage.tsx";
import { BlueprintView } from "./blueprints/BlueprintView.tsx";
import { open_conversation, wanted_watch } from "./assistant/selection.ts";
import { ContextTree } from "./contexts/ContextTree.tsx";
import { ContextView } from "./contexts/ContextView.tsx";
import { HomeView } from "./contexts/HomeView.tsx";
import { GraphPage } from "./graph/GraphPage.tsx";
import { HistoryView } from "./history/HistoryView.tsx";
import { InboxPage } from "./inbox/InboxPage.tsx";
import { JobsPage } from "./jobs/JobsPage.tsx";
import { SettingsView } from "./settings/SettingsView.tsx";
import { sidebar_views, SidebarFoot } from "./Sidebar.tsx";

// ── Sections ─────────────────────────────────────────────────────────────────

const theme = theme_choice("codex-theme");
const brand_icon = "icon.svg";

// Relative, so a server behind a proxy under a folder keeps it.
const accounts = create_accounts_client({ base: "api" });

// Sections outside the features, the account pages only for someone signed in on the server.
const own_sections = ["settings", "account", "users"];

// ── App ──────────────────────────────────────────────────────────────────────

// A browser signs in to the server; the desktop and phone apps keep their own data and sign in only to sync.
// A device that syncs asks to trust its server's certificate whenever sync fails over it.
function DeviceApp() {
  const { certificates, device } = page();
  return <>
    {device && certificates && <SyncCertificatePrompt device={device} certificates={certificates} subscribe={data_watch.subscribe} />}
    <Pages me={null} />
  </>;
}

export function App() {
  return page().host === "web" ? <SignedInApp /> : <DeviceApp />;
}

function SignedInApp() {
  const { account, refresh, sign_out } = use_account(accounts);
  if (account.state === "checking") return null;
  if (account.state === "signed_out") {
    return (
      <Shell brand="CODEX" brand_icon={brand_icon} theme={theme} user={null}>
        <SignInForm client={accounts} title="CODEX" icon={brand_icon} on_signed_in={refresh} />
      </Shell>
    );
  }
  return <Pages me={account.me} on_sign_out={() => void sign_out()} />;
}

function Pages({ me, on_sign_out }: { me: Me | null; on_sign_out?: () => void }) {
  const route = use_route();
  const [named_section = "overview", ...rest] = route.parts;
  const is_own = named_section === "settings" || named_section === "history" || named_section === "graph" || named_section === "context" || named_section === "blueprints" || named_section === "blueprint" || named_section === "inbox" || named_section === "jobs" || (me !== null && own_sections.includes(named_section));
  const section = is_own ? named_section : "overview";
  const context_id = section === "context" ? (rest[0] ?? null) : null;
  const own_labels: Record<string, string> = { settings: "Settings", history: "History", graph: "Graph", blueprints: "Blueprints", blueprint: "Blueprint", inbox: "Inbox", jobs: "Jobs", account: "Your account", users: "Users", context: "Context" };
  const label = own_labels[section] ?? "Contexts";
  const view_key = route.parts.join("/");
  const is_admin = me !== null && me.role === me.roles.at(-1);
  const [assistant_open, set_assistant_open] = use_side_pane("codex-assistant-open", true);
  const asked = use_watch(wanted_watch);
  const waiting = use_data((api) => api.get_inbox_count());
  // The context last open, so a conversation it holds opens there.
  const last_context = useRef<string | null>(null);
  if (context_id) last_context.current = context_id;

  useEffect(() => {
    document.title = `${label} · CODEX`;
  }, [label]);

  // A conversation asked for opens the pane.
  useEffect(() => {
    if (asked > 0) set_assistant_open(true);
  }, [asked]);

  // A codex://conversation/<id> link, from another program or a message, shows that conversation in the pane.
  useEffect(() => {
    if (named_section !== "conversation" || !rest[0]) return;
    const id = decodeURIComponent(rest[0]);
    void attempt(() => calls().get_conversation(id)).then((found) => {
      if (found) open_conversation(id, found.contexts.map((each) => each.id), last_context.current);
      else window.location.replace(last_context.current ? `#/context/${last_context.current}` : "#/overview");
    });
  }, [view_key]);

  const view = () => {
    if (context_id) return <ContextView id={context_id} />;
    if (me && section === "account") return <AccountView client={accounts} />;
    if (me && section === "users") return <UsersView client={accounts} me={me} />;
    if (section === "history") return <HistoryView />;
    if (section === "blueprints") return <BlueprintsPage />;
    if (section === "inbox") return <InboxPage />;
    if (section === "jobs") return <JobsPage focus={rest[0] ? decodeURIComponent(rest[0]) : null} />;
    if (section === "blueprint" && rest[0]) return <BlueprintView id={decodeURIComponent(rest[0])} />;
    if (section === "graph") return <GraphPage focus={rest[0] ? decodeURIComponent(rest[0]) : null} />;
    return section === "settings" ? <SettingsView /> : <HomeView />;
  };

  return (
    <Shell
      brand="CODEX"
      brand_icon={brand_icon}
      views={sidebar_views(waiting.data ?? 0)}
      active={section === "blueprint" ? "blueprints" : section}
      sidebar={<ContextTree active_id={context_id} />}
      sidebar_foot={<SidebarFoot section={section} show_users={is_admin} />}
      theme={theme}
      view_key={view_key}
      user={me?.name}
      user_href="#/account"
      on_logout={on_sign_out}
      settings={{ href: "#/settings", active: section === "settings" }}
      tools={
        <button type="button" className="icon" aria-pressed={assistant_open} aria-label="Assistant" title="Assistant" onClick={() => set_assistant_open(!assistant_open)}>
          <Bot size={18} />
        </button>
      }
      side_pane={{
        title: "Assistant",
        open: assistant_open,
        on_open_change: set_assistant_open,
        width: { default_width: 380, min: 300, max: 720, storage_key: "codex-assistant-width" },
        content: <AssistantPane context_id={context_id} />,
      }}
    >
      <Fragment key={view_key}>{view()}</Fragment>
    </Shell>
  );
}
