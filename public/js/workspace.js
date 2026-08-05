// The workspace panel, shown only when the app is hosted for several people.
//
// There are no accounts: a bank belongs to whoever holds its link. That is a
// deliberate trade (nobody has to sign up) but it means clearing cookies would
// otherwise lose everything silently. So the link is put in front of the user
// on their first visit, stays reachable from the top bar, and sits next to a
// backup download.

import { api, links } from './api.js';
import { el, mount, modal, toast } from './dom.js';

const SEEN_KEY = 'tutoring-tools:workspace-intro-seen';

function workspaceUrl(token) {
  return `${location.origin}/?w=${encodeURIComponent(token)}`;
}

/**
 * A token in the address bar would end up in screenshots, shared links and
 * browser history. The cookie is already set by the time this runs, so drop it.
 */
export function scrubTokenFromUrl() {
  const url = new URL(location.href);
  if (!url.searchParams.has('w')) return false;
  url.searchParams.delete('w');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  return true;
}

function linkRow(token) {
  const field = el('input.ws-link', {
    type: 'text',
    readonly: true,
    value: workspaceUrl(token),
    onfocus: (event) => event.target.select(),
  });

  const copy = el('button.primary', {
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(field.value);
        toast('Link copied. Bookmark it somewhere safe.');
      } catch {
        // Clipboard access can be refused; selecting the text still works.
        field.select();
        toast('Press Ctrl+C to copy the selected link.');
      }
    },
  }, 'Copy link');

  return el('div.ws-linkrow', field, copy);
}

function panel(workspace) {
  return el('div',
    el('p', 'The problem bank is shared and maintained by whoever runs this site. '
      + 'What is yours are the sets you build and any template changes you make — '
      + 'those belong to this browser, and this link is what gets you back to them.'),
    linkRow(workspace.token),
    el('p.hint', 'Open it on another device to use the same bank there. '
      + 'Treat it like a password: anyone with the link can see and edit your problems.'),
    el('div.notice', { style: { marginTop: '1rem' } },
      el('strong', 'Save it now. '),
      'If you clear your cookies or use private browsing without this link, '
      + 'your saved sets cannot be recovered — not even by us, because only a '
      + 'hashed copy of the token is stored. The problem bank itself is always '
      + 'here; it is your own sets that would be lost.'),
    el('div.btn-row', { style: { marginTop: '.75rem' } },
      el('a.btn', { href: links.exportBank({}), download: 'problem-bank.json' },
        'Download the problem bank'),
      el('a.btn', {
        href: `mailto:?subject=${encodeURIComponent('My Tutoring Tools bank')}`
          + `&body=${encodeURIComponent(workspaceUrl(workspace.token))}`,
      }, 'Email myself the link')),
    el('p.hint', { style: { marginTop: '.75rem' } },
      'The download is a JSON copy of the whole problem bank, yours to keep.'));
}

export function openWorkspacePanel(workspace) {
  const handle = modal('Your workspace', panel(workspace), {
    footer: el('div.btn-row.end', { style: { marginTop: '1rem' } },
      el('button', { onclick: () => handle.close() }, 'Done')),
    onclose: () => localStorage.setItem(SEEN_KEY, '1'),
  });
  return handle;
}

/** Top-bar entry point, plus the one-time nudge on a first visit. */
export function initWorkspace(workspace) {
  const slot = document.getElementById('workspace-slot');
  if (!slot) return;

  // Single-user (running locally): there is nothing to explain or protect.
  if (!workspace || !workspace.multiUser || !workspace.token) {
    mount(slot);
    return;
  }

  mount(slot, el('button.tiny.ws-chip', {
    title: 'Get the link back to this bank',
    onclick: () => openWorkspacePanel(workspace),
  }, 'Your workspace'));

  if (!localStorage.getItem(SEEN_KEY)) {
    openWorkspacePanel(workspace);
  }
}
