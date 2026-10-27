'use strict';

const $ = (id) => document.getElementById(id);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const hero = $('hero-video');
let heroWanted = !reducedMotion.matches;
let heroVisible = true;
let caseWanted = !reducedMotion.matches;
let caseVisible = false;
let fullDemoPlaying = false;
let currentCase = null;
let allCases = [];
let filteredCases = [];
let selectedFilter = 'all';
let switching = false;
let selectionVersion = 0;
let pairAttemptVersion = 0;
const buffering = new Set();
let scrubActive = false;
let animationFrame = 0;
const source = $('source-video');
const ours = $('ours-video');
const dialog = $('case-dialog');
const playIcons = { play: '▶', pause: 'Ⅱ' };

function controlState(button, playing, label) {
  button.querySelector('.control-icon').textContent = playing ? playIcons.pause : playIcons.play;
  button.querySelector('.control-text').textContent = playing ? 'Pause' : 'Play';
  button.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${label}`);
}
function safelyPlay(video) {
  return video.play().catch(() => false);
}
function updateHero() {
  if (heroWanted && heroVisible && !document.hidden && !fullDemoPlaying) {
    safelyPlay(hero).then(() => controlState($('hero-play'), !hero.paused, 'overview animation'));
  } else {
    hero.pause();
    controlState($('hero-play'), false, 'overview animation');
  }
}
if (reducedMotion.matches) { hero.removeAttribute('autoplay'); hero.pause(); }
$('hero-play').addEventListener('click', () => { heroWanted = hero.paused; updateHero(); });
new IntersectionObserver(([entry]) => { heroVisible = entry.isIntersecting; updateHero(); }, { threshold: 0.12 }).observe(hero);

const demo = $('full-demo');
$('demo-play').hidden = false;
$('demo-play').addEventListener('click', async () => {
  const result = await safelyPlay(demo);
  if (result !== false) $('demo-play').hidden = true;
});
demo.addEventListener('play', () => { $('demo-play').hidden = true; fullDemoPlaying = true; updateHero(); updatePair(); updateComparison(); });
function demoStopped() { fullDemoPlaying = false; updateHero(); updatePair(); updateComparison(); }
demo.addEventListener('pause', demoStopped);
demo.addEventListener('ended', demoStopped);

function pairShouldPlay() {
  return currentCase && caseWanted && (caseVisible || dialog.open) && !document.hidden && !fullDemoPlaying && !switching && !scrubActive;
}
function pausePair() {
  pairAttemptVersion += 1;
  source.pause(); ours.pause();
  cancelAnimationFrame(animationFrame);
  controlState($('case-play'), false, 'case videos');
}
function syncFrame() {
  if (!pairShouldPlay() || source.paused) return;
  if (Math.abs(source.currentTime - ours.currentTime) > 0.07 && ours.readyState >= 2) ours.currentTime = source.currentTime;
  if (source.duration > 0) $('case-scrub').value = String(Math.round(source.currentTime / source.duration * 1000));
  animationFrame = requestAnimationFrame(syncFrame);
}
async function updatePair() {
  if (!pairShouldPlay()) { pausePair(); return; }
  if (buffering.size) return;
  const activeVersion = selectionVersion;
  const attemptVersion = ++pairAttemptVersion;
  if (source.readyState >= 1 && ours.readyState >= 1 && Math.abs(ours.currentTime - source.currentTime) > 0.04) ours.currentTime = source.currentTime;
  const results = await Promise.all([safelyPlay(source), safelyPlay(ours)]);
  if (!currentCase || selectionVersion !== activeVersion || pairAttemptVersion !== attemptVersion) return;
  if (!pairShouldPlay()) { pausePair(); return; }
  if (buffering.size) return;
  if (results.some(result => result === false)) { pausePair(); return; }
  controlState($('case-play'), true, 'case videos');
  cancelAnimationFrame(animationFrame);
  animationFrame = requestAnimationFrame(syncFrame);
}
[source, ours].forEach(video => {
  video.addEventListener('waiting', () => {
    if (!pairShouldPlay()) return;
    buffering.add(video);
    pairAttemptVersion += 1;
    video.preload = 'auto';
    (video === source ? ours : source).pause();
    cancelAnimationFrame(animationFrame);
    $('case-play').querySelector('.control-text').textContent = 'Loading';
  });
  video.addEventListener('canplay', () => { buffering.delete(video); updatePair(); });
  video.addEventListener('error', () => {
    pausePair();
    $('results-error').hidden = false;
  });
});
$('case-play').addEventListener('click', () => { caseWanted = source.paused || ours.paused; updatePair(); });
new IntersectionObserver(([entry]) => { caseVisible = entry.isIntersecting; updatePair(); }, { threshold: 0.15 }).observe($('case-stage'));
$('case-scrub').addEventListener('input', (event) => {
  if (!Number.isFinite(source.duration)) return;
  scrubActive = true;
  pausePair();
  const time = Number(event.target.value) / 1000 * Math.max(0, source.duration - 0.04);
  source.currentTime = time; ours.currentTime = time;
});
$('case-scrub').addEventListener('change', () => { scrubActive = false; updatePair(); });

const sceneNames = { bonsai: 'Bonsai', horse: 'Horse', fangzhou: 'Portrait', person: 'Person', face: 'Face', garden: 'Garden', room: 'Room', bicycle: 'Bicycle', dog: 'Dog' };
function groupFor(item) {
  return ['person', 'face', 'fangzhou'].includes(item.category) ? 'portrait' : 'scene';
}
function selectCase(item, scrollToStage = false) {
  switching = true;
  selectionVersion += 1;
  buffering.clear();
  pausePair();
  currentCase = item;
  $('results-error').hidden = true;
  $('case-prompt').textContent = item.prompt;
  $('case-category').textContent = sceneNames[item.category] || '3D scene';
  $('case-position').textContent = `${filteredCases.indexOf(item) + 1} of ${filteredCases.length}`;
  source.preload = 'metadata'; ours.preload = 'metadata';
  source.poster = item.sourcePoster;
  ours.poster = item.poster;
  source.src = item.source;
  ours.src = item.ours;
  source.load(); ours.load();
  $('case-scrub').value = '0';
  $('case-reference').hidden = !item.reference;
  if (item.reference) {
    $('reference-image').src = item.reference.src;
    $('reference-image').alt = `User provided reference for: ${item.prompt}`;
  } else {
    $('reference-image').removeAttribute('src');
  }
  $('case-grid').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.id === item.id)));
  $('case-stage').setAttribute('aria-busy', 'false');
  switching = false;
  updatePair();
  if (scrollToStage) $('case-stage').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'center' });
}
function applyFilter(filter) {
  selectedFilter = filter;
  filteredCases = allCases.filter(item => filter === 'all' || (filter === 'reference' ? Boolean(item.reference) : groupFor(item) === filter));
  document.querySelectorAll('.filter').forEach(button => {
    const selected = button.dataset.filter === filter;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  const fragment = document.createDocumentFragment();
  filteredCases.forEach(item => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'case-tile'; button.dataset.id = item.id;
    button.setAttribute('aria-label', item.prompt);
    button.setAttribute('aria-pressed', 'false');
    const image = document.createElement('img');
    image.src = item.poster; image.alt = ''; image.loading = 'lazy'; image.width = 384; image.height = 192;
    const label = document.createElement('span'); label.textContent = item.label || item.title;
    button.append(image, label);
    if (item.reference) {
      const badge = document.createElement('span'); badge.className = 'reference-tag'; badge.textContent = 'User provided'; button.append(badge);
    }
    button.addEventListener('click', () => selectCase(item, true));
    fragment.append(button);
  });
  $('case-grid').replaceChildren(fragment);
  const selected = filteredCases.includes(currentCase) ? currentCase : filteredCases[0];
  if (selected) selectCase(selected);
}
document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => applyFilter(button.dataset.filter)));
function stepCase(direction) {
  if (!filteredCases.length) return;
  const next = (filteredCases.indexOf(currentCase) + direction + filteredCases.length) % filteredCases.length;
  selectCase(filteredCases[next]);
}
$('previous-case').addEventListener('click', () => stepCase(-1));
$('next-case').addEventListener('click', () => stepCase(1));

// Move the existing players into the dialog so their view position is preserved.
const expandedNodes = [document.querySelector('.paired-videos'), document.querySelector('.case-playback'), $('case-reference')];
$('case-expand').addEventListener('click', () => {
  if (!currentCase) return;
  $('dialog-title').textContent = currentCase.prompt;
  expandedNodes.forEach(node => $('dialog-content').append(node));
  $('case-expand').hidden = true;
  dialog.showModal();
  document.body.style.overflow = 'hidden';
  $('close-dialog').focus();
  updatePair();
});
$('close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => {
  expandedNodes.forEach(node => $('case-stage').append(node));
  $('case-expand').hidden = false;
  document.body.style.overflow = '';
  updatePair();
  $('case-expand').focus();
});
dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });

const comparison = $('comparison-video');
let comparisonVisible = false;
let comparisonWanted = !reducedMotion.matches;
let comparisonSelected = false;
let automaticComparisonPause = false;
function pauseComparison() {
  if (!comparison.paused) { automaticComparisonPause = true; comparison.pause(); }
}
comparison.addEventListener('pause', () => {
  controlState($('comparison-play'), false, 'comparison');
  if (automaticComparisonPause) automaticComparisonPause = false;
  else comparisonWanted = false;
});
comparison.addEventListener('play', () => { comparisonWanted = true; controlState($('comparison-play'), true, 'comparison'); });
$('comparison-play').addEventListener('click', () => { comparisonWanted = comparison.paused; updateComparison(); });
function updateComparison() {
  if (comparisonSelected && comparisonVisible && comparisonWanted && !document.hidden && !fullDemoPlaying) safelyPlay(comparison);
  else pauseComparison();
}
function selectComparison(item) {
  comparisonSelected = true;
  pauseComparison();
  comparison.poster = item.comparisonPoster || item.poster;
  comparison.src = item.comparison;
  comparison.setAttribute('aria-label', `Baseline comparison: ${item.prompt}`);
  comparison.load();
  $('comparison-tabs').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.id === item.id)));
  updateComparison();
}
new IntersectionObserver(([entry]) => { comparisonVisible = entry.isIntersecting; updateComparison(); }, { threshold: 0.2 }).observe(comparison);
document.addEventListener('visibilitychange', () => { updateHero(); updatePair(); updateComparison(); if (document.hidden) demo.pause(); });
reducedMotion.addEventListener('change', event => {
  if (event.matches) { heroWanted = false; caseWanted = false; comparisonWanted = false; updateHero(); updatePair(); updateComparison(); }
});

async function loadCases() {
  const response = await fetch('media/cases.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error('Case data unavailable');
  const data = await response.json();
  allCases = data.cases;
  if (!Array.isArray(allCases) || !allCases.length) throw new Error('No cases available');
  // Lead with a structural edit; the remaining cases follow the curated demo order.
  applyFilter(selectedFilter);
  const compareCases = allCases.filter(item => item.comparison);
  compareCases.forEach(item => {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.id = item.id;
    button.textContent = item.label || item.title;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => selectComparison(item));
    $('comparison-tabs').append(button);
  });
  if (compareCases.length) selectComparison(compareCases[0]);
  else $('comparisons').hidden = true;
}
loadCases().catch(() => { $('results-error').hidden = false; $('case-prompt').textContent = 'Explore the results in the full demo'; $('case-stage').setAttribute('aria-busy', 'false'); });

$('copy-citation').addEventListener('click', async () => {
  const citation = $('bibtex').textContent;
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(citation);
    else {
      const field = document.createElement('textarea'); field.value = citation; field.style.position = 'fixed'; field.style.opacity = '0'; document.body.append(field); field.select();
      const copied = document.execCommand('copy'); field.remove(); if (!copied) throw new Error('Copy unavailable');
    }
    $('copy-citation').textContent = 'Copied ✓';
    $('copy-status').textContent = 'Citation copied to clipboard.';
    setTimeout(() => { $('copy-citation').textContent = 'Copy citation ⧉'; }, 2200);
  } catch {
    $('copy-status').textContent = 'Please select and copy the BibTeX text below.';
    $('copy-citation').textContent = 'Select the text below';
  }
});
