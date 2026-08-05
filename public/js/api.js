// Thin wrapper over fetch: unwraps JSON and turns error responses into throws
// carrying the server's message, so callers can just try/catch.

async function request(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  if (response.status === 204) return null;

  const isJson = (response.headers.get('content-type') || '').includes('json');
  const payload = isJson ? await response.json() : await response.text();
  if (!response.ok) {
    const message = isJson && payload && payload.error ? payload.error : `${response.status} ${response.statusText}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

/** Build a query string, dropping empty values and joining arrays. */
export function query(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const api = {
  meta: () => request('GET', '/api/meta'),
  facets: () => request('GET', '/api/problems/facets'),
  workspace: () => request('GET', '/api/workspace'),

  problems: {
    list: (filters) => request('GET', `/api/problems${query(filters)}`),
    get: (id) => request('GET', `/api/problems/${id}`),
    create: (problem) => request('POST', '/api/problems', problem),
    update: (id, problem) => request('PUT', `/api/problems/${id}`, problem),
    remove: (id) => request('DELETE', `/api/problems/${id}`),
    preview: (id, options) => request('GET', `/api/problems/${id}/preview${query(options)}`),
    previewDraft: (problem, options = {}) => request('POST', '/api/problems/preview', { problem, ...options }),
    import: (problems) => request('POST', '/api/problems/import', { problems }),
  },

  sets: {
    list: () => request('GET', '/api/sets'),
    get: (id, options) => request('GET', `/api/sets/${id}${query(options)}`),
    create: (set) => request('POST', '/api/sets', set),
    update: (id, set) => request('PUT', `/api/sets/${id}`, set),
    remove: (id) => request('DELETE', `/api/sets/${id}`),
    duplicate: (id, title) => request('POST', `/api/sets/${id}/duplicate`, { title }),
    generate: (spec) => request('POST', '/api/sets/generate', spec),
    addItems: (id, problemIds) => request('POST', `/api/sets/${id}/items`, { problem_ids: problemIds }),
    generateItems: (id, spec) => request('POST', `/api/sets/${id}/items/generate`, spec),
    updateItem: (id, itemId, patch) => request('PATCH', `/api/sets/${id}/items/${itemId}`, patch),
    removeItem: (id, itemId) => request('DELETE', `/api/sets/${id}/items/${itemId}`),
    moveItem: (id, itemId, to) => request('POST', `/api/sets/${id}/items/${itemId}/move`, { to }),
    sort: (id, by) => request('POST', `/api/sets/${id}/sort`, { by }),
    reseed: (id, itemIds) => request('POST', `/api/sets/${id}/reseed`, { item_ids: itemIds }),
  },

  templates: {
    list: (kind) => request('GET', `/api/templates${query({ kind })}`),
    get: (id) => request('GET', `/api/templates/${id}`),
    create: (template) => request('POST', '/api/templates', template),
    update: (id, template) => request('PUT', `/api/templates/${id}`, template),
    remove: (id) => request('DELETE', `/api/templates/${id}`),
    setDefault: (id) => request('POST', `/api/templates/${id}/default`),
    reset: (id) => request('POST', `/api/templates/${id}/reset`),
  },

  render: {
    set: (id, options) => request('GET', `/api/render/sets/${id}${query(options)}`),
    preview: (payload) => request('POST', '/api/render/preview', payload),
  },

  pdfStatus: () => request('GET', '/api/render/pdf-status'),
};

/** Download URLs are plain links so the browser handles the file itself. */
export const links = {
  tex: (setId, options) => `/download/${setId}/tex${query(options)}`,
  pdf: (setId, options) => `/download/${setId}/pdf${query(options)}`,
  print: (setId, options) => `/print/${setId}${query(options)}`,
  exportBank: (filters) => `/api/problems/export${query(filters)}`,
};
