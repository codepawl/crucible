import './site-chrome.js';
import './site.css';
import './recipes.css';

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
