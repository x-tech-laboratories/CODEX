// The Blueprints page: what waits for the user, the blueprints that apply everywhere, and those that apply in a
// context, each opening in the workspace.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Chip, Chips } from "@x-tech-laboratories/x-libs/web/react/badges";
import { AddIcon, Icon } from "@x-tech-laboratories/x-libs/web/react/icons";
import { PageHeading, Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded } from "@x-tech-laboratories/x-libs/web/react/states";
import { ScrollText } from "lucide-react";

import { blueprint_route, type BlueprintSummary } from "../../shared/blueprints/model.ts";
import { global_context_id } from "../../shared/contexts/model.ts";
import { use_data } from "../api.ts";
import { context_href } from "../contexts/actions.tsx";
import { new_blueprint, StatusBadge } from "./BlueprintView.tsx";
import { BlueprintProposalCard } from "./ProposalCard.tsx";

// ── Rows ─────────────────────────────────────────────────────────────────────

function BlueprintRow({ blueprint }: { blueprint: BlueprintSummary }) {
  return (
    <li className="item-row">
      <Icon icon={ScrollText} />
      <div className="item-text">
        <div className="item-title">
          <a href={blueprint_route(blueprint.id)}>{blueprint.title}</a>
          {blueprint.status !== "active" && <StatusBadge status={blueprint.status} />}
          {blueprint.waiting_changes > 0 && <span className="badge tone-warn">{blueprint.waiting_changes} proposed {blueprint.waiting_changes === 1 ? "change" : "changes"}</span>}
        </div>
        <span className="muted item-snippet">{blueprint.applies_when}</span>
        <span className="muted small">{blueprint.use_count === 0 ? "Not used yet" : `Used ${blueprint.use_count} ${blueprint.use_count === 1 ? "time" : "times"}`}</span>
        {blueprint.contexts.length > 0 && (
          <Chips inline>
            {blueprint.contexts.map((context) => (
              <Chip key={context.id} on_click={() => (window.location.hash = context_href(context.id).slice(1))}>
                {context.name}
              </Chip>
            ))}
          </Chips>
        )}
      </div>
    </li>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function BlueprintsPage() {
  const data = use_data(async (api) => ({ all: await api.list_blueprints(), proposals: await api.list_blueprint_proposals() }));
  return (
    <>
      <PageHeading
        title="Blueprints"
        icon={<Icon icon={ScrollText} />}
        subtitle="Workflows you taught the assistant: when each applies, its rules and its steps in order."
        actions={
          <button type="button" className="accent solid" onClick={() => new_blueprint(null)}>
            <Icon icon={AddIcon} /> New blueprint
          </button>
        }
      />
      <Loaded resource={data}>
        {({ all, proposals }) => {
          const kept = all.filter((each) => each.status !== "proposed");
          const applies_everywhere = (each: (typeof kept)[number]) => each.contexts.length === 0 || each.contexts.every((place) => place.id === global_context_id);
          const global = kept.filter(applies_everywhere);
          const placed = kept.filter((each) => !applies_everywhere(each));
          return (
            <>
              {proposals.length > 0 && (
                <Section title={`Waiting for you · ${proposals.length}`}>
                  {proposals.map((proposal) => (
                    <BlueprintProposalCard key={proposal.id} proposal={proposal} />
                  ))}
                </Section>
              )}
              <Section title={`Everywhere · ${global.length}`}>
                {global.length === 0 ? (
                  <Empty title="None applies everywhere" hint="Write one here, ask the assistant to save a conversation as one from its pane, or move one from a context on its page." />
                ) : (
                  <ul className="item-list">
                    {global.map((blueprint) => (
                      <BlueprintRow key={blueprint.id} blueprint={blueprint} />
                    ))}
                  </ul>
                )}
              </Section>
              {placed.length > 0 && (
                <Section title={`In contexts · ${placed.length}`}>
                  <ul className="item-list">
                    {placed.map((blueprint) => (
                      <BlueprintRow key={blueprint.id} blueprint={blueprint} />
                    ))}
                  </ul>
                </Section>
              )}
            </>
          );
        }}
      </Loaded>
    </>
  );
}
