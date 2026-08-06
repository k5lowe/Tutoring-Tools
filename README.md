# Question Bank

A curated bank of maths questions you can browse, filter and practise from.

Pick a subject, topic and difficulty, read the question, work it out, then
reveal the answer. Questions marked *generated* give you fresh numbers every
time you ask, so one entry is unlimited practice rather than a single problem.

The bank is written by one owner. Everyone else reads it.

```bash
npm install
npm start          # then open http://127.0.0.1:4675
```

Needs Node 20.11 or newer. First run seeds a starter bank of 167 questions
across Algebra 1, Algebra 2, Geometry, Precalculus and Calculus 1 — 151 of them
generated, so they give fresh numbers every time.

On **Node 22.5+** SQLite comes from Node itself (`node:sqlite`) — nothing to
build. On **Node 20** that module doesn't exist, so `npm install` also pulls
`better-sqlite3`, which ships prebuilt binaries; the app picks whichever is
available and prints which one it used at startup. If neither can be loaded it
tells you how to fix it instead of failing with a stack trace.

---

## Generated questions

This is what makes the bank bigger than the number of rows in it. A generated
question stores parameter ranges and constraints; the numbers are drawn on
demand and the answer is *computed* from them, so it cannot be wrong.

Set the type to *Generated* in the editor and write `{{ }}` where a value goes:

```
Question:   Solve for $x$: $ {{coef(a,'x')}} {{signed(b)}} = {{c}} $
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

`c` is derived from `a`, `x` and `b` — that is what keeps the printed equation
and the answer consistent. Never type a number into the answer that you drew
randomly; compute it. `constraints` reject a draw and try again, which is how
you insist on things like a positive discriminant:

```json
"constraints": ["disc > 0", "isint(sqrt(disc)) == 0"]
```

Variable types are `int`, `decimal`, `choice` (numbers or strings) and `expr`.
The editor shows three live samples as you type, and readers get a **New
numbers** button on every generated question.

### Formatting helpers

Generated algebra reads badly when built naively — `x + -3`, `1x`, `2x^2 + 0x`.
These exist to avoid that:

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

## Writing questions

Questions are LaTeX: `$…$` for inline maths, `$$…$$` for a display line. KaTeX
renders it in the browser, so `\frac{1}{2}`, `x^{12}`, `\sqrt[3]{8}`, `\pi`,
`\le`, `\approx` and the rest all work. Nothing is compiled — there is no TeX
installation anywhere in this app.

Each question carries a subject, topic, subtopic, difficulty 1–5, tags, and an
optional textbook reference. Those are what the filters are built from, so
consistent spelling matters more than completeness.

The **worked solution** field is optional and sits behind a second reveal, under
the answer — so a reader can check their answer without being shown the method.

## Writing a lot of questions at once

**Add many…** opens a box you can paste plain text into. This is the fast path
for filling the bank: nothing is escaped, so a backslash is a backslash, and the
subject, topic and difficulty you would otherwise retype on every question are
set once with an `@` line.

```
@ Algebra 1 > Factoring > Monic trinomials | d2 | tags: factoring, drill

Q: Factor completely: $x^2 - 5x - 14$
A: $(x-7)(x+2)$
S: Two numbers with product $-14$ and sum $-5$: $-7$ and $2$.
---
Q: Factor completely: $x^2 + 9x + 20$
A: $(x+4)(x+5)$
```

| Marker | Means |
| --- | --- |
| `@` | subject > topic > subtopic, plus defaults for everything below it |
| `Q:` `A:` `S:` | the question, the answer, the worked solution |
| `D:` `N:` `K:` | difficulty 1–5, problem number, a stable key for re-importing |
| `V:` `C:` | a variable and a condition, for generated questions |
| `---` | ends a question — a new `Q:` ends one too |

Anything else continues the field above it, so a question can run over several
lines and contain paragraphs. A later `@` line changes only what it mentions:
`@ | d5` keeps the topic and raises the difficulty.

Generated questions declare their numbers with `V:` lines instead of
hand-written parameter JSON:

```
Q: Solve for $x$: $ {{coef(a,'x')}} {{signed(b)}} = {{c}} $
A: $x = {{x}}$
V: a = int 2..9
V: x = int -9..9 except 0
V: b = int -12..12 except 0
V: c = expr a*x + b
C: a != 1
```

Variables read as `int 1..10 except 5, 6 step 2`, `decimal 0.5..4 step 0.5`,
`choice 3, 4, "square"` or `expr n*(n+1)/2`.

**Check** parses the lot without saving anything. Every mistake is reported
against the line it is on and does not stop the questions around it from being
read, and every generated question is test-run at several seeds — so a template
that cannot actually generate is caught while you are still looking at it. What
survives is shown as rendered maths, and only then does **Import** save it.

## Curating in bulk

Adding a hundred questions takes one paste, so fixing a hundred takes one
action. The **Curate** controls at the bottom of the filter panel act on every
question the filter currently matches — not just the page you can see.

**Change all…** applies one set of changes to the whole match. Fill in only what
should change; a blank field is left exactly as it is, so re-filing a batch
under a new topic will not touch its difficulties or its maths. Tags are added
and removed by name rather than replaced, so a bulk retag cannot wipe the
per-question tags underneath it. When a rename moves the batch out from under
the filter you were using, the filter follows it, so the questions stay on
screen.

**Delete all…** needs you to type the number of questions before it will run.
There is no undo button for it — a snapshot is taken immediately beforehand, so
getting the questions back means stopping the server and running
`npm run restore -- latest`. Possible, but not a click, which is why it asks.

Both check the count against what you were shown. If the bank has changed
underneath you — another tab, a stray edit — the request is refused and nothing
happens, rather than acting on a different set than the one you confirmed.

### Undoing an import

The check before an import catches questions that are *broken*. It cannot catch
a question that is perfectly valid and filed wrong, which is the mistake the
text format makes easiest: one typo in an `@` line quietly misfiles everything
below it, and every one of those questions previews perfectly because the maths
is fine.

So each import records what it did, and **Undo that import** takes back exactly
those questions — not everything currently matching some filter, which would
also catch the batch you wrote last month. Questions the import overwrote (a
re-import matching on `external_key`) are restored to their previous content,
not merely deleted. Undoing walks backwards: take back the newest and the one
before it becomes the next candidate.

## Backups

The bank is a few thousand questions written by hand over months, so it gets
copied without being asked.

A snapshot is written with SQLite's `VACUUM INTO`: a complete, consistent
database file, taken without stopping the server. It is not an export needing
re-import — it is a bank you can open directly.

Snapshots are taken **at startup, every 24 hours, and immediately before an
import, a bulk change or a bulk delete**. That last one is the point: bulk
delete has no undo of its own, and the copy taken a moment earlier is the way
back from it.

They are pruned to everything from the last 48 hours, the newest of each of the
last 14 days, and the newest of each of the last 8 weeks. That is counted over
the snapshots that exist rather than the calendar, so a bank left alone for a
month comes back to a month of history rather than to nothing.

```bash
npm run snapshot            # take one now
npm run snapshot -- list    # what is there
npm run restore -- latest   # put the newest one back
npm run restore -- bank-20260806T051736946Z-before-bulk-delete.db
```

Restoring needs the server stopped — SQLite keeps a write-ahead log in sidecar
files, and swapping the database out from under a running process leaves those
describing a bank that no longer exists, so `npm run restore` checks the port
and refuses. The snapshot is verified before anything is touched, and the
database being replaced is kept as `.replaced-<time>` rather than destroyed.

The panel shows when the bank was last copied, with buttons to back up now or
download the newest copy. A backup that fails quietly is worse than none,
because you stop checking — so if it has not run, it says so.

Snapshots go next to the database (`data/snapshots`, or `/data/snapshots` when
hosted), which puts them on the same persistent disk. **That covers a bad
import, a mis-clicked delete and file corruption. It does not cover losing the
disk.** For that, download a copy periodically — the download link in the panel,
or `GET /api/snapshots/<name>`, hands one over as a file.

Set `SNAPSHOT_HOURS` to change the interval, or `0` to stop the timer; the
copies taken before bulk changes still happen. `TUTORING_TOOLS_SNAPSHOTS` puts
them somewhere else — a different mount, if you have one.

## Import and export

**Export** gives you a JSON file of whatever the current filter matches. The
**JSON** tab of the same dialog takes it back: questions whose `external_key`
already exists are updated in place rather than duplicated, so a round trip is
safe and re-running an import is not destructive. Give a question a `K:` line to
get the same behaviour from the text format.

JSON does mean escaping LaTeX backslashes (`\\frac`), which is why it is the
second tab rather than the first.

## The starter bank

167 questions, written in the plain-text format and kept in `data/questions`.
Those `.txt` files are the source you edit; the JSON under `data/seed` is built
from them.

```bash
npm run check:questions   # parse, generate and render every one
npm run build:seed        # rebuild data/seed from data/questions
```

`check:questions` runs each generated question across 200 seeds and fails on
anything that will not generate, will not render, leaves a placeholder
unsubstituted, prints an unclosed `$`, or prints a term like `+ 0` or `1x`.
Those last few are the faults that survive a passing parse and only show up
when somebody reads the question. `build:seed` refuses to write if any check
fails, so a broken question cannot reach the seed folder.

What none of it checks is whether the *mathematics* is right. That is a reading
job, which is why the sources are kept as readable text rather than JSON.

The 62 original questions carry `source_book: "Course Packet"` with invented
chapter and section numbers — placeholders, not references to a real textbook.
The 105 added later carry no book reference at all, so you can file them
against your own materials.

Your own questions are never touched by seeding. Re-running `npm run seed` only
updates rows that came from the seed files (matched on `external_key`); use
`npm run reseed` to force those back to their shipped state.

## Hosting it

By default the app is single-user: you are on your own machine, so nothing is
locked and the editing controls are always there. Set `MULTI_USER=1` and it
becomes a public, read-only bank:

- Visitors browse, filter, search, reveal answers and re-roll generated
  questions. They cannot add, edit, delete or import — every write returns 403
  and the UI does not offer the controls.
- Editing needs `ADMIN_KEY`. Sign in from the top bar to unlock it. Sessions are
  random tokens held in memory, so the key never goes into a cookie and a
  restart signs you out. Attempts are throttled to 10 per hour per address, and
  `/api/health` is exempt from that limiter — otherwise a saturated limiter
  would fail the platform's health check and get the service restarted in a
  loop. With no `ADMIN_KEY` set the bank cannot be edited at all, which is the
  safe way to fail.
- There are no visitor accounts and no cookies for readers. Nobody has anything
  of their own to lose.

The bank stays readable, Export included. That matches what a visitor can
already see question by question, but it does make wholesale copying easy;
remove the export route if that matters to you.

### Deploying

`Dockerfile` and `render.yaml` are ready to use. Point Render at the repository
and it reads the blueprint: a Docker service with a 1 GB disk mounted at
`/data`, `MULTI_USER=1`, and the database at `/data/tutoring-tools.db`.

The disk is the part that matters. The bank is a SQLite file, so a platform with
an ephemeral filesystem (Vercel, Netlify, Render's free plan) would wipe every
question on each deploy.

```bash
docker build -t question-bank .
docker run -p 4675:4675 -v bank-data:/data question-bank
```

Measured at 10,062 questions in a 3 MB database: facets 53 ms, a page of 25
questions with rendered maths 30 ms, free-text search 10 ms. SQLite will carry a
bank far larger than you will write by hand.

## Layout

```
server/
  lib/        the expression evaluator, generated-question drawing,
              the plain-text authoring parser, snapshots, and
              LaTeX-to-HTML rendering
  store/      SQLite access, and the record of what each import did
  routes/     the JSON API
  middleware/ owner sign-in, rate limiting
public/       the front end (vanilla ES modules, no build step)
data/questions/ the question sources, in the plain-text format
data/seed/    starter questions as JSON, built from data/questions
test/         72 tests over the expression language, generation, the text
              format, bulk curation, undo, backup/restore and the API
```

The database holds the questions and a log of imports (kept so they can be
undone). It lives at `data/tutoring-tools.db`, with snapshots beside it in
`data/snapshots`. Set `TUTORING_TOOLS_DB` to put the database elsewhere, `PORT`
and `HOST` to change where the server listens.

```bash
npm test      # full suite
npm run dev   # restart on file changes
```
