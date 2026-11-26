// The Graph page: the whole graph, with a search box that finds and centres a node, opened on a node when a link
// count asked for one, such as "#/graph/item:x-tasks:t1".

// ── Imports ──────────────────────────────────────────────────────────────────

import { PageHeading } from "@x-tech-laboratories/x-libs/web/react/layout";

import { GraphPanel } from "./GraphPanel.tsx";

// ── Page ─────────────────────────────────────────────────────────────────────

export function graph_href(node_key: string): string {
  return `#/graph/${encodeURIComponent(node_key)}`;
}

export function GraphPage({ focus = null }: { focus?: string | null }) {
  return (
    <>
      <PageHeading title="Graph" subtitle="Everything CODEX holds, the people, places and topics in it, and how they link" />
      <GraphPanel context_id={null} focus={focus} with_search label="The whole graph" />
    </>
  );
}
