// What every site page except the home page loads for the shared top bar and footer: the tokens, the fonts, the chrome styles and the
// release version in the bar. The home page loads the same styles from landing.js and fills the version itself.
import './site-tokens.css';
import './brand-fonts.css';
import './site-chrome.css';
import { observeCodeBlocks } from './site-code.js';

observeCodeBlocks();

async function showReleaseVersion() {
  const labels = document.querySelectorAll('[data-release-version]');
  const commitLinks = document.querySelectorAll('[data-release-commit]');
  try {
    const response = await fetch('/release.json', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Release endpoint returned ${response.status}.`);
    const release = await response.json();
    for (const label of labels) label.textContent = `v${release.version}`;
    for (const link of commitLinks) {
      link.href = `https://github.com/codepawl/crucible/commit/${release.commit}`;
      link.textContent = `Commit ${String(release.commit).slice(0, 7)}`;
    }
  } catch {
    for (const label of labels) label.textContent = 'Release unavailable';
  }
}

showReleaseVersion();
