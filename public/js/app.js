// Router and boot. Facets and meta are fetched once and shared with the views,
// since the filter controls in several screens are built from them.

import { api } from './api.js';
import { el, mount, toast } from './dom.js';
import { buildView } from './view-build.js';
import { bankView } from './view-bank.js';
import { setsView } from './view-sets.js';
import { templatesView } from './view-templates.js';
import { initWorkspace, scrubTokenFromUrl } from './workspace.js';

const ROUTES = {
  build: buildView,
  bank: bankView,
  sets: setsView,
  templates: templatesView,
};

const root = document.getElementById('view');
const context = { facets: null, meta: null, workspace: null };

function currentRoute() {
  const name = (location.hash || '#/build').replace(/^#\/?/, '').split('/')[0];
  return Object.prototype.hasOwnProperty.call(ROUTES, name) ? name : 'build';
}

function navigate(name) {
  if (currentRoute() === name) {
    render();
    return;
  }
  location.hash = `#/${name}`;
}

function markActiveTab(name) {
  for (const link of document.querySelectorAll('#tabs a')) {
    link.classList.toggle('active', link.dataset.route === name);
  }
}

async function reloadFacets() {
  context.facets = await api.facets();
}

async function render() {
  const name = currentRoute();
  markActiveTab(name);
  mount(root, el('div.spinner', 'Loading…'));
  try {
    await ROUTES[name](root, { ...context, navigate, reloadFacets });
  } catch (error) {
    mount(root, el('div.panel',
      el('div.notice.error',
        el('strong', 'This screen failed to load. '),
        error.message)));
    // The stack is worth keeping for anyone with the console open.
    console.error(error);
  }
}

function renderPdfStatus() {
  const host = document.getElementById('pdf-status');
  const { available, disabled } = context.meta.pdf;

  // Three states, and saying the right one matters: "off by choice" is not the
  // same problem as "TeX isn't installed".
  let label = 'PDF ready';
  let explanation = 'A LaTeX engine was found — PDFs are compiled locally.';
  if (disabled) {
    label = 'PDF off';
    explanation = 'Building PDFs is switched off on this server, because templates are '
      + 'LaTeX you can edit. Download the .tex file, or use Print.';
  } else if (!available) {
    label = 'no LaTeX engine';
    explanation = 'No latexmk/pdflatex/tectonic on PATH. Download .tex files, or print from the browser.';
  }

  mount(host, el('span', { class: `dot ${available ? 'on' : 'off'}` }), label);
  host.title = explanation;
}

async function boot() {
  try {
    // The workspace call comes first: hosted, it is what mints the cookie, and
    // every later request needs to be attributed to the same bank.
    context.workspace = await api.workspace();
    scrubTokenFromUrl();
    [context.meta, context.facets] = await Promise.all([api.meta(), api.facets()]);
  } catch (error) {
    mount(root, el('div.panel', el('div.notice.error',
      el('strong', 'Could not reach the server. '),
      `${error.message} — is it still running?`)));
    return;
  }
  renderPdfStatus();
  initWorkspace(context.workspace);
  window.addEventListener('hashchange', render);
  await render();

  if (context.facets.total === 0) {
    toast('The bank is empty. Run "npm run seed" for starter problems, or add your own.');
  }
}

boot();
