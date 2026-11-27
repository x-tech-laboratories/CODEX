// The sidebar's tree of contexts: open one by clicking it, drag one into or beside another, and right-click for the rest.

// ── Imports ──────────────────────────────────────────────────────────────────

import { open_context_menu } from "@x-tech-laboratories/x-libs/web/react/menus";
import { use_pref } from "@x-tech-laboratories/x-libs/web/react/prefs";
import { Tree } from "@x-tech-laboratories/x-libs/web/react/tree";

import { global_context_id } from "../../shared/contexts/model.ts";
import type { ContextSummary } from "../../shared/contexts/model.ts";
import { calls, succeeds, use_data } from "../api.ts";
import { context_href, context_menu, new_context } from "./actions.tsx";

// ── Tree ─────────────────────────────────────────────────────────────────────

const collapsed_pref = "codex-contexts-collapsed";

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
      {contexts.status === "loaded" && list.length <= 1 && <p className="muted context-tree-empty">Global holds everything. Make a context inside it for each project or area you keep things for.</p>}
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
        // Global stays the root: it is never dragged, and nothing goes beside it.
        can_drop={(dragged, target, placement) => dragged.id !== global_context_id && (target.id !== global_context_id || placement === "inside")}
        on_move={(context, move) => void succeeds(() => calls().move_context(context.id, move.parent_id, move.position))}
        on_context_menu={(event, context) => open_context_menu(event, context_menu(context))}
      />
    </nav>
  );
}
