'use strict';

const { instantiate } = require('./variants');

/**
 * A plain-text format for writing lots of questions quickly.
 *
 * JSON is a poor authoring format for maths: every backslash has to be doubled,
 * so `\frac` becomes `\\frac` and one slip invalidates the whole file. Here
 * nothing is escaped — a line is taken literally — and the metadata you would
 * otherwise repeat on every question is set once with an `@` line.
 *
 *   @ Algebra 1 > Factoring > Monic trinomials | d2 | tags: factoring, drill
 *
 *   Q: Factor completely: $x^2 - 5x - 14$
 *   A: $(x-7)(x+2)$
 *   S: Two numbers with product $-14$ and sum $-5$: $-7$ and $2$.
 *   ---
 *   Q: Factor completely: $x^2 + 9x + 20$
 *   A: $(x+4)(x+5)$
 *
 * Generated questions declare their variables with `V:` lines, which avoids
 * hand-writing the parameter JSON:
 *
 *   Q: Solve for $x$: $ {{coef(a,'x')}} {{signed(b)}} = {{c}} $
 *   A: $x = {{x}}$
 *   V: a = int 2..9
 *   V: x = int -9..9 except 0
 *   V: b = int -12..12 except 0
 *   V: c = expr a*x + b
 *   C: a != 1
 *
 * Markers, each at the start of a line:
 *   @   set subject/topic/subtopic and defaults for everything below
 *   Q:  the question          A:  the answer         S:  worked solution
 *   V:  a variable            C:  a constraint
 *   D:  difficulty override   N:  problem number     K:  external key
 *   --- end of this question
 * Any other line continues whichever field came last.
 */

const MARKER = /^([QASVCDNK])\s*:\s?/;
const SEPARATOR = /^-{3,}\s*$/;
const CONTEXT = /^@\s*(.*)$/;

/**
 * `int 2..9 except 0, 1 step 2` and friends.
 *
 * Messages here name the variable but not the line: the caller knows which line
 * it was reading and attaches that, so saying it twice only reads as a stutter.
 */
function parseVariable(text) {
  const eq = text.indexOf('=');
  if (eq < 1) throw new Error('expected "V: name = …"');
  const name = text.slice(0, eq).trim();
  if (!/^[A-Za-z_]\w*$/.test(name)) {
    throw new Error(`"${name}" is not a usable variable name`);
  }
  const rest = text.slice(eq + 1).trim();
  const [word, ...tail] = rest.split(/\s+/);
  const type = (word || '').toLowerCase();
  const spec = tail.join(' ').trim();

  if (type === 'expr') {
    if (!spec) throw new Error(`"${name}" has no expression`);
    return [name, { type: 'expr', expr: spec }];
  }

  if (type === 'choice') {
    const values = spec.split(',').map((value) => value.trim()).filter(Boolean)
      .map((value) => {
        const unquoted = value.replace(/^["']|["']$/g, '');
        const asNumber = Number(unquoted);
        return unquoted !== '' && Number.isFinite(asNumber) && unquoted === String(asNumber)
          ? asNumber
          : unquoted;
      });
    if (values.length === 0) throw new Error(`"${name}" has no choices`);
    return [name, { type: 'choice', values }];
  }

  if (type === 'int' || type === 'decimal') {
    const range = /^(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)/.exec(spec);
    if (!range) throw new Error(`"${name}" needs a range like 2..9`);
    const variable = { type, min: Number(range[1]), max: Number(range[2]) };

    const except = /\bexcept\s+([-\d.,\s]+)/i.exec(spec);
    if (except) {
      variable.exclude = except[1].split(',').map((value) => Number(value.trim()))
        .filter(Number.isFinite);
    }
    const step = /\bstep\s+(-?\d+(?:\.\d+)?)/i.exec(spec);
    if (step) variable.step = Number(step[1]);
    return [name, variable];
  }

  throw new Error(`"${name}" has unknown type "${word}" — use int, decimal, choice or expr`);
}

/** `@ Algebra 1 > Factoring | d2 | tags: a, b | book: X | section: 3.4` */
function parseContext(text, previous) {
  const context = { ...previous };
  const [pathPart, ...optionParts] = text.split('|');

  const path = pathPart.trim();
  if (path) {
    const [subject, topic, subtopic] = path.split('>').map((part) => part.trim());
    context.subject = subject || '';
    context.topic = topic || '';
    context.subtopic = subtopic || '';
  }

  for (const raw of optionParts) {
    const option = raw.trim();
    if (!option) continue;

    const difficulty = /^d\s*([1-5])$/i.exec(option);
    if (difficulty) {
      context.difficulty = Number(difficulty[1]);
      continue;
    }
    const colon = option.indexOf(':');
    if (colon === -1) throw new Error(`cannot read "${option}"`);
    const key = option.slice(0, colon).trim().toLowerCase();
    const value = option.slice(colon + 1).trim();

    switch (key) {
      case 'tags':
        context.tags = value.split(',').map((tag) => tag.trim()).filter(Boolean);
        break;
      case 'book': context.source_book = value; break;
      case 'chapter': context.source_chapter = value; break;
      case 'section': context.source_section = value; break;
      case 'difficulty': context.difficulty = Number(value); break;
      default:
        throw new Error(`unknown setting "${key}"`);
    }
  }
  return context;
}

function blankDraft(context, line) {
  return {
    line,
    subject: context.subject || '',
    topic: context.topic || '',
    subtopic: context.subtopic || '',
    difficulty: context.difficulty || 3,
    tags: [...(context.tags || [])],
    source_book: context.source_book || '',
    source_chapter: context.source_chapter || '',
    source_section: context.source_section || '',
    source_number: '',
    external_key: null,
    // Set when any line of this question failed to parse. Such a question is
    // rejected rather than imported in some half-understood form — a botched
    // "V:" line would otherwise quietly become a fixed question.
    broken: false,
    statement: [],
    answer: [],
    solution: [],
    vars: {},
    constraints: [],
  };
}

/** Turn the accumulated lines of one draft into a question object. */
function finishDraft(draft) {
  const text = (lines) => lines.join('\n').trim();
  const question = {
    subject: draft.subject,
    topic: draft.topic,
    subtopic: draft.subtopic,
    difficulty: draft.difficulty,
    kind: Object.keys(draft.vars).length > 0 ? 'template' : 'static',
    statement: text(draft.statement),
    answer: text(draft.answer),
    solution: text(draft.solution),
    tags: draft.tags,
    source_book: draft.source_book,
    source_chapter: draft.source_chapter,
    source_section: draft.source_section,
    source_number: draft.source_number,
    params: {},
    line: draft.line,
  };
  if (draft.external_key) question.external_key = draft.external_key;
  if (question.kind === 'template') {
    question.params = { vars: draft.vars };
    if (draft.constraints.length > 0) question.params.constraints = draft.constraints;
  }
  return question;
}

/**
 * Parse the text format.
 *
 * @returns {{ questions: object[], errors: {line: number, message: string}[] }}
 *   Questions are returned in the same shape the JSON import accepts. A
 *   question that fails to parse or generate is reported rather than dropped
 *   silently, and never blocks the ones around it.
 */
function parseQuestions(source) {
  const lines = String(source ?? '').split(/\r?\n/);
  const questions = [];
  const errors = [];

  let context = {};
  let draft = null;
  let field = null;

  const commit = () => {
    if (!draft) return;
    if (draft.broken) {
      draft = null;
      field = null;
      return;
    }
    try {
      const question = finishDraft(draft);
      if (!question.statement) {
        errors.push({ line: draft.line, message: 'this question has no text after "Q:"' });
      } else {
        questions.push(question);
      }
    } catch (error) {
      errors.push({ line: draft.line, message: error.message });
    }
    draft = null;
    field = null;
  };

  lines.forEach((raw, index) => {
    const line = index + 1;

    if (SEPARATOR.test(raw)) {
      commit();
      return;
    }

    const contextMatch = CONTEXT.exec(raw);
    if (contextMatch) {
      commit();
      try {
        context = parseContext(contextMatch[1], context);
      } catch (error) {
        errors.push({ line, message: error.message });
      }
      return;
    }

    const markerMatch = MARKER.exec(raw);
    if (markerMatch) {
      const marker = markerMatch[1];
      const value = raw.slice(markerMatch[0].length);

      if (marker === 'Q') {
        // A new Q: ends the previous question even without a separator.
        commit();
        draft = blankDraft(context, line);
        field = draft.statement;
        field.push(value);
        return;
      }
      if (!draft) {
        errors.push({ line, message: `"${marker}:" appears before any "Q:"` });
        return;
      }

      switch (marker) {
        case 'A': field = draft.answer; field.push(value); break;
        case 'S': field = draft.solution; field.push(value); break;
        case 'D': {
          const difficulty = Number(value.trim());
          if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) {
            errors.push({ line, message: `difficulty must be 1–5, got "${value.trim()}"` });
            draft.broken = true;
          } else {
            draft.difficulty = difficulty;
          }
          field = null;
          break;
        }
        case 'N': draft.source_number = value.trim(); field = null; break;
        case 'K': draft.external_key = value.trim(); field = null; break;
        case 'C': draft.constraints.push(value.trim()); field = null; break;
        case 'V': {
          try {
            const [name, variable] = parseVariable(value);
            draft.vars[name] = variable;
          } catch (error) {
            errors.push({ line, message: error.message });
            draft.broken = true;
          }
          field = null;
          break;
        }
        default: break;
      }
      return;
    }

    // Anything else continues the field that came last. Blank lines inside a
    // field are kept, so a question can have paragraphs.
    if (field) {
      field.push(raw);
      return;
    }
    if (raw.trim()) {
      errors.push({ line, message: `"${raw.trim().slice(0, 40)}" is not inside a question` });
    }
  });

  commit();

  // A generated question that cannot actually generate is worth catching now,
  // while the author is looking at it, rather than when a student opens it.
  const checked = [];
  for (const question of questions) {
    if (question.kind !== 'template') {
      checked.push(question);
      continue;
    }
    try {
      for (const seed of [1, 2, 12345]) instantiate(question, seed);
      checked.push(question);
    } catch (error) {
      errors.push({ line: question.line, message: `cannot generate: ${error.message}` });
    }
  }

  return { questions: checked, errors };
}

module.exports = { parseQuestions, parseVariable, parseContext };
