const $ = id => document.getElementById(id);
const tips = {
  guide: ['A little preparation goes a long way.', 'Drop in a whole batch. Choose your format once, then let the conversion queue do the work. Your originals stay untouched.'],
  format: ['Pick your kind of magic.', 'WebM aims for compact files. MP4 is usually faster to encode. Both formats are exported silently and checked against the same limits.'],
  audio: ['Keep the soundtrack, separately.', 'Turn on Catbox to upload an MP3 publicly and put its link in the filename. Leave it off to keep everything on your device.'],
  encoding: ['A tidy name is a useful name.', 'Base64url is compact and portable. Prefixes and suffixes go outside the link. Encoding is reversible; it is not encryption.'],
  privacy: ['Your workshop. Your files.', 'Video conversion happens on your computer. Only the optional Catbox setting sends audio online. No account is needed.'],
};
const notes = [
  ['Leave the details to me.', "Add your videos together. I'll help you keep the whole batch within the limits."],
  ['Keep the whole story.', 'Long videos can be split into matching parts automatically. Change that in Advanced options.'],
  ['A little space to spare.', 'The size target leaves room below the limit. Each finished video is decoded and checked before it gets its badge.'],
  ['The soundtrack is optional.', 'Catbox gives your audio its own public link. Your video stays silent, and a local MP3 is saved too.'],
  ['Make the filename yours.', 'Find link encoding, prefixes, suffixes, and a live filename preview in Advanced options.'],
  ['Prefer a quieter workshop?', 'Use the pause button beside Help to stop the character animations. Your system’s reduced-motion preference is respected too.'],
];
let noteIndex = 0, lastContext = '', initialized = false;
function note(title, message, mood = 'A little guidance') {
  $('rinTitle').textContent = title; $('rinMessage').textContent = message; $('rinMood').textContent = mood;
}
export function updateRinContext(state) {
  if (!initialized) return;
  const files = state.files || [];
  const errors = files.filter(f => f.state === 'error').length;
  const done = files.filter(f => f.state === 'done').length;
  const key = state.batch?.active ? 'active' : errors ? `error:${errors}` : done ? `done:${done}:${files.length}` : files.length ? `queued:${files.length}` : 'empty';
  if (key === lastContext) return;
  lastContext = key;
  if (state.batch?.active) note('Good things take a little precision.', 'I’ll keep an eye on the queue. Finished files are checked for size, duration, codec, and audio before they’re saved.', 'At work');
  else if (errors) note('Let’s take another look.', 'Check the message beside the affected video. Your originals and any completed exports are safe.', 'Needs attention');
  else if (done && done === files.length) note('Your exports are ready.', 'Preview the results, open their folder, or download the whole batch. Check any audio notices before posting.', 'All checked');
  else if (files.length) note(`${files.length === 1 ? 'One video' : `${files.length} videos`}. You’re all set.`, 'Choose WebM or MP4, decide whether to keep the audio separately, and start your conversion.', 'Ready when you are');
  else note(...notes[0]);
}
export function initRin() {
  initialized = true;
  const nextNote = () => { noteIndex = (noteIndex + 1) % notes.length; note(...notes[noteIndex]); };
  $('rinNextTip').addEventListener('click', nextNote);
  $('rinGuideButton').addEventListener('click', nextNote);

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
      if (anchor === button && pinned) hide(); else show(button, true);
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
