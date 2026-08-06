'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parseQuestions } = require('../server/lib/quickparse');
const { checkFile, DIRECTORY } = require('./check-questions');

/**
 * Turn the readable question sources in data/questions into seed JSON.
 *
 *   npm run build:seed
 *
 * The text files are the thing to edit — no escaped backslashes, no repeated
 * metadata. The JSON is generated from them and is what a fresh install loads.
 * Nothing is written if the sources do not pass their checks, so a broken
 * question cannot reach the seed folder by way of a build.
 *
 * Keys are derived from subject, topic and subtopic, which is what makes a
 * re-import update a question in place rather than adding a second copy of it.
 */

const SEED_DIRECTORY = path.join(__dirname, '..', 'data', 'seed');

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** A stable key per question, so re-importing edits rather than duplicates. */
function keyFor(question, seen) {
  const base = ['q', slug(question.subject), slug(question.topic), slug(question.subtopic)]
    .filter(Boolean).join('-');
  let key = base;
  for (let n = 2; seen.has(key); n += 1) key = `${base}-${n}`;
  seen.add(key);
  return key;
}

function build() {
  const files = fs.readdirSync(DIRECTORY).filter((name) => name.endsWith('.txt')).sort();
  const problems = [];

  // Check everything first: a partial write would leave the seed folder in a
  // state that matches no source file.
  for (const name of files) {
    const result = checkFile(path.join(DIRECTORY, name));
    if (result.failures.length > 0) {
      console.error(`\n  ${name} has ${result.failures.length} problem(s). `
        + 'Run "npm run check:questions" for the details. Nothing was written.\n');
      return null;
    }
  }

  const written = [];
  for (const name of files) {
    const text = fs.readFileSync(path.join(DIRECTORY, name), 'utf8');
    const { questions } = parseQuestions(text);
    if (questions.length === 0) continue;

    const subjects = [...new Set(questions.map((question) => question.subject))];
    if (subjects.length !== 1) {
      console.error(`\n  ${name} mixes subjects (${subjects.join(', ')}). `
        + 'One subject per file, please — the seed format puts it at the top.\n');
      return null;
    }

    const seen = new Set();
    const payload = {
      subject: subjects[0],
      problems: questions.map((question) => {
        const { subject, line, ...rest } = question;
        return { external_key: keyFor(question, seen), ...rest };
      }),
    };

    const target = path.join(SEED_DIRECTORY, `more-${name.replace(/\.txt$/, '.json')}`);
    fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
    written.push({ target: path.basename(target), count: questions.length });
    problems.push(...questions);
  }

  return { written, total: problems.length };
}

function main() {
  const result = build();
  if (!result) {
    process.exitCode = 1;
    return;
  }
  console.log('');
  for (const { target, count } of result.written) {
    console.log(`  ${target.padEnd(28)} ${count} questions`);
  }
  console.log(`\n  ${result.total} questions written to data/seed.\n`);
}

if (require.main === module) main();

module.exports = { build, keyFor };
