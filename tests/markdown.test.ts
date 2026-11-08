// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { render_markdown } from '@x-tech-laboratories/x-libs/web/react/markdown';

// The model's output is drawn by X-Libs' Markdown; these checks hold it to the rules the pages rely on.
describe('markdown from the model', () => {
    it('styles bold, code and italic text', () => {
        const html = render_markdown('**Bold** and `code` and *slanted* and _under_');

        expect(html).toContain('<strong>Bold</strong> and <code>code</code> and <em>slanted</em> and <em>under</em>');
    });

    it('makes only web links clickable, opening in a new tab', () => {
        const web = render_markdown('[Docs](https://example.com/a)');
        const local = render_markdown('[File](file:///home/me/notes.txt)');

        expect(web).toContain('<a href="https://example.com/a" target="_blank" rel="noreferrer">Docs</a>');
        expect(local).not.toContain('<a ');
        expect(local).toContain('File (file:///home/me/notes.txt)');
    });

    it('shows raw HTML as text and leaves underscores inside words alone', () => {
        const html = render_markdown('<script>alert(1)</script> snake_case_name');

        expect(html).not.toContain('<script');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; snake_case_name');
    });

    it('renders headings, nested lists, quotes and rules', () => {
        const html = render_markdown('#### Deep\n- one\n  - two\n\n1. first\n\n> quoted\n\n---');

        expect(html).toContain('<h4>Deep</h4>');
        expect(html).toMatch(/<ul>\s*<li>one\s*<ul>\s*<li>two<\/li>/);
        expect(html).toContain('<ol>');
        expect(html).toContain('<blockquote>');
        expect(html).toContain('<hr>');
    });

    it('keeps code blocks as written, even when unclosed', () => {
        const html = render_markdown('```ts\nconst a = 1 < 2;\n**not bold**\n```\n```\nopen');

        expect(html).toContain('<code class="language-ts">const a = 1 &lt; 2;\n**not bold**\n</code>');
        expect(html).toContain('<code>open');
        expect(html).not.toContain('<strong>');
    });
});
