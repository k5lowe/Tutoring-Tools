'use strict';

/**
 * Problem labelling. Tutors working alongside a textbook usually want the
 * worksheet to carry the book's own numbering so a student can find the
 * problem in the book — that is what the `textbook` and `section` modes do.
 */

const MODES = ['sequential', 'alpha', 'textbook', 'section'];

function toAlpha(index) {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * A textbook reference like "3.4 #17", or '' when the problem has no number of
 * its own. Callers fall back to sequential counting in that case: a generated
 * template problem belongs to a section but has no number in the book, and
 * labelling it "3.4." would collide with every other problem from 3.4.
 */
function textbookReference(item, { showSection = true } = {}) {
  const number = (item.source_number || '').trim();
  if (!number) return '';
  const section = (item.source_section || '').trim();
  if (!section || !showSection) return `\\#${number}`;
  return `${section}\\,\\#${number}`;
}

/**
 * Compute display labels for a list of set items.
 * Returns an array of `{ label, heading }`; `heading` is set on the first item
 * of each new textbook section when mode is `section`.
 */
function computeLabels(items, mode = 'sequential', options = {}) {
  const effectiveMode = MODES.includes(mode) ? mode : 'sequential';
  const startAt = Number.isFinite(options.startAt) ? Math.floor(options.startAt) : 1;
  const out = [];
  let counter = startAt;
  let currentSection = null;

  items.forEach((item, index) => {
    if (item.label_override) {
      out.push({ label: item.label_override, heading: null });
      counter += 1;
      return;
    }

    switch (effectiveMode) {
      case 'alpha':
        out.push({ label: `${toAlpha(index)})`, heading: null });
        break;
      case 'textbook': {
        const reference = textbookReference(item, { showSection: true });
        out.push({ label: reference ? `${reference}.` : `${counter}.`, heading: null });
        break;
      }
      case 'section': {
        const section = (item.source_section || '').trim() || 'Additional practice';
        const isNewSection = section !== currentSection;
        if (isNewSection) {
          currentSection = section;
          counter = startAt;
        }
        const reference = textbookReference(item, { showSection: false });
        out.push({
          label: reference ? `${reference}.` : `${counter}.`,
          heading: isNewSection ? sectionHeading(item, section) : null,
        });
        break;
      }
      default:
        out.push({ label: `${counter}.`, heading: null });
        break;
    }
    counter += 1;
  });

  return out;
}

/**
 * Gather items that share a textbook section, in order of each section's first
 * appearance, preserving the tutor's ordering within a section.
 *
 * The `section` numbering mode only emits a heading where the section changes,
 * so ungrouped input produces the same heading several times. Rather than make
 * that the tutor's problem, the mode groups as its name promises. Storage order
 * is untouched — this happens at render time.
 */
function groupBySection(items) {
  const buckets = new Map();
  for (const item of items) {
    const key = (item.source_section || '').trim() || '￿';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  return [...buckets.values()].flat();
}

function sectionHeading(item, section) {
  const book = (item.source_book || '').trim();
  const topic = (item.topic || '').trim();
  const parts = [];
  if (section) parts.push(`Section ${section}`);
  if (topic) parts.push(topic);
  const label = parts.join(' --- ') || 'Practice';
  return book ? `${label} (${book})` : label;
}

module.exports = { computeLabels, textbookReference, groupBySection, MODES };
