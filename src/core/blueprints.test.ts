import { describe, expect, it } from 'vitest';

import { STEP_KINDS, blueprintSchema, draftBlueprint, repairInput, validateBlueprint, type Blueprint } from './blueprints.js';
import { grammarSchema, type ChatCompletionRequest, type ChatModel } from './model.js';

// ============================================================================
// Fixtures
// ============================================================================

function folderBlueprint(): Blueprint {
    return {
        name: 'sort folder',
        request_shape: 'sort every file under a folder into categories',
        inputs: ['folder'],
        steps: [
            { id: 'files', kind: 'list', source: 'files', query: 'every file under the folder', inputs: ['folder'], each: '' },
            { id: 'label', kind: 'classify', question: 'Which category is this file?', labels: ['invoice', 'contract', 'other'], inputs: [], each: 'files' },
            { id: 'covered', kind: 'check', rule: 'every_item_once', inputs: ['files', 'label'], each: '' },
            { id: 'report', kind: 'write', instruction: 'List each file under its category.', max_words: 300, inputs: ['label'], each: '' },
        ],
        output: 'report',
    };
}

function withSteps(changes: (blueprint: Blueprint) => void): Blueprint {
    const blueprint = folderBlueprint();
    changes(blueprint);
    return blueprint;
}

function scriptedModel(replies: string[]): ChatModel & { requests: ChatCompletionRequest[] } {
    const requests: ChatCompletionRequest[] = [];
    return {
        requests,
        async createChatCompletion(request) {
            requests.push(request);
            return { content: replies[requests.length - 1], tool_calls: [], finish_reason: 'stop' };
        },
    };
}

// ============================================================================
// Schema
// ============================================================================

describe('blueprint schema', () => {
    it('has one step variant per kind, each fixing its kind', () => {
        const steps = (blueprintSchema().properties as Record<string, { items: { oneOf: Array<{ properties: { kind: { const: string } } }> } }>).steps;

        expect(steps.items.oneOf.map((variant) => variant.properties.kind.const)).toEqual([...STEP_KINDS]);
    });

    it('names only the catalogue agents and sources', () => {
        const json = JSON.stringify(blueprintSchema({ sources: ['mail'], agents: ['calendar'] }));

        expect(json).toContain('"enum":["mail"]');
        expect(json).toContain('"enum":["calendar"]');
        expect(json).not.toContain('"todos"');
    });

    it('keeps every step field when turned into a grammar', () => {
        const grammar = JSON.stringify(grammarSchema(blueprintSchema()));

        for (const field of ['source', 'operator', 'labels', 'max_words', 'rule', 'each']) {
            expect(grammar).toContain(`"${field}"`);
        }
    });
});

// ============================================================================
// Validation
// ============================================================================

describe('validateBlueprint', () => {
    it('passes a well-formed blueprint', () => {
        expect(validateBlueprint(folderBlueprint())).toEqual([]);
    });

    it('refuses what is not a blueprint object or has no steps', () => {
        expect(validateBlueprint('{"broken"')).toEqual(['The blueprint must be one JSON object.']);
        expect(validateBlueprint({ inputs: [], steps: [] })).toContain('The blueprint needs at least one step.');
        expect(validateBlueprint({ inputs: 'x', steps: [] })).toContain('"inputs" must be a list of names.');
    });

    it('refuses too many steps, steps without an id and inputs that are not a list', () => {
        const tooMany = withSteps((blueprint) => {
            for (let index = 0; index < 16; index++) {
                blueprint.steps.push({ id: `note${index}`, kind: 'notify', message: 'x', inputs: ['report'], each: '' });
            }
        });
        const malformed = withSteps((blueprint) => {
            blueprint.steps.push(null as never, { id: 'loose', kind: 'notify', message: 'x', inputs: 'report' as never, each: '' });
        });

        expect(validateBlueprint(tooMany)).toContain('The blueprint has 20 steps; keep it to 16.');
        expect(validateBlueprint(malformed)).toContain('Step 5 needs a non-empty "id".');
        expect(validateBlueprint(malformed)).toContain('step "loose" needs "inputs" as a list of ids.');
    });

    it('refuses unknown kinds, sources and agents', () => {
        const problems = validateBlueprint(
            withSteps((blueprint) => {
                blueprint.steps[0].source = 'free_slots';
                blueprint.steps.splice(1, 0, { id: 'who', kind: 'lookup', agent: 'travel', find: 'x', inputs: ['files'], each: '' });
                blueprint.steps.push({ id: 'magic', kind: 'teleport' as never, inputs: [], each: '' });
            }),
        );

        expect(problems.join('\n')).toMatch(/"free_slots", which is not a source/);
        expect(problems.join('\n')).toMatch(/agent "travel", which does not exist/);
        expect(problems.join('\n')).toMatch(/kind "teleport", which does not exist/);
    });

    it('refuses inputs and each that point at nothing earlier', () => {
        const problems = validateBlueprint(
            withSteps((blueprint) => {
                blueprint.steps[1].each = 'report';
                blueprint.steps[3].inputs = ['label', 'later'];
            }),
        );

        expect(problems).toContain('step "label" runs for each item of "report", which is not an earlier step.');
        expect(problems).toContain('step "report" uses "later", which is neither an earlier step nor a blueprint input.');
    });

    it('refuses running per item of a step that gives no list', () => {
        const problems = validateBlueprint(
            withSteps((blueprint) => {
                blueprint.steps.splice(1, 0, { id: 'summary', kind: 'write', instruction: 'x', max_words: 10, inputs: ['files'], each: '' });
                blueprint.steps[2].each = 'summary';
            }),
        );

        expect(problems).toContain('step "label" runs for each item of "summary", a write step that gives no list.');
    });

    it('refuses repeated ids, missing fields and bad numbers', () => {
        const problems = validateBlueprint(
            withSteps((blueprint) => {
                blueprint.steps.push({ id: 'files', kind: 'notify', message: 'x', inputs: [], each: '' });
                delete blueprint.steps[1].question;
                blueprint.steps[3].max_words = 0;
                blueprint.steps.push({ id: 'top', kind: 'select', count: 0, inputs: ['files'], each: '' });
            }),
        );

        expect(problems).toContain('The id "files" is used twice; give every step its own id.');
        expect(problems).toContain('step "label" (classify) needs the field "question".');
        expect(problems).toContain(`step "report" needs max_words between 1 and 400.`);
        expect(problems).toContain('step "top" needs a whole number of at least 1.');
    });

    it('refuses a classify with fewer than two labels and an intersect of one list', () => {
        const problems = validateBlueprint(
            withSteps((blueprint) => {
                blueprint.steps[1].labels = ['invoice', 'invoice'];
                blueprint.steps.push({ id: 'common', kind: 'intersect', field: 'start', inputs: ['files'], each: '' });
            }),
        );

        expect(problems).toContain('step "label" classifies into fewer than two different labels.');
        expect(problems).toContain('step "common" intersects 1 list; it needs two or more inputs.');
    });

    it('refuses running a whole-list code step per item, and a check of a step against itself', () => {
        const problems = validateBlueprint(
            withSteps((blueprint) => {
                blueprint.steps[2].each = 'files';
                blueprint.steps.push({ id: 'again', kind: 'check', rule: 'every_item_once', inputs: ['label', 'label'], each: '' });
            }),
        );

        expect(problems).toContain('step "covered" is a check step, which works on whole lists; set its "each" to "" and give the list in its inputs.');
        expect(problems.join('\n')).toMatch(/step "again" checks every_item_once, which needs exactly two different inputs/);
    });

    it('checks the number of inputs a check rule needs', () => {
        const problems = validateBlueprint(
            withSteps((blueprint) => {
                blueprint.steps[2].inputs = ['label'];
                blueprint.steps.push({ id: 'some', kind: 'check', rule: 'not_empty', inputs: ['files', 'label'], each: '' });
            }),
        );

        expect(problems.join('\n')).toMatch(/every_item_once, which needs exactly two different inputs/);
        expect(problems.join('\n')).toMatch(/not_empty, which needs exactly one input/);
    });

    it('needs an ask_user step before any act step', () => {
        const unapproved = withSteps((blueprint) => {
            blueprint.steps.push({ id: 'send', kind: 'act', agent: 'mail', action: 'send the report', inputs: ['report'], each: '' });
        });
        const approved = withSteps((blueprint) => {
            blueprint.steps.push({ id: 'ok', kind: 'ask_user', question: 'Send the report?', inputs: ['report'], each: '' });
            blueprint.steps.push({ id: 'send', kind: 'act', agent: 'mail', action: 'send the report', inputs: ['ok'], each: '' });
            blueprint.output = 'ok';
        });

        expect(validateBlueprint(unapproved).join('\n')).toMatch(/step "send" changes the world with no ask_user step/);
        expect(validateBlueprint(approved)).toEqual([]);
    });

    it('refuses unused results, unused inputs, a bad output and steps with nothing to work on', () => {
        const problems = validateBlueprint(
            withSteps((blueprint) => {
                blueprint.inputs.push('categories');
                blueprint.steps.push({ id: 'extra', kind: 'sort', field: 'name', order: 'ascending', inputs: [], each: '' });
                blueprint.output = 'nowhere';
            }),
        );

        expect(problems).toContain('The blueprint input "categories" is never used.');
        expect(problems).toContain('step "extra" (sort) has no inputs, so it has nothing to work on.');
        expect(problems).toContain('"output" is "nowhere", which is not a step id; name the step whose result is the reply.');
        expect(problems).toContain('The result of step "report" is never used; feed it into a later step or remove the step.');
    });

    it('needs a check when a model step runs per item', () => {
        const problems = validateBlueprint(
            withSteps((blueprint) => {
                blueprint.steps.splice(2, 1);
            }),
        );

        expect(problems.join('\n')).toMatch(/runs per item but no check step follows/);
    });
});

// ============================================================================
// Drafting
// ============================================================================

describe('draftBlueprint', () => {
    it('keeps a first draft that passes, asking under the schema grammar', async () => {
        const llm = scriptedModel([JSON.stringify(folderBlueprint())]);

        const draft = await draftBlueprint(llm, 'sort my folder');

        expect(draft.repaired).toBe(false);
        expect(draft.problems).toEqual([]);
        expect(llm.requests).toHaveLength(1);
        expect(llm.requests[0].response_format?.schema).toEqual(blueprintSchema());
    });

    it('gives the problems back for one repair', async () => {
        const broken = withSteps((blueprint) => {
            blueprint.output = 'nowhere';
        });
        const llm = scriptedModel([JSON.stringify(broken), JSON.stringify(folderBlueprint())]);

        const draft = await draftBlueprint(llm, 'sort my folder');

        expect(draft.repaired).toBe(true);
        expect(draft.firstProblems).toHaveLength(2);
        expect(draft.problems).toEqual([]);
        expect(llm.requests[1].messages[1].content).toContain('- "output" is "nowhere"');
    });

    it('drafts without a grammar when asked, and reports what is still wrong after the repair', async () => {
        const llm = scriptedModel(['not json', 'still not json']);

        const draft = await draftBlueprint(llm, 'sort my folder', undefined, { useGrammar: false });

        expect(llm.requests[0].response_format).toBeUndefined();
        expect(draft.final).toBe('still not json');
        expect(draft.problems).toEqual(['The blueprint must be one JSON object.']);
    });

    it('quotes the earlier draft in the repair input', () => {
        expect(repairInput('x', 'raw text', ['one'])).toContain('Your blueprint:\nraw text');
    });
});
