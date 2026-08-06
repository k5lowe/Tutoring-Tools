// Boot. There is one screen — the bank — so there is no router any more.

import { api } from './api.js';
import { el, mount, toast } from './dom.js';
import { bankView } from './view-bank.js';

const root = document.getElementById('view');
const context = { facets: null, meta: null };

/** Re-read the filter vocabulary and hand it back, so the panel can take it. */
async function reloadFacets() {
  context.facets = await api.facets();
  return context.facets;
}

/** Re-read server state that can change mid-session, then redraw. */
async function refreshMeta() {
  context.meta = await api.meta();
  await render();
}

async function render() {
  mount(root, el('div.spinner', 'Loading…'));
  try {
    await bankView(root, { ...context, reloadFacets, refreshMeta });
  } catch (error) {
    mount(root, el('div.panel',
      el('div.notice.error',
        el('strong', 'The bank failed to load. '),
        error.message)));
    // The stack is worth keeping for anyone with the console open.
    console.error(error);
  }
}

async function boot() {
  try {
    [context.meta, context.facets] = await Promise.all([api.meta(), api.facets()]);
  } catch (error) {
    mount(root, el('div.panel', el('div.notice.error',
      el('strong', 'Could not reach the server. '),
      `${error.message} — is it still running?`)));
    return;
  }
  await render();

  if (context.facets.total === 0 && context.meta.canEditBank) {
    toast('The bank is empty. Run "npm run seed" for starter questions, or add your own.');
  }
}

boot();
