import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

/**
 * Render note markdown to sanitized HTML, turning Obsidian `[[Target|Alias]]`
 * wikilinks into <a data-wikilink="Target"> elements the note panel can
 * intercept. Frontmatter is stripped from the preview (it's shown as chips).
 */
export function renderNote(md: string): string {
  const withoutFm = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const withLinks = withoutFm.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const t = target.trim();
    const label = (alias ?? t).trim();
    return `<a href="#" class="wikilink" data-wikilink="${escapeAttr(t)}">${escapeHtml(label)}</a>`;
  });
  const html = marked.parse(withLinks, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-wikilink'] });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
