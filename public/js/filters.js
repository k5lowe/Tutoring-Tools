// The filter panel, shared by the set builder and the problem bank.

import { el, labelled, select, mount, debounce } from './dom.js';

export function emptyFilters() {
  return { q: '', subject: '', topic: '', kind: '', difficulties: [] };
}

/** Strip empties so the query string stays readable. */
export function toQuery(filters) {
  const out = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value == null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

export function describe(filters) {
  const parts = [];
  if (filters.subject) parts.push(filters.subject);
  if (filters.topic) parts.push(filters.topic);
  if (filters.difficulties.length) parts.push(`difficulty ${filters.difficulties.join('/')}`);
  if (filters.kind) parts.push(filters.kind === 'template' ? 'generated only' : 'fixed only');
  if (filters.q) parts.push(`"${filters.q}"`);
  return parts.length ? parts.join(' · ') : 'the whole bank';
}

/**
 * @param {object} options
 * @param {object} options.facets   from /api/problems/facets
 * @param {object} options.filters  mutated in place as the user interacts
 * @param {Function} options.onchange
 *
 * The facets are held rather than copied, and `update()` replaces them. Adding
 * questions introduces new subjects, topics and tags, and a panel built once at
 * page load would not offer them — you could import a hundred questions under a
 * new topic and then have no way to filter to the batch you just added.
 */
export function filterPanel({ facets, filters, onchange, showSearch = true }) {
  const host = el('div');
  let current = facets;
  const fire = () => onchange(filters);
  const fireSoon = debounce(fire, 300);

  function topicsFor(subject) {
    const relevant = subject
      ? current.topics.filter((entry) => entry.subject === subject)
      : current.topics;
    return [...new Set(relevant.map((entry) => entry.topic))];
  }

  function render() {
    const difficultyChips = el('div.chips', [1, 2, 3, 4, 5].map((level) => {
      const on = filters.difficulties.includes(level);
      return el(`button.chip${on ? '.on' : ''}`, {
        type: 'button',
        title: ['easiest', 'easy', 'medium', 'hard', 'hardest'][level - 1],
        onclick: () => {
          filters.difficulties = on
            ? filters.difficulties.filter((value) => value !== level)
            : [...filters.difficulties, level].sort();
          render();
          fire();
        },
      }, String(level));
    }));

    mount(host,
      showSearch
        ? labelled('Search', el('input', {
          type: 'text',
          placeholder: 'search the questions and answers…',
          value: filters.q,
          oninput: (event) => {
            filters.q = event.target.value;
            fireSoon();
          },
        }))
        : null,

      labelled('Subject', select(
        [{ value: '', label: 'Any subject' }, ...current.subjects],
        {
          value: filters.subject,
          onchange: (event) => {
            filters.subject = event.target.value;
            // A topic from the old subject would filter everything out.
            if (filters.topic && !topicsFor(filters.subject).includes(filters.topic)) filters.topic = '';
            render();
            fire();
          },
        },
      )),

      labelled('Topic', select(
        [{ value: '', label: 'Any topic' }, ...topicsFor(filters.subject)],
        {
          value: filters.topic,
          onchange: (event) => {
            filters.topic = event.target.value;
            fire();
          },
        },
      )),

      el('div.field-label', 'Difficulty'),
      difficultyChips,

      el('div.field-label', { style: { marginTop: '.7rem' } }, 'Problem type'),
      select(
        [
          { value: '', label: 'Fixed and generated' },
          { value: 'static', label: 'Fixed problems only' },
          { value: 'template', label: 'Generated (infinite variants) only' },
        ],
        {
          value: filters.kind,
          onchange: (event) => {
            filters.kind = event.target.value;
            fire();
          },
        },
      ),

      el('div.btn-row', { style: { marginTop: '.85rem' } },
        el('button.tiny', {
          type: 'button',
          onclick: () => {
            Object.assign(filters, emptyFilters());
            render();
            fire();
          },
        }, 'Clear filters')),
    );
  }

  render();

  return {
    node: host,
    render,
    /** Take newly loaded facets, keeping whatever the user has selected. */
    update(next) {
      if (!next) return;
      current = next;
      render();
    },
  };
}
