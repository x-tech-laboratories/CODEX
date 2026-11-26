// The event handlers the assistant runs: the harness's own, plus mail triage and drafted replies.
import { DEFAULT_EVENT_HANDLERS, type EventHandler } from '@x-tech-laboratories/smartharness/events';
import { draftReplyHandler } from './draftReply.js';
import type { AssistantSettings } from './settings.js';
import { emailHandler } from './triage.js';

export const ASSISTANT_EVENT_HANDLERS: ReadonlyMap<string, EventHandler<AssistantSettings>> = new Map<string, EventHandler<AssistantSettings>>([
    ...DEFAULT_EVENT_HANDLERS,
    ['email.received', emailHandler],
    ['email.draft', draftReplyHandler],
]);
