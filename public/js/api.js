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

  admin: {
    status: () => request('GET', '/api/admin'),
    unlock: (key) => request('POST', '/api/admin/unlock', { key }),
    lock: () => request('POST', '/api/admin/lock'),
  },

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




};

/** Download URLs are plain links so the browser handles the file itself. */
export const links = {
  exportBank: (filters) => `/api/problems/export${query(filters)}`,
};
