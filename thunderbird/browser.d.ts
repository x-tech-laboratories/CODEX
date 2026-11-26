// The parts of Thunderbird's WebExtension API the add-on uses.

interface ThunderbirdMessageHeader {
  id: number;
  headerMessageId: string;
  subject: string;
  author: string;
  date: string | Date;
}

interface ThunderbirdMessagePart {
  contentType?: string;
  body?: string;
  parts?: ThunderbirdMessagePart[];
}

declare const browser: {
  tabs: { query(query: { active: boolean; currentWindow: boolean }): Promise<{ id?: number }[]> };
  messageDisplay: { getDisplayedMessage(tab_id: number): Promise<ThunderbirdMessageHeader | null> };
  messages: { getFull(message_id: number): Promise<ThunderbirdMessagePart> };
  storage: { local: { get(keys: string[]): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): Promise<void> } };
  permissions: { request(permissions: { origins: string[] }): Promise<boolean> };
  runtime: { openOptionsPage(): Promise<void> };
};
