// The page: the sign-in in a browser, the shell around every section, and the router between them.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Fragment, useEffect } from "react";
import { create_accounts_client, type Me } from "@x-tech-laboratories/x-libs/web/accounts";
import { AccountView, UsersView } from "@x-tech-laboratories/x-libs/web/react/accounts";
import { SyncCertificatePrompt } from "@x-tech-laboratories/x-libs/web/react/certificates";
import { Shell, use_route } from "@x-tech-laboratories/x-libs/web/react/shell";
import { SignInForm, use_account } from "@x-tech-laboratories/x-libs/web/react/sign_in";
import { theme_choice } from "@x-tech-laboratories/x-libs/web/theme";

import { data_watch, page } from "./api.ts";
import { ContextTree } from "./contexts/ContextTree.tsx";
import { ContextView } from "./contexts/ContextView.tsx";
import { HomeView } from "./contexts/HomeView.tsx";
import { HistoryView } from "./history/HistoryView.tsx";
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
  const is_own = named_section === "settings" || named_section === "history" || named_section === "context" || (me !== null && own_sections.includes(named_section));
  const section = is_own ? named_section : "overview";
  const context_id = section === "context" ? (rest[0] ?? null) : null;
  const own_labels: Record<string, string> = { settings: "Settings", history: "History", account: "Your account", users: "Users", context: "Context" };
  const label = own_labels[section] ?? "Contexts";
  const view_key = route.parts.join("/");
  const is_admin = me !== null && me.role === me.roles.at(-1);

  useEffect(() => {
    document.title = `${label} · CODEX`;
  }, [label]);

  const view = () => {
    if (context_id) return <ContextView id={context_id} />;
    if (me && section === "account") return <AccountView client={accounts} />;
    if (me && section === "users") return <UsersView client={accounts} me={me} />;
    if (section === "history") return <HistoryView />;
    return section === "settings" ? <SettingsView /> : <HomeView />;
  };

  return (
    <Shell
      brand="CODEX"
      brand_icon={brand_icon}
      views={sidebar_views}
      active={section}
      sidebar={<ContextTree active_id={context_id} />}
      sidebar_foot={<SidebarFoot section={section} show_users={is_admin} />}
      theme={theme}
      view_key={view_key}
      user={me?.name}
      user_href="#/account"
      on_logout={on_sign_out}
      settings={{ href: "#/settings", active: section === "settings" }}
    >
      <Fragment key={view_key}>{view()}</Fragment>
    </Shell>
  );
}
