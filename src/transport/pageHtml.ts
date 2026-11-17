/**
 * The page's HTML as it is handed to a chatbot to find a locator in (operator, 2026-11-17: "when it fails, let the bot
 * save the HTML and give it to the user — the goal is to give the HTML to a chat bot and have it say which locator it
 * is and what its selector is"). What only makes it longer and says nothing about where an element is goes: scripts,
 * styles, stylesheets, the pictures' path data, inline images, comments. The sidebar goes too, unless the locator that
 * failed is one of the sidebar's own: it holds the names of all the operator's conversations. When it is kept, those
 * names are put out ("chat title") and only the structure, the ids and the labels of its buttons stay.
 *
 * Run in the page (`page.evaluate`), on a copy of the document: the page itself is not touched. No function is named
 * inside it: the checks run the source through tsx, which wraps a named one in `__name(…)`, and the page has no
 * `__name` — the HTML was not kept at all until this was so.
 */
export function strippedPageHtml(keepSidebar: boolean): string {
  const doc = document.documentElement.cloneNode(true) as HTMLElement;
  const noise = 'script, style, noscript, template, link[rel="stylesheet"], link[rel="preload"], link[rel="prefetch"], link[rel="modulepreload"], meta, iframe';
  for (const el of Array.from(doc.querySelectorAll(noise))) el.remove();
  // A picture's paths are long and say nothing about where it is: the element stays, empty, with its attributes.
  for (const svg of Array.from(doc.querySelectorAll('svg'))) svg.replaceChildren();
  const SIDEBAR = 'nav, [role="navigation"], aside';
  if (!keepSidebar) {
    for (const el of Array.from(doc.querySelectorAll(SIDEBAR))) el.remove();
  } else {
    for (const side of Array.from(doc.querySelectorAll(SIDEBAR))) {
      // A conversation's row: its title put out, in its text and in its labels; its address (an id, no name) stays.
      for (const a of Array.from(side.querySelectorAll('a[href*="conversation"]'))) {
        for (const at of ['aria-label', 'title']) if (a.hasAttribute(at)) a.setAttribute(at, 'chat title');
        const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n.textContent ?? '').trim()) n.textContent = 'chat title';
      }
    }
  }
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const at of Array.from(el.attributes)) {
      // Nothing in the file runs when it is opened: no handler, no script address.
      if (/^on/i.test(at.name) || /^\s*javascript:/i.test(at.value)) {
        el.removeAttribute(at.name);
        continue;
      }
      // Inline images and the like: the attribute stays, its value shortened.
      if (/^data:/i.test(at.value) && at.value.length > 80) el.setAttribute(at.name, `${at.value.slice(0, 40)}…`);
      // The page's own styles on an element say nothing about which element it is.
      if (at.name === 'style') el.removeAttribute('style');
    }
  }
  const comments = document.createTreeWalker(doc, NodeFilter.SHOW_COMMENT);
  const gone: Node[] = [];
  for (let n = comments.nextNode(); n; n = comments.nextNode()) gone.push(n);
  for (const n of gone) n.parentNode?.removeChild(n);
  return `<!doctype html>\n${doc.outerHTML.replace(/\n\s*\n+/g, '\n')}`;
}
