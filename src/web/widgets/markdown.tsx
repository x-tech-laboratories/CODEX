// Markdown drawn as escaped HTML, keeping the newest text in sight unless the reader has scrolled up.
import { useLayoutEffect, useMemo, useRef } from 'react';

import { markdown_to_html } from '../markdown.ts';

const FOLLOW_SLACK_PIXELS = 4;

export function Markdown({ text, class_name }: { text: string; class_name?: string }) {
    const box = useRef<HTMLDivElement>(null);
    const html = useMemo(() => markdown_to_html(text), [text]);
    const element = box.current;
    const following = element === null || element.scrollTop >= element.scrollHeight - element.clientHeight - FOLLOW_SLACK_PIXELS;

    useLayoutEffect(() => {
        if (following && box.current !== null) {
            box.current.scrollTop = box.current.scrollHeight;
        }
    }, [html]);

    return <div ref={box} className={class_name ? `markdown ${class_name}` : 'markdown'} dangerouslySetInnerHTML={{ __html: html }} />;
}
