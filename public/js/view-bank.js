// The question bank — the whole app.
//
// Anyone can browse, filter and search it, and work through questions with the
// answer hidden until they ask for it. Generated questions can be re-rolled for
// fresh numbers, which is where the practice really comes from. Only the owner
// sees the editing controls.

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

// Shown in the empty "Write questions" box: a working example is a faster
// explanation than prose, and it can be edited straight into a real batch.
const WRITE_PLACEHOLDER = `@ Algebra 1 > Factoring > Monic trinomials | d2 | tags: factoring

Q: Factor completely: $x^2 - 5x - 14$
A: $(x-7)(x+2)$
S: Two numbers with product $-14$ and sum $-5$: $-7$ and $2$.
---
Q: Factor completely: $x^2 + 9x + 20$
A: $(x+4)(x+5)$`;

const FORMAT_HELP = `@  sets subject > topic > subtopic and the defaults below it
   @ Algebra 1 > Factoring | d2 | tags: drill | book: Course Packet | section: 4.6
   A later @ line changes only what it mentions, so "@ | d5" keeps the topic.

Q: the question      A: the answer      S: worked solution
D: difficulty 1-5    N: problem number  K: a stable key, for re-importing
---  ends a question (a new "Q:" ends one too)

Anything else continues the field above it, so questions can run over several
lines and have paragraphs. Backslashes are literal: write \\frac{1}{2}, not
\\\\frac{1}{2}.

Generated questions declare their numbers with V: lines and any conditions
with C: lines. The answer is computed, so it cannot disagree with the question.

   Q: Solve for $x$: $ {{coef(a,'x')}} {{signed(b)}} = {{c}} $
   A: $x = {{x}}$
   V: a = int 2..9
   V: x = int -9..9 except 0
   V: b = int -12..12 except 0
   V: c = expr a*x + b
   C: a != 1

Variables:  int 1..10 except 5, 6 step 2   ·   decimal 0.5..4 step 0.5
            choice 3, 4, "square"          ·   expr n*(n+1)/2`;

export async function bankView(root, { facets, meta, reloadFacets, refreshMeta }) {
  const canEdit = Boolean(meta.canEditBank);
  const filters = emptyFilters();
  const listHost = el('div.list');
  const summary = el('div.count');
  const page = { limit: 25, offset: 0, total: 0 };
  let sort = 'topic';
  // Answers stay hidden by default: the bank is for practising from, and a
  // visible answer is no practice at all.
  let revealAll = false;

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
      ? 'No questions match'
      : `${page.offset + 1}–${shown} of ${payload.total}`;

    if (payload.items.length === 0) {
      mount(listHost, el('div.empty', 'No questions match those filters.'));
      return;
    }

    mount(listHost,
      payload.items.map(questionCard),
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

  /** One question, with its answer behind a reveal. */
  function questionCard(problem) {
    const body = el('div.card-body');
    const answerHost = el('div.answer-host');
    let shown = revealAll;

    const revealButton = el('button.tiny', {
      onclick: () => {
        shown = !shown;
        paint();
      },
    });

    function paint(instance) {
      const html = instance ? instance.html : problem.html;
      mount(body, html && html.error
        ? el('div.notice.error', `This question could not be generated: ${html.error}`)
        : rich(html ? html.statement : excerpt(problem.statement)));

      revealButton.textContent = shown ? 'Hide answer' : 'Show answer';
      const hasAnswer = html && (html.answer || html.solution);
      revealButton.style.display = hasAnswer ? '' : 'none';

      if (!shown || !hasAnswer) {
        mount(answerHost);
        return;
      }
      mount(answerHost, el('div.answer-shown',
        html.answer
          ? el('div', el('span.answer-label', 'Answer '), rich(html.answer, 'inline-block'))
          : null,
        html.solution
          ? el('details.solution-details', { open: false },
            el('summary', 'Worked solution'),
            rich(html.solution))
          : null));
    }

    async function reroll() {
      const payload = await attempt(
        () => api.problems.preview(problem.id, { count: 1, seed: Math.floor(Math.random() * 2e9) }),
        { failure: 'Could not generate another version' },
      );
      if (!payload) return;
      const instance = payload.instances[0];
      if (!instance.ok) {
        toast(instance.error, 'error');
        return;
      }
      paint(instance);
    }

    paint();

    return el('div.card',
      el('div.card-head',
        el('div.card-meta',
          el('span.badge', { class: `d${problem.difficulty}` }, `difficulty ${problem.difficulty}`),
          problem.kind === 'template' ? el('span.badge.template', 'generated') : null,
          el('span', [problem.subject, problem.topic, problem.subtopic].filter(Boolean).join(' · ')),
          problem.source_book ? el('span', problem.source_book) : null,
          problem.source_section ? el('span', `§${problem.source_section}`) : null,
          problem.source_number ? el('span', `#${problem.source_number}`) : null),
        canEdit
          ? el('div.card-actions',
            el('button.tiny', { onclick: () => openEditor(problem) }, 'Edit'),
            el('button.tiny', {
              title: 'Copy as a new question',
              onclick: () => openEditor({ ...problem, id: undefined, external_key: null }),
            }, 'Duplicate'),
            el('button.tiny.danger', {
              onclick: async () => {
                if (!confirmAction('Delete this question?')) return;
                await attempt(() => api.problems.remove(problem.id));
                toast('Question deleted.');
                await search(false);
              },
            }, 'Delete'))
          : null),
      body,
      answerHost,
      el('div.card-foot',
        revealButton,
        problem.kind === 'template'
          ? el('button.tiny', { title: 'Same question, new numbers', onclick: reroll }, '↻ New numbers')
          : null,
        problem.tags.length
          ? el('div.chips', problem.tags.map((tag) => el('span.chip.chip-static', tag)))
          : null));
  }

  // ---------- editor (owner only) ----------

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
      [{ value: 'static', label: 'Fixed question' }, { value: 'template', label: 'Generated from a template' }],
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
        toast('A question needs a statement.', 'error');
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
        toast(isNew ? 'Question added.' : 'Question saved.');
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
        labelled('Question (LaTeX)', area('statement', { rows: 5 }),
          'Use $…$ for inline maths. In a template, {{ }} holds an expression: '
          + '$ {{coef(a,\'x\')}} {{signed(b)}} = {{c}} $'),
        labelled('Answer (LaTeX)', area('answer', { rows: 2 })),
        labelled('Worked solution (LaTeX)', area('solution', { rows: 4 }),
          'Shown behind a second reveal, under the answer.'),
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
          'Never shown to anyone browsing the bank.')),
      el('div',
        el('div.panel-head',
          el('h2', 'Preview'),
          el('button.tiny', { onclick: preview }, 'Refresh preview')),
        previewHost));

    const handle = modal(isNew ? 'New question' : 'Edit question', form, {
      footer: el('div.btn-row.end', { style: { marginTop: '1rem' } },
        el('button', { onclick: () => handle.close() }, 'Cancel'),
        el('button.primary', { onclick: save }, isNew ? 'Add to bank' : 'Save changes')),
    });

    preview();
  }

  // ---------- import (owner only) ----------

  /** Finish an import: report what happened, close up and refresh the list. */
  async function finishImport(payload, handle) {
    if (!payload) return;
    toast(`Imported: ${payload.created} added, ${payload.updated} updated`
      + (payload.errors.length ? `, ${payload.errors.length} failed` : '') + '.');
    handle.close();
    await reloadFacets();
    await search();
  }

  /**
   * Writing questions as plain text. This is the fast path for filling the bank:
   * no escaping, no JSON, and the metadata you would otherwise repeat on every
   * question is set once with an `@` line. Nothing is saved until the parse has
   * been checked and the author has seen what came out of it.
   */
  function writeTab(handle) {
    const area = el('textarea.mono', {
      rows: 18,
      spellcheck: false,
      placeholder: WRITE_PLACEHOLDER,
    });
    const resultHost = el('div.scroll-y', { style: { marginTop: '.7rem' } });
    const importButton = el('button.primary', { disabled: true, onclick: doImport }, 'Import');
    // Nothing to import until a check has run; editing the text invalidates it.
    let ready = null;

    function invalidate() {
      ready = null;
      importButton.disabled = true;
      importButton.textContent = 'Import';
    }

    async function check() {
      if (!area.value.trim()) {
        mount(resultHost, el('div.notice', 'Nothing to check yet.'));
        return;
      }
      mount(resultHost, el('div.spinner', 'Checking…'));
      const payload = await attempt(() => api.problems.parse(area.value),
        { failure: 'Could not check the text' });
      if (!payload) {
        mount(resultHost);
        return;
      }

      ready = payload.count > 0 ? payload.questions : null;
      importButton.disabled = !ready;
      importButton.textContent = ready
        ? `Import ${payload.count} question${payload.count === 1 ? '' : 's'}`
        : 'Import';

      mount(resultHost,
        payload.errors.length
          ? el('div.notice.error',
            el('strong', `${payload.errors.length} problem${payload.errors.length === 1 ? '' : 's'} to fix`),
            el('ul', payload.errors.map((error) => el('li', `line ${error.line}: ${error.message}`))))
          : null,
        payload.count === 0
          ? el('div.empty', 'No questions parsed.')
          : el('div.notice',
            `${payload.count} question${payload.count === 1 ? '' : 's'} ready`
            + (payload.errors.length ? ' — the rest are listed above and will not be imported.' : '.')
            + (payload.previewed < payload.count
              ? ` Showing the first ${payload.previewed}; all ${payload.count} were checked `
                + 'and all will be imported.'
              : '')),
        payload.questions.filter((question) => question.preview).map(parsedCard));
    }

    async function doImport() {
      if (!ready) return;
      // `line` is the parser's own bookkeeping; the bank has no column for it.
      const questions = ready.map(({ line, preview: _preview, ...question }) => question);
      const payload = await attempt(() => api.problems.import(questions),
        { failure: 'Import failed' });
      await finishImport(payload, handle);
    }

    return {
      node: el('div',
        el('details.format-help',
          el('summary', 'The format'),
          el('pre.mono', FORMAT_HELP)),
        el('div', { style: { marginTop: '.6rem' } }, area),
        el('div.btn-row', { style: { marginTop: '.5rem' } },
          el('button.tiny', { onclick: check }, 'Check'),
          el('span.hint', { style: { margin: 0 } },
            'Nothing is saved until you import.')),
        resultHost),
      footer: importButton,
      init: () => {
        area.addEventListener('input', invalidate);
        area.focus();
      },
    };
  }

  /** One parsed question, as it will look in the bank. */
  function parsedCard(question, index) {
    const { preview: sample } = question;
    return el('div.card',
      el('div.card-meta',
        el('span.mono', `#${index + 1}`),
        el('span.badge', { class: `d${question.difficulty}` }, `difficulty ${question.difficulty}`),
        question.kind === 'template' ? el('span.badge.template', 'generated') : null,
        el('span', [question.subject, question.topic, question.subtopic].filter(Boolean).join(' · ')),
        question.source_number ? el('span', `#${question.source_number}`) : null),
      sample.ok
        ? el('div',
          el('div.card-body', rich(sample.html.statement)),
          sample.html.answer
            ? el('div.item-answer', el('strong', 'Answer: '), rich(sample.html.answer, 'inline-block'))
            : null)
        : el('div.notice.error', sample.error));
  }

  /** The original path: a JSON array, or a file exported from this bank. */
  function jsonTab(handle) {
    const area = el('textarea.mono', {
      rows: 14,
      spellcheck: false,
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

    return {
      node: el('div',
        el('p.hint', { style: { marginTop: 0 } },
          'Paste a JSON array, or choose a file exported from this bank. Questions '
          + 'carrying an "external_key" that already exists are updated in place rather '
          + 'than duplicated. Note that JSON needs every LaTeX backslash doubled '
          + '("\\\\frac"); the other tab does not.'),
        fileInput,
        el('div', { style: { marginTop: '.6rem' } }, area)),
      footer: el('button.primary', {
        onclick: async () => {
          let parsed;
          try {
            parsed = JSON.parse(area.value);
          } catch (error) {
            toast(`Not valid JSON: ${error.message}`, 'error');
            return;
          }
          const list = Array.isArray(parsed) ? parsed : parsed.problems;
          if (!Array.isArray(list)) {
            toast('Expected a JSON array of questions.', 'error');
            return;
          }
          const payload = await attempt(() => api.problems.import(list), { failure: 'Import failed' });
          await finishImport(payload, handle);
        },
      }, 'Import'),
    };
  }

  function openImport() {
    const body = el('div');
    const footerSlot = el('div');
    const handle = { close: () => dialog.close() };

    const tabs = [
      { label: 'Write questions', build: writeTab },
      { label: 'JSON', build: jsonTab },
    ].map((tab) => ({ ...tab, built: null, button: null }));

    function show(active) {
      for (const tab of tabs) tab.button.classList.toggle('active', tab === active);
      if (!active.built) active.built = active.build(handle);
      mount(body, active.built.node);
      mount(footerSlot, active.built.footer);
      if (active.built.init) active.built.init();
    }

    for (const tab of tabs) {
      tab.button = el('button.tab-button', { onclick: () => show(tab) }, tab.label);
    }

    const dialog = modal('Add questions',
      el('div',
        el('div.tab-row', tabs.map((tab) => tab.button)),
        body),
      {
        footer: el('div.btn-row.end', { style: { marginTop: '1rem' } },
          el('button', { onclick: () => dialog.close() }, 'Cancel'),
          footerSlot),
      });

    show(tabs[0]);
  }

  // ---------- owner sign-in ----------

  function ownerControls() {
    const slot = document.getElementById('owner-slot');
    if (!slot) return;
    if (!meta.adminAvailable) {
      mount(slot);
      return;
    }

    if (canEdit) {
      mount(slot,
        meta.multiUser
          ? el('button.tiny.ws-chip', {
            onclick: async () => {
              await attempt(() => api.admin.lock());
              toast('Signed out. The bank is read-only again.');
              await refreshMeta();
            },
          }, 'Owner · sign out')
          : null);
      return;
    }

    mount(slot, el('button.tiny.ws-chip', {
      onclick: () => {
        const field = el('input', { type: 'password', placeholder: 'Owner key' });
        const handle = modal('Sign in as the owner',
          el('div',
            el('p.hint', { style: { marginTop: 0 } },
              'The bank is read-only for visitors. Enter the owner key to add, edit or '
              + 'import questions.'),
            field),
          {
            footer: el('div.btn-row.end', { style: { marginTop: '1rem' } },
              el('button', { onclick: () => handle.close() }, 'Cancel'),
              el('button.primary', {
                onclick: async () => {
                  const ok = await attempt(() => api.admin.unlock(field.value),
                    { failure: 'Could not sign in' });
                  if (!ok) return;
                  handle.close();
                  toast('Signed in. You can edit the bank.');
                  await refreshMeta();
                },
              }, 'Sign in')),
          });
        field.focus();
      },
    }, 'Owner sign-in'));
  }

  // ---------- assemble ----------

  const panel = filterPanel({ facets, filters, onchange: () => search() });

  mount(root,
    datalist('subjects-list', facets.subjects),
    datalist('topics-list', [...new Set(facets.topics.map((entry) => entry.topic))]),
    datalist('books-list', facets.books),
    el('div.split',
      el('div.panel.sticky-panel',
        el('h2', 'Find questions'),
        panel.node,
        el('hr', { style: { border: 0, borderTop: '1px solid var(--line)', margin: '.9rem 0' } }),
        labelled('Sort by', select(
          [
            { value: 'topic', label: 'Subject and topic' },
            { value: 'difficulty', label: 'Difficulty' },
            { value: 'textbook', label: 'Textbook order' },
            { value: 'recent', label: 'Recently added' },
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
          canEdit ? el('button.tiny', { onclick: openImport }, 'Add many…') : null,
          el('a.btn.tiny', { href: links.exportBank(toQuery(filters)) }, 'Export'))),
      el('div',
        el('div.panel-head',
          el('h2', 'Questions'),
          el('div.btn-row',
            summary,
            el('button.tiny', {
              onclick: (event) => {
                revealAll = !revealAll;
                event.target.textContent = revealAll ? 'Hide all answers' : 'Show all answers';
                search(false);
              },
            }, revealAll ? 'Hide all answers' : 'Show all answers'),
            canEdit
              ? el('button.primary', { onclick: () => openEditor() }, '+ New question')
              : null)),
        listHost)));

  ownerControls();
  await search();
}
