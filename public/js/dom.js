// Small DOM helpers. Enough structure to keep views readable without pulling in
// a framework — the whole UI is a handful of screens over a REST API.

/**
 * Apply a style object to a node.
 *
 * Object.assign cannot be used here: a CSSStyleDeclaration silently ignores
 * custom properties, so `{ '--hue': 198 }` would set nothing and every rule
 * reading `var(--hue)` would be dropped as invalid. Those have to go through
 * setProperty.
 */
function setStyle(node, styles) {
  for (const [key, value] of Object.entries(styles)) {
    if (key.startsWith('--')) node.style.setProperty(key, String(value));
    else node.style[key] = value;
  }
}

/**
 * el('div.card', { onclick }, children)
 * Tag string supports #id and .class shorthands.
 */
export function el(spec, props = null, ...children) {
  const [tag, ...rest] = String(spec).split(/(?=[.#])/);
  const node = document.createElement(tag || 'div');

  for (const token of rest) {
    if (token.startsWith('#')) node.id = token.slice(1);
    else if (token.startsWith('.')) node.classList.add(token.slice(1));
  }

  if (props && (Array.isArray(props) || props instanceof Node || typeof props === 'string')) {
    children.unshift(props);
  } else if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className += (node.className ? ' ' : '') + value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style' && typeof value === 'object') setStyle(node, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in node && key !== 'list' && key !== 'type') {
        node[key] = value;
      } else {
        node.setAttribute(key, value === true ? '' : value);
      }
    }
    // `type` must be set before `value` on inputs, so it is applied explicitly.
    if (props.type) node.setAttribute('type', props.type);
    if (props.list) node.setAttribute('list', props.list);
    if (props.value != null) node.value = props.value;
  }

  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(4)) {
    if (child == null || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

/** A block of server-rendered math/markup. */
export function rich(html, className = '') {
  return el('div', { class: className, html: html || '' });
}

export function labelled(text, control, hint) {
  return el('label.field', el('span', text), control, hint ? el('p.hint', hint) : null);
}

export function select(options, { value, onchange, ...rest } = {}) {
  const node = el('select', { onchange, ...rest });
  for (const option of options) {
    const { value: optionValue, label } = typeof option === 'object'
      ? option
      : { value: option, label: option };
    node.appendChild(el('option', { value: optionValue, selected: optionValue === value }, label));
  }
  node.value = value ?? '';
  return node;
}

export function datalist(id, values) {
  return el('datalist', { id }, values.map((value) => el('option', { value })));
}

let toastTimer = 0;
export function toast(message, kind = '') {
  const host = document.getElementById('toasts');
  const node = el(`div.toast${kind ? `.${kind}` : ''}`, message);
  host.appendChild(node);
  clearTimeout(toastTimer);
  setTimeout(() => node.remove(), kind === 'error' ? 7000 : 3500);
}

/** Run an async action, surfacing failures as a toast instead of a console error. */
export async function attempt(action, { failure = 'Something went wrong' } = {}) {
  try {
    return await action();
  } catch (error) {
    toast(`${failure}: ${error.message}`, 'error');
    return undefined;
  }
}

export function modal(title, content, { footer = null, onclose = null, width } = {}) {
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (onclose) onclose();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  const box = el('div.modal', { style: width ? { width } : null },
    el('div.modal-head',
      el('h3', title),
      el('button.ghost', { onclick: close, title: 'Close' }, '✕')),
    content,
    footer);
  const backdrop = el('div.modal-backdrop', {
    onclick: (event) => {
      if (event.target === backdrop) close();
    },
  }, box);
  document.body.appendChild(backdrop);
  document.addEventListener('keydown', onKey);
  return { close, box };
}

export function confirmAction(message) {
  // eslint-disable-next-line no-alert -- a native confirm is the right weight here.
  return window.confirm(message);
}

/** Collapse LaTeX to a one-line excerpt for dense list rows. */
export function excerpt(text, limit = 120) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export function debounce(fn, delay = 250) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
