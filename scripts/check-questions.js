'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parseQuestions } = require('../server/lib/quickparse');
const { instantiate } = require('../server/lib/variants');
const { fragmentToHtml } = require('../server/lib/latex2html');

/**
 * Check the question sources in data/questions before they go anywhere near a
 * bank.
 *
 *   npm run check:questions
 *
 * Three things are verified, because they fail independently:
 *
 *   1. The text parses at all, with every mistake reported against its line.
 *   2. Every generated question actually generates, across many seeds — not the
 *      three the importer tries. A range that only breaks on one draw in fifty
 *      is exactly the kind of thing a student finds and you do not.
 *   3. Every question renders as LaTeX. KaTeX failing is silent in the parser,
 *      which cares about generation, not about whether the maths displays.
 *
 * None of this checks that the mathematics is *correct* — that is a reading
 * job, and the point of keeping the sources as readable text.
 */

const SEEDS = 200;
const DIRECTORY = path.join(__dirname, '..', 'data', 'questions');

/**
 * An odd number of `$` means a maths delimiter was left open, so prose ends up
 * italicised inside an equation or an equation leaks out as plain text. KaTeX
 * does not complain — it renders whatever it was handed — so this has to be
 * counted rather than observed.
 */
function unbalancedMath(text) {
  const withoutEscaped = String(text).replace(/\\\$/g, '');
  const withoutDisplay = withoutEscaped.replace(/\$\$[\s\S]*?\$\$/g, '');
  return (withoutDisplay.match(/\$/g) || []).length % 2 !== 0;
}

/** KaTeX reports a failed fragment inline rather than throwing. */
function renderProblems(instance) {
  const bad = [];
  for (const field of ['statement', 'answer', 'solution']) {
    const html = fragmentToHtml(instance[field]);
    if (html.includes('math-error')) bad.push(field);
  }
  return bad;
}

function checkFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const { questions, errors } = parseQuestions(text);
  const failures = errors.map((error) => `line ${error.line}: ${error.message}`);
  let generated = 0;

  questions.forEach((question, index) => {
    const label = `#${index + 1} "${question.statement.slice(0, 45).replace(/\s+/g, ' ')}…"`;
    const seeds = question.kind === 'template' ? SEEDS : 1;
    if (question.kind === 'template') generated += 1;

    const seenAnswers = new Set();
    for (let seed = 1; seed <= seeds; seed += 1) {
      let instance;
      try {
        instance = instantiate(question, seed * 7919);
      } catch (error) {
        failures.push(`${label} failed to generate at seed ${seed}: ${error.message}`);
        break;
      }
      const bad = renderProblems(instance);
      if (bad.length > 0) {
        failures.push(`${label} does not render (${bad.join(', ')}) at seed ${seed}`);
        break;
      }
      if (!instance.statement.trim()) {
        failures.push(`${label} produced an empty statement at seed ${seed}`);
        break;
      }
      // A placeholder that survives into the output was never substituted.
      // This happens silently: a placeholder may not contain braces, so
      // something like {{cat("x^{", m, "}")}} is left alone rather than
      // reported, and the reader gets raw source where the maths should be.
      const leaked = ['statement', 'answer', 'solution']
        .filter((field) => String(instance[field]).includes('{{'));
      if (leaked.length > 0) {
        failures.push(`${label} has an unsubstituted placeholder in `
          + `${leaked.join(', ')} at seed ${seed} — a placeholder cannot contain braces`);
        break;
      }
      const unbalanced = ['statement', 'answer', 'solution']
        .filter((field) => unbalancedMath(instance[field]));
      if (unbalanced.length > 0) {
        failures.push(`${label} has an unclosed $ in ${unbalanced.join(', ')} at seed ${seed}`);
        break;
      }
      // "1x" means a coefficient of 1 was printed instead of being folded in.
      // coef() handles that; a bare {{a}}x does not, so it has to be caught.
      // Only a following letter counts: "1\right)" is a legitimate value of 1.
      const one = ['statement', 'answer']
        .filter((field) => /(^|[^\d.\w])1(?=[a-zA-Z])/.test(instance[field]));
      if (one.length > 0) {
        failures.push(`${label} prints a coefficient of 1 in ${one.join(', ')} at seed ${seed}`);
        break;
      }
      // "+ 0" and "- 0" are not terms anyone writes; they mean a variable was
      // allowed to be zero somewhere it should not have been.
      const zeroTerm = ['statement', 'answer']
        .filter((field) => /[+-]\s*0(?![.\d])/.test(instance[field]));
      if (zeroTerm.length > 0) {
        failures.push(`${label} prints a "+ 0" term in ${zeroTerm.join(', ')} at seed ${seed}`);
        break;
      }
      // A "generated" question drawing the same thing every time is a fixed
      // question wearing a costume, and worth knowing about.
      seenAnswers.add(`${instance.statement}|${instance.answer}`);
    }

    if (question.kind === 'template' && seenAnswers.size === 1) {
      failures.push(`${label} is marked generated but never changes`);
    }
    if (!question.answer.trim()) {
      failures.push(`${label} has no answer`);
    }
  });

  return { file: path.basename(file), questions, generated, failures };
}

const excerpt = (text) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > 62 ? `${flat.slice(0, 61)}…` : flat;
};

/**
 * Report questions that look like restatements of one another.
 *
 * Adding a question that already exists under another name is easy to do and
 * hard to notice: the bank grows, the count goes up, and a student practising
 * the subtopic just meets the same problem twice.
 *
 * This is advice, not a failure. Deliberately parallel questions are good
 * teaching — asking for the opposite side, then the adjacent, then the tangent
 * ratio will score highly here and should stay. What it is worth scanning for
 * is a pair that is the same question with different wording.
 */
function findNearDuplicates(all, threshold = 0.72) {
  // Compare what a student would actually read, not the template source.
  //
  // Collapsing every {{...}} to one symbol throws away the maths, which is
  // usually the only thing separating two questions worded alike: "g(x) = x^2
  // - k^2" and "g(x) = x^2 + a" are different questions in identical prose.
  // Rendering both at the same seed keeps the numbers in the comparison, and
  // two templates that really are the same question render the same way.
  const rendered = all.map((q) => {
    if (q.kind !== 'template') return q.statement;
    try {
      return instantiate({ ...q, kind: 'template' }, 1).statement;
    } catch {
      return q.statement;
    }
  });

  // Adjacent word pairs, not single words. Single words rate "Solve for x:
  // <one expression>" against every other short instruction as identical,
  // because almost nothing survives the normalising. Pairs keep the ordering
  // that actually distinguishes one instruction from another.
  const shingles = (text) => {
    const w = String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);
    const out = new Set();
    for (let i = 0; i + 1 < w.length; i += 1) out.add(`${w[i]} ${w[i + 1]}`);
    return out;
  };
  const tokens = rendered.map((text) => shingles(text));
  const pairs = [];

  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      // Two very short statements can coincide by accident; ignore those
      // rather than report a pile of false matches that trains you to skim.
      if (Math.min(tokens[i].size, tokens[j].size) < 8) continue;
      const shared = [...tokens[i]].filter((w) => tokens[j].has(w)).length;
      const union = tokens[i].size + tokens[j].size - shared;
      if (union === 0) continue;
      const score = shared / union;
      if (score >= threshold) {
          pairs.push({ score, a: all[i], b: all[j], sa: rendered[i], sb: rendered[j] });
        }
    }
  }
  return pairs.sort((x, y) => y.score - x.score);
}

function main() {
  if (!fs.existsSync(DIRECTORY)) {
    console.error(`No such directory: ${DIRECTORY}`);
    process.exitCode = 1;
    return;
  }
  const files = fs.readdirSync(DIRECTORY).filter((name) => name.endsWith('.txt')).sort();
  let total = 0;
  let templates = 0;
  let broken = 0;
  const everything = [];

  for (const name of files) {
    const result = checkFile(path.join(DIRECTORY, name));
    total += result.questions.length;
    templates += result.generated;
    broken += result.failures.length;
    everything.push(...result.questions);

    const status = result.failures.length === 0 ? 'ok' : `${result.failures.length} PROBLEM(S)`;
    console.log(`\n  ${result.file}: ${result.questions.length} questions `
      + `(${result.generated} generated) — ${status}`);
    for (const failure of result.failures) console.log(`      ${failure}`);
  }

  const duplicates = findNearDuplicates(everything);
  if (duplicates.length > 0) {
    console.log(`\n  ${duplicates.length} pair(s) look like restatements of each other. `
      + 'Deliberately parallel questions are fine — check the rest:');
    for (const { score, a, b, sa, sb } of duplicates.slice(0, 12)) {
      console.log(`      ${score.toFixed(2)}  ${a.subject} > ${a.subtopic}: ${excerpt(sa)}`);
      console.log(`            vs  ${b.subject} > ${b.subtopic}: ${excerpt(sb)}`);
    }
    if (duplicates.length > 12) console.log(`      ...and ${duplicates.length - 12} more.`);
  }

  console.log(`\n  ${total} questions, ${templates} generated, `
    + `each checked across ${SEEDS} seeds.`);
  if (broken > 0) {
    console.log(`  ${broken} problem(s) to fix.\n`);
    process.exitCode = 1;
  } else {
    console.log('  No problems.\n');
  }
}

if (require.main === module) main();

module.exports = { checkFile, DIRECTORY, SEEDS };
