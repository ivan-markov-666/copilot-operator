/**
 * The model menu's locators as Settings edits them (operator, 2026-10-24: "an option in Settings to edit the general
 * locators"). The same rules as `src/transport/locators.ts` — a template holds its placeholder, an axis has two
 * colons, a name is filled in without breaking the quotes — which `test/picker-locators.check.ts` holds this to, and
 * what only a browser can say: whether the XPath or the CSS selector parses at all. The defaults come from the API
 * (`/settings`), so they are written in one place.
 */
export const MODEL_NAME = '{$model_name}';
export const PROVIDER_NAME = '{$provider_name}';

export type PickerKey = 'button' | 'rows' | 'model' | 'provider' | 'providerModel';
export const PICKER_KEYS: PickerKey[] = ['button', 'rows', 'model', 'provider', 'providerModel'];

/** The placeholder a template must hold; the two elements hold none. */
export const PLACEHOLDER: Record<PickerKey, string | null> = {
  button: null,
  rows: null,
  model: MODEL_NAME,
  provider: PROVIDER_NAME,
  providerModel: MODEL_NAME,
};

export type LocatorProblem =
  | { kind: 'placeholder'; placeholder: string }
  | { kind: 'colons'; axis: string }
  | { kind: 'xpath'; message: string }
  | { kind: 'css'; message: string };

/** Whether a locator is an XPath: it starts as one does. */
export function isXPath(locator: string): boolean {
  return /^\s*(\/|\(|\.\.?\/)/.test(locator);
}

function xpathText(text: string): string {
  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes('"')) return `"${text}"`;
  return `concat('${text.split("'").join(`', "'", '`)}')`;
}

/** A template with the names put in; a name with a quote of its placeholder's kind becomes an XPath literal of its own. */
export function fillLocator(template: string, names: { model?: string; provider?: string }): string {
  let out = template;
  const fill = (placeholder: string, name: string | undefined) => {
    if (name === undefined) return;
    out = out
      .split(`'${placeholder}'`).join(name.includes("'") ? xpathText(name) : `'${name}'`)
      .split(`"${placeholder}"`).join(name.includes('"') ? xpathText(name) : `"${name}"`)
      .split(placeholder).join(name);
  };
  fill(MODEL_NAME, names.model);
  fill(PROVIDER_NAME, names.provider);
  return out;
}

/**
 * What is wrong with a locator written for `key`, or null. With a document, whether it parses is tried too: an XPath
 * evaluated, a CSS selector queried, each with a name put in its placeholder.
 */
export function locatorProblem(key: PickerKey, locator: string, doc?: Document): LocatorProblem | null {
  const s = locator.trim();
  if (s === '') return null;
  const needs = PLACEHOLDER[key];
  if (needs && !s.includes(needs)) return { kind: 'placeholder', placeholder: needs };
  const xpath = s.startsWith('xpath=') || (!s.startsWith('css=') && isXPath(s));
  const axis = /(^|[/[(|\s])(ancestor-or-self|ancestor|attribute|child|descendant-or-self|descendant|following-sibling|following|parent|preceding-sibling|preceding|self):(?!:)/.exec(s);
  if (axis && xpath) return { kind: 'colons', axis: axis[2]! };
  if (!doc) return null;
  const text = fillLocator(s.replace(/^(xpath|css)=/, ''), { model: 'Think deeper', provider: 'Claude' });
  try {
    if (xpath) doc.evaluate(text, doc, null, XPathResult.ANY_TYPE, null);
    else doc.querySelector(text);
  } catch (e) {
    const message = ((e as Error).message ?? String(e)).replace(/^Failed to execute '\w+' on 'Document': /, '');
    return xpath ? { kind: 'xpath', message } : { kind: 'css', message };
  }
  return null;
}
