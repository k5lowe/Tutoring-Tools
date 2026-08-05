// Modal for hand-picking problems out of the bank, used when auto-selection
// needs a nudge ("add that one word problem I always use").

import { api } from './api.js';
import { el, mount, modal, rich, excerpt, attempt, toast } from './dom.js';
import { filterPanel, emptyFilters, toQuery } from './filters.js';

export function openPicker({ facets, onAdd, excludeIds = [] }) {
  const filters = emptyFilters();
  const chosen = new Map();
  const results = el('div.list.scroll-y');
  const summary = el('div.count');
  const addButton = el('button.primary', { disabled: true, onclick: submit }, 'Add 0 problems');

  function updateButton() {
    addButton.disabled = chosen.size === 0;
    addButton.textContent = `Add ${chosen.size} problem${chosen.size === 1 ? '' : 's'}`;
  }

  async function search() {
    mount(results, el('div.spinner', 'Searching…'));
    const payload = await attempt(
      () => api.problems.list({ ...toQuery(filters), render: 1, limit: 60, sort: 'textbook' }),
      { failure: 'Could not search the bank' },
    );
    if (!payload) return;

    summary.textContent = `${payload.total} match${payload.total === 1 ? '' : 'es'}`
      + (payload.total > payload.items.length ? ` — showing the first ${payload.items.length}` : '');

    if (payload.items.length === 0) {
      mount(results, el('div.empty', 'Nothing matches those filters.'));
      return;
    }

    mount(results, payload.items.map((problem) => {
      const already = excludeIds.includes(problem.id);
      const on = chosen.has(problem.id);
      const card = el(`div.card.selectable${on ? '.on' : ''}`, {
        onclick: () => {
          if (chosen.has(problem.id)) chosen.delete(problem.id);
          else chosen.set(problem.id, problem);
          card.classList.toggle('on');
          updateButton();
        },
      },
      el('div.card-head',
        el('div.card-meta',
          el('span.badge', `d${problem.difficulty}`),
          problem.kind === 'template' ? el('span.badge.template', 'generated') : null,
          el('span', [problem.subject, problem.topic].filter(Boolean).join(' · ')),
          problem.source_section ? el('span', `§${problem.source_section}`) : null,
          problem.source_number ? el('span', `#${problem.source_number}`) : null,
          already ? el('span.badge', 'already in set') : null)),
      el('div.card-body', problem.html && problem.html.statement
        ? rich(problem.html.statement)
        : el('div.mono', excerpt(problem.statement))));
      return card;
    }));
  }

  function submit() {
    const ids = [...chosen.keys()];
    onAdd(ids);
    handle.close();
    toast(`Added ${ids.length} problem${ids.length === 1 ? '' : 's'}.`);
  }

  const panel = filterPanel({ facets, filters, onchange: search });

  const handle = modal('Add problems from the bank',
    el('div.split',
      el('div.panel', panel.node),
      el('div',
        el('div.panel-head', el('h2', 'Results'), summary),
        results)),
    {
      footer: el('div.btn-row.end', { style: { marginTop: '1rem' } },
        el('button', { onclick: () => handle.close() }, 'Cancel'),
        addButton),
    });

  search();
  return handle;
}
