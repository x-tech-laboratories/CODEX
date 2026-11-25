// Blueprints: fixed step lists for known request shapes, written by the model in a small typed language and checked in code.
import { prompt } from './prompts.js';
import { runStage, type ChatModel } from './model.js';

// ============================================================================
// The language
// ============================================================================

export const CODE_KINDS = ['list', 'filter', 'sort', 'select', 'intersect', 'batch', 'check', 'notify'] as const;
export const MODEL_KINDS = ['classify', 'extract', 'lookup', 'write'] as const;
export const STOP_KINDS = ['ask_user', 'act'] as const;
export const STEP_KINDS = [...CODE_KINDS, ...MODEL_KINDS, ...STOP_KINDS] as const;
export type StepKind = (typeof STEP_KINDS)[number];

// Kinds whose result is a list of items, so a later step can run once per item of it.
export const LIST_KINDS: readonly StepKind[] = ['list', 'filter', 'sort', 'select', 'intersect', 'batch'];

// Kinds that may run once per item; the other code steps always take whole lists.
export const PER_ITEM_KINDS: readonly StepKind[] = ['list', ...MODEL_KINDS, 'ask_user', 'act'];

export const FILTER_OPERATORS = ['equals', 'not_equals', 'contains', 'before', 'after', 'at_least', 'at_most'] as const;
export const SORT_ORDERS = ['ascending', 'descending'] as const;
export const CHECK_RULES = ['every_item_once', 'not_empty'] as const;

export const MAX_STEPS = 16;
export const MAX_LABELS = 12;
export const MAX_WORDS_LIMIT = 400;
const SHORT_TEXT = 200;

// What the harness can reach: the sources code lists from and the agents a step may call.
export type Catalogue = { sources: string[]; agents: string[] };

export const DEFAULT_CATALOGUE: Catalogue = {
    sources: ['files', 'mail', 'calendar', 'contacts', 'notes', 'todos'],
    agents: ['files', 'mail', 'calendar', 'contacts', 'notes', 'todos'],
};

export type Step = {
    id: string;
    kind: StepKind;
    inputs: string[];
    each: string;
    [field: string]: unknown;
};

export type Blueprint = {
    name: string;
    request_shape: string;
    inputs: string[];
    steps: Step[];
    output: string;
};

// ============================================================================
// Schema
// ============================================================================

const text = (maxLength = SHORT_TEXT) => ({ type: 'string', minLength: 1, maxLength });
const choice = (values: readonly string[]) => ({ type: 'string', enum: [...values] });
const names = { type: 'array', items: text(60) };

// The fields each kind carries beside id, kind, inputs and each, in the order the model writes them.
export function kindFields(catalogue: Catalogue): Record<StepKind, Record<string, unknown>> {
    return {
        list: { source: choice(catalogue.sources), query: text() },
        filter: { field: text(60), operator: choice(FILTER_OPERATORS), value: text(100) },
        sort: { field: text(60), order: choice(SORT_ORDERS) },
        select: { count: { type: 'integer' } },
        intersect: { field: text(60) },
        batch: { size: { type: 'integer' } },
        check: { rule: choice(CHECK_RULES) },
        notify: { message: text() },
        classify: { question: text(), labels: { type: 'array', items: text(60), minItems: 2, maxItems: MAX_LABELS } },
        extract: { fields: { type: 'array', items: text(60), minItems: 1, maxItems: 8 } },
        lookup: { agent: choice(catalogue.agents), find: text() },
        write: { instruction: text(400), max_words: { type: 'integer' } },
        ask_user: { question: text() },
        act: { agent: choice(catalogue.agents), action: text() },
    };
}

// The JSON schema a draft is forced into by grammar: one variant per step kind, so a step carries exactly its kind's fields.
export function blueprintSchema(catalogue: Catalogue = DEFAULT_CATALOGUE): Record<string, unknown> {
    const fields = kindFields(catalogue);
    const variants = STEP_KINDS.map((kind) => ({
        type: 'object',
        properties: {
            id: text(40),
            kind: { const: kind },
            ...fields[kind],
            inputs: names,
            each: { type: 'string', maxLength: 40 },
        },
        additionalProperties: false,
    }));
    return {
        type: 'object',
        properties: {
            name: text(80),
            request_shape: text(),
            inputs: names,
            // The grammar builder reads oneOf only; anyOf would leave the steps unconstrained.
            steps: { type: 'array', items: { oneOf: variants }, minItems: 1, maxItems: MAX_STEPS },
            output: text(40),
        },
        additionalProperties: false,
    };
}

// ============================================================================
// Validation
// ============================================================================

// Every step this one depends on, through its inputs and its each, however far back.
function ancestors(step: Step, byId: Map<string, Step>): Set<string> {
    const seen = new Set<string>();
    const pending = [...step.inputs, ...(step.each ? [step.each] : [])];
    while (pending.length > 0) {
        const id = pending.pop()!;
        const earlier = byId.get(id);
        if (seen.has(id) || earlier === undefined) {
            continue;
        }
        seen.add(id);
        pending.push(...earlier.inputs, ...(earlier.each ? [earlier.each] : []));
    }
    return seen;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// Check a step's own fields against its kind, including what the grammar cannot express.
function fieldProblems(step: Step, catalogue: Catalogue): string[] {
    const problems: string[] = [];
    const at = `step "${step.id}"`;
    for (const field of Object.keys(kindFields(catalogue)[step.kind])) {
        if (!(field in step)) {
            problems.push(`${at} (${step.kind}) needs the field "${field}".`);
        }
    }
    if (step.kind === 'list' && !catalogue.sources.includes(step.source as string)) {
        problems.push(`${at} lists from "${String(step.source)}", which is not a source; use one of ${catalogue.sources.join(', ')}.`);
    }
    if ((step.kind === 'lookup' || step.kind === 'act') && !catalogue.agents.includes(step.agent as string)) {
        problems.push(`${at} calls the agent "${String(step.agent)}", which does not exist; use one of ${catalogue.agents.join(', ')}.`);
    }
    if (step.kind === 'classify') {
        const labels = isStringList(step.labels) ? step.labels : [];
        if (new Set(labels).size < 2) {
            problems.push(`${at} classifies into fewer than two different labels.`);
        }
    }
    const amount = step.kind === 'select' ? step.count : step.kind === 'batch' ? step.size : 1;
    if (!(Number.isInteger(amount) && Number(amount) >= 1)) {
        problems.push(`${at} needs a whole number of at least 1.`);
    }
    if (step.kind === 'write' && !(Number.isInteger(step.max_words) && Number(step.max_words) >= 1 && Number(step.max_words) <= MAX_WORDS_LIMIT)) {
        problems.push(`${at} needs max_words between 1 and ${MAX_WORDS_LIMIT}.`);
    }
    if (step.kind === 'intersect' && step.inputs.length < 2) {
        problems.push(`${at} intersects ${step.inputs.length} list; it needs two or more inputs.`);
    }
    if (step.kind === 'check' && step.rule === 'every_item_once' && (step.inputs.length !== 2 || step.inputs[0] === step.inputs[1])) {
        problems.push(`${at} checks every_item_once, which needs exactly two different inputs: the items, then the result that must hold each once.`);
    }
    if (step.kind === 'check' && step.rule === 'not_empty' && step.inputs.length !== 1) {
        problems.push(`${at} checks not_empty, which needs exactly one input.`);
    }
    return problems;
}

// Everything wrong with a draft that code can see, each as one sentence the model can act on; empty means it passes.
export function validateBlueprint(draft: unknown, catalogue: Catalogue = DEFAULT_CATALOGUE): string[] {
    if (!isObject(draft)) {
        return ['The blueprint must be one JSON object.'];
    }
    const problems: string[] = [];
    const blueprintInputs = isStringList(draft.inputs) ? draft.inputs : [];
    if (!isStringList(draft.inputs)) {
        problems.push('"inputs" must be a list of names.');
    }
    if (!Array.isArray(draft.steps) || draft.steps.length === 0) {
        return [...problems, 'The blueprint needs at least one step.'];
    }
    if (draft.steps.length > MAX_STEPS) {
        problems.push(`The blueprint has ${draft.steps.length} steps; keep it to ${MAX_STEPS}.`);
    }

    const byId = new Map<string, Step>();
    const steps: Step[] = [];
    for (const [index, raw] of draft.steps.entries()) {
        if (!isObject(raw) || typeof raw.id !== 'string' || raw.id === '') {
            problems.push(`Step ${index + 1} needs a non-empty "id".`);
            continue;
        }
        if (!STEP_KINDS.includes(raw.kind as StepKind)) {
            problems.push(`step "${raw.id}" has the kind "${String(raw.kind)}", which does not exist; use one of ${STEP_KINDS.join(', ')}.`);
            continue;
        }
        if (byId.has(raw.id) || blueprintInputs.includes(raw.id)) {
            problems.push(`The id "${raw.id}" is used twice; give every step its own id.`);
            continue;
        }
        const step: Step = { ...raw, id: raw.id, kind: raw.kind as StepKind, inputs: isStringList(raw.inputs) ? raw.inputs : [], each: typeof raw.each === 'string' ? raw.each : '' };
        if (!isStringList(raw.inputs)) {
            problems.push(`step "${step.id}" needs "inputs" as a list of ids.`);
        }

        for (const input of step.inputs) {
            if (!byId.has(input) && !blueprintInputs.includes(input)) {
                problems.push(`step "${step.id}" uses "${input}", which is neither an earlier step nor a blueprint input.`);
            }
        }
        if (step.each !== '' && !PER_ITEM_KINDS.includes(step.kind)) {
            problems.push(`step "${step.id}" is a ${step.kind} step, which works on whole lists; set its "each" to "" and give the list in its inputs.`);
        } else if (step.each !== '') {
            const over = byId.get(step.each);
            if (over === undefined) {
                problems.push(`step "${step.id}" runs for each item of "${step.each}", which is not an earlier step.`);
            } else if (!LIST_KINDS.includes(over.kind) && over.each === '') {
                problems.push(`step "${step.id}" runs for each item of "${step.each}", a ${over.kind} step that gives no list.`);
            }
        }
        if (step.kind !== 'list' && step.kind !== 'ask_user' && step.kind !== 'notify' && step.inputs.length === 0 && step.each === '') {
            problems.push(`step "${step.id}" (${step.kind}) has no inputs, so it has nothing to work on.`);
        }
        problems.push(...fieldProblems(step, catalogue));

        byId.set(step.id, step);
        steps.push(step);
    }

    for (const step of steps.filter((candidate) => candidate.kind === 'act')) {
        if (![...ancestors(step, byId)].some((id) => byId.get(id)?.kind === 'ask_user')) {
            problems.push(`step "${step.id}" changes the world with no ask_user step before it; add one to its inputs so the user approves first.`);
        }
    }

    const used = new Set(steps.flatMap((step) => [...step.inputs, step.each]));
    const output = typeof draft.output === 'string' ? draft.output : '';
    if (!byId.has(output)) {
        problems.push(`"output" is "${output}", which is not a step id; name the step whose result is the reply.`);
    }
    for (const step of steps) {
        if (step.id !== output && !used.has(step.id) && step.kind !== 'check' && step.kind !== 'notify' && step.kind !== 'act') {
            problems.push(`The result of step "${step.id}" is never used; feed it into a later step or remove the step.`);
        }
    }
    for (const input of blueprintInputs) {
        if (!used.has(input)) {
            problems.push(`The blueprint input "${input}" is never used.`);
        }
    }
    const runsPerItem = steps.some((step) => step.each !== '' && (MODEL_KINDS as readonly string[]).includes(step.kind));
    if (runsPerItem && !steps.some((step) => step.kind === 'check')) {
        problems.push('A model step runs per item but no check step follows; add a check, such as every_item_once on the items and the result.');
    }
    return problems;
}

// ============================================================================
// Drafting
// ============================================================================

export const BLUEPRINT_MAX_TOKENS = 3072;

export type BlueprintDraft = {
    request: string;
    first: unknown;
    firstProblems: string[];
    final: unknown;
    problems: string[];
    repaired: boolean;
};

function parseDraft(reply: string): unknown {
    try {
        return JSON.parse(reply);
    } catch {
        return reply;
    }
}

export function draftInput(request: string): string {
    return `Write the blueprint for this request shape: ${JSON.stringify(request)}`;
}

export function repairInput(request: string, draft: unknown, problems: string[]): string {
    const previous = typeof draft === 'string' ? draft : JSON.stringify(draft);
    const note = prompt('blueprint-repair', { PROBLEMS: problems.map((problem) => `- ${problem}`).join('\n') });
    return `${draftInput(request)}\n\nYour blueprint:\n${previous}\n\n${note}`;
}

// Draft a blueprint under the schema's grammar, check it in code, and give the model one turn to fix what the check found.
export async function draftBlueprint(
    llm: ChatModel,
    request: string,
    catalogue: Catalogue = DEFAULT_CATALOGUE,
    options: { signal?: AbortSignal; useGrammar?: boolean } = {},
): Promise<BlueprintDraft> {
    const system = prompt('blueprint');
    const stage = { maxTokens: BLUEPRINT_MAX_TOKENS, jsonSchema: options.useGrammar === false ? null : blueprintSchema(catalogue), signal: options.signal };

    const first = parseDraft(await runStage(llm, system, draftInput(request), stage));
    const firstProblems = validateBlueprint(first, catalogue);
    if (firstProblems.length === 0) {
        return { request, first, firstProblems, final: first, problems: [], repaired: false };
    }

    const final = parseDraft(await runStage(llm, system, repairInput(request, first, firstProblems), stage));
    return { request, first, firstProblems, final, problems: validateBlueprint(final, catalogue), repaired: true };
}
