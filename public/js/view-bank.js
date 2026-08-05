// "Problem bank": browse, edit, and add problems, including the parameterised
// template problems that generate unlimited variants.

import { api, links } from './api.js';
import {
  el, mount, labelled, select, rich, toast, attempt, modal, confirmAction, excerpt, datalist,
} from './dom.js';
import { filterPanel, emptyFilters, toQuery } from './filters.js';

const HELPER_HINT = 'Helpers: frac(a,b) · radical(n) · signed(n) → “+ 3” / “− 3” · '
  + 'coef(a,"x") → “3x”, “x”, “−x” · term(a,"x") → “+ 3x” · fmt(x,2) · sqrt, gcd, sin, cos, …';

const EXAMPLE_PARAMS = `{
  "vars": {
    "a": { "type": "int", "min": 2, "max": 9 },
    "x": { "type": "int", "min": -9, "max": 9, "exclude": [0] },
    "b": { "type": "int", "min": -12, "max": 12, "exclude": [0] },
    "c": { "type": "expr", "expr": "a*x + b" }
  },
  "constraints": ["a != 1"]
}`;

export async function bankView(root, { facets, reloadFacets }) {
  const filters = emptyFilters();
  const listHost = el('div.list');
  const summary = el('div.count');
  let page = { limit: 40, offset: 0, total: 0 };
  let sort = 'recent';

  async function search(reset = true) {
    if (reset) page.offset = 0;
    mount(listHost, el('div.spinner', 'Loading…'));
    const payload = await attempt(
      () => api.problems.list({
        ...toQuery(filters), render: 1, sort, limit: page.limit, offset: page.offset,
      }),
      { failure: 'Could not load the bank' },
    );
    if (!payload) return;
    page.total = payload.total;

    const shown = page.offset + payload.items.length;
    summary.textContent = payload.total === 0
      ? 'No problems match'
      : `${page.offset + 1}–${shown} of ${payload.total}`;

    if (payload.items.length === 0) {
      mount(listHost, el('div.empty', 'No problems match those filters.'));
      return;
    }

    mount(listHost,
      payload.items.map(problemCard),
      el('div.btn-row', { style: { justifyContent: 'center', marginTop: '.5rem' } },
        el('button.tiny', {
          disabled: page.offset === 0,
          onclick: () => {
            page.offset = Math.max(0, page.offset - page.limit);
            search(false);
          },
        }, '← Previous'),
        el('button.tiny', {
          disabled: shown >= payload.total,
          onclick: () => {
            page.offset += page.limit;
            search(false);
          },
        }, 'Next →')));
  }

  function problemCard(problem) {
    return el('div.card',
      el('div.card-head',
        el('div.card-meta',
          el('span.badge', { class: `d${problem.difficulty}` }, `difficulty ${problem.difficulty}`),
          problem.kind === 'template' ? el('span.badge.template', 'generated') : null,
          el('span', [problem.subject, problem.topic, problem.subtopic].filter(Boolean).join(' · ')),
          problem.source_book ? el('span', problem.source_book) : null,
          problem.source_section ? el('span', `§${problem.source_section}`) : null,
          problem.source_number ? el('span', `#${problem.source_number}`) : null),
        el('div.card-actions',
          el('button.tiny', { onclick: () => openEditor(problem) }, 'Edit'),
          el('button.tiny', {
            title: 'Copy as a new problem',
            onclick: () => openEditor({ ...problem, id: undefined, external_key: null }),
          }, 'Duplicate'),
          el('button.tiny.danger', {
            onclick: async () => {
              if (!confirmAction('Delete this problem? Sets that use it will lose it too.')) return;
              await attempt(() => api.problems.remove(problem.id));
              toast('Problem deleted.');
              await search(false);
            },
          }, 'Delete'))),
      el('div.card-body',
        problem.html && problem.html.error
          ? el('div.notice.error', `Template error: ${problem.html.error}`)
          : rich(problem.html ? problem.html.statement : excerpt(problem.statement))),
      problem.html && problem.html.answer
        ? el('div.item-answer', el('strong', 'Answer: '), rich(problem.html.answer))
        : null,
      problem.tags.length
        ? el('div.chips', { style: { marginTop: '.4rem' } },
          problem.tags.map((tag) => el('span.chip.chip-static', tag)))
        : null);
  }

  // ---------- editor ----------

  function openEditor(problem = {}) {
    const isNew = !problem.id;
    const previewHost = el('div');
    const fields = {};

    const input = (key, props = {}) => {
      const node = el('input', { type: 'text', value: problem[key] ?? '', ...props });
      fields[key] = node;
      return node;
    };
    const area = (key, props = {}) => {
      const node = el('textarea', { value: problem[key] ?? '', ...props });
      fields[key] = node;
      return node;
    };

    fields.difficulty = select([1, 2, 3, 4, 5], { value: problem.difficulty || 3 });
    fields.kind = select(
      [{ value: 'static', label: 'Fixed problem' }, { value: 'template', label: 'Generated from a template' }],
      {
        value: problem.kind || 'static',
        onchange: () => {
          paramsBlock.style.display = fields.kind.value === 'template' ? '' : 'none';
        },
      },
    );

    fields.params = el('textarea', {
      rows: 12,
      value: problem.params && Object.keys(problem.params).length
        ? JSON.stringify(problem.params, null, 2)
        : EXAMPLE_PARAMS,
    });

    const paramsBlock = el('div',
      { style: { display: (problem.kind || 'static') === 'template' ? '' : 'none' } },
      labelled('Parameters (JSON)', fields.params,
        'Types: int · decimal · choice · expr. Add "constraints" to reject bad draws, '
        + 'e.g. ["b*b - 4*a*c > 0"].'));

    function collect() {
      let params = {};
      if (fields.kind.value === 'template') {
        try {
          params = JSON.parse(fields.params.value || '{}');
        } catch (error) {
          throw new Error(`Parameters are not valid JSON: ${error.message}`);
        }
      }
      return {
        subject: fields.subject.value,
        topic: fields.topic.value,
        subtopic: fields.subtopic.value,
        difficulty: Number(fields.difficulty.value),
        kind: fields.kind.value,
        statement: fields.statement.value,
        answer: fields.answer.value,
        solution: fields.solution.value,
        params,
        tags: fields.tags.value.split(',').map((tag) => tag.trim()).filter(Boolean),
        source_book: fields.source_book.value,
        source_edition: fields.source_edition.value,
        source_chapter: fields.source_chapter.value,
        source_section: fields.source_section.value,
        source_number: fields.source_number.value,
        notes: fields.notes.value,
        external_key: problem.external_key || null,
      };
    }

    async function preview() {
      let draft;
      try {
        draft = collect();
      } catch (error) {
        mount(previewHost, el('div.notice.error', error.message));
        return;
      }
      const count = draft.kind === 'template' ? 3 : 1;
      const payload = await attempt(() => api.problems.previewDraft(draft, { count }));
      if (!payload) return;

      mount(previewHost, payload.instances.map((instance, index) => (instance.ok
        ? el('div.card',
          el('div.card-meta', `Sample ${index + 1}`, el('span.mono', `seed ${instance.seed}`)),
          el('div.card-body', rich(instance.html.statement)),
          instance.html.answer
            ? el('div.item-answer', el('strong', 'Answer: '), rich(instance.html.answer))
            : null,
          instance.html.solution
            ? el('div.item-answer', el('strong', 'Solution: '), rich(instance.html.solution))
            : null)
        : el('div.notice.error', instance.error))));
    }

    async function save() {
      let draft;
      try {
        draft = collect();
      } catch (error) {
        toast(error.message, 'error');
        return;
      }
      if (!draft.statement.trim()) {
        toast('A problem needs a statement.', 'error');
        return;
      }
      const payload = await attempt(
        () => (isNew ? api.problems.create(draft) : api.problems.update(problem.id, draft)),
        { failure: 'Could not save' },
      );
      if (!payload) return;
      if (payload.check && !payload.check.ok) {
        toast(`Saved, but the template fails to generate: ${payload.check.error}`, 'error');
      } else {
        toast(isNew ? 'Problem added.' : 'Problem saved.');
      }
      handle.close();
      await reloadFacets();
      await search(false);
    }

    const form = el('div.split',
      el('div',
        el('div.row',
          labelled('Subject', input('subject', { list: 'subjects-list' })),
          labelled('Difficulty', fields.difficulty)),
        el('div.row',
          labelled('Topic', input('topic', { list: 'topics-list' })),
          labelled('Subtopic', input('subtopic'))),
        labelled('Type', fields.kind),
        labelled('Statement (LaTeX)', area('statement', { rows: 5 }),
          'Use $…$ for inline math. In a template, {{ }} holds an expression: '
          + '$ {{coef(a,\'x\')}} {{signed(b)}} = {{c}} $'),
        labelled('Answer (LaTeX)', area('answer', { rows: 2 })),
        labelled('Worked solution (LaTeX)', area('solution', { rows: 4 }),
          'Shown on lesson notes and the worked-solutions key.'),
        paramsBlock,
        el('p.hint', HELPER_HINT),
        el('fieldset',
          el('legend', 'Textbook reference'),
          el('div.row',
            labelled('Book', input('source_book', { list: 'books-list' })),
            labelled('Edition', input('source_edition'))),
          el('div.row',
            labelled('Chapter', input('source_chapter')),
            labelled('Section', input('source_section')),
            labelled('Problem #', input('source_number')))),
        labelled('Tags', input('tags', {
          value: (problem.tags || []).join(', '),
          placeholder: 'factoring, quadratics, drill',
        })),
        labelled('Private notes', area('notes', { rows: 2 }),
          'Never printed — reminders to yourself.')),
      el('div',
        el('div.panel-head',
          el('h2', 'Preview'),
          el('button.tiny', { onclick: preview }, 'Refresh preview')),
        previewHost));

    const handle = modal(isNew ? 'New problem' : 'Edit problem', form, {
      footer: el('div.btn-row.end', { style: { marginTop: '1rem' } },
        el('button', { onclick: () => handle.close() }, 'Cancel'),
        el('button.primary', { onclick: save }, isNew ? 'Add to bank' : 'Save changes')),
    });

    preview();
  }

  // ---------- import / export ----------

  function openImport() {
    const area = el('textarea', {
      rows: 14,
      placeholder: '[{ "subject": "Algebra 1", "topic": "…", "statement": "…", "answer": "…" }]',
    });
    const fileInput = el('input', {
      type: 'file',
      accept: '.json,application/json',
      onchange: async (event) => {
        const file = event.target.files[0];
        if (file) area.value = await file.text();
      },
    });

    const handle = modal('Import problems',
      el('div',
        el('p.hint', 'Paste a JSON array, or choose a file exported from this app. '
          + 'Problems carrying an "external_key" that already exists are updated in place '
          + 'rather than duplicated.'),
        fileInput,
        el('div', { style: { marginTop: '.6rem' } }, area)),
      {
        footer: el('div.btn-row.end', { style: { marginTop: '1rem' } },
          el('button', { onclick: () => handle.close() }, 'Cancel'),
          el('button.primary', {
            onclick: async () => {
              let parsed;
              try {
                parsed = JSON.parse(area.value);
              } catch (error) {
                toast(`Not valid JSON: ${error.message}`, 'error');
                return;
              }
              const list = Array.isArray(parsed) ? parsed : parsed.problems;
              const payload = await attempt(() => api.problems.import(list), { failure: 'Import failed' });
              if (!payload) return;
              toast(`Imported: ${payload.created} added, ${payload.updated} updated`
                + (payload.errors.length ? `, ${payload.errors.length} failed` : '') + '.');
              handle.close();
              await reloadFacets();
              await search();
            },
          }, 'Import')),
      });
  }

  // ---------- assemble ----------

  const panel = filterPanel({ facets, filters, onchange: () => search() });

  mount(root,
    datalist('subjects-list', facets.subjects),
    datalist('topics-list', [...new Set(facets.topics.map((entry) => entry.topic))]),
    datalist('books-list', facets.books),
    el('div.split',
      el('div.panel.sticky-panel',
        el('h2', 'Filter'),
        panel.node,
        el('hr', { style: { border: 0, borderTop: '1px solid var(--line)', margin: '.9rem 0' } }),
        labelled('Sort by', select(
          [
            { value: 'recent', label: 'Recently updated' },
            { value: 'textbook', label: 'Textbook order' },
            { value: 'difficulty', label: 'Difficulty' },
            { value: 'topic', label: 'Subject and topic' },
          ],
          {
            value: sort,
            onchange: (event) => {
              sort = event.target.value;
              search();
            },
          },
        )),
        el('div.btn-row',
          el('button.tiny', { onclick: openImport }, 'Import…'),
          el('a.btn.tiny', { href: links.exportBank(toQuery(filters)) }, 'Export'))),
      el('div',
        el('div.panel-head',
          el('h2', 'Problems'),
          el('div.btn-row',
            summary,
            el('button.primary', { onclick: () => openEditor() }, '+ New problem'))),
        listHost)));

  await search();
}
