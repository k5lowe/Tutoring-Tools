# Tutoring Tools

A problem bank and printable practice-set generator for tutors.

Pick a topic and a difficulty, get a formatted problem set — plus its answer key,
its worked solutions, and as many alternate versions as you need. Output is
LaTeX first (minimal preamble, no package soup), with a browser print path for
when you don't have TeX on the machine you're sitting at.

It runs locally. Your bank is a single SQLite file you own.

```bash
npm install
npm start          # then open http://127.0.0.1:4675
```

Needs Node 20.11 or newer. First run seeds a starter bank of 62 problems across
Algebra 1, Algebra 2, Geometry, Precalculus and Calculus 1.

On **Node 22.5+** SQLite comes from Node itself (`node:sqlite`) — nothing to
build. On **Node 20** that module doesn't exist, so `npm install` also pulls
`better-sqlite3`, which ships prebuilt binaries; the app picks whichever is
available and prints which one it used at startup. If neither can be loaded it
tells you how to fix it instead of failing with a stack trace.

If you're on a different port or already have it running, `npm start` says so
rather than throwing `EADDRINUSE`.

---

## The idea

Two things make this different from writing each worksheet by hand:

**1. Problems can be templates, not fixed text.** A template problem stores
parameter ranges and a set of constraints; the app draws numbers, computes the
answer from those numbers, and can produce a fresh instance forever. One
"solve `ax + b = c`" entry covers a whole term of two-step-equation practice,
and the answer key is always right because the answer is derived, not typed.

**2. Every draw is reproducible.** Each problem in a set stores a *seed*. The
worksheet and its answer key are separate documents rendered from the same
seed, so they can never drift apart. Reseed a set and you get the same problems
with different numbers — the same worksheet for a different student, or a
retake that isn't the test they already saw.

## The workflow

**Build a set** — filter the bank by subject, topic, textbook section,
difficulty and tags. Say how many problems and in what shape (mixed difficulty,
ramping up, textbook order). Generate. Then adjust: drag to reorder, redraw an
individual problem, pull specific problems in from the bank, ask for five more
like these.

**Get it out** — four ways, all from the same set:

| Output | Route |
| --- | --- |
| Print preview in the browser | `Print ↗` — server-rendered KaTeX, prints properly |
| LaTeX source | `Copy .tex` / `Download .tex` |
| Everything at once | `All versions + keys` — one `.tex`, page-broken |
| PDF | shown when `latexmk`, `pdflatex`, or `tectonic` is on your `PATH` |

No TeX installed is a supported state, not a broken one: the header says so, and
the `.tex` download and browser printing both still work.

## Numbering

Because problems usually live alongside a book:

- **Sequential** — 1, 2, 3…
- **Textbook reference** — `3.4 #17`, so a student can find it in the book
- **Grouped by section** — section headings, numbering restarting under each
- **Letters** — a), b), c)…

In the textbook modes, a generated problem has no number in the book, so it
falls back to the running count rather than borrowing the section number.
Grouped mode gathers problems from the same section together at render time
(your ordering within a section is preserved), so each heading appears once.

## Writing a template problem

In the Problem bank tab, set the type to *Generated* and write `{{ }}` where you
want a value. Anything inside is an expression:

```
Statement:  Solve for $x$: $ {{coef(a,'x')}} {{signed(b)}} = {{c}} $
Answer:     $x = {{x}}$
Parameters: {
              "vars": {
                "a": { "type": "int", "min": 2, "max": 9 },
                "x": { "type": "int", "min": -9, "max": 9, "exclude": [0] },
                "b": { "type": "int", "min": -12, "max": 12, "exclude": [0] },
                "c": { "type": "expr", "expr": "a*x + b" }
              },
              "constraints": ["a != 1"]
            }
```

`c` is *computed* from the values drawn for `a`, `x` and `b` — that is what keeps
the printed equation and the printed answer consistent. `constraints` reject a
draw and try again, which is how you insist on things like a positive
discriminant or an irrational root:

```json
"constraints": ["disc > 0", "isint(sqrt(disc)) == 0"]
```

Parameter types are `int`, `decimal`, `choice` (pick from a list, numbers or
strings) and `expr` (computed from earlier variables). The editor shows three
live samples as you type, so you can see what students will actually get.

### Formatting helpers

Hand-written algebra reads badly when generated naively — `x + -3`, `1x`,
`2x^2 + 0x`. These helpers exist to avoid that:

| Helper | Result |
| --- | --- |
| `signed(3)` / `signed(-3)` | `+ 3` / `- 3` |
| `coef(3,'x')` / `coef(1,'x')` / `coef(-1,'x')` | `3x` / `x` / `-x` |
| `term(3,'x')` / `term(0,'x')` | `+ 3x` / *nothing* |
| `frac(2,8)` | `\frac{1}{4}` (reduced; integer if it divides) |
| `radical(12)` | `2\sqrt{3}` |
| `fmt(x, 2)` | fixed decimal places |

Plus the usual numeric functions: `sqrt cbrt abs floor ceil round min max pow
exp ln log log10 sin cos tan asin acos atan hypot gcd lcm fact nCr nPr isint
sign trunc`, the constants `pi`, `e`, `tau`, and `cat`/`str`/`ifelse`.

The expression language is a small parser written for this purpose — not
`eval`. It has no property access, no assignment, and no way to reach anything
in the host process.

## Templates (the LaTeX itself)

The Templates tab holds the actual documents. Four ship with the app: practice
worksheet, lesson notes with worked examples, a three-column answer key, and a
worked-solutions key. Edit them freely; "Reset to shipped" undoes a mistake.

The preamble is deliberately small — `geometry`, `amsmath`, `amssymb`, and
`multicol` only where columns are used. Problems are laid out by a four-line
`\problem` macro built on `\makebox` and `\hangindent`, so labels like
`3.4 #17` work without a list package.

Fields available to a template are listed in the app; briefly:
`{{title}} {{course}} {{student}} {{date}} {{instructions}} {{version}}`,
`{{#problems}}…{{/problems}}` with `{{label}} {{statement}} {{answer}}
{{solution}} {{heading}} {{source}} {{difficulty}}`, and guards like
`{{#hasSolution}}` / `{{^hasAnswer}}`.

Statements, answers, solutions and instructions are treated as LaTeX and passed
through untouched. Short metadata fields (title, course, student, date) get `&`,
`%`, `#` and `_` escaped so a stray character can't break your build, while `$`
and `\` are left alone so inline math in a title still works.

## The starter bank

The seeded problems carry `source_book: "Course Packet"` with plausible chapter
and section numbers. Those are placeholders, not references to any real
textbook — replace them with your own books and problem numbers as you go. The
maths itself is original and checked (`npm test` verifies every template problem
generates cleanly across multiple seeds).

Your own problems are never touched by seeding. Re-running `npm run seed` only
updates rows that came from the seed files (matched on `external_key`); use
`npm run reseed` to force those back to their shipped state.

## Import and export

Export gives you a JSON file of the current filter's worth of problems. Import
takes it back — rows whose `external_key` already exists are updated in place
rather than duplicated, so a round trip is safe and you can keep your bank in
version control if you want.

## Hosting it for other people

By default the app is single-user: one bank, no cookies, no accounts — which is
what you want on your own machine. Set `MULTI_USER=1` and it becomes
multi-tenant instead:

- Each visitor gets a private workspace on first request, seeded with the
  starter bank and their own copy of the templates.
- Identity is a random token in an `HttpOnly` cookie — no signup, no password.
  Only its SHA-256 hash is stored, so a copy of the database does not hand over
  anyone's workspace.
- `GET /api/workspace` returns that token, and the app puts it in front of the
  visitor: a **Your workspace** panel opens on the first visit with the
  bookmarkable `?w=<token>` link, a copy button, a backup download and a plain
  warning that clearing cookies loses the bank. Afterwards it lives behind a
  top-bar button. Opening the link in another browser adopts that workspace,
  and the token is stripped from the address bar immediately so it does not
  linger in history or screenshots.

None of this appears when running locally — no panel, no button, no cookie.

Every query is scoped to a workspace, and `test/workspaces.test.js` exists to
prove it: one visitor cannot read, edit or delete another's problems, sets or
templates, cannot render or download their documents, and cannot pull a foreign
problem into a set by guessing its id.

Two things to sort out before putting it on the public internet:

- **Turn off server-side PDF.** Templates are user-editable LaTeX compiled by
  `pdflatex`; exposed publicly, `\input{/etc/passwd}` in a template would read
  server files into the returned PDF. Simply not installing a TeX engine leaves
  the `.tex` download and browser printing working, which is the safe default.
- **Use a host with a persistent disk** (Render, Fly.io, Railway). Platforms
  with an ephemeral filesystem wipe the SQLite file on every redeploy.

## Data and layout

```
server/
  lib/        expression evaluator, variant generation, numbering,
              LaTeX and HTML document builders, optional PDF compilation
  store/      SQLite access for problems, sets, templates
  routes/     JSON API and the document/download endpoints
  templates/  the shipped LaTeX templates
public/       the front end (vanilla ES modules, no build step)
data/seed/    starter problems as JSON
test/         44 tests over the expression language, generation and the API
```

The database lives at `data/tutoring-tools.db`. Copy it to back up or move
machines. Set `TUTORING_TOOLS_DB` to put it elsewhere, `PORT` and `HOST` to
change where the server listens.

```bash
npm test      # full suite
npm run dev   # restart on file changes
```

## Notes and limits

- The browser preview converts LaTeX to HTML on a best-effort basis: maths is
  rendered properly by KaTeX, and the common text commands (`\textbf`,
  `\emph`, `enumerate`, `itemize`, `\\`) are handled. Anything more exotic
  shows through as literal text — the `.tex` file is always the authoritative
  output.
- There is no authentication. It binds to `127.0.0.1` and is meant to run on
  your own machine; don't expose it to a network as-is.
- Diagrams aren't generated. Geometry problems that need a figure are best
  handled by putting TikZ (or an `\includegraphics`) directly in the statement
  and adding the package to your template.
