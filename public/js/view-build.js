// "Build a set": the main workflow — choose topic and difficulty on the left,
// get a printable, numbered problem set on the right.

import { api, links } from './api.js';
import {
  el, mount, labelled, select, rich, toast, attempt, confirmAction, excerpt,
} from './dom.js';
import { filterPanel, emptyFilters, toQuery, describe } from './filters.js';
import { openPicker } from './picker.js';

const LAST_SET_KEY = 'tutoring-tools:last-set';

const DISTRIBUTION_LABELS = {
  mixed: 'Mixed — spread across difficulty levels',
  ramp: 'Ramp — easiest first, hardest last',
  random: 'Random order',
  flat: 'Textbook order',
};

const NUMBERING_LABELS = {
  sequential: 'Sequential — 1, 2, 3…',
  textbook: 'Textbook reference — 3.4 #17',
  section: 'Grouped by section, with headings',
  alpha: 'Letters — a), b), c)…',
};

const KIND_LABELS = {
  practice: 'Practice worksheet',
  notes: 'Lesson notes (with solutions)',
  answers: 'Answer key',
};

export async function buildView(root, { facets, meta }) {
  const filters = emptyFilters();
  const spec = { count: 10, distribution: 'mixed' };
  let current = null;
  let output = { kind: 'practice', version: 0, tab: 'preview', data: null };

  const itemsHost = el('div');
  const outputHost = el('div');
  const detailsHost = el('div');
  const poolNote = el('p.hint');

  // ---------- generator ----------

  const panel = filterPanel({
    facets,
    filters,
    onchange: async () => {
      const payload = await attempt(() => api.problems.list({ ...toQuery(filters), limit: 1 }));
      if (payload) {
        poolNote.textContent = `${payload.total} problem${payload.total === 1 ? '' : 's'} match ${describe(filters)}.`;
      }
    },
  });

  const countInput = el('input', {
    type: 'number', min: 1, max: 100, value: spec.count,
    onchange: (event) => {
      spec.count = Math.max(1, Math.min(100, Number(event.target.value) || 10));
      event.target.value = spec.count;
    },
  });

  const titleInput = el('input', { type: 'text', placeholder: 'e.g. Quadratics — Week 3' });

  async function generate() {
    const payload = await attempt(() => api.sets.generate({
      title: titleInput.value.trim() || `${filters.topic || filters.subject || 'Practice'} set`,
      subject: filters.subject,
      count: spec.count,
      distribution: spec.distribution,
      numbering: filters.section || filters.book ? 'section' : 'sequential',
      filters: toQuery(filters),
      meta: { course: filters.subject || '', itemsep: '2.5em' },
    }), { failure: 'Could not generate a set' });
    if (!payload) return;

    if (payload.shortfall > 0) {
      toast(`Only ${payload.set.items.length} of ${spec.count} problems available for those filters.`);
    }
    await load(payload.set.id);
  }

  // ---------- loading / refresh ----------

  async function load(setId, { remembered = false } = {}) {
    let payload;
    try {
      payload = await api.sets.get(setId, { render: 1 });
    } catch (error) {
      // A set remembered from a previous session may since have been deleted;
      // that is not worth an error message, just forget it.
      localStorage.removeItem(LAST_SET_KEY);
      if (!remembered) toast(`Could not load set: ${error.message}`, 'error');
      renderDetails();
      renderItems();
      mount(outputHost, el('div.empty', 'No set yet.'));
      return;
    }
    current = payload.set;
    localStorage.setItem(LAST_SET_KEY, String(current.id));
    output.version = Math.min(output.version, current.versions - 1);
    renderDetails();
    renderItems();
    await refreshOutput();
  }

  async function refreshItems() {
    if (!current) return;
    const payload = await attempt(() => api.sets.get(current.id, { render: 1 }));
    if (!payload) return;
    current = payload.set;
    renderItems();
    await refreshOutput();
  }

  async function patchSet(patch) {
    if (!current) return;
    const payload = await attempt(() => api.sets.update(current.id, { ...current, ...patch, items: undefined }));
    if (!payload) return;
    await load(current.id);
  }

  // ---------- set details ----------

  function renderDetails() {
    if (!current) {
      mount(detailsHost, el('div.empty', 'Generate a set to edit its details.'));
      return;
    }
    const metaData = current.meta || {};
    const field = (key, value) => ({ ...metaData, [key]: value });

    mount(detailsHost,
      labelled('Title', el('input', {
        type: 'text', value: current.title,
        onchange: (event) => patchSet({ title: event.target.value }),
      })),
      el('div.row',
        labelled('Course', el('input', {
          type: 'text', value: metaData.course || '',
          onchange: (event) => patchSet({ meta: field('course', event.target.value) }),
        })),
        labelled('Student', el('input', {
          type: 'text', value: metaData.student || '', placeholder: 'blank = name line',
          onchange: (event) => patchSet({ meta: field('student', event.target.value) }),
        }))),
      labelled('Instructions', el('textarea', {
        rows: 2, value: metaData.instructions || '',
        placeholder: 'Show all work. No calculator.',
        onchange: (event) => patchSet({ meta: field('instructions', event.target.value) }),
      }), 'LaTeX is allowed here — inline math with $…$.'),
      labelled('Numbering', select(
        Object.entries(NUMBERING_LABELS).map(([value, label]) => ({ value, label })),
        { value: current.numbering, onchange: (event) => patchSet({ numbering: event.target.value }) },
      )),
      el('div.row',
        labelled('Versions', el('input', {
          type: 'number', min: 1, max: 26, value: current.versions,
          onchange: (event) => patchSet({ versions: Number(event.target.value) || 1 }),
        }), 'A/B/C forms of the same set'),
        labelled('Work space', el('input', {
          type: 'text', value: metaData.itemsep || '2.5em',
          onchange: (event) => patchSet({ meta: field('itemsep', event.target.value) }),
        }), 'gap after each problem')),
      labelled('Columns', select([1, 2, 3], {
        value: Number(metaData.columns) || 1,
        onchange: (event) => patchSet({ meta: field('columns', Number(event.target.value)) }),
      })),
    );
  }

  // ---------- item list ----------

  function renderItems() {
    if (!current) {
      mount(itemsHost, el('div.empty',
        'Pick a subject, topic and difficulty on the left, then press Generate set.'));
      return;
    }
    if (current.items.length === 0) {
      mount(itemsHost, el('div.empty', 'This set is empty. Use “Add from bank” to put problems in it.'));
      return;
    }

    const rows = current.items.map((item, index) => {
      const row = el('div.item-row', { draggable: true, dataset: { itemId: item.item_id, index } },
        item.heading
          ? rich(item.html && item.html.heading ? item.html.heading : item.heading, 'item-heading')
          : null,
        el('div.item-label', { class: 'drag-handle', title: 'Drag to reorder' }, item.label || `${index + 1}.`),
        el('div.item-body',
          item.error ? el('div.notice.error', `Could not generate: ${item.error}`) : null,
          item.html && item.html.statement ? rich(item.html.statement) : el('div.mono', excerpt(item.statement)),
          item.html && item.html.answer
            ? el('div.item-answer', el('strong', 'Answer: '), rich(item.html.answer, 'inline-answer'))
            : null,
          el('div.card-meta', { style: { marginTop: '.35rem' } },
            el('span.badge', `d${item.difficulty}`),
            item.kind === 'template' ? el('span.badge.template', 'generated') : null,
            el('span', [item.topic, item.subtopic].filter(Boolean).join(' · ')),
            item.source_section ? el('span', `§${item.source_section}`) : null)),
        el('div.card-actions',
          item.kind === 'template'
            ? el('button.ghost.tiny', {
              title: 'Redraw this problem with new numbers',
              onclick: async () => {
                await attempt(() => api.sets.reseed(current.id, [item.item_id]));
                await refreshItems();
              },
            }, '⟳')
            : null,
          el('button.ghost.tiny', {
            title: 'Move up', disabled: index === 0,
            onclick: async () => {
              await attempt(() => api.sets.moveItem(current.id, item.item_id, index - 1));
              await refreshItems();
            },
          }, '↑'),
          el('button.ghost.tiny', {
            title: 'Move down', disabled: index === current.items.length - 1,
            onclick: async () => {
              await attempt(() => api.sets.moveItem(current.id, item.item_id, index + 1));
              await refreshItems();
            },
          }, '↓'),
          el('button.ghost.tiny.danger', {
            title: 'Remove from set',
            onclick: async () => {
              await attempt(() => api.sets.removeItem(current.id, item.item_id));
              await refreshItems();
            },
          }, '✕')));

      row.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', String(index));
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (event) => {
        event.preventDefault();
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', async (event) => {
        event.preventDefault();
        row.classList.remove('drop-target');
        const from = Number(event.dataTransfer.getData('text/plain'));
        if (Number.isFinite(from) && from !== index) {
          await attempt(() => api.sets.moveItem(current.id, current.items[from].item_id, index));
          await refreshItems();
        }
      });
      return row;
    });

    mount(itemsHost, rows);
  }

  // ---------- output ----------

  async function refreshOutput() {
    if (!current) {
      mount(outputHost, el('div.empty', 'No set yet.'));
      return;
    }
    const payload = await attempt(
      () => api.render.set(current.id, {
        kind: output.kind,
        version: current.versions > 1 ? output.version : undefined,
      }),
      { failure: 'Could not render the set' },
    );
    if (!payload) return;
    output.data = payload;
    renderOutput();
  }

  function renderOutput() {
    const data = output.data;
    if (!data) {
      mount(outputHost, el('div.empty', 'No set yet.'));
      return;
    }

    const versionOptions = Array.from({ length: current.versions }, (unused, index) => ({
      value: index,
      label: `Version ${String.fromCharCode(65 + index)}`,
    }));

    const kindTabs = el('div.tab-strip', Object.entries(KIND_LABELS).map(([kind, label]) => el(
      `button${output.kind === kind ? '.on' : ''}`,
      {
        onclick: async () => {
          output.kind = kind;
          await refreshOutput();
        },
      },
      label,
    )));

    const bundleQuery = { kinds: 'practice,answers', versions: current.versions > 1 ? 'all' : undefined };
    const single = {
      kind: output.kind,
      version: current.versions > 1 ? String.fromCharCode(65 + output.version) : undefined,
    };

    const body = output.tab === 'source'
      ? el('textarea.tex-source', { readonly: true, value: data.latex })
      : el('iframe.preview-frame', { srcdoc: data.html, title: 'Print preview' });

    mount(outputHost,
      kindTabs,
      data.warnings && data.warnings.length
        ? el('div.notice',
          el('strong', `${data.warnings.length} problem(s) could not be generated`),
          el('ul', data.warnings.map((warning) => el('li', warning.message))))
        : null,
      el('div.panel-head',
        el('div.btn-row',
          el('button', {
            class: output.tab === 'preview' ? 'primary' : '',
            onclick: () => {
              output.tab = 'preview';
              renderOutput();
            },
          }, 'Preview'),
          el('button', {
            class: output.tab === 'source' ? 'primary' : '',
            onclick: () => {
              output.tab = 'source';
              renderOutput();
            },
          }, 'LaTeX source'),
          current.versions > 1
            ? select(versionOptions, {
              value: output.version,
              onchange: async (event) => {
                output.version = Number(event.target.value);
                await refreshOutput();
              },
            })
            : null),
        el('div.btn-row',
          el('button.tiny', {
            onclick: async () => {
              await navigator.clipboard.writeText(data.latex);
              toast('LaTeX copied to the clipboard.');
            },
          }, 'Copy .tex'),
          el('a.btn.tiny', { href: links.tex(current.id, single) }, 'Download .tex'),
          el('a.btn.tiny', { href: links.tex(current.id, bundleQuery) }, 'All versions + keys'),
          meta.pdf.available
            ? el('a.btn.tiny.primary', { href: links.pdf(current.id, single), target: '_blank' }, 'PDF')
            : null,
          el('a.btn.tiny', { href: links.print(current.id, single), target: '_blank' }, 'Print ↗'))),
      body,
      el('p.hint', `Template: ${data.template.name}. `
        + `${data.count} problem${data.count === 1 ? '' : 's'}. `
        + (meta.pdf.available
          ? 'PDF compiled locally.'
          : 'No LaTeX engine detected — use “Print ↗” for a printable page, or download the .tex.')),
    );
  }

  // ---------- assemble ----------

  const generatorPanel = el('div.panel',
    el('h2', 'What do you need?'),
    panel.node,
    el('hr', { style: { border: 0, borderTop: '1px solid var(--line)', margin: '.9rem 0' } }),
    labelled('Title', titleInput),
    el('div.row',
      labelled('How many problems', countInput),
      labelled('Order', select(
        Object.entries(DISTRIBUTION_LABELS).map(([value, label]) => ({ value, label })),
        {
          value: spec.distribution,
          onchange: (event) => {
            spec.distribution = event.target.value;
          },
        },
      ))),
    poolNote,
    el('div.btn-row', el('button.primary', { onclick: generate, style: { flex: '1' } }, 'Generate set')));

  const setPanel = el('div.panel',
    el('div.panel-head',
      el('h2', 'The set'),
      el('div.btn-row',
        el('button.tiny', {
          onclick: () => {
            if (!current) {
              toast('Generate a set first.', 'error');
              return;
            }
            openPicker({
              facets,
              excludeIds: current.items.map((item) => item.problem_id),
              onAdd: async (ids) => {
                await attempt(() => api.sets.addItems(current.id, ids));
                await refreshItems();
              },
            });
          },
        }, '+ Add from bank'),
        el('button.tiny', {
          onclick: async () => {
            if (!current) return;
            await attempt(() => api.sets.generateItems(current.id, {
              count: 5, distribution: spec.distribution, filters: toQuery(filters),
            }), { failure: 'Could not add more problems' });
            await refreshItems();
          },
        }, '+ 5 more like these'),
        el('button.tiny', {
          title: 'New numbers for every generated problem in the set',
          onclick: async () => {
            if (!current) return;
            await attempt(() => api.sets.reseed(current.id));
            await refreshItems();
            toast('Regenerated all template problems.');
          },
        }, '⟳ Reshuffle numbers'),
        el('button.tiny', {
          title: 'Order the problems by textbook section',
          onclick: async () => {
            if (!current) return;
            await attempt(() => api.sets.sort(current.id, 'section'));
            await refreshItems();
          },
        }, 'Sort by section'),
        el('button.tiny.danger', {
          onclick: async () => {
            if (!current || !confirmAction(`Delete the set “${current.title}”?`)) return;
            await attempt(() => api.sets.remove(current.id));
            localStorage.removeItem(LAST_SET_KEY);
            current = null;
            renderDetails();
            renderItems();
            mount(outputHost, el('div.empty', 'No set yet.'));
          },
        }, 'Delete set'))),
    itemsHost);

  mount(root, el('div.split.split-wide',
    el('div',
      generatorPanel,
      el('div.panel', el('h2', 'Set details'), detailsHost)),
    el('div',
      setPanel,
      el('div.panel', el('h2', 'Output'), outputHost))));

  // Restore whatever was being worked on before the last reload.
  const remembered = localStorage.getItem(LAST_SET_KEY);
  if (remembered) {
    await load(remembered, { remembered: true });
  } else {
    renderItems();
    renderDetails();
    mount(outputHost, el('div.empty', 'No set yet.'));
  }
  panel.render();
}

export { LAST_SET_KEY };
