'use strict';

const katex = require('katex');

/**
 * Best-effort LaTeX -> HTML for the in-browser print preview.
 *
 * Math is the part that has to be right, and KaTeX handles that. Around the
 * math we support the small set of text commands that actually show up in
 * problem statements. Anything else is passed through as literal text rather
 * than silently dropped, so it is obvious in preview that a command needs a
 * real LaTeX build.
 *
 * The authoritative output is always the .tex file; this is for eyeballing and
 * for printing straight from the browser when no TeX install is around.
 */

const MATH_ENVIRONMENTS = [
  'align', 'align*', 'aligned', 'gather', 'gather*', 'gathered',
  'equation', 'equation*', 'multline', 'multline*', 'split',
];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderMath(source, displayMode) {
  try {
    return katex.renderToString(source, {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'html',
    });
  } catch (error) {
    return `<code class="math-error" title="${escapeHtml(error.message)}">${escapeHtml(source)}</code>`;
  }
}

/**
 * Split input into text and math segments.
 * Recognises $...$, $$...$$, \(...\), \[...\] and the display environments
 * listed above.
 */
function segment(source) {
  const segments = [];
  let text = '';
  let i = 0;

  const flushText = () => {
    if (text) {
      segments.push({ type: 'text', value: text });
      text = '';
    }
  };

  while (i < source.length) {
    const rest = source.slice(i);

    // Escaped dollar / backslash: keep verbatim, never treat as a delimiter.
    if (rest.startsWith('\\$') || rest.startsWith('\\\\')) {
      text += rest.slice(0, 2);
      i += 2;
      continue;
    }

    const envMatch = /^\\begin\{([a-z*]+)\}/i.exec(rest);
    if (envMatch && MATH_ENVIRONMENTS.includes(envMatch[1])) {
      const name = envMatch[1];
      const closing = `\\end{${name}}`;
      const end = source.indexOf(closing, i);
      if (end !== -1) {
        flushText();
        segments.push({ type: 'math', display: true, value: source.slice(i, end + closing.length) });
        i = end + closing.length;
        continue;
      }
    }

    if (rest.startsWith('$$') || rest.startsWith('\\[')) {
      const open = rest.startsWith('$$') ? '$$' : '\\[';
      const close = open === '$$' ? '$$' : '\\]';
      const end = source.indexOf(close, i + open.length);
      if (end !== -1) {
        flushText();
        segments.push({ type: 'math', display: true, value: source.slice(i + open.length, end) });
        i = end + close.length;
        continue;
      }
    }

    if (rest.startsWith('$') || rest.startsWith('\\(')) {
      const open = rest.startsWith('$') ? '$' : '\\(';
      const close = open === '$' ? '$' : '\\)';
      let end = -1;
      for (let j = i + open.length; j < source.length; j += 1) {
        if (source[j] === '\\') {
          j += 1;
          continue;
        }
        if (source.startsWith(close, j)) {
          end = j;
          break;
        }
      }
      if (end !== -1) {
        flushText();
        segments.push({ type: 'math', display: false, value: source.slice(i + open.length, end) });
        i = end + close.length;
        continue;
      }
    }

    text += source[i];
    i += 1;
  }

  flushText();
  return segments;
}

const SIMPLE_COMMANDS = [
  [/\\textbf\{([^{}]*)\}/g, '<strong>$1</strong>'],
  [/\\textit\{([^{}]*)\}/g, '<em>$1</em>'],
  [/\\emph\{([^{}]*)\}/g, '<em>$1</em>'],
  [/\\underline\{([^{}]*)\}/g, '<u>$1</u>'],
  [/\\texttt\{([^{}]*)\}/g, '<code>$1</code>'],
  [/\\textsc\{([^{}]*)\}/g, '<span class="smallcaps">$1</span>'],
  [/\\text\{([^{}]*)\}/g, '$1'],
];

const LITERALS = [
  [/\\%/g, '%'], [/\\&/g, '&amp;'], [/\\#/g, '#'], [/\\_/g, '_'],
  [/\\\$/g, '$'], [/\\\{/g, '{'], [/\\\}/g, '}'],
  [/\\ldots/g, '&hellip;'], [/\\dots/g, '&hellip;'],
  [/\\degree/g, '&deg;'], [/\\circ/g, '&deg;'],
  [/\\quad/g, '<span class="quad"></span>'],
  [/\\qquad/g, '<span class="qquad"></span>'],
  [/\\noindent/g, ''], [/\\centering/g, ''], [/\\par\b/g, '</p><p>'],
  [/\\vspace\*?\{[^{}]*\}/g, '<span class="vspace"></span>'],
  [/\\hspace\*?\{[^{}]*\}/g, '<span class="quad"></span>'],
  [/\\hfill/g, '<span class="hfill"></span>'],
  [/\\medskip|\\smallskip|\\bigskip/g, '<span class="vspace"></span>'],
  [/~/g, '&nbsp;'],
];

/** Convert a run of non-math LaTeX into HTML. */
function textToHtml(source) {
  let out = escapeHtml(source);

  // Lists. Handled before inline commands so \item boundaries stay intact.
  out = out.replace(
    /\\begin\{(enumerate|itemize)\}(\[[^\]]*\])?([\s\S]*?)\\end\{\1\}/g,
    (match, kind, _options, body) => {
      const items = body
        .split(/\\item\b/)
        .slice(1)
        .map((item) => `<li>${item.trim()}</li>`)
        .join('');
      const tag = kind === 'enumerate' ? 'ol' : 'ul';
      return `<${tag} class="tex-list">${items}</${tag}>`;
    },
  );

  for (const [pattern, replacement] of SIMPLE_COMMANDS) {
    // Twice, so one level of nesting (\textbf{\textit{x}}) resolves.
    out = out.replace(pattern, replacement).replace(pattern, replacement);
  }
  for (const [pattern, replacement] of LITERALS) {
    out = out.replace(pattern, replacement);
  }

  out = out.replace(/---/g, '&mdash;').replace(/--/g, '&ndash;');
  out = out.replace(/\\\\\s*(\[[^\]]*\])?/g, '<br>');
  out = out.replace(/\n{2,}/g, '</p><p>');

  return out;
}

/** Convert a LaTeX fragment (a problem statement, say) to HTML. */
function fragmentToHtml(source) {
  if (!source) return '';
  return segment(String(source))
    .map((part) => (part.type === 'math' ? renderMath(part.value, part.display) : textToHtml(part.value)))
    .join('');
}

/** KaTeX's stylesheet, inlined so the preview works offline. */
function katexStylesheetPath() {
  return require.resolve('katex/dist/katex.min.css');
}

module.exports = { fragmentToHtml, renderMath, segment, escapeHtml, katexStylesheetPath };
