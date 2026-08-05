'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

/**
 * Optional PDF compilation.
 *
 * A TeX installation is not required to use the app — the .tex download and the
 * browser print preview both work without one. When `latexmk` or `pdflatex` is
 * on PATH we offer one-click PDFs as well.
 */

const CANDIDATES = [
  { command: 'latexmk', args: (file) => ['-pdf', '-interaction=nonstopmode', '-halt-on-error', file] },
  { command: 'pdflatex', args: (file) => ['-interaction=nonstopmode', '-halt-on-error', file] },
  { command: 'tectonic', args: (file) => ['--keep-logs', '--print', file] },
];

let cached = null;

function detectEngine({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  for (const candidate of CANDIDATES) {
    try {
      execFileSync(candidate.command, ['--version'], { stdio: 'ignore', timeout: 10000 });
      cached = candidate;
      return cached;
    } catch {
      // Try the next engine.
    }
  }
  cached = { command: null };
  return cached;
}

function isAvailable() {
  return Boolean(detectEngine().command);
}

/** Last few lines of a TeX log, which is where the real error message lives. */
function extractError(log) {
  const lines = String(log || '').split('\n');
  const firstError = lines.findIndex((line) => line.startsWith('!'));
  if (firstError === -1) return lines.slice(-25).join('\n').trim();
  return lines.slice(firstError, firstError + 20).join('\n').trim();
}

/**
 * Compile LaTeX source to a PDF buffer.
 * Runs in a throwaway temp directory that is always cleaned up.
 */
async function compile(latex, { jobName = 'document', timeoutMs = 60000 } = {}) {
  const engine = detectEngine();
  if (!engine.command) {
    const error = new Error('No LaTeX engine found on PATH (looked for latexmk, pdflatex, tectonic).');
    error.code = 'ENOENGINE';
    throw error;
  }

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutoring-tools-'));
  const texFile = path.join(workdir, 'document.tex');
  fs.writeFileSync(texFile, latex, 'utf8');

  try {
    // pdflatex needs two passes for anything that references itself; latexmk
    // handles that on its own.
    const passes = engine.command === 'pdflatex' ? 2 : 1;
    let lastOutput = '';
    for (let pass = 0; pass < passes; pass += 1) {
      lastOutput = await new Promise((resolve, reject) => {
        execFile(
          engine.command,
          engine.args('document.tex'),
          { cwd: workdir, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
          (error, stdout, stderr) => {
            // A non-zero exit still often leaves a usable PDF; decide by file.
            if (error && !fs.existsSync(path.join(workdir, 'document.pdf'))) {
              const logPath = path.join(workdir, 'document.log');
              const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : `${stdout}\n${stderr}`;
              const failure = new Error(`LaTeX build failed:\n${extractError(log)}`);
              failure.code = 'EBUILD';
              reject(failure);
              return;
            }
            resolve(`${stdout}\n${stderr}`);
          },
        );
      });
    }

    const pdfPath = path.join(workdir, 'document.pdf');
    if (!fs.existsSync(pdfPath)) {
      const failure = new Error(`LaTeX produced no PDF:\n${extractError(lastOutput)}`);
      failure.code = 'EBUILD';
      throw failure;
    }
    return { pdf: fs.readFileSync(pdfPath), engine: engine.command, jobName };
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

module.exports = { compile, isAvailable, detectEngine };
