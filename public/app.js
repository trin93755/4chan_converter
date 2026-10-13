import { initRin, updateRinContext } from './rin.js';

const $ = id => document.getElementById(id);
const svg = name => `<svg aria-hidden="true"><use href="#${name}"/></svg>`;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
let token = location.hash.slice(1) || sessionStorage.getItem('frame-token') || '';
if (token) sessionStorage.setItem('frame-token', token);
history.replaceState(null, '', location.pathname);
let config = null, state = { files: [], batch: null }, importing = false, starting = false, connected = false;
let outputFormat = 'webm', filenameValid = true, previewTimer, toastTimer, previewUrl, pollTimer;
const thumbnails = new Map();
const defaults = { format: 'webm', catbox: false, encoding: 'base64url', prefix: '', suffix: '', includeSource: false, naming: 'source', longVideo: 'split' };
const controls = ['catboxToggle', 'encoding', 'prefix', 'suffix', 'includeSource', 'naming', 'longVideo', 'userhash', 'outputRoot'];
const active = () => !!state.batch?.active;
const candidates = () => state.files.filter(f => ['ready', 'error', 'cancelled'].includes(f.state));
const outputs = () => state.files.flatMap(f => f.outputs || []);
const size = bytes => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
const duration = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function updateCustomSettings() {
  const value = options();
  const custom = !!(value.prefix || value.suffix || value.naming !== defaults.naming || value.longVideo !== defaults.longVideo ||
    (config && $('outputRoot').value.trim() !== config.outputRoot) ||
    (value.catbox && (value.encoding !== defaults.encoding || value.includeSource || value.userhash)));
  $('advancedIndicator').hidden = !custom;
  $('customSettingsNotice').hidden = !$('advancedPanel').hidden || !custom;
}
function setAdvanced(enabled) {
  document.documentElement.dataset.mode = enabled ? 'advanced' : 'simple';
  $('advancedPanel').hidden = !enabled;
  $('simpleMode').setAttribute('aria-pressed', String(!enabled));
  $('advancedMode').setAttribute('aria-pressed', String(enabled));
  try { localStorage.setItem('gem-interface-mode', enabled ? 'advanced' : 'simple'); } catch {}
  updateCustomSettings();
}
$('simpleMode').addEventListener('click', () => setAdvanced(false));
$('advancedMode').addEventListener('click', () => setAdvanced(true));
$('reviewSettings').addEventListener('click', () => { setAdvanced(true); $('naming').focus(); });

function showToast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
}
async function api(endpoint, { method = 'GET', data, blob = false } = {}) {
  const response = await fetch(`/api/${endpoint}`, { method, headers: { 'X-Frame-Token': token, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
  if (!response.ok) {
    let error; try { error = (await response.json()).error; } catch { error = `Request failed (${response.status}).`; }
    throw new Error(error);
  }
  return blob ? response.blob() : response.json();
}
function options() {
  return { format: outputFormat, catbox: $('catboxToggle').checked, encoding: $('encoding').value,
    prefix: $('prefix').value, suffix: $('suffix').value, includeSource: $('includeSource').checked,
    naming: $('naming').value, longVideo: $('longVideo').value, userhash: $('userhash').value };
}
function applySettings(value) {
  outputFormat = value.format === 'mp4' ? 'mp4' : 'webm';
  for (const key of ['encoding', 'prefix', 'suffix', 'naming', 'longVideo']) $(key).value = value[key] ?? defaults[key];
  $('catboxToggle').checked = value.catbox === true; $('includeSource').checked = value.includeSource === true;
  updateSettings();
}
function updateSettings() {
  const catbox = $('catboxToggle').checked;
  for (const button of document.querySelectorAll('[data-format]')) {
    const selected = button.dataset.format === outputFormat;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', selected);
  }
  for (const id of ['encoding', 'includeSource', 'userhash']) $(id).disabled = !catbox;
  $('catboxDisclosure').hidden = !catbox;
  const hints = { base64url: 'Compact and filename-safe.', base64: 'Standard Base64; / becomes %2F.', utf8: 'Readable URL; : and / are escaped.', percent: 'Percent-encoded URL.', hex: 'UTF-8 bytes in hex. Longer, but reversible.' };
  $('encodingHint').textContent = catbox ? hints[$('encoding').value] : 'Enable Catbox audio above.';
  updateCustomSettings();
  const saved = options(); delete saved.userhash; saved.catbox = false;
  try { localStorage.setItem('frame-settings', JSON.stringify(saved)); } catch {}
  clearTimeout(previewTimer); filenameRequest++; filenameValid = false; updateActions();
  previewTimer = setTimeout(updateFilename, 180);
}
let filenameRequest = 0;
async function updateFilename() {
  const request = ++filenameRequest;
  try {
    const response = await api('filename', { method: 'POST', data: { ...options(), name: state.files[0]?.name || 'my-video.mp4' } });
    if (request !== filenameRequest) return;
    $('filenamePreview').textContent = response.filename; $('filenameError').hidden = true; filenameValid = true;
  } catch (error) {
    if (request !== filenameRequest) return;
    $('filenameError').textContent = error.message; $('filenameError').hidden = false; filenameValid = false;
    setAdvanced(true);
  }
  updateActions();
}
function updateActions() {
  const busy = active() || starting;
  $('engineStatus').innerHTML = `<span class="status-dot"></span> ${!connected ? 'Offline' : config?.dependencies.ready ? 'Local · ready' : 'Setup needed'}`;
  $('engineStatus').dataset.state = connected ? 'ready' : 'offline';
  $('settingsFields').disabled = busy;
  $('convertButton').disabled = !connected || !config?.dependencies.ready || !candidates().length || importing || busy || !filenameValid;
  $('convertButton').hidden = active() || (state.files.length > 0 && !candidates().length); $('cancelButton').hidden = !active();
  $('clearButton').disabled = busy || importing || !state.files.length;
  $('clearButton').hidden = !state.files.length;
  $('addButton').disabled = importing || !connected || !config?.dependencies.ready;
  $('folderButton').disabled = $('addButton').disabled;
  $('dropzone').setAttribute('aria-disabled', $('addButton').disabled);
  const n = candidates().length;
  $('convertButton').innerHTML = `${starting ? 'Starting…' : n ? `Convert ${n}` : 'Convert'} ${svg('arrow')}`;
  $('downloadAll').disabled = busy || !outputs().length;
  $('revealButton').disabled = !connected;
}

function render() {
  updateRinContext(state);
  const count = state.files.length;
  $('fileCount').textContent = count;
  $('fileCount').hidden = count === 0;
  $('dropzone').classList.toggle('compact', count > 0);
  $('queueSize').textContent = '';
  const focused = document.activeElement?.dataset;
  const focusSelector = focused?.action ? `[data-action="${focused.action}"][data-id="${focused.id}"]` : null;
  $('fileList').innerHTML = state.files.map(file => {
    const info = file.info;
    const status = { ready: 'In queue', queued: 'Waiting', processing: 'Converting', done: 'Verified', error: 'Failed', cancelled: 'Cancelled' }[file.state];
    const icon = file.state === 'done' ? svg('check') : file.state === 'error' ? svg('alert') : '';
    const split = info.duration > 119 && $('longVideo').value === 'split' ? `<span>${Math.ceil(info.duration / 119)} parts</span>` : '';
    return `<article class="file-item" aria-label="${escapeHtml(file.name)}"><div class="file-main"><div class="file-thumb">${thumbnails.get(file.id) ? `<img src="${thumbnails.get(file.id)}" alt="">` : svg('film')}</div><div class="file-info"><div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div><div class="file-meta"><span>${size(file.size)}</span><span>${duration(info.duration)}</span><span>${info.width} × ${info.height}</span>${split}</div></div><span class="file-status ${file.state}">${icon}${status}</span><button class="icon-button file-remove" data-action="remove" data-id="${file.id}" aria-label="Remove ${escapeHtml(file.name)}" ${active() || importing ? 'disabled' : ''}>${svg('close')}</button></div>
      ${file.state === 'processing' ? `<div class="item-progress"><progress max="100" value="${file.progress}" aria-label="Conversion progress for ${escapeHtml(file.name)}"></progress><span>${file.progress}%</span></div><div class="item-stage">${escapeHtml(file.stage)}</div>` : ''}
      ${file.error ? `<div class="file-error">${escapeHtml(file.error)}</div>` : ''}
      ${(file.outputs || []).map(output => `<div class="output-line">${svg('check')}<div class="output-info"><strong title="${escapeHtml(output.name)}">${escapeHtml(output.name)}</strong><span>${size(output.bytes)} · ${duration(output.duration)} · ${output.codec.toUpperCase()} · No audio</span></div><div class="output-actions"><button class="icon-button" title="Preview video" aria-label="Preview ${escapeHtml(output.name)}" data-action="preview" data-id="${output.id}">${svg('play')}</button>${output.audioUrl ? `<button class="icon-button" title="Copy audio link" aria-label="Copy audio link" data-action="copy" data-id="${output.id}">${svg('link')}</button>` : ''}${output.hasLocalAudio ? `<button class="icon-button" title="Download extracted audio" aria-label="Download extracted audio" data-action="audio" data-id="${output.id}">${svg('volume')}</button>` : ''}<button class="icon-button" title="Download video" aria-label="Download ${escapeHtml(output.name)}" data-action="download" data-id="${output.id}">${svg('download')}</button></div></div>${output.warning ? `<div class="file-warning">${escapeHtml(output.warning)}</div>` : ''}`).join('')}
    </article>`;
  }).join('');
  if (focusSelector) $('fileList').querySelector(focusSelector)?.focus({ preventScroll: true });
  const failed = state.files.filter(f => f.state === 'error').length;
  const out = outputs();
  $('summaryTitle').textContent = active() ? 'Converting…' : candidates().length ? `${count} ${count === 1 ? 'video' : 'videos'} · ${size(state.files.reduce((n, f) => n + f.size, 0))}` : '';
  $('summaryDetail').textContent = failed ? `${failed} failed. Convert again to retry.` : '';
  $('summaryDetail').hidden = !failed;
  $('batchProgressWrap').hidden = !active();
  const progress = count ? Math.round(state.files.reduce((sum, file) => sum + (['done', 'error', 'cancelled'].includes(file.state) ? 100 : file.progress), 0) / count) : 0;
  $('batchProgress').value = progress; $('batchProgressLabel').textContent = `${progress}%`;
  $('resultsBar').hidden = out.length === 0;
  $('resultsTitle').textContent = `${out.length} ${active() ? 'saved' : 'ready'}`;
  const warningCount = out.filter(o => o.warning).length;
  $('resultsSubtitle').textContent = warningCount ? `${warningCount} audio ${warningCount === 1 ? 'notice' : 'notices'}. See files above.` : '';
  $('resultsSubtitle').hidden = warningCount === 0;
  if (state.batch?.error) { $('connectionNotice').textContent = state.batch.error; $('connectionNotice').hidden = false; }
  updateActions();
}

async function loadThumbnails() {
  for (const file of state.files) {
    if (!file.thumbnail || thumbnails.has(file.id)) continue;
    thumbnails.set(file.id, '');
    try { const blob = await api(`thumbnail?id=${file.id}`, { blob: true }); thumbnails.set(file.id, URL.createObjectURL(blob)); }
    catch { thumbnails.delete(file.id); }
  }
  for (const [id, url] of thumbnails) if (!state.files.some(f => f.id === id)) { URL.revokeObjectURL(url); thumbnails.delete(id); }
}
async function refresh() {
  try {
    const next = await api('state');
    const changed = JSON.stringify(next) !== JSON.stringify(state);
    const justFinished = active() && !next.batch?.active;
    state = next; connected = true; $('connectionNotice').hidden = true;
    if (changed) { await loadThumbnails(); render(); }
    else updateActions();
    if (justFinished && state.files.some(f => f.state === 'error')) showToast('Finished with errors. Check the affected files.');
  } catch (error) {
    connected = false; $('connectionNotice').textContent = `Connection lost. Keep the launcher open. ${error.message}`; $('connectionNotice').hidden = false; updateActions();
  }
  pollTimer = setTimeout(refresh, active() ? 850 : 2500);
}
function upload(file, index, total) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/files?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('X-Frame-Token', token);
    xhr.upload.onprogress = event => {
      $('importBar').value = event.lengthComputable ? (event.loaded / event.total) * 100 : 0;
      $('importText').textContent = `Adding ${index}/${total} · ${file.name}`;
    };
    xhr.upload.onload = () => { $('importText').textContent = `Reading ${index}/${total} · ${file.name}`; };
    xhr.onload = () => {
      let result; try { result = JSON.parse(xhr.responseText); } catch { return reject(new Error('The file could not be imported.')); }
      xhr.status >= 200 && xhr.status < 300 ? resolve(result) : reject(new Error(result.error || 'Import failed.'));
    };
    xhr.onerror = () => reject(new Error('Import interrupted. Keep the launcher running.'));
    xhr.send(file);
  });
}
async function addFiles(list) {
  if (importing || !connected || !config?.dependencies.ready) return;
  const all = [...list];
  const accepted = all.filter(f => config.extensions.includes(`.${f.name.split('.').pop().toLowerCase()}`));
  if (!accepted.length) return showToast('No supported videos found. Add MP4, WebM, MOV, MKV, AVI, or another common video format.');
  importing = true; $('importProgress').hidden = false; updateActions();
  const errors = [];
  for (let i = 0; i < accepted.length; i++) {
    try {
      $('importText').textContent = `Adding ${i + 1}/${accepted.length} · ${accepted[i].name}`; $('importBar').value = 0;
      const item = await upload(accepted[i], i + 1, accepted.length);
      if (!state.files.some(f => f.id === item.id)) state.files.push(item);
      await loadThumbnails(); render();
    } catch (error) { errors.push(`${accepted[i].name}: ${error.message}`); }
  }
  importing = false; $('importProgress').hidden = true; render(); updateFilename();
  if (errors.length) showToast(`${errors.length} import ${errors.length === 1 ? 'failed' : 'failures'}. ${errors[0]}`);
  else if (accepted.length < all.length) showToast(`Added ${accepted.length} videos. Skipped ${all.length - accepted.length} unsupported files.`);
}

async function walkEntry(entry) {
  if (entry.isFile) return [await new Promise((resolve, reject) => entry.file(resolve, reject))];
  if (!entry.isDirectory) return [];
  const reader = entry.createReader(); const files = [];
  while (true) {
    const entries = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!entries.length) break;
    for (const child of entries) files.push(...await walkEntry(child));
  }
  return files;
}
const browse = () => { if (!$('addButton').disabled) $('fileInput').click(); };
$('dropzone').addEventListener('click', browse);
$('dropzone').addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); browse(); } });
$('addButton').addEventListener('click', browse);
$('folderButton').addEventListener('click', () => $('folderInput').click());
for (const id of ['fileInput', 'folderInput']) $(id).addEventListener('change', event => { addFiles(event.target.files); event.target.value = ''; });
for (const eventName of ['dragenter', 'dragover']) $('dropzone').addEventListener(eventName, event => { event.preventDefault(); $('dropzone').classList.add('dragging'); });
$('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('dragging'));
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => event.preventDefault());
$('dropzone').addEventListener('drop', async event => {
  event.preventDefault(); $('dropzone').classList.remove('dragging');
  const entries = [...(event.dataTransfer.items || [])].map(item => item.webkitGetAsEntry?.()).filter(Boolean);
  const fallback = [...event.dataTransfer.files];
  try { await addFiles(entries.length ? (await Promise.all(entries.map(walkEntry))).flat() : fallback); }
  catch (error) { showToast(error.message); }
});

for (const button of document.querySelectorAll('[data-format]')) button.addEventListener('click', () => { outputFormat = button.dataset.format; updateSettings(); });
for (const id of controls) $(id).addEventListener('input', () => { updateSettings(); if (id === 'longVideo') render(); });
$('resetSettings').addEventListener('click', () => { $('userhash').value = ''; $('outputRoot').value = config.outputRoot; applySettings(defaults); });
$('convertButton').addEventListener('click', async () => {
  if ($('convertButton').disabled) return;
  starting = true; updateActions();
  try {
    state = await api('convert', { method: 'POST', data: { ids: candidates().map(f => f.id), options: options(), outputRoot: $('outputRoot').value.trim() } });
    render(); clearTimeout(pollTimer); refresh();
  } catch (error) { showToast(error.message); }
  finally { starting = false; updateActions(); }
});
$('cancelButton').addEventListener('click', async () => {
  $('cancelButton').disabled = true; $('cancelButton').textContent = 'Cancelling…';
  try { await api('cancel', { method: 'POST' }); showToast('Cancelling. Finished exports are kept.'); }
  catch (error) { showToast(error.message); }
  finally { $('cancelButton').disabled = false; $('cancelButton').textContent = 'Cancel'; }
});
$('clearButton').addEventListener('click', async () => {
  try { state = await api('clear', { method: 'POST' }); await loadThumbnails(); render(); updateFilename(); showToast('Cleared. Exports kept.'); }
  catch (error) { showToast(error.message); }
});
async function download(endpoint, filename) {
  const blob = await api(endpoint, { blob: true });
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
$('fileList').addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const { action, id } = button.dataset;
  try {
    if (action === 'remove') { state = await api('remove', { method: 'POST', data: { id } }); await loadThumbnails(); render(); updateFilename(); return; }
    const output = outputs().find(o => o.id === id); if (!output) return;
    if (action === 'download') { button.disabled = true; await download(`download?id=${id}`, output.name); }
    if (action === 'audio') { button.disabled = true; await download(`download?id=${id}&audio=1`, output.name.replace(/\.(webm|mp4)$/, '.mp3')); }
    if (action === 'copy') { await navigator.clipboard.writeText(output.audioUrl); showToast('Audio link copied.'); }
    if (action === 'preview') {
      const blob = await api(`download?id=${id}`, { blob: true });
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(blob); $('previewVideo').src = previewUrl;
      $('previewTitle').textContent = output.name;
      $('previewInfo').textContent = `${size(output.bytes)} · ${duration(output.duration)} · ${output.width} × ${output.height} · ${output.codec.toUpperCase()} · No audio`;
      $('previewDialog').showModal();
    }
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});
$('revealButton').addEventListener('click', async () => { try { await api('reveal', { method: 'POST' }); } catch (error) { showToast(error.message); } });
$('downloadAll').addEventListener('click', async () => {
  $('downloadAll').disabled = true; $('downloadAll').innerHTML = `${svg('loader')} Preparing ZIP…`;
  try { await download('archive', '4chan-gem-exports.zip'); } catch (error) { showToast(error.message); }
  finally { $('downloadAll').innerHTML = `${svg('download')} Download ZIP`; updateActions(); }
});
$('helpButton').addEventListener('click', () => $('helpDialog').showModal());
$('profileButton').addEventListener('click', () => $('helpDialog').showModal());
$('closeHelp').addEventListener('click', () => $('helpDialog').close());
$('closePreview').addEventListener('click', () => $('previewDialog').close());
$('previewDialog').addEventListener('close', () => { $('previewVideo').pause(); $('previewVideo').removeAttribute('src'); $('previewVideo').load(); if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; });
for (const id of ['helpDialog', 'previewDialog']) $(id).addEventListener('click', event => { if (event.target === $(id)) { const r = $(id).getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $(id).close(); } });
$('quitButton').addEventListener('click', async () => {
  if (active() && !confirm('Quit and cancel this batch? Finished exports are kept.')) return;
  try { await api('shutdown', { method: 'POST' }); clearTimeout(pollTimer); connected = false; $('connectionNotice').textContent = 'App closed. Use the launcher to start again.'; $('connectionNotice').hidden = false; updateActions(); }
  catch (error) { showToast(error.message); }
});

async function boot() {
  try {
    config = await api('config'); connected = true;
    $('outputRoot').value = config.outputRoot;
    let saved = defaults; try { saved = { ...defaults, ...JSON.parse(localStorage.getItem('frame-settings') || '{}'), catbox: false }; } catch {}
    applySettings(saved);
    let advanced = false; try { advanced = localStorage.getItem('gem-interface-mode') === 'advanced'; } catch {}
    setAdvanced(advanced);
    $('engineStatus').innerHTML = `<span class="status-dot"></span> ${config.dependencies.ready ? 'Local · ready' : 'Setup needed'}`;
    if (!config.dependencies.ready) {
      $('setupNotice').textContent = `${config.dependencies.error} Install FFmpeg with VP9, H.264, and MP3 support, then restart. See README.md.`;
      $('setupNotice').hidden = false;
    }
    await refresh();
  } catch (error) { $('connectionNotice').textContent = error.message; $('connectionNotice').hidden = false; connected = false; }
  render();
}
initRin();
boot();
