// An email that needs an answer gets a drafted reply, worked as a task tree on the background model.
import { untrustedBlock } from '@x-tech-laboratories/smartharness/contextBudget';
import type { EventContext, EventHandler, EventOutcome } from '@x-tech-laboratories/smartharness/events';
import { clip, field, MAX_ANSWER_CHARS, MAX_TITLE_CHARS, runEventTree } from '@x-tech-laboratories/smartharness/eventTree';
import type { EventRecord } from '@x-tech-laboratories/smartharness/knowledge';
import { assistantPrompt as prompt } from './prompts.js';
import { checkNote, draftChecks, replySubject, senderAddress, type MailThread } from './mailChecks.js';
import { MailStore } from './mailStore.js';

// Longest mail text put in the prompt, since the mail is written by anyone.
const MAX_MAIL_PROMPT_CHARS = 4000;

export const DRAFT_PROMPT = prompt('draft');

// An email that needs an answer gets a reply drafted from what the owner's notes know; the draft is only proposed.
// A draft that fails a non-model check is still proposed, with a note saying what to check.
export const draftReplyHandler: EventHandler = async (event: EventRecord, context: EventContext): Promise<EventOutcome> => {
    const { payload } = event;
    const thread: MailThread = {
        from: field(payload, 'from'),
        to: field(payload, 'to'),
        subject: field(payload, 'subject'),
        date: field(payload, 'date'),
        body: field(payload, 'body').slice(0, MAX_MAIL_PROMPT_CHARS),
    };
    const mail = `From: ${thread.from}\nSubject: ${thread.subject}\nDate: ${thread.date}\n\n${thread.body}`;
    // External: the sender wrote this prompt's content, so the run is held to research and writing.
    const written = await runEventTree(`${DRAFT_PROMPT}\n\nEmail:\n${untrustedBlock(mail)}`, 'external', context);
    const answer = clip(written, MAX_ANSWER_CHARS);
    if (!answer) {
        return { status: 'ignored', detail: 'The model wrote no draft.' };
    }
    const recipient = senderAddress(thread.from) || thread.from;
    const subject = replySubject(thread.subject);
    const checks = draftChecks(written, recipient, subject, thread);
    const note = checkNote(checks);
    const title = clip(`Reply to ${thread.from || 'sender'}: ${thread.subject || '(no subject)'}`, MAX_TITLE_CHARS);
    const actionId = context.store.addAction({
        eventId: event.id,
        kind: 'draft',
        title,
        body: note ? `${answer}\n\n${note}` : answer,
        payload: { message_id: field(payload, 'message_id'), source: event.source, file: field(payload, 'file'), to: recipient, subject },
    });
    const outcomeId = payload.mail_outcome_id;
    if (typeof outcomeId === 'number' && Number.isInteger(outcomeId)) {
        new MailStore(context.store).recordMailDraft(outcomeId, actionId, answer, checks.map((check) => check.name));
    }
    return { status: 'done', detail: `Proposed action ${actionId}` };
};
