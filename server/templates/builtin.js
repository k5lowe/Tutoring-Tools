'use strict';

/**
 * The document templates shipped with the app.
 *
 * They are seeded into the `templates` table on first run and are editable from
 * the Templates screen — nothing here is hard-coded into the renderer, so you
 * can bend the output to whatever house style you already use.
 *
 * Design notes:
 *  - Minimal preamble: geometry for margins, amsmath/amssymb for math. No
 *    enumitem: problems are laid out with a small \problem macro built on
 *    \makebox and \hangindent, which keeps labels like "3.4 #17" working
 *    without pulling in a list package.
 *  - multicol is loaded only by the templates that actually use columns.
 *
 * Available fields: title, course, student, date, instructions, notes,
 * objectives[], version, hasVersions, count, columns/multipleColumns, itemsep,
 * and problems[] with n, label, heading, statement, answer, solution,
 * hasAnswer, hasSolution, source, difficulty, subject, topic, subtopic.
 */

const PREAMBLE = String.raw`% Minimal preamble by design: margins + AMS math.
\usepackage[margin=1in]{geometry}
\usepackage{amsmath}
\usepackage{amssymb}

\pagestyle{empty}
\setlength{\parindent}{0pt}

% Width reserved for the problem label. Widen it if you use long textbook
% references such as "12.4 #117".
\newlength{\problemindent}
\setlength{\problemindent}{2.6em}

% \problem{label}{statement} -- hanging indent, no list package required.
\newcommand{\problem}[2]{%
  \par
  \begingroup
    \hangindent=\problemindent
    \hangafter=1
    \noindent\makebox[\problemindent][l]{\bfseries #1}#2\par
  \endgroup
}

% Section break used by the "group by textbook section" numbering mode.
\newcommand{\problemheading}[1]{%
  \par\vspace{1.2em}
  {\large\bfseries #1}\par\vspace{0.5em}
}`;

const PRACTICE = `\\documentclass[11pt]{article}

${PREAMBLE}
{{#multipleColumns}}\\usepackage{multicol}
{{/multipleColumns}}
\\begin{document}

% ---------- Header ----------
{\\Large\\bfseries {{title}}}{{#hasVersions}}\\hfill{\\large\\bfseries Version {{version}}}{{/hasVersions}}

\\vspace{0.4em}
{{#course}}{{course}}{{/course}}\\hfill Name: {{#student}}{{student}}{{/student}}{{^student}}\\underline{\\hspace{1.9in}}{{/student}}\\quad Date: {{#date}}{{date}}{{/date}}{{^date}}\\underline{\\hspace{1in}}{{/date}}

\\vspace{0.5em}
\\hrule
\\vspace{1.1em}
{{#instructions}}
{{instructions}}

\\vspace{1.1em}
{{/instructions}}
{{#multipleColumns}}\\begin{multicols}{ {{columns}} }
{{/multipleColumns}}
{{#problems}}
{{#heading}}\\problemheading{ {{heading}} }
{{/heading}}
\\problem{ {{label}} }{ {{statement}} }
\\vspace{ {{itemsep}} }

{{/problems}}
{{#multipleColumns}}\\end{multicols}
{{/multipleColumns}}
\\end{document}
`;

const NOTES = `\\documentclass[11pt]{article}

${PREAMBLE}

% Notes handouts are read, not written on, so numbers may sit tighter.
\\newcommand{\\solutionlabel}{\\textit{Solution.}\\;}

\\begin{document}

% ---------- Header ----------
{\\Large\\bfseries {{title}}}{{#hasVersions}}\\hfill{\\large\\bfseries Version {{version}}}{{/hasVersions}}

\\vspace{0.4em}
{{#course}}{{course}}{{/course}}{{#date}}\\hfill {{date}}{{/date}}

\\vspace{0.5em}
\\hrule
\\vspace{1.1em}
{{#hasObjectives}}
\\textbf{Objectives}
\\begin{itemize}
{{#objectives}}\\item {{text}}
{{/objectives}}\\end{itemize}

\\vspace{0.9em}
{{/hasObjectives}}
{{#instructions}}
{{instructions}}

\\vspace{1em}
{{/instructions}}
{{#problems}}
{{#heading}}\\problemheading{ {{heading}} }
{{/heading}}
\\problem{ {{label}} }{ {{statement}} }
{{#hasSolution}}
\\begingroup
\\leftskip=\\problemindent
\\vspace{0.35em}
\\solutionlabel {{solution}}
\\par
\\endgroup
{{/hasSolution}}
{{^hasSolution}}{{#hasAnswer}}
\\begingroup
\\leftskip=\\problemindent
\\vspace{0.35em}
\\textit{Answer.}\\; {{answer}}
\\par
\\endgroup
{{/hasAnswer}}{{/hasSolution}}
\\vspace{ {{itemsep}} }

{{/problems}}
{{#notes}}
\\vspace{1.2em}
\\hrule
\\vspace{0.8em}
{{notes}}
{{/notes}}
\\end{document}
`;

const ANSWERS = `\\documentclass[11pt]{article}

${PREAMBLE}
\\usepackage{multicol}

\\begin{document}

{\\large\\bfseries {{title}} --- Answer Key}{{#hasVersions}}\\hfill{\\bfseries Version {{version}}}{{/hasVersions}}

\\vspace{0.4em}
{{#course}}{{course}}{{/course}}{{#date}}\\hfill {{date}}{{/date}}

\\vspace{0.5em}
\\hrule
\\vspace{1em}
{{#anyAnswers}}
\\begin{multicols}{3}
{{#problems}}
\\problem{ {{label}} }{ {{#hasAnswer}}{{answer}}{{/hasAnswer}}{{^hasAnswer}}---{{/hasAnswer}} }
\\vspace{0.5em}

{{/problems}}
\\end{multicols}
{{/anyAnswers}}
{{^anyAnswers}}
No answers are recorded for the problems in this set.
{{/anyAnswers}}
\\end{document}
`;

const WORKED_KEY = `\\documentclass[11pt]{article}

${PREAMBLE}

\\begin{document}

{\\large\\bfseries {{title}} --- Worked Solutions}{{#hasVersions}}\\hfill{\\bfseries Version {{version}}}{{/hasVersions}}

\\vspace{0.4em}
{{#course}}{{course}}{{/course}}{{#date}}\\hfill {{date}}{{/date}}

\\vspace{0.5em}
\\hrule
\\vspace{1em}
{{#problems}}
\\problem{ {{label}} }{ {{statement}} }
\\begingroup
\\leftskip=\\problemindent
\\vspace{0.3em}
{{#hasSolution}}\\textit{Solution.}\\; {{solution}}{{/hasSolution}}{{^hasSolution}}{{#hasAnswer}}\\textit{Answer.}\\; {{answer}}{{/hasAnswer}}{{^hasAnswer}}\\textit{No solution recorded.}{{/hasAnswer}}{{/hasSolution}}
\\par
\\endgroup
\\vspace{1em}

{{/problems}}
\\end{document}
`;

const BUILTIN_TEMPLATES = [
  {
    name: 'Practice worksheet',
    kind: 'practice',
    body: PRACTICE,
    is_default: 1,
    builtin: 1,
  },
  {
    name: 'Lesson notes (worked examples)',
    kind: 'notes',
    body: NOTES,
    is_default: 1,
    builtin: 1,
  },
  {
    name: 'Answer key (3 columns)',
    kind: 'answers',
    body: ANSWERS,
    is_default: 1,
    builtin: 1,
  },
  {
    name: 'Worked solutions key',
    kind: 'answers',
    body: WORKED_KEY,
    is_default: 0,
    builtin: 1,
  },
];

module.exports = { BUILTIN_TEMPLATES, PREAMBLE };
