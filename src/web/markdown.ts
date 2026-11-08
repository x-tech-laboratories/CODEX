// Turns common Markdown into escaped HTML; anything else stays as written, and only web links become clickable.

const INLINE_MARKDOWN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w))/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;
const LINK_SCHEMES = ['http://', 'https://'];
const MAX_LIST_DEPTH = 4;

// ============================================================================
// Escaping
// ============================================================================

export function escape_html(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ============================================================================
// Inline styles
// ============================================================================

export function inline_html(text: string): string {
    return text
        .split(INLINE_MARKDOWN)
        .filter((part) => part)
        .map((part) => {
            const link = LINK.exec(part);
            if (link && LINK_SCHEMES.some((scheme) => link[2].startsWith(scheme))) {
                return `<a href="${escape_html(link[2])}" target="_blank" rel="noreferrer">${escape_html(link[1])}</a>`;
            }
            if (link) {
                return escape_html(`${link[1]} (${link[2]})`);
            }
            if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
                return `<strong>${escape_html(part.slice(2, -2))}</strong>`;
            }
            if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
                return `<code>${escape_html(part.slice(1, -1))}</code>`;
            }
            if ('*_'.includes(part[0]) && part[part.length - 1] === part[0] && part.length > 2) {
                return `<em>${escape_html(part.slice(1, -1))}</em>`;
            }
            return escape_html(part);
        })
        .join('');
}

// ============================================================================
// Blocks
// ============================================================================

export function markdown_to_html(text: string): string {
    const blocks: string[] = [];
    let paragraph: string[] = [];
    let code: string[] | null = null;

    const end_paragraph = (): void => {
        if (paragraph.length > 0) {
            blocks.push(`<p>${paragraph.join('<br>')}</p>`);
            paragraph = [];
        }
    };

    for (const line of text.split(/\r?\n/)) {
        if (line.trimStart().startsWith('```')) {
            if (code === null) {
                end_paragraph();
                code = [];
            } else {
                blocks.push(`<pre><code>${escape_html(code.join('\n'))}</code></pre>`);
                code = null;
            }
            continue;
        }
        if (code !== null) {
            code.push(line);
            continue;
        }
        const heading = HEADING.exec(line);
        const list_item = LIST_ITEM.exec(line);
        if (heading) {
            end_paragraph();
            const level = Math.min(heading[1].length, 3);
            blocks.push(`<h${level}>${inline_html(heading[2])}</h${level}>`);
        } else if (RULE.test(line)) {
            end_paragraph();
            blocks.push('<hr>');
        } else if (list_item) {
            end_paragraph();
            const marker = '-*+'.includes(list_item[2]) ? '•' : list_item[2];
            const depth = Math.min(Math.floor(list_item[1].replace(/\t/g, '    ').length / 2), MAX_LIST_DEPTH);
            blocks.push(`<div class="list-item depth-${depth}">${escape_html(marker)} ${inline_html(list_item[3])}</div>`);
        } else if (line.startsWith('>')) {
            end_paragraph();
            blocks.push(`<blockquote>${inline_html(line.slice(1).trimStart())}</blockquote>`);
        } else if (!line.trim()) {
            end_paragraph();
        } else {
            paragraph.push(inline_html(line));
        }
    }
    end_paragraph();
    if (code !== null) {
        blocks.push(`<pre><code>${escape_html(code.join('\n'))}</code></pre>`);
    }
    return blocks.join('\n');
}
