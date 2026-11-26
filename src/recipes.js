import './site-chrome.js';
import './site.css';
import './recipes.css';
import { highlightCode } from './code-highlight.js';

const COPIED_LABEL_MILLISECONDS = 2000;
const rawSources = new Map();

document.querySelectorAll('.recipe-code pre code[id]').forEach(code => {
  const source = code.textContent ?? '';
  rawSources.set(code.id, source);
  code.innerHTML = highlightCode(source, 'json');
  code.classList.add('hljs', 'language-json');
});

function mountCopyButton(button) {
  const targetId = button.dataset.copyCode;
  const source = document.getElementById(targetId);
  button.addEventListener('click', async () => {
    const raw = rawSources.get(targetId) ?? source.textContent;
    try {
      await navigator.clipboard.writeText(raw);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, COPIED_LABEL_MILLISECONDS);
    } catch {
      getSelection().selectAllChildren(source);
    }
  });
}

document.querySelectorAll('[data-copy-code]').forEach(mountCopyButton);

document.querySelectorAll('[data-recipe-compare]').forEach(container => {
  const slider = container.querySelector('.recipe-compare-slider');
  if (!slider) return;
  const sync = () => container.style.setProperty('--compare', `${slider.value}%`);
  slider.addEventListener('input', sync);
  sync();
});

// A clip that moves on its own stops for people who asked for less motion; its first frame stays as the picture.
if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.querySelectorAll('.recipe-clip').forEach(video => {
    video.removeAttribute('autoplay');
    video.pause();
    video.controls = true;
  });
}
