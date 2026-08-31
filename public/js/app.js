// Boot and routing.
//
// Two screens now: a home page of subject cards, and the bank itself. The route
// lives in the hash so the back button works and a filtered view can be linked
// to or bookmarked — "#/browse?subject=Calculus%202" reopens exactly where you
// were.

import { api } from './api.js';
import { el, mount, toast } from './dom.js';
import { bankView } from './view-bank.js';
import { homeView } from './view-home.js';

const root = document.getElementById('view');
const context = { facets: null, meta: null };

/** Read the hash into { name, params }. Anything unrecognised means home. */
function currentRoute() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, search] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(search || ''));
  return { name: path === 'browse' ? 'browse' : 'home', params };
}

function go(hash) {
  if (window.location.hash === hash) render();
  else window.location.hash = hash;
}

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
  const route = currentRoute();
  // The home page is a white ground with coloured cards; the bank is the dense
  // working surface. A class on <body> lets the stylesheet tell them apart.
  document.body.classList.toggle('on-home', route.name === 'home');

  mount(root, el('div.spinner', 'Loading…'));
  try {
    if (route.name === 'home') {
      homeView(root, {
        facets: context.facets,
        onOpen: (subject) => go(subject ? `#/browse?subject=${encodeURIComponent(subject)}` : '#/browse'),
      });
    } else {
      await bankView(root, {
        ...context, reloadFacets, refreshMeta, initialFilters: route.params,
      });
    }
  } catch (error) {
    mount(root, el('div.panel',
      el('div.notice.error',
        el('strong', 'The bank failed to load. '),
        error.message)));
    // The stack is worth keeping for anyone with the console open.
    console.error(error);
  }
}

/** The brand in the top bar is the way home, so it has to behave like a link. */
function wireBrand() {
  const brand = document.querySelector('.brand');
  if (!brand) return;
  brand.addEventListener('click', (event) => {
    event.preventDefault();
    go('#/');
  });
  brand.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      go('#/');
    }
  });
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

  wireBrand();
  window.addEventListener('hashchange', render);
  await render();

  if (context.facets.total === 0 && context.meta.canEditBank) {
    toast('The bank is empty. Run "npm run seed" for starter questions, or add your own.');
  }
}

boot();
