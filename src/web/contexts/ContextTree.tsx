// The sidebar's tree of contexts: open one by clicking it, drag one into or beside another, and right-click for the rest.

// ── Imports ──────────────────────────────────────────────────────────────────

import { open_context_menu } from "@x-tech-laboratories/x-libs/web/react/menus";
import { use_pref } from "@x-tech-laboratories/x-libs/web/react/prefs";
import { Tree } from "@x-tech-laboratories/x-libs/web/react/tree";

import type { ContextSummary } from "../../shared/contexts/model.ts";
import { calls, succeeds, use_data } from "../api.ts";
import { context_href, context_menu, new_context } from "./actions.tsx";

// ── Tree ─────────────────────────────────────────────────────────────────────

const collapsed_pref = "x-context-contexts-collapsed";

function is_text_list(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function ContextTree({ active_id }: { active_id: string | null }) {
  const contexts = use_data((api) => api.list_contexts(false));
  const [collapsed, set_collapsed] = use_pref<string[]>(collapsed_pref, [], is_text_list);
  const list = (contexts.status === "loaded" ? contexts.data : null) ?? [];

  return (
    <nav className="context-tree" aria-label="Contexts">
      <div className="context-tree-head">
        <span className="field-label">Contexts</span>
        <span className="row-actions">
          <button type="button" onClick={() => new_context(null)}>
            New
          </button>
        </span>
      </div>
      {contexts.status === "loaded" && list.length === 0 && <p className="muted context-tree-empty">No contexts yet. Make one for each project or area you keep things for.</p>}
      <Tree<ContextSummary>
        items={list}
        label="Contexts"
        render_item={(context) => context.name}
        render_extra={(context) => (context.item_count > 0 ? <span className="muted">{context.item_count}</span> : null)}
        name_of={(context) => context.name}
        collapsed={new Set(collapsed)}
        on_collapsed_change={(next) => set_collapsed([...next])}
        selected_id={active_id}
        on_select={(context) => (window.location.hash = context_href(context.id).slice(1))}
        allow_inside
        on_move={(context, move) => void succeeds(() => calls().move_context(context.id, move.parent_id, move.position))}
        on_context_menu={(event, context) => open_context_menu(event, context_menu(context))}
      />
    </nav>
  );
}
