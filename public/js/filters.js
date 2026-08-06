// The filter panel, shared by the set builder and the problem bank.

import { el, labelled, select, mount, debounce } from './dom.js';

export function emptyFilters() {
  return {
    q: '', subject: '', topic: '', section: '', book: '', kind: '',
    difficulties: [], tags: [],
  };
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
  if (filters.book) parts.push(filters.book);
  if (filters.section) parts.push(`§${filters.section}`);
  if (filters.difficulties.length) parts.push(`difficulty ${filters.difficulties.join('/')}`);
  if (filters.tags.length) parts.push(filters.tags.join(', '));
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
/** How many tag chips to show before the list is folded away. */
const TAG_PREVIEW = 12;

export function filterPanel({ facets, filters, onchange, showSearch = true }) {
  const host = el('div');
  let current = facets;
  let showAllTags = false;
  const fire = () => onchange(filters);
  const fireSoon = debounce(fire, 300);

  function topicsFor(subject) {
    const relevant = subject
      ? current.topics.filter((entry) => entry.subject === subject)
      : current.topics;
    return [...new Set(relevant.map((entry) => entry.topic))];
  }

  function sectionsFor(book) {
    const relevant = book
      ? current.sections.filter((entry) => entry.source_book === book)
      : current.sections;
    return [...new Set(relevant.map((entry) => entry.source_section))];
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

    // Tags are the one part of this panel that grows with the bank, so it is
    // the one part that has to be capped. A selected tag is always shown even
    // when it falls outside the preview, otherwise collapsing the list would
    // hide a filter that is still applied.
    const chosen = current.tags.filter((tag) => filters.tags.includes(tag.value));
    const rest = current.tags.filter((tag) => !filters.tags.includes(tag.value));
    const visible = showAllTags
      ? [...chosen, ...rest]
      : [...chosen, ...rest.slice(0, Math.max(TAG_PREVIEW - chosen.length, 0))];
    const hidden = current.tags.length - visible.length;

    const tagChips = el('div.chips',
      visible.map((tag) => {
        const on = filters.tags.includes(tag.value);
        return el(`button.chip${on ? '.on' : ''}`, {
          type: 'button',
          title: `${tag.count} problem(s)`,
          onclick: () => {
            filters.tags = on
              ? filters.tags.filter((value) => value !== tag.value)
              : [...filters.tags, tag.value];
            render();
            fire();
          },
        }, tag.value);
      }),
      hidden > 0 || showAllTags
        ? el('button.chip.chip-more', {
          type: 'button',
          onclick: () => {
            showAllTags = !showAllTags;
            render();
          },
        }, showAllTags ? 'show fewer' : `+${hidden} more`)
        : null);

    mount(host,
      showSearch
        ? labelled('Search', el('input', {
          type: 'text',
          placeholder: 'statement, answer, notes, problem number…',
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

      el('div.row',
        labelled('Textbook', select(
          [{ value: '', label: 'Any' }, ...current.books],
          {
            value: filters.book,
            onchange: (event) => {
              filters.book = event.target.value;
              if (filters.section && !sectionsFor(filters.book).includes(filters.section)) filters.section = '';
              render();
              fire();
            },
          },
        )),
        labelled('Section', select(
          [{ value: '', label: 'Any' }, ...sectionsFor(filters.book)],
          {
            value: filters.section,
            onchange: (event) => {
              filters.section = event.target.value;
              fire();
            },
          },
        ))),

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

      el('div.field-label', { style: { marginTop: '.7rem' } }, 'Tags'),
      tagChips,

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
