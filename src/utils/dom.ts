/**
 * Tiny DOM helpers. Enough structure to keep views declarative without
 * pulling in a framework, per spec §2.
 */

type Child = Node | string | number | null | undefined | false;

export interface Attrs {
  class?: string;
  text?: string;
  html?: string;
  dataset?: Record<string, string | undefined>;
  style?: Partial<CSSStyleDeclaration> | string;
  [key: string]: unknown;
}

/** Create an element. Event handlers are passed as `onclick`, `oninput`, etc. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;

    if (key === 'class') element.className = String(value);
    else if (key === 'text') element.textContent = String(value);
    else if (key === 'html') element.innerHTML = String(value);
    else if (key === 'dataset') {
      for (const [dataKey, dataValue] of Object.entries(value as Record<string, string>)) {
        if (dataValue !== undefined) element.dataset[dataKey] = dataValue;
      }
    } else if (key === 'style') {
      if (typeof value === 'string') element.setAttribute('style', value);
      else Object.assign(element.style, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2), value as EventListener);
    } else if (value === true) {
      element.setAttribute(key, '');
    } else {
      element.setAttribute(key, String(value));
    }
  }

  append(element, children);
  return element;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child,
    );
  }
}

/**
 * Append children, skipping nullish ones. Native `append()` throws on null,
 * which makes conditional children awkward at call sites.
 */
export function mount(parent: Node, ...children: Child[]): void {
  append(parent, children);
}

export function fragment(...children: Child[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  append(frag, children);
  return frag;
}

export function clear(element: Element): void {
  element.replaceChildren();
}

/** Inline SVG from a path spec. Icons are hand-rolled to avoid a dependency. */
export function svg(paths: string[], size = 24): SVGSVGElement {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  element.setAttribute('viewBox', '0 0 24 24');
  element.setAttribute('width', String(size));
  element.setAttribute('height', String(size));
  element.setAttribute('fill', 'none');
  element.setAttribute('stroke', 'currentColor');
  element.setAttribute('stroke-width', '1.75');
  element.setAttribute('stroke-linecap', 'round');
  element.setAttribute('stroke-linejoin', 'round');
  element.setAttribute('aria-hidden', 'true');

  for (const path of paths) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    node.setAttribute('d', path);
    element.appendChild(node);
  }
  return element;
}
