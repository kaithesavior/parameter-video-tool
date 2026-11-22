'use strict';
// Video library: the sidebar list of videos.
// Imported videos are uploaded to the local server and saved in the project's videos/ folder
// (server.cjs, /api/videos), so they are ordinary files on this computer; nothing leaves it.
// The list shows that folder. Removing a video deletes its file.
// If the server cannot save a video (e.g. the page was opened without `npm start`), the video
// is kept for the current session only.

const LIBRARY_ACTIVE_KEY = 'stickies.library.active',
  LIBRARY_COLLAPSED_KEY = 'stickies.library.collapsed',
  LIBRARY_THUMBS_KEY = 'stickies.library.thumbs',
  LIBRARY_TIMEOUT_MS = 3000,
  THUMB_WIDTH = 160,
  WRITE_HEADERS = { 'x-stickies-videos': '1' };

// {id, name, size, duration, thumb, url, stored, blob?}
// id is 'file:<name>' for videos in the folder, 'session-…' for session-only ones.
let libraryVideos = [];
// Whether the server can save videos. When it cannot, the sidebar says so until it can.
let folderAvailable = true;
const FOLDER_WARNING =
  'Videos cannot be saved to the videos folder, so imported videos disappear on reload. ' +
  'Restart the tool (stop npm start with Ctrl+C, run npm start again), reload this page and import them again.';

function folderVideoId(name) {
  return 'file:' + name;
}
function folderVideoUrl(name) {
  return 'videos/' + encodeURIComponent(name);
}

// ----- Server: the videos folder ------------------------------------------------------------------

function withTimeout(promise, ms, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}
async function serverJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'HTTP ' + response.status);
  return body;
}
async function fetchFolderVideos() {
  try {
    const body = await serverJson(
      await withTimeout(fetch('/api/videos', { cache: 'no-store' }), LIBRARY_TIMEOUT_MS, 'The server did not respond.'),
    );
    folderAvailable = true;
    return body.videos;
  } catch (error) {
    folderAvailable = false;
    throw error;
  }
}
async function uploadToFolder(file, name = file.name) {
  return serverJson(
    await fetch('/api/videos?name=' + encodeURIComponent(name), {
      method: 'POST',
      headers: { ...WRITE_HEADERS, 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }),
  );
}
async function deleteFromFolder(name) {
  const response = await fetch('/api/videos/' + encodeURIComponent(name), { method: 'DELETE', headers: WRITE_HEADERS });
  if (!response.ok && response.status !== 404) await serverJson(response);
}

// ----- Thumbnails and durations (cached in this browser) -------------------------------------------

function readThumbCache() {
  try {
    return JSON.parse(localStorage.getItem(LIBRARY_THUMBS_KEY) || '{}');
  } catch {
    return {};
  }
}
function thumbKey(entry) {
  return entry.name + '|' + entry.size;
}
function rememberThumb(entry) {
  const cache = readThumbCache();
  cache[thumbKey(entry)] = { duration: entry.duration, thumb: entry.thumb };
  // Keep only videos still in the library.
  const keep = new Set(libraryVideos.map(thumbKey));
  for (const key of Object.keys(cache)) if (!keep.has(key)) delete cache[key];
  try {
    localStorage.setItem(LIBRARY_THUMBS_KEY, JSON.stringify(cache));
  } catch {
    // A missing thumbnail is regenerated next time.
  }
}

// Resolves with {duration, thumb}, or null when the browser cannot play the video.
function probeVideo(src) {
  return new Promise(resolve => {
    const probe = document.createElement('video');
    probe.muted = true;
    probe.playsInline = true;
    probe.preload = 'auto';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.removeAttribute('src');
      probe.load();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), 10000);
    probe.onloadedmetadata = () => {
      if (!Number.isFinite(probe.duration) || !probe.videoWidth) return finish(null);
      probe.currentTime = Math.min(1, probe.duration * 0.1);
    };
    probe.onseeked = () => {
      const canvas = document.createElement('canvas');
      canvas.width = THUMB_WIDTH;
      canvas.height = Math.round((THUMB_WIDTH * probe.videoHeight) / probe.videoWidth);
      let thumb = '';
      try {
        canvas.getContext('2d').drawImage(probe, 0, 0, canvas.width, canvas.height);
        thumb = canvas.toDataURL('image/jpeg', 0.7);
      } catch {
        // A thumbnail is optional.
      }
      finish({ duration: probe.duration, thumb });
    };
    probe.onerror = () => finish(null);
    probe.src = src;
  });
}
// Fills in missing thumbnails one video at a time, without blocking the editor.
async function fillMissingThumbs() {
  for (const entry of libraryVideos.filter(item => !item.thumb && item.url)) {
    const info = await probeVideo(entry.url);
    if (!info || !libraryVideos.includes(entry)) continue;
    Object.assign(entry, info);
    rememberThumb(entry);
    paintVideoLibrary();
  }
}

// ----- Importing, opening and removing --------------------------------------------------

function libraryFind(id) {
  return libraryVideos.find(entry => entry.id === id);
}
// Opens the first video in the library, or shows "No video" when the library is empty.
async function openFirstVideo() {
  if (libraryVideos.length) return openLibraryVideo(libraryVideos[0].id);
  unloadVideo();
}
// The library entry for a file name, used when a timeline JSON names its video.
function libraryFindByName(name) {
  return libraryVideos.find(entry => entry.name === name);
}
function folderEntry(video, cached = readThumbCache()) {
  const entry = {
    id: folderVideoId(video.name),
    name: video.name,
    size: video.size,
    url: folderVideoUrl(video.name),
    duration: Number.NaN,
    thumb: '',
    stored: true,
  };
  return Object.assign(entry, cached[thumbKey(entry)]);
}

// Saves video files to the videos folder and resolves with their library entries. Files the
// browser cannot play are skipped; importing the same file twice reuses it.
async function importVideos(fileList) {
  const files = Array.from(fileList || []);
  const entries = [],
    skipped = [];
  let sessionOnly = 0;
  // One file at a time on purpose: decoding or uploading several large videos at once can
  // exhaust memory.
  for (const file of files) {
    const local = URL.createObjectURL(file);
    const info = await probeVideo(local);
    URL.revokeObjectURL(local);
    if (!info) {
      skipped.push(file.name);
      continue;
    }
    setStatus(`Saving "${file.name}" to the videos folder…`);
    let entry;
    try {
      const saved = await uploadToFolder(file);
      folderAvailable = true;
      entry = folderEntry({ name: saved.name, size: saved.size });
    } catch (error) {
      folderAvailable = false;
      console.warn('Video kept for this session only:', error);
      entry = { id: 'session-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: file.name, size: file.size, blob: file, url: '', stored: false };
      sessionOnly++;
    }
    Object.assign(entry, info);
    libraryVideos = [entry, ...libraryVideos.filter(item => item.id !== entry.id)];
    if (entry.stored) rememberThumb(entry);
    entries.push(entry);
  }
  paintVideoLibrary();
  const notes = [];
  if (skipped.length) notes.push(`Not a playable video: ${skipped.join(', ')}. Use MP4 or WebM.`);
  if (sessionOnly)
    notes.push(`${sessionOnly} video(s) could not be saved and will be gone after a reload. Restart npm start, then import again.`);
  if (notes.length) {
    setStatus(notes.join(' '), skipped.length ? 'error' : 'warn');
    // Shown again instead of "Video ready." when the imported video opens.
    startupNotice = notes.join(' ');
  }
  else if (entries.length) setStatus(`Saved to the videos folder: ${entries.map(entry => entry.name).join(', ')}.`);
  return entries;
}

function rememberActive(id) {
  try {
    localStorage.setItem(LIBRARY_ACTIVE_KEY, id);
  } catch {
    // Remembering the last video is a convenience only.
  }
}

async function openLibraryVideo(id) {
  if (recording) return;
  const entry = libraryFind(id);
  if (!entry) return;
  rememberActive(id);
  if (!entry.stored) return loadFile(entry.blob, entry.name, entry.id);
  return loadVideoUrl(entry.url, entry.name, entry.id);
}

async function removeLibraryVideo(id) {
  const entry = libraryFind(id);
  if (!entry || recording) return;
  const where = entry.stored ? ' This deletes the file from the videos folder.' : '';
  if (!confirm(`Remove "${entry.name}"?${where}`)) return;
  if (entry.stored) {
    try {
      await deleteFromFolder(entry.name);
    } catch (error) {
      setStatus(`Could not delete "${entry.name}": ${error.message}`, 'error');
      return;
    }
  }
  libraryVideos = libraryVideos.filter(item => item.id !== id);
  forgetVideoState(id);
  if (currentVideoId === id) await openFirstVideo().catch(error => setStatus(error.message));
  paintVideoLibrary();
  setStatus(`Removed "${entry.name}".`);
}

async function clearLibrary() {
  if (recording || !libraryVideos.length) return;
  if (!confirm(`Remove all ${libraryVideos.length} imported video(s)? Their files are deleted from the videos folder.`))
    return;
  const failed = [];
  for (const entry of libraryVideos) {
    try {
      if (entry.stored) await deleteFromFolder(entry.name);
      forgetVideoState(entry.id);
    } catch {
      failed.push(entry);
    }
  }
  libraryVideos = failed;
  if (!failed.some(entry => entry.id === currentVideoId)) await openFirstVideo().catch(error => setStatus(error.message));
  paintVideoLibrary();
  setStatus(
    failed.length
      ? `Could not delete: ${failed.map(entry => entry.name).join(', ')}.`
      : 'Library cleared. Import a video to continue.',
  );
}

// ----- Moving videos from older versions --------------------------------------------------------------
// Earlier versions kept imported videos inside the browser (IndexedDB). They are uploaded to the
// videos folder once, with their saved parameters and timelines, and then removed from the browser.

const OLD_DB = 'stickies-video-library',
  OLD_STORE = 'videos';
function readOldVideos() {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') return resolve([]);
    let request;
    try {
      request = indexedDB.open(OLD_DB);
    } catch {
      return resolve([]);
    }
    request.onupgradeneeded = () => request.transaction.abort(); // nothing stored: do not create it
    request.onerror = () => resolve([]);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OLD_STORE)) {
        db.close();
        return resolve([]);
      }
      const all = db.transaction(OLD_STORE).objectStore(OLD_STORE).getAll();
      all.onsuccess = () => {
        db.close();
        resolve(all.result || []);
      };
      all.onerror = () => {
        db.close();
        resolve([]);
      };
    };
  });
}
async function moveOldVideos() {
  const old = await withTimeout(readOldVideos(), LIBRARY_TIMEOUT_MS, 'Browser storage did not respond.');
  if (!old.length) return 0;
  let moved = 0;
  let active = null;
  try {
    active = localStorage.getItem(LIBRARY_ACTIVE_KEY);
  } catch {
    // Not important.
  }
  for (const entry of old) {
    if (!entry?.blob) continue;
    setStatus(`Moving "${entry.name}" into the videos folder…`);
    const saved = await uploadToFolder(entry.blob, entry.name);
    const newId = folderVideoId(saved.name);
    try {
      VideoState.move(localStorage, entry.id, newId);
      if (active === entry.id) localStorage.setItem(LIBRARY_ACTIVE_KEY, newId);
    } catch {
      // Storage blocked: the video still moves.
    }
    moved++;
  }
  await new Promise(resolve => {
    const request = indexedDB.deleteDatabase(OLD_DB);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
  return moved;
}

// ----- Sidebar ------------------------------------------------------------------------------

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600),
    minutes = Math.floor((total % 3600) / 60),
    secs = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}
function formatSize(bytes) {
  if (!bytes) return '';
  return bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : (bytes / 1e6).toFixed(1) + ' MB';
}

function libraryRow(entry) {
  const item = document.createElement('li');
  item.className = 'library-item';
  if (entry.id === currentVideoId) item.setAttribute('aria-current', 'true');
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'library-open';
  open.title = entry.stored ? `${entry.name}\nvideos/${entry.name}` : entry.name;
  open.onclick = () => openLibraryVideo(entry.id).catch(error => setStatus(error.message));
  const thumb = document.createElement('span');
  thumb.className = 'library-thumb';
  if (entry.thumb) thumb.style.backgroundImage = `url("${entry.thumb}")`;
  const time = document.createElement('span');
  time.className = 'library-duration';
  time.textContent = formatDuration(entry.duration);
  thumb.append(time);
  const text = document.createElement('span');
  text.className = 'library-text';
  const name = document.createElement('span');
  name.className = 'library-name';
  name.textContent = entry.name;
  const meta = document.createElement('span');
  meta.className = 'library-meta';
  meta.textContent = [formatSize(entry.size), entry.stored ? '' : 'this session only'].filter(Boolean).join(' · ');
  text.append(name, meta);
  open.append(thumb, text);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'library-remove icon ghost sm';
  remove.title = entry.stored ? 'Delete from the videos folder' : 'Remove';
  remove.setAttribute('aria-label', `Remove ${entry.name}`);
  remove.textContent = '×';
  remove.onclick = () => void removeLibraryVideo(entry.id);
  item.append(open, remove);
  return item;
}

function paintVideoLibrary() {
  const list = $('library-list');
  if (!list) return;
  list.replaceChildren(...libraryVideos.map(libraryRow));
  $('library-count').textContent = String(libraryVideos.length);
  $('library-clear').disabled = !libraryVideos.length || recording;
  $('library-empty').hidden = libraryVideos.length > 0 || !folderAvailable;
  $('library-warning').hidden = folderAvailable;
  $('library-warning').textContent = FOLDER_WARNING;
}

function setLibraryCollapsed(collapsed) {
  document.querySelector('main').classList.toggle('library-collapsed', collapsed);
  $('library-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('library-toggle').title = collapsed ? 'Show video library' : 'Hide video library';
  try {
    localStorage.setItem(LIBRARY_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Convenience only.
  }
}

// ----- Wiring and start-up --------------------------------------------------------------------

$('open').onclick = () => $('file').click();
$('library-add').onclick = () => $('file').click();
$('viewer-import').onclick = () => $('file').click();
// One Import for everything: videos go to the videos folder (the first one opens); a JSON file
// (a cue timeline or view parameters) is applied, together with a video selected alongside it.
$('file').onchange = async () => {
  const input = $('file');
  try {
    const files = Array.from(input.files || []);
    if (files.some(file => isJsonFile(file))) {
      await openJsonFiles(files);
    } else {
      const entries = await importVideos(files);
      if (entries.length) await openLibraryVideo(entries[0].id);
    }
  } catch (error) {
    setStatus('Import failed: ' + error.message);
  } finally {
    input.value = '';
  }
};
$('library-clear').onclick = () => void clearLibrary();
$('library-toggle').onclick = () =>
  setLibraryCollapsed(!document.querySelector('main').classList.contains('library-collapsed'));

async function startLibrary() {
  try {
    setLibraryCollapsed(localStorage.getItem(LIBRARY_COLLAPSED_KEY) === '1');
  } catch {
    setLibraryCollapsed(false);
  }
  paintVideoLibrary();
  let moved = 0;
  try {
    moved = await moveOldVideos();
  } catch (error) {
    console.warn('Videos from an older version could not be moved yet:', error);
  }
  try {
    const cached = readThumbCache();
    libraryVideos = (await fetchFolderVideos()).map(video => folderEntry(video, cached));
  } catch (error) {
    console.warn('Video library unavailable:', error);
    startupNotice ||= 'The videos folder could not be read, so imported videos will last this session only. Restart npm start and reload.';
  }
  if (moved) startupNotice ||= `${moved} video(s) from an earlier version were moved into the videos folder.`;
  paintVideoLibrary();
  // The last video watched, else the first in the library, else "No video".
  let last = null;
  try {
    last = localStorage.getItem(LIBRARY_ACTIVE_KEY);
  } catch {
    // Open the first video instead.
  }
  const opening = libraryFind(last) ? openLibraryVideo(last) : openFirstVideo();
  await Promise.resolve(opening).catch(error => {
    setStatus(error.message, 'warn');
    unloadVideo();
  });
  if (!libraryVideos.length && startupNotice) setStatus(startupNotice, 'warn');
  else if (!libraryVideos.length) setStatus('No videos yet. Import a video to start.');
  paintVideoLibrary();
  void fillMissingThumbs();
}
void startLibrary();
