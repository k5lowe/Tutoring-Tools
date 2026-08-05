// "Templates": the LaTeX documents the app produces. Editable, because every
// tutor's house style differs and the output should match yours, not mine.

import { api } from './api.js';
import {
  el, mount, labelled, select, toast, attempt, confirmAction,
} from './dom.js';

const FIELD_REFERENCE = [
  ['{{title}}', 'set title'],
  ['{{course}} {{student}} {{date}}', 'header metadata'],
  ['{{instructions}} {{notes}}', 'free-text blocks (LaTeX allowed)'],
  ['{{version}} {{#hasVersions}}…{{/hasVersions}}', 'A/B/C version label'],
  ['{{count}}', 'number of problems'],
  ['{{itemsep}}', 'gap after each problem'],
  ['{{#multipleColumns}}…{{/multipleColumns}}', 'true when columns > 1'],
  ['{{#hasObjectives}}{{#objectives}}{{text}}{{/objectives}}{{/hasObjectives}}', 'lesson objectives'],
  ['{{#problems}}…{{/problems}}', 'loop over the problems'],
  ['{{label}}', 'problem label, per the numbering mode'],
  ['{{statement}} {{answer}} {{solution}}', 'problem content'],
  ['{{#hasAnswer}} {{#hasSolution}}', 'guards for missing content'],
  ['{{heading}}', 'section heading (grouped numbering)'],
  ['{{source}} {{difficulty}} {{topic}}', 'per-problem metadata'],
  ['{{n}}', 'position, starting at 1'],
];

export async function templatesView(root) {
  let templates = [];
  let selectedId = null;
  const listHost = el('div.list');
  const editorHost = el('div');

  async function refresh(keepSelection = true) {
    const payload = await attempt(() => api.templates.list(), { failure: 'Could not load templates' });
    if (!payload) return;
    templates = payload.templates;
    if (!keepSelection || !templates.some((template) => template.id === selectedId)) {
      selectedId = templates.length ? templates[0].id : null;
    }
    renderList();
    renderEditor();
  }

  function renderList() {
    const byKind = new Map();
    for (const template of templates) {
      if (!byKind.has(template.kind)) byKind.set(template.kind, []);
      byKind.get(template.kind).push(template);
    }

    mount(listHost, [...byKind.entries()].map(([kind, group]) => el('div',
      el('div.field-label', { style: { marginTop: '.5rem' } }, kind),
      group.map((template) => el(`div.card.selectable${template.id === selectedId ? '.on' : ''}`, {
        onclick: () => {
          selectedId = template.id;
          renderList();
          renderEditor();
        },
      },
      el('div.card-head',
        el('div', el('strong', template.name)),
        el('div.card-meta',
          template.is_default ? el('span.badge.template', 'default') : null,
          template.builtin ? el('span.badge', 'built-in') : null)))))));
  }

  function renderEditor() {
    const template = templates.find((candidate) => candidate.id === selectedId);
    if (!template) {
      mount(editorHost, el('div.empty', 'No templates.'));
      return;
    }

    const nameInput = el('input', { type: 'text', value: template.name });
    const kindSelect = select(
      [
        { value: 'practice', label: 'practice — worksheet' },
        { value: 'notes', label: 'notes — lesson handout' },
        { value: 'answers', label: 'answers — key' },
      ],
      { value: template.kind },
    );
    const bodyArea = el('textarea', { value: template.body, rows: 30, spellcheck: false });

    async function save() {
      const payload = await attempt(
        () => api.templates.update(template.id, {
          name: nameInput.value, kind: kindSelect.value, body: bodyArea.value,
        }),
        { failure: 'Could not save the template' },
      );
      if (!payload) return;
      toast('Template saved.');
      await refresh();
    }

    mount(editorHost,
      el('div.row',
        labelled('Name', nameInput),
        labelled('Kind', kindSelect)),
      labelled('LaTeX body', bodyArea),
      el('div.btn-row',
        el('button.primary', { onclick: save }, 'Save template'),
        !template.is_default
          ? el('button', {
            onclick: async () => {
              await attempt(() => api.templates.setDefault(template.id));
              toast(`Now the default ${template.kind} template.`);
              await refresh();
            },
          }, 'Make default')
          : null,
        el('button', {
          onclick: async () => {
            const payload = await attempt(() => api.templates.create({
              name: `${template.name} (copy)`, kind: template.kind, body: bodyArea.value,
            }));
            if (!payload) return;
            selectedId = payload.template.id;
            toast('Copied to a new template.');
            await refresh();
          },
        }, 'Duplicate'),
        template.builtin
          ? el('button', {
            title: 'Restore the version this app shipped with',
            onclick: async () => {
              if (!confirmAction('Discard your edits and restore the shipped template?')) return;
              await attempt(() => api.templates.reset(template.id));
              toast('Template restored.');
              await refresh();
            },
          }, 'Reset to shipped')
          : el('button.danger', {
            onclick: async () => {
              if (!confirmAction(`Delete the template “${template.name}”?`)) return;
              await attempt(() => api.templates.remove(template.id));
              await refresh(false);
            },
          }, 'Delete')),
      el('div.panel', { style: { marginTop: '1rem' } },
        el('h2', 'Fields you can use'),
        el('div.list', FIELD_REFERENCE.map(([code, description]) => el('div.card-meta',
          el('code.mono', code),
          el('span', description))))));
  }

  mount(root, el('div.split',
    el('div.panel.sticky-panel', el('h2', 'Templates'), listHost),
    el('div.panel',
      el('div.panel-head',
        el('h2', 'Edit template'),
        el('p.hint', { style: { margin: 0 } },
          'Sections repeat over lists; everything else is inserted literally. '
          + 'Output is LaTeX, so nothing is HTML-escaped.')),
      editorHost)));

  await refresh(false);
}
