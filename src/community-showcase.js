// The Community section of the showcase page: work other people made with Crucible, picked from the Show and tell
// discussions. Each picked entry lives in public/community/featured.json with a local webp still beside it, so the page
// never loads a picture from another host. docs/community-showcase.md says how to submit and how to feature an entry.

export const SUBMIT_URL = 'https://github.com/codepawl/crucible/discussions/new?category=show-and-tell';
export const SUBMIT_EMAIL = 'hello@codepawl.com';
export const FEATURED_PATH = '/community/featured.json';

const EMAIL_SUBJECT = 'Crucible showcase submission';
const EMAIL_BODY = [
  'Picture or render: attach a still, 16:9 and at least 1280 px wide if you can.',
  'Credit (name or handle, and its link):',
  'Live page, repo or post:',
  'Models and assets (who made them, and their licence):',
  'Crucible version:',
  '',
  'CodePawl may show this picture on crucible.codepawl.com and its social accounts, with the credit above. I made it or have the right to share it.',
].join('\n');

const DISCUSSION_URL = /^https:\/\/github\.com\/codepawl\/crucible\/discussions\/\d+$/;
const IMAGE_PATH = /^\/community\/[a-z0-9-]+\.webp$/;
const MAX_TEXT_LENGTH = 160;
const MAX_ENTRIES = 60;
const REQUIRED_TEXT_FIELDS = ['title', 'author', 'alt', 'assets'];

export function submitEmailUrl() {
  const query = `subject=${encodeURIComponent(EMAIL_SUBJECT)}&body=${encodeURIComponent(EMAIL_BODY)}`;
  return `mailto:${SUBMIT_EMAIL}?${query}`;
}

function isHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function textProblems(entry, field) {
  const value = entry[field];
  if (typeof value !== 'string' || value.trim() === '') return [`"${field}" must be a non-empty string`];
  if (value.length > MAX_TEXT_LENGTH) return [`"${field}" is ${value.length} characters; keep it to ${MAX_TEXT_LENGTH}`];
  return [];
}

// Returns what is wrong with one featured entry, as sentences that say what to pass instead. An empty list means it is valid.
export function communityEntryProblems(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return ['an entry must be an object'];
  const problems = REQUIRED_TEXT_FIELDS.flatMap((field) => textProblems(entry, field));
  if (!isHttpsUrl(entry.authorUrl)) problems.push('"authorUrl" must be an https link to the author');
  const hasDiscussion = entry.discussion !== undefined;
  if (hasDiscussion ? typeof entry.discussion !== 'string' || !DISCUSSION_URL.test(entry.discussion) : entry.link === undefined) {
    problems.push('"discussion" must be the Show and tell link, https://github.com/codepawl/crucible/discussions/<number> (it may be left out only when "link" is set, for the studio own pieces)');
  }
  if (typeof entry.image !== 'string' || !IMAGE_PATH.test(entry.image)) {
    problems.push('"image" must be a local still such as /community/<lowercase-name>.webp');
  }
  for (const side of ['width', 'height']) {
    if (!Number.isInteger(entry[side]) || entry[side] < 1) problems.push(`"${side}" must be the still's ${side} in pixels`);
  }
  if (entry.link !== undefined && !isHttpsUrl(entry.link)) problems.push('"link" must be an https link, or left out');
  return problems;
}

// Reads featured.json and returns its entries, or throws an error that names each bad entry and field.
export function parseFeatured(data) {
  const entries = data?.entries;
  if (!Array.isArray(entries)) throw new Error('featured.json must be { "entries": [ ... ] }');
  if (entries.length > MAX_ENTRIES) throw new Error(`featured.json has ${entries.length} entries; keep it to ${MAX_ENTRIES}`);
  const problems = entries.flatMap((entry, index) => communityEntryProblems(entry).map((problem) => `entry ${index + 1}: ${problem}`));
  if (problems.length > 0) throw new Error(`featured.json is not valid: ${problems.join('; ')}`);
  return entries;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

// The markup of one entry. The still links to the live page when there is one, otherwise to the discussion.
export function communityFigureMarkup(entry) {
  const target = escapeHtml(entry.link ?? entry.discussion);
  const discussionLink = entry.discussion ? ` | <a href="${escapeHtml(entry.discussion)}">Discussion</a>` : '';
  const image = `<img src="${escapeHtml(entry.image)}" alt="${escapeHtml(entry.alt)}" width="${entry.width}" height="${entry.height}" loading="lazy" />`;
  const author = `<a href="${escapeHtml(entry.authorUrl)}">${escapeHtml(entry.author)}</a>`;
  return `<figure><a class="community-still" href="${target}">${image}</a>`
    + `<figcaption><strong>${escapeHtml(entry.title)}</strong><span>By ${author}</span>`
    + `<small>${escapeHtml(entry.assets)}${discussionLink}</small></figcaption></figure>`;
}

// Fills the Community grid from featured.json. The submit links stay visible whatever happens, and a list that is empty
// or fails to load shows the example card (emptyState) instead of a blank grid.
export async function renderCommunity({ grid, emailLink, emptyState, fetchJson = defaultFetchJson }) {
  if (emailLink) emailLink.href = submitEmailUrl();
  let entries = [];
  try {
    entries = parseFeatured(await fetchJson(FEATURED_PATH));
  } catch (error) {
    console.warn(`Community showcase: ${error.message}`);
  }
  grid.innerHTML = entries.map(communityFigureMarkup).join('');
  grid.hidden = entries.length === 0;
  if (emptyState) emptyState.hidden = entries.length > 0;
  return entries.length;
}

async function defaultFetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}
