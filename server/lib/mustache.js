'use strict';

/**
 * Minimal Mustache-style renderer for the LaTeX document templates.
 *
 * Supported:
 *   {{name}}            insert value (no escaping — the output is LaTeX)
 *   {{#name}}...{{/name}}  section: repeat over an array, or render once if truthy
 *   {{^name}}...{{/name}}  inverted section: render when empty/falsy
 *   {{! comment }}
 *
 * Inside a section over an array of objects, that object's keys are in scope,
 * and `{{.}}` refers to the current item. Parent scopes remain visible.
 */

const TOKEN = /\{\{([#^/!]?)\s*([^{}]*?)\s*\}\}/g;

function parse(source) {
  const root = { children: [] };
  const stack = [root];
  let cursor = 0;
  let match;

  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(source)) !== null) {
    const [raw, sigil, name] = match;
    const top = stack[stack.length - 1];
    if (match.index > cursor) {
      top.children.push({ type: 'text', value: source.slice(cursor, match.index) });
    }
    cursor = match.index + raw.length;

    if (sigil === '!') continue;
    if (sigil === '#' || sigil === '^') {
      const node = { type: 'section', name, inverted: sigil === '^', children: [] };
      top.children.push(node);
      stack.push(node);
      continue;
    }
    if (sigil === '/') {
      if (stack.length === 1) throw new Error(`template: unexpected {{/${name}}}`);
      const closing = stack.pop();
      if (closing.name !== name) {
        throw new Error(`template: {{/${name}}} does not close {{#${closing.name}}}`);
      }
      continue;
    }
    top.children.push({ type: 'variable', name });
  }

  if (cursor < source.length) {
    stack[stack.length - 1].children.push({ type: 'text', value: source.slice(cursor) });
  }
  if (stack.length !== 1) {
    throw new Error(`template: unclosed {{#${stack[stack.length - 1].name}}}`);
  }
  return root;
}

function lookup(name, scopes) {
  if (name === '.') return scopes[scopes.length - 1];
  const path = name.split('.');
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    let value = scopes[i];
    let found = true;
    for (const key of path) {
      if (value != null && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        found = false;
        break;
      }
    }
    if (found) return value;
  }
  return undefined;
}

function isEmpty(value) {
  if (value == null || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return value === 0;
  return false;
}

function renderNodes(nodes, scopes, out) {
  for (const node of nodes) {
    if (node.type === 'text') {
      out.push(node.value);
    } else if (node.type === 'variable') {
      const value = lookup(node.name, scopes);
      if (value != null && value !== false) out.push(String(value));
    } else if (node.type === 'section') {
      const value = lookup(node.name, scopes);
      const empty = isEmpty(value);
      if (node.inverted) {
        if (empty) renderNodes(node.children, scopes, out);
        continue;
      }
      if (empty) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          scopes.push(item);
          renderNodes(node.children, scopes, out);
          scopes.pop();
        }
      } else {
        scopes.push(typeof value === 'object' ? value : { '.': value });
        renderNodes(node.children, scopes, out);
        scopes.pop();
      }
    }
  }
}

function render(source, context) {
  const out = [];
  renderNodes(parse(String(source)).children, [context || {}], out);
  return out.join('');
}

module.exports = { render, parse };
