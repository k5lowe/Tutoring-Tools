// "Saved sets": every set you have built, ready to reprint or reshuffle.

import { api, links } from './api.js';
import { el, mount, toast, attempt, confirmAction } from './dom.js';
import { LAST_SET_KEY } from './view-build.js';

export async function setsView(root, { meta, navigate }) {
  const listHost = el('div.list');

  async function refresh() {
    mount(listHost, el('div.spinner', 'Loading…'));
    const payload = await attempt(() => api.sets.list(), { failure: 'Could not load sets' });
    if (!payload) return;

    if (payload.sets.length === 0) {
      mount(listHost, el('div.empty', 'No saved sets yet. Build one from the “Build a set” tab.'));
      return;
    }

    mount(listHost, payload.sets.map((set) => {
      const single = { kind: 'practice' };
      const bundle = { kinds: 'practice,answers', versions: set.versions > 1 ? 'all' : undefined };
      return el('div.card',
        el('div.card-head',
          el('div',
            el('strong', set.title),
            el('div.card-meta', { style: { marginTop: '.25rem' } },
              el('span', `${set.item_count} problem${set.item_count === 1 ? '' : 's'}`),
              set.subject ? el('span', set.subject) : null,
              set.versions > 1 ? el('span.badge', `${set.versions} versions`) : null,
              el('span.badge', set.numbering),
              el('span', `updated ${set.updated_at}`))),
          el('div.card-actions',
            el('button.tiny.primary', {
              onclick: () => {
                localStorage.setItem(LAST_SET_KEY, String(set.id));
                navigate('build');
              },
            }, 'Open'),
            el('a.btn.tiny', { href: links.print(set.id, single), target: '_blank' }, 'Print ↗'),
            el('a.btn.tiny', { href: links.tex(set.id, bundle) }, '.tex'),
            meta.pdf.available
              ? el('a.btn.tiny', { href: links.pdf(set.id, single), target: '_blank' }, 'PDF')
              : null,
            el('button.tiny', {
              title: 'Copy this set, then reshuffle for a fresh worksheet',
              onclick: async () => {
                const payloadCopy = await attempt(() => api.sets.duplicate(set.id));
                if (!payloadCopy) return;
                toast(`Duplicated as “${payloadCopy.set.title}”.`);
                await refresh();
              },
            }, 'Duplicate'),
            el('button.tiny', {
              title: 'New numbers for every generated problem',
              onclick: async () => {
                await attempt(() => api.sets.reseed(set.id));
                toast('Regenerated. Same problems, new numbers.');
              },
            }, '⟳'),
            el('button.tiny.danger', {
              onclick: async () => {
                if (!confirmAction(`Delete “${set.title}”?`)) return;
                await attempt(() => api.sets.remove(set.id));
                if (localStorage.getItem(LAST_SET_KEY) === String(set.id)) {
                  localStorage.removeItem(LAST_SET_KEY);
                }
                await refresh();
              },
            }, 'Delete'))));
    }));
  }

  mount(root, el('div.panel',
    el('div.panel-head',
      el('h2', 'Saved sets'),
      el('p.hint', { style: { margin: 0 } },
        'Duplicate a set and press ⟳ to hand the same worksheet to a different student with different numbers.')),
    listHost));

  await refresh();
}
