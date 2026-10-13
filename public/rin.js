const $ = id => document.getElementById(id);
const tips = {
  guide: ['Ready when you are.', 'Add a batch, choose a format, and convert. Your originals stay untouched.'],
  format: ['WebM or MP4?', 'WebM is compact. MP4 is usually faster. Both are silent and checked for /pol/.'],
  audio: ['Keep the soundtrack.', 'Catbox uploads a public MP3 and adds its link to the filename. A local copy is saved too.'],
  encoding: ['Choose how the link looks.', 'Base64url is compact. All options are reversible. Encoding is not encryption.'],
};
const notes = [
  ['Ready when you are.', 'Add a batch, choose a format, and convert. Originals stay untouched.'],
  ['Keep the whole clip.', 'Long videos split automatically. Change this in Advanced.'],
  ['Every export gets checked.', 'Size, duration, codec, and silence are verified before saving.'],
  ['Your files stay local.', 'Only optional Catbox audio goes online. Anyone with its link can listen.'],
  ['Make the name yours.', 'Advanced has link encodings, prefixes, suffixes, and a live preview.'],
  ['Pause whenever you like.', 'The header pause button stops my animations. Reduced motion is respected too.'],
];
let noteIndex = -1, lastContext = '';
export function updateRinContext(state) {
  const files = state.files || [];
  const errors = files.filter(f => f.state === 'error').length;
  const done = files.filter(f => f.state === 'done').length;
  const key = state.batch?.active ? 'active' : errors ? 'error' : done === files.length && done ? 'done' : 'ready';
  if (key === lastContext) return;
  lastContext = key;
  tips.guide = key === 'active' ? ['Working on it.', 'You can leave this tab in the background. Cancel keeps finished exports.'] :
    key === 'error' ? ['One needs attention.', 'Check the error beside that file. Convert again to retry. Originals are safe.'] :
    key === 'done' ? ['All checked.', 'Preview a video, open its folder, or download the ZIP.'] : notes[0];
}
export function initRin() {
  $('rinGuideButton').addEventListener('click', () => { noteIndex = (noteIndex + 1) % notes.length; tips.guide = notes[noteIndex]; });
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  let paused = false;
  try { paused = localStorage.getItem('frame-motion-paused') === 'true'; } catch {}
  function syncMotion() {
    const stopped = paused || motionPreference.matches;
    document.documentElement.dataset.motion = stopped ? 'paused' : 'playing';
    const label = motionPreference.matches ? 'Animations paused by your system preference' : paused ? 'Resume character animations' : 'Pause character animations';
    $('motionToggle').setAttribute('aria-label', label);
    $('motionToggle').setAttribute('aria-pressed', String(stopped));
    $('motionToggle').title = label;
    $('motionToggle').disabled = motionPreference.matches;
    $('motionIcon').querySelector('use').setAttribute('href', stopped ? '#play' : '#pause');
  }
  $('motionToggle').addEventListener('click', () => {
    paused = !paused;
    try { localStorage.setItem('frame-motion-paused', String(paused)); } catch {}
    syncMotion();
  });
  motionPreference.addEventListener('change', syncMotion);
  syncMotion();

  const bubble = $('rinTooltip');
  let anchor = null, pinned = false, openTimer, closeTimer, pointerOverBubble = false;
  function hide() {
    clearTimeout(openTimer); clearTimeout(closeTimer);
    anchor?.removeAttribute('aria-describedby');
    anchor = null; pinned = false; pointerOverBubble = false; bubble.hidden = true;
  }
  function position() {
    if (!anchor || bubble.hidden) return;
    const r = anchor.getBoundingClientRect(), b = bubble.getBoundingClientRect();
    const left = Math.max(12, Math.min(innerWidth - b.width - 12, r.left + r.width / 2 - b.width / 2));
    const below = r.bottom + 11;
    const top = below + b.height <= innerHeight - 12 ? below : Math.max(12, r.top - b.height - 11);
    bubble.style.left = `${left}px`; bubble.style.top = `${top}px`;
  }
  function show(target, pin = false) {
    clearTimeout(openTimer); clearTimeout(closeTimer);
    if (pinned && anchor !== target && !pin) return;
    anchor?.removeAttribute('aria-describedby');
    anchor = target; pinned = pin || pinned;
    const [title, body] = tips[target.dataset.rinTip];
    $('rinTooltipTitle').textContent = title; $('rinTooltipText').textContent = body;
    anchor.setAttribute('aria-describedby', 'rinTooltip');
    bubble.hidden = false; position();
  }
  function scheduleHide() {
    clearTimeout(openTimer); clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (!pinned && !pointerOverBubble && document.activeElement !== anchor) hide();
    }, 220);
  }
  for (const button of document.querySelectorAll('[data-rin-tip]')) {
    button.addEventListener('pointerenter', event => {
      if (event.pointerType === 'touch') return;
      clearTimeout(closeTimer);
      openTimer = setTimeout(() => show(button), 220);
    });
    button.addEventListener('pointerleave', scheduleHide);
    button.addEventListener('focus', () => show(button));
    button.addEventListener('blur', () => {
      if (anchor === button && !pinned && !pointerOverBubble) hide();
    });
    button.addEventListener('click', () => {
      if (button.id === 'rinGuideButton') show(button, true);
      else if (anchor === button && pinned) hide(); else show(button, true);
    });
  }
  bubble.addEventListener('pointerenter', () => { pointerOverBubble = true; clearTimeout(closeTimer); });
  bubble.addEventListener('pointerleave', () => { pointerOverBubble = false; scheduleHide(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  document.addEventListener('pointerdown', event => {
    if (anchor && !anchor.contains(event.target) && !bubble.contains(event.target)) hide();
  });
  document.addEventListener('focusin', event => {
    if (anchor && !anchor.contains(event.target) && !bubble.contains(event.target)) hide();
  });
  window.addEventListener('resize', position);
  document.addEventListener('scroll', position, true);
}
