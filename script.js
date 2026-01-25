/* ================= CONFIG ================= */
const CLIENT_ID = "986736634476-ph01g1mpr6f50c0oi3qb61u946dcmtcc.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/drive.readonly";
const ROOT_MUSIC_FOLDER_ID = "1h7LJQvQmHq_XjJwxCch8SXtsjR3qjgdD";

let accessToken = null;
let tokenExpiry = 0; // Timestamp when token expires
let tokenClient = null;
let pendingTokenResolver = null;
let loginShouldLoadRoot = false;
let currentAudioUrl = null;
let folderStack = [];
let currentFolderId = ROOT_MUSIC_FOLDER_ID;
let allItems = []; // Store all items for search
let searchTimeout = null;
let currentPlaylist = []; // Songs in current folder
let originalPlaylist = []; // Unshuffled order for restoring
let isShuffleOn = false; // Toggle state
let currentTrackIndex = -1; // Current playing track index
// Streaming helpers to allow abort and MediaSource usage
let currentStreamController = null;
let currentMediaSource = null;

// Track album art blob URL so we can revoke it when replaced
let currentAlbumArtUrl = null;

// Set the default bottom album art (simple emoji/icon) and clear any previous blob URL
function setDefaultAlbumArt() {
    const el = document.querySelector('.album-art');
    if (!el) return;
    if (currentAlbumArtUrl) {
        try { URL.revokeObjectURL(currentAlbumArtUrl); } catch (e) { }
        currentAlbumArtUrl = null;
    }

    // Premium SVG Audio Icon
    const audioIconSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="100%" height="100%">
        <circle cx="24" cy="24" r="20" fill="#262626"/>
        <path d="M20,14v16.1c-0.8-0.6-1.9-1-3-1c-2.8,0-5,2.2-5,5s2.2,5,5,5s5-2.2,5-5V20h8v-6H20z" fill="#FFB300"/>
      </svg>
    `;

    el.innerHTML = audioIconSvg;
    el.style.background = 'transparent';
    el.style.boxShadow = 'none';
}

// Prefetching helpers to reduce gap between songs
const PREFETCH_THRESHOLD = 20; // seconds before end to start preloading
// Increase initial prefetch to 512KB for more reliable quick starts
const PREFETCH_INITIAL_CHUNK = 512 * 1024; // initial bytes to fetch for next track
let preloadedTracks = {}; // fileId -> { initialBuffer, contentRange, status, fullBlobUrl }
let prefetchControllers = {};

/* ================= LOGIN ================= */
function login(shouldLoadRoot = true) {
    // If GSI hasn't loaded yet, wait a short while and try again (improves UX on slow network)
    if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
        showMessage('Google Identity Services loading… will try shortly.', false, 3000);
        const start = Date.now();
        const wait = setInterval(() => {
            if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
                clearInterval(wait);
                login(shouldLoadRoot);
            } else if (Date.now() - start > 10000) {
                clearInterval(wait);
                showMessage('Google Identity Services failed to load. Check network or try reloading the page.', true);
            }
        }, 500);
        return;
    }

    if (!tokenClient) {
        try {
            tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: CLIENT_ID,
                scope: SCOPES,
                callback: token => {
                    accessToken = token.access_token;
                    // Store expiry time (minus 5 minutes buffer for safety)
                    if (token.expires_in) {
                        tokenExpiry = Date.now() + (token.expires_in * 1000) - (5 * 60 * 1000);
                        console.debug('Token refreshed. Expires in:', token.expires_in, 'seconds');
                    } else {
                        tokenExpiry = Date.now() + 3500 * 1000; // Default assumption if missing
                    }

                    if (pendingTokenResolver) {
                        pendingTokenResolver(accessToken);
                        pendingTokenResolver = null;
                    }
                    if (loginShouldLoadRoot) {
                        loginShouldLoadRoot = false;
                        loadRootFolders();
                    }
                }
            });
        } catch (e) {
            showMessage('Failed to initialize Google Identity (check console).', true);
            console.error(e);
            return;
        }
    }
    loginShouldLoadRoot = shouldLoadRoot;
    try {
        tokenClient.requestAccessToken({ prompt: '' });
    } catch (e) {
        showMessage('Failed to request access token.', true);
        console.error(e);
    }
}

// Get an access token, prompting if needed. Resolves to a token string or rejects on timeout/error.
function getAccessToken() {
    return new Promise((resolve, reject) => {
        // Return valid token if not expired
        if (accessToken && Date.now() < tokenExpiry) return resolve(accessToken);

        if (accessToken) console.debug('Token expired or expiring soon, refreshing...');

        if (!tokenClient) {
            // Create token client on-demand and request a token (do not auto-load root by default)
            login(false);
        }

        // If we already have a pending resolver, we might append to it? simpler to just overwrite or queue.
        // For simplicity, overwrite current listener or assume sequential calls.
        pendingTokenResolver = (token) => resolve(token);

        // Trigger a token request which will resolve pendingTokenResolver via callback
        if (tokenClient) tokenClient.requestAccessToken({ prompt: '' });

        // Timeout in case something goes wrong with the token flow
        setTimeout(() => {
            if (pendingTokenResolver) {
                pendingTokenResolver = null;
                reject(new Error('Timed out getting access token'));
            }
        }, 15000);
    });
}

// Wrapper for Google Drive requests that ensures a valid token and retries once on 401/403
async function driveFetch(url, options = {}) {
    try {
        await getAccessToken();
        options.headers = options.headers || {};
        options.headers['Authorization'] = `Bearer ${accessToken}`;

        let res = await fetch(url, options);
        if (res.status === 401 || res.status === 403) {
            // Try refreshing token and retry once
            accessToken = null;
            try {
                await getAccessToken();
                options.headers['Authorization'] = `Bearer ${accessToken}`;
                res = await fetch(url, options);
            } catch (err) {
                showMessage('Authentication required. Please sign in.', true);
                throw err;
            }
        }

        // If non-OK, show a message but return the response to callers for fine-grained handling
        if (!res.ok) {
            console.debug('driveFetch: non-OK response', { url, status: res.status, statusText: res.statusText });
            showMessage(`Request failed: ${res.status} ${res.statusText}`, true);
        }

        return res;
    } catch (err) {
        showMessage(err.message || 'Network error', true);
        throw err;
    }
}

// Simple non-blocking notification UI helper
function showMessage(msg, isError = false, timeout = 5000) {
    const el = document.getElementById('notif');
    if (!el) {
        console.log((isError ? 'ERROR: ' : '') + msg);
        return;
    }
    el.textContent = msg;
    el.style.display = 'block';
    el.style.background = isError ? 'rgba(255, 80, 80, 0.08)' : 'rgba(255, 179, 0, 0.06)';
    el.style.borderColor = isError ? 'rgba(255, 80, 80, 0.16)' : 'rgba(255, 179, 0, 0.12)';
    setTimeout(() => { el.style.display = 'none'; }, timeout);
}

// Helper to fetch a specific byte range (requires valid access token)
async function fetchRange(url, start, end, signal) {
    try {
        const headers = { 'Range': `bytes=${start}-${end}` };
        // driveFetch automatically adds Authorization header
        const res = await driveFetch(url, { headers, signal });
        if (!res.ok) {
            // 416 means range not satisfiable (e.g. file smaller than requested chunk)
            if (res.status === 416) return { status: 416, buffer: new ArrayBuffer(0), contentRange: res.headers.get('Content-Range') };
            throw new Error(`fetchRange failed: ${res.status}`);
        }
        const buffer = await res.arrayBuffer();
        return {
            buffer,
            status: res.status,
            contentRange: res.headers.get('Content-Range'),
            total: res.headers.get('Content-Range') ? parseInt(res.headers.get('Content-Range').split('/')[1]) : null
        };
    } catch (e) {
        if (signal && signal.aborted) throw e;
        console.error('fetchRange error', e);
        throw e;
    }
}

// Set album art for current track. Tries the provided thumbnail URL, and falls back to fetching the image via driveFetch if direct load fails.
async function setAlbumArt(fileId, thumbnailLink) {
    const el = document.querySelector('.album-art');
    if (!el) return;
    console.debug('setAlbumArt start', { fileId, thumbnailLink });

    // Remove previous object URL if any
    if (currentAlbumArtUrl) {
        try { URL.revokeObjectURL(currentAlbumArtUrl); } catch (e) { /* ignore */ }
        currentAlbumArtUrl = null;
    }

    // Show spinner and clear existing content
    el.innerHTML = '';
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    el.appendChild(spinner);

    // Default to emoji while loading/fallback
    let used = false;
    if (!thumbnailLink) {
        // No thumbnail available -> remove spinner and show default
        spinner.remove();
        el.textContent = '🎵';
        console.debug('setAlbumArt: no thumbnailLink provided');
        return;
    }

    // Try direct image load first (may fail due to CORS or auth)
    try {
        const img = new Image();
        img.alt = 'Album art';
        img.src = thumbnailLink;
        await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
        spinner.remove();
        el.innerHTML = '';
        el.appendChild(img);
        used = true;
        console.debug('setAlbumArt: direct load succeeded');
    } catch (err) {
        console.debug('setAlbumArt: direct load failed, trying auth fetch', err);
        // Direct load failed; fall back to fetching via authorized connection
        try {
            const res = await driveFetch(thumbnailLink);
            console.debug('setAlbumArt: driveFetch response', { status: res.status, ok: res.ok });
            if (!res.ok) throw new Error('Thumbnail fetch failed');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            currentAlbumArtUrl = url;
            const img = new Image();
            img.alt = 'Album art';
            img.src = url;
            await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
            spinner.remove();
            el.innerHTML = '';
            el.appendChild(img);
            used = true;
            console.debug('setAlbumArt: auth fetch succeeded');
        } catch (err2) {
            console.warn('Failed to load thumbnail via auth fetch', err2);
        }
    }

    if (!used) {
        spinner.remove();
        el.textContent = '🎵';
        console.debug('setAlbumArt: using fallback emoji');
    }
}

// Set the default bottom album art (simple emoji/icon) and clear any previous blob URL
function setDefaultAlbumArt() {
    const el = document.querySelector('.album-art');
    if (!el) return;
    if (currentAlbumArtUrl) {
        try { URL.revokeObjectURL(currentAlbumArtUrl); } catch (e) { }
        currentAlbumArtUrl = null;
    }
    el.innerHTML = '🎵';
}

// Load an <img> element with a thumbnail URL. Tries direct load first and falls back to fetching via driveFetch (auth) if needed.
async function loadThumbnailImage(imgEl, thumbnailUrl) {
    if (!imgEl || !thumbnailUrl) return;
    console.debug('loadThumbnailImage start', { thumbnailUrl, imgEl });
    return new Promise(async (resolve) => {
        let revokedUrl = null;
        const cleanup = () => {
            imgEl.onload = null; imgEl.onerror = null;
            if (revokedUrl) {
                try { URL.revokeObjectURL(revokedUrl); } catch (e) { }
                revokedUrl = null;
            }
            resolve();
        };

        imgEl.onload = () => {
            console.debug('loadThumbnailImage: direct load succeeded', { thumbnailUrl });
            cleanup();
        };
        imgEl.onerror = async (ev) => {
            console.debug('loadThumbnailImage: direct load failed, will try auth fetch', { thumbnailUrl, error: ev });
            // Try fetching via authorized endpoint (driveFetch)
            try {
                const res = await driveFetch(thumbnailUrl);
                console.debug('loadThumbnailImage: driveFetch response', { status: res.status, ok: res.ok });
                if (!res.ok) return cleanup();
                const blob = await res.blob();
                revokedUrl = URL.createObjectURL(blob);
                imgEl.src = revokedUrl;
                // Wait for onload/onerror to resolve
            } catch (e) {
                console.debug('loadThumbnailImage: auth fetch failed', e);
                cleanup();
            }
        };

        // Kick off: try direct set first
        try { imgEl.src = thumbnailUrl; } catch (e) { imgEl.onerror && imgEl.onerror(e); }
    });
}

// Fetch a byte range using Drive and return buffer + headers; logs timing and response for diagnostics
async function fetchRange(url, start, end, signal) {
    const options = { headers: { Range: `bytes=${start}-${end}` } };
    if (signal) options.signal = signal;
    const t0 = performance.now();
    const res = await driveFetch(url, options);

    // Handle 416 Range Not Satisfiable by probing for total size where possible
    const cr = res.headers.get('Content-Range');
    if (res.status === 416) {
        console.warn('fetchRange: 416 Range Not Satisfiable', { url, start, end, contentRange: cr });
        let total = null;
        if (cr) {
            const m = cr.match(/\/(\d+)\s*$/);
            if (m) total = parseInt(m[1], 10);
        }
        if (total === null) {
            try {
                // Lightweight probe to get a Content-Range with total when server supports it
                const probe = await driveFetch(url, { headers: { Range: 'bytes=0-0' } });
                const cr2 = probe.headers.get('Content-Range');
                if (cr2) {
                    const m2 = cr2.match(/\/(\d+)\s*$/);
                    if (m2) total = parseInt(m2[1], 10);
                }
            } catch (e) { console.debug('fetchRange probe failed', e); }
        }
        return { buffer: new ArrayBuffer(0), contentRange: cr, status: res.status, elapsed: (performance.now() - t0), total };
    }

    const buffer = await res.arrayBuffer();
    const t1 = performance.now();
    console.debug('fetchRange', { url, start, end, status: res.status, contentRange: cr, elapsedMs: (t1 - t0), returnedBytes: buffer.byteLength });
    return { buffer, contentRange: cr, status: res.status, elapsed: (t1 - t0) };
}

// Append ArrayBuffer to SourceBuffer and wait for updateend
function appendBufferSafe(sourceBuffer, arrayBuffer) {
    return new Promise((resolve, reject) => {
        const onUpdate = () => { sourceBuffer.removeEventListener('updateend', onUpdate); resolve(); };
        sourceBuffer.addEventListener('updateend', onUpdate);
        try {
            sourceBuffer.appendBuffer(arrayBuffer);
        } catch (err) {
            sourceBuffer.removeEventListener('updateend', onUpdate);
            reject(err);
        }
    });
}

// Find a top-level MP4 box by name in an ArrayBuffer
function findBox(arrayBuffer, name) {
    if (!arrayBuffer) return null;
    const dv = new DataView(arrayBuffer);
    let pos = 0;
    const len = arrayBuffer.byteLength;
    while (pos + 8 <= len) {
        const size = dv.getUint32(pos);
        const type = String.fromCharCode(
            dv.getUint8(pos + 4), dv.getUint8(pos + 5), dv.getUint8(pos + 6), dv.getUint8(pos + 7)
        );
        if (type === name) return { pos, size };
        if (size === 0) break; // box extends to end
        pos += size;
    }
    return null;
}

// Concatenate two ArrayBuffers into one
function concatArrayBuffers(a, b) {
    const aLen = a ? a.byteLength : 0;
    const bLen = b ? b.byteLength : 0;
    const tmp = new Uint8Array(aLen + bLen);
    if (a) tmp.set(new Uint8Array(a), 0);
    if (b) tmp.set(new Uint8Array(b), aLen);
    return tmp.buffer;
}

// Fetch the last `tailSize` bytes of a resource using Range suffix request
async function fetchTail(url, tailSize = 512 * 1024) {
    try {
        const options = { headers: { Range: `bytes=-${tailSize}` } };
        const res = await driveFetch(url, options);
        const buffer = await res.arrayBuffer();
        const cr = res.headers.get('Content-Range');
        console.debug('fetchTail', { url, tailSize, status: res.status, contentRange: cr, returnedBytes: buffer.byteLength });
        return { buffer, contentRange: cr, status: res.status };
    } catch (e) {
        console.warn('fetchTail failed', e);
        throw e;
    }
}

// Query Drive metadata for file size (returns integer bytes or null)
async function getFileSizeFromDrive(fileId) {
    try {
        if (!fileId) return null;
        const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=size`;
        const res = await driveFetch(url);
        if (!res.ok) return null;
        const js = await res.json();
        if (js && js.size) {
            console.debug('getFileSizeFromDrive', { fileId, size: js.size });
            return parseInt(js.size, 10);
        }
    } catch (e) {
        console.debug('getFileSizeFromDrive failed', e);
    }
    return null;
}
// Try to build an init segment (ftyp+moov) from initial and tail buffers.
// Prefer mp4box.js when available; otherwise fall back to simple ftyp+moov concatenation.
async function buildInitSegment(initialBuffer, tailBuffer) {
    // If moov already in initial, nothing to do
    if (findBox(initialBuffer, 'moov')) {
        console.debug('buildInitSegment: moov found in initial buffer');
        return initialBuffer;
    }

    // Try mp4box if available
    if (window.MP4Box && typeof MP4Box.createFile === 'function') {
        try {
            return await new Promise((resolve, reject) => {
                const mp4boxfile = MP4Box.createFile();
                mp4boxfile.onError = function (e) { reject(e); };
                mp4boxfile.onReady = function (info) {
                    try {
                        console.debug('mp4box onReady', info);
                        if (info && info.tracks) console.debug('mp4box tracks', info.tracks.map(t => ({ id: t.id, type: t.type, codec: t.codec })));
                        // mp4box exposes an init segment builder; try to request it
                        if (typeof mp4boxfile.initializeSegmentation === 'function') {
                            const initSeg = mp4boxfile.initializeSegmentation();
                            if (initSeg && initSeg.buffer) return resolve(initSeg.buffer);
                        }
                        if (typeof mp4boxfile.getInitSegment === 'function') {
                            const initSeg = mp4boxfile.getInitSegment();
                            if (initSeg && initSeg.buffer) return resolve(initSeg.buffer);
                        }
                        // Fallback: try to generate init by exporting ftyp+moov manually via mp4box's internal structures
                        // If above methods didn't return a proper init, reject and fallback to manual concatenation
                        reject(new Error('mp4box could not produce init segment'));
                    } catch (err) { reject(err); }
                };

                // Feed buffers to mp4box with fileStart offsets
                try {
                    const buf1 = initialBuffer.slice(0);
                    buf1.fileStart = 0;
                    mp4boxfile.appendBuffer(buf1);
                    if (tailBuffer) {
                        const buf2 = tailBuffer.slice(0);
                        buf2.fileStart = initialBuffer.byteLength;
                        mp4boxfile.appendBuffer(buf2);
                    }
                    mp4boxfile.flush();
                } catch (err) { reject(err); }
            });
        } catch (e) {
            console.warn('mp4box attempt failed, falling back to simple concat', e);
        }
    }

    // Simple fallback: find ftyp in initial, moov in tail and concat
    const ftyp = findBox(initialBuffer, 'ftyp');
    const moov = findBox(tailBuffer, 'moov');
    console.debug('buildInitSegment: ftyp found?', !!ftyp, 'moov found?', !!moov, ftyp, moov);
    if (ftyp && moov) {
        const ftypBuf = initialBuffer.slice(ftyp.pos, ftyp.pos + ftyp.size);
        const moovBuf = tailBuffer.slice(moov.pos, moov.pos + moov.size);
        return concatArrayBuffers(ftypBuf, moovBuf);
    }

    // Could not build init
    return null;
}

/* ================= ROOT FOLDERS ================= */
async function loadRootFolders() {
    folderStack = [];
    currentFolderId = ROOT_MUSIC_FOLDER_ID;
    updateBreadcrumb();

    const res = await driveFetch(
        `https://www.googleapis.com/drive/v3/files?q='${ROOT_MUSIC_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name,thumbnailLink,iconLink)`
    );
    const data = await res.json();
    allItems = data.files || []; // Fix: Populate allItems so search works in root folder

    const folderList = document.getElementById("folders");

    const songsList = document.getElementById("songs");
    folderList.innerHTML = "";
    songsList.innerHTML = "";
    // Remove any folder-level header shuffle that might exist
    const parent = songsList.parentNode;
    const existingHeader = parent.querySelector('.folder-shuffle-header');
    if (existingHeader) existingHeader.remove();

    // Clear search when going to root
    document.getElementById("search-input").value = "";


    if (data.files && data.files.length > 0) {
        document.getElementById("folders-section").style.display = "block";
        data.files.forEach((folder, i) => {
            const div = document.createElement("div");
            div.className = "item";
            div.style.animationDelay = `${i * 0.05}s`;

            const iconWrapper = document.createElement('div');
            iconWrapper.className = 'item-icon';
            const textDiv = document.createElement('div');
            textDiv.className = 'item-text';
            textDiv.textContent = folder.name;

            // Custom flat folder icon (SVG)
            const folderIconSvg = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="100%" height="100%">
              <defs>
                <linearGradient id="folderGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" style="stop-color:#FFB74D;stop-opacity:1" />
                  <stop offset="100%" style="stop-color:#FF9800;stop-opacity:1" />
                </linearGradient>
                <linearGradient id="folderBackGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" style="stop-color:#FFE082;stop-opacity:1" />
                  <stop offset="100%" style="stop-color:#FFB74D;stop-opacity:1" />
                </linearGradient>
              </defs>
              <path d="M40,12H22l-4-4H8c-2.2,0-4,1.8-4,4v24c0,2.2,1.8,4,4,4h32c2.2,0,4-1.8,4-4V16C44,13.8,42.2,12,40,12z" fill="url(#folderBackGrad)"/>
              <path d="M40,12H22l-4-4H8c-2.2,0-4,1.8-4,4v24c0,2.2,1.8,4,4,4h32c2.2,0,4-1.8,4-4V16C44,13.8,42.2,12,40,12z" fill="none" opacity="0.1"/>
              <path d="M40,15H8c-2.2-0.1-4,1.8-4,4v17c0,2.2,1.8,4,4,4h32c2.2,0,4-1.8,4-4V19C44,16.8,42.2,15,40,15z" fill="url(#folderGrad)"/>
            </svg>
          `;

            // Use custom icon for folders, ignore Drive's low-res iconLink
            iconWrapper.innerHTML = folderIconSvg;
            // Apply a slightly different style to the wrapper for these icons
            iconWrapper.style.background = 'transparent';
            iconWrapper.style.transform = 'scale(1.2)';

            div.appendChild(iconWrapper);
            div.appendChild(textDiv);

            // Add per-folder shuffle button that doesn't trigger the folder click
            const shuffleBtn = document.createElement('button');
            shuffleBtn.className = 'shuffle-btn';
            shuffleBtn.title = 'Shuffle this folder';
            shuffleBtn.innerHTML = `
            <svg viewBox="0 0 24 24">
              <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
            </svg>
          `;
            shuffleBtn.onclick = (e) => { e.stopPropagation(); shuffleFolder(folder.id, folder.name); };
            const actions = document.createElement('div');
            actions.className = 'item-actions';
            actions.appendChild(shuffleBtn);
            div.appendChild(actions);

            div.onclick = () => loadFolder(folder.id, folder.name);
            folderList.appendChild(div);
        });
    } else {
        document.getElementById("folders-section").style.display = "none";
    }
}

/* ================= LOAD ANY FOLDER ================= */
async function loadFolder(folderId, folderName = "", pushHistory = true) {
    if (folderId === currentFolderId) return;

    if (pushHistory) {
        folderStack.push({ id: currentFolderId, name: folderName });
    }
    currentFolderId = folderId;
    updateBreadcrumb();

    const res = await driveFetch(
        `https://www.googleapis.com/drive/v3/files?q='${folderId}' in parents and trashed=false&fields=files(id,name,mimeType,thumbnailLink,iconLink)`
    );
    const data = await res.json();

    // Store items for search
    allItems = data.files || [];

    // Build playlist from audio files only
    currentPlaylist = allItems.filter(item => item.mimeType.startsWith("audio/"));
    originalPlaylist = [...currentPlaylist];

    if (isShuffleOn && currentPlaylist.length > 0) {
        shuffleArray(currentPlaylist);
    }

    const songsList = document.getElementById("songs");
    songsList.innerHTML = "";
    document.getElementById("folders-section").style.display = "none";

    // Clear search when navigating
    document.getElementById("search-input").value = "";

    displayItems(allItems);

    // Add a header-level shuffle button for this folder view (if any audio files present)
    const songsContainer = document.getElementById('songs');
    const parent = songsContainer.parentNode;
    // Remove existing header if any (avoid duplicates)
    const existingHeader = parent.querySelector('.folder-shuffle-header');
    if (existingHeader) existingHeader.remove();
    if (currentPlaylist && currentPlaylist.length > 0) {
        const headerShuffle = document.createElement('div');
        headerShuffle.className = 'folder-shuffle-header';
        const headerBtn = document.createElement('button');
        headerBtn.className = 'shuffle-btn';
        headerBtn.title = 'Shuffle songs in this folder';
        headerBtn.innerHTML = `
          <svg viewBox="0 0 24 24">
            <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
          </svg>
        `;
        headerBtn.onclick = () => {
            if (!isShuffleOn) toggleShuffleMode();
            if (currentPlaylist.length > 0) {
                // Always start playing a random song when 'Shuffle Folder' is clicked from the top
                const randIndex = Math.floor(Math.random() * currentPlaylist.length);
                const track = currentPlaylist[randIndex];
                playSong(track.id, track.name);
            }
        };
        headerShuffle.appendChild(headerBtn);
        parent.insertBefore(headerShuffle, songsContainer);
    }
}

function displayItems(items) {
    const songsList = document.getElementById("songs");
    songsList.innerHTML = "";

    if (items && items.length > 0) {
        items.forEach((item, i) => {
            const div = document.createElement("div");
            div.className = "item";
            div.style.animationDelay = `${i * 0.05}s`;

            // Build icon area and text
            const iconWrapper = document.createElement('div');
            iconWrapper.className = 'item-icon';
            const textDiv = document.createElement('div');
            textDiv.className = 'item-text';
            textDiv.textContent = item.name;


            // Custom SVG definitions
            const folderIconSvg = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="100%" height="100%">
              <defs>
                <linearGradient id="folderGrad2" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" style="stop-color:#FFB74D;stop-opacity:1" />
                  <stop offset="100%" style="stop-color:#FF9800;stop-opacity:1" />
                </linearGradient>
                <linearGradient id="folderBackGrad2" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" style="stop-color:#FFE082;stop-opacity:1" />
                  <stop offset="100%" style="stop-color:#FFB74D;stop-opacity:1" />
                </linearGradient>
              </defs>
              <path d="M40,12H22l-4-4H8c-2.2,0-4,1.8-4,4v24c0,2.2,1.8,4,4,4h32c2.2,0,4-1.8,4-4V16C44,13.8,42.2,12,40,12z" fill="url(#folderBackGrad2)"/>
              <path d="M40,15H8c-2.2-0.1-4,1.8-4,4v17c0,2.2,1.8,4,4,4h32c2.2,0,4-1.8,4-4V19C44,16.8,42.2,15,40,15z" fill="url(#folderGrad2)"/>
            </svg>
          `;

            const audioIconSvg = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="100%" height="100%">
              <circle cx="24" cy="24" r="20" fill="#262626"/>
              <path d="M20,14v16.1c-0.8-0.6-1.9-1-3-1c-2.8,0-5,2.2-5,5s2.2,5,5,5s5-2.2,5-5V20h8v-6H20z" fill="#FFB300"/>
            </svg>
          `;

            // Handle icons based on type
            if (item.mimeType === 'application/vnd.google-apps.folder') {
                iconWrapper.innerHTML = folderIconSvg;
                iconWrapper.style.background = 'transparent';
                iconWrapper.style.transform = 'scale(1.2)';
            } else if (item.mimeType && item.mimeType.startsWith('audio/')) {
                iconWrapper.innerHTML = audioIconSvg;
                iconWrapper.style.background = 'transparent';
            } else {
                // For other types, try thumbnail or default
                const thumbCandidate = item.thumbnailLink || item.iconLink;
                if (thumbCandidate) {
                    const img = document.createElement('img');
                    img.alt = item.name;
                    loadThumbnailImage(img, thumbCandidate).catch(() => { });
                    iconWrapper.appendChild(img);
                } else {
                    iconWrapper.textContent = '🎵';
                }
            }

            div.appendChild(iconWrapper);
            div.appendChild(textDiv);

            // If this is a folder, add a small shuffle button and folder click handler
            if (item.mimeType === "application/vnd.google-apps.folder") {
                const shuffleBtn = document.createElement('button');
                shuffleBtn.className = 'shuffle-btn';
                shuffleBtn.title = 'Shuffle this folder';
                // Simple flat Shuffle SVG
                shuffleBtn.innerHTML = `
          <svg viewBox="0 0 24 24">
            <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
              </svg>
          `;
                shuffleBtn.onclick = (e) => { e.stopPropagation(); shuffleFolder(item.id, item.name); };
                const actions = document.createElement('div');
                actions.className = 'item-actions';
                actions.appendChild(shuffleBtn);
                div.appendChild(actions);

                div.onclick = () => loadFolder(item.id, item.name);
            } else if (item.mimeType && item.mimeType.startsWith("audio/")) {
                div.onclick = () => playSong(item.id, item.name);
            }

            songsList.appendChild(div);
        });
    } else {
        songsList.innerHTML = `
          <div class="empty-state">
          <div class="empty-state-icon">🎵</div>
          <div>No music files found</div>
        </div>
          `;
    }
}

// Toggle Shuffle Mode (On/Off)
function toggleShuffleMode() {
    const btn = document.getElementById('player-shuffle-btn');

    if (!isShuffleOn) {
        // Turn ON
        if (currentPlaylist.length === 0) return;

        isShuffleOn = true;
        showMessage('Shuffle On', false, 1500);

        // Save current order if not already saved (or if we need to sync)
        // If we just loaded, originalPlaylist should call loadFolder. 
        // But let's ensure we have a backup.
        if (originalPlaylist.length === 0) {
            originalPlaylist = [...currentPlaylist];
        }

        // Shuffle currentPlaylist
        // If a song is playing, keep it playing (move to top or just re-find index)
        const currentSong = currentPlaylist[currentTrackIndex];

        // Shuffle everything
        shuffleArray(currentPlaylist);

        // If playing, find where the current song went and update index
        if (currentSong) {
            const newIndex = currentPlaylist.findIndex(s => s.id === currentSong.id);
            if (newIndex !== -1) {
                currentTrackIndex = newIndex;
            }
        }

        // Update UI
        if (btn) {
            btn.style.background = 'linear-gradient(135deg, #FFCA28 0%, #FF6F00 100%)';
            btn.style.boxShadow = '0 0 12px rgba(255, 111, 0, 0.6)';
        }

    } else {
        // Turn OFF
        isShuffleOn = false;
        showMessage('Shuffle Off', false, 1500);

        // Restore original order
        if (originalPlaylist.length > 0) {
            // If we had a current song, we need to map per ID to find new index in original
            const currentSong = currentPlaylist[currentTrackIndex];

            currentPlaylist = [...originalPlaylist];

            if (currentSong) {
                const newIndex = currentPlaylist.findIndex(s => s.id === currentSong.id);
                if (newIndex !== -1) {
                    currentTrackIndex = newIndex;
                }
            }
        }

        // Update UI
        if (btn) {
            btn.style.background = ''; // reset to default CSS
            btn.style.boxShadow = '';
        }
    }
}

// Shuffle helper (Fisher-Yates)
function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

// Shuffle a folder by fetching its audio files, randomizing order, and starting playback
async function shuffleFolder(folderId, folderName = '') {
    try {
        showMessage(`Shuffling "${folderName || 'folder'}"...`, false, 2000);
        const res = await driveFetch(
            `https://www.googleapis.com/drive/v3/files?q='${folderId}' in parents and trashed=false&fields=files(id,name,mimeType,thumbnailLink,iconLink)`
        );
        const data = await res.json();
        const songs = (data.files || []).filter(f => f.mimeType && f.mimeType.startsWith('audio/'));
        if (songs.length === 0) {
            showMessage('No songs found in this folder', true);
            return;
        }
        shuffleArray(songs);
        currentPlaylist = songs;
        currentTrackIndex = 0;
        playSong(currentPlaylist[0].id, currentPlaylist[0].name);
    } catch (e) {
        console.error('shuffleFolder failed', e);
        showMessage('Failed to shuffle folder', true);
    }
}

// Shuffle the currently-loaded folder playlist (no network fetch required)
function shuffleCurrentFolder() {
    if (!currentPlaylist || currentPlaylist.length === 0) {
        showMessage('No songs to shuffle in this folder', true);
        return;
    }
    shuffleArray(currentPlaylist);
    currentTrackIndex = 0;
    playSong(currentPlaylist[0].id, currentPlaylist[0].name);
}

// Prefetch the beginning of a file so the next track can start immediately
async function prefetchNextTrack(fileId, fileName, mimeType) {
    if (!fileId) return;
    if (preloadedTracks[fileId] || prefetchControllers[fileId]) return; // already prefetching or prefetched
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

    // Controller used for the initial chunk; if we start a background full fetch we'll replace this with a background controller
    const initialCtrl = new AbortController();
    prefetchControllers[fileId] = initialCtrl;

    try {
        console.debug('prefetchNextTrack: starting (initial chunk)', { fileId, fileName });

        // Fetch a small initial chunk (same size used for streaming startup)
        const initialRes = await fetchRange(url, 0, PREFETCH_INITIAL_CHUNK - 1, initialCtrl.signal);

        // If server returned full file (200), create a blob URL for immediate playback
        if (initialRes.status === 200) {
            const blob = new Blob([initialRes.buffer], { type: (mimeType || 'audio/mpeg') });
            const urlObj = URL.createObjectURL(blob);
            preloadedTracks[fileId] = { fullBlobUrl: urlObj, status: 200 };
            console.debug('prefetchNextTrack: full file fetched (initial returned 200)', { fileId, size: initialRes.buffer.byteLength });

            // No background fetching needed; clear controller
            if (prefetchControllers[fileId] === initialCtrl) delete prefetchControllers[fileId];
            return;
        }

        // Store initial buffer and metadata
        preloadedTracks[fileId] = { initialBuffer: initialRes.buffer, contentRange: initialRes.contentRange, status: initialRes.status };
        console.debug('prefetchNextTrack: initial chunk fetched', { fileId, contentRange: initialRes.contentRange });

        // Start background fetch of the remaining bytes to get the full file for seamless playback
        (async () => {
            try {
                // Determine byte ranges from Content-Range header if possible
                let start = null;
                let total = null;
                if (initialRes.contentRange) {
                    const m = initialRes.contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/);
                    if (m) {
                        start = parseInt(m[2], 10) + 1;
                        total = m[3] === '*' ? null : parseInt(m[3], 10);
                    }
                }

                if (total !== null && start !== null && start <= (total - 1)) {
                    const bgCtrl = new AbortController();
                    prefetchControllers[fileId] = bgCtrl;
                    console.debug('prefetchNextTrack: background tail fetch', { fileId, start, end: total - 1 });
                    const tail = await fetchRange(url, start, total - 1, bgCtrl.signal);

                    // Combine initial buffer + tail into a single Blob and expose via object URL
                    const combined = new Blob([preloadedTracks[fileId].initialBuffer, tail.buffer], { type: (mimeType || 'audio/mpeg') });
                    const blobUrl = URL.createObjectURL(combined);

                    // Replace preloaded entry with full blob reference and free initialBuffer
                    try { delete preloadedTracks[fileId].initialBuffer; } catch (e) { }
                    preloadedTracks[fileId] = { fullBlobUrl: blobUrl, status: 200 };
                    console.debug('prefetchNextTrack: full blob assembled and ready', { fileId });
                } else {
                    // Unknown total size: fall back to fetching the full file directly
                    console.debug('prefetchNextTrack: unknown total, falling back to full fetch', { fileId });
                    const bgCtrl = new AbortController();
                    prefetchControllers[fileId] = bgCtrl;
                    const fullRes = await driveFetch(url, { signal: bgCtrl.signal });
                    if (fullRes && fullRes.ok) {
                        const blob = await fullRes.blob();
                        const blobUrl = URL.createObjectURL(blob);
                        preloadedTracks[fileId] = { fullBlobUrl: blobUrl, status: 200 };
                        console.debug('prefetchNextTrack: full fetch succeeded', { fileId });
                    }
                }
            } catch (e) {
                if (e && e.name === 'AbortError') console.debug('prefetchNextTrack background aborted', { fileId });
                else console.warn('prefetchNextTrack background failed', e);
            } finally {
                // Clear any background controller reference if it's the one we set
                if (prefetchControllers[fileId] && typeof prefetchControllers[fileId].signal === 'undefined') {
                    // We set a controller object (legacy); clear it
                    delete prefetchControllers[fileId];
                } else if (prefetchControllers[fileId] && typeof prefetchControllers[fileId].abort === 'function') {
                    // Clear if it's still a controller
                    delete prefetchControllers[fileId];
                }
            }
        })();

    } catch (e) {
        if (e && e.name === 'AbortError') console.debug('prefetchNextTrack aborted (initial)', { fileId });
        else console.warn('prefetchNextTrack failed', e);
        if (prefetchControllers[fileId] === initialCtrl) delete prefetchControllers[fileId];
    }
}

// Clear any preloaded entry and revoke objectURL if present
function clearPreloaded(fileId) {
    const p = preloadedTracks[fileId];
    if (!p) return;
    if (p.fullBlobUrl) {
        try { URL.revokeObjectURL(p.fullBlobUrl); } catch (e) { }
    }
    delete preloadedTracks[fileId];
}

/* ================= PLAY MUSIC ================= */
async function playSong(fileId, fileName) {
    try {
        // 1. Immediate UI Feedback
        document.getElementById("track-title").textContent = "Loading " + fileName + "...";
        document.querySelector(".play-btn").textContent = "⏸";

        // Find track index
        currentTrackIndex = currentPlaylist.findIndex(song => song.id === fileId);

        // 2. Cleanup previous streams
        if (currentStreamController) {
            try { currentStreamController.abort(); } catch (e) { }
            currentStreamController = null;
        }
        if (currentMediaSource) {
            try { currentMediaSource.endOfStream(); } catch (e) { }
            currentMediaSource = null;
        }
        if (currentAudioUrl) {
            try { URL.revokeObjectURL(currentAudioUrl); } catch (e) { }
            currentAudioUrl = null;
        }

        const player = document.getElementById("player");

        // 3. Check for Preloaded Blob (Fastest)
        const pre = preloadedTracks[fileId];
        if (pre && pre.fullBlobUrl) {
            console.debug('Using preloaded full blob', fileId);
            currentAudioUrl = pre.fullBlobUrl;
            player.src = currentAudioUrl;
            try { delete preloadedTracks[fileId]; } catch (e) { }
        } else {
            // 4. Force Full Download (User Request)
            // Always download the full file blob before playing
            await startFullDownload();
            return;
        }

        // 5. Common Setup if preloaded worked (otherwise startFullDownload handles it)
        finalizePlaybackSetup();

    } catch (err) {
        console.error("Error loading song:", err);
        document.getElementById("track-title").textContent = "Failed to load: " + fileName;
        document.querySelector(".play-btn").textContent = "▶";
    }

    function finalizePlaybackSetup() {
        document.getElementById("track-title").textContent = fileName;
        setDefaultAlbumArt();
        player.ontimeupdate = updateProgress;
        player.onended = () => {
            document.querySelector(".play-btn").textContent = "▶";
            playNext();
        };
        player.onerror = (e) => {
            console.error("Playback error", player.error);
            document.getElementById("track-title").textContent = "Error playing: " + fileName;
        };
        const playPromise = player.play();
        if (playPromise !== undefined) {
            playPromise.catch(error => {
                console.warn("Play auto-start prevented or failed:", error);
                document.querySelector(".play-btn").textContent = "▶";
            });
        }
    }

    // Helper to download full blob and play
    async function startFullDownload() {
        try {
            console.debug('Starting full download for', fileName);
            const token = await getAccessToken();
            const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
            const res = await driveFetch(url);
            if (!res.ok) throw new Error(res.status);
            const blob = await res.blob();

            if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
            currentAudioUrl = URL.createObjectURL(blob);
            player.src = currentAudioUrl;

            // Finalize setup now that we have the src
            finalizePlaybackSetup();

        } catch (e) {
            console.error('Full download failed', e);
            document.getElementById("track-title").textContent = "Error: " + e.message;
            document.querySelector(".play-btn").textContent = "▶";
        }
    }
}

/* ================= PLAYER CONTROLS ================= */
function togglePlay() {
    const player = document.getElementById("player");
    const btn = document.querySelector(".play-btn");

    if (player.paused) {
        player.play();
        btn.textContent = "⏸";
    } else {
        player.pause();
        btn.textContent = "▶";
    }
}

function playNext() {
    if (currentPlaylist.length === 0) return;

    // Move to next track, loop back to start if at end
    currentTrackIndex = (currentTrackIndex + 1) % currentPlaylist.length;
    const nextSong = currentPlaylist[currentTrackIndex];
    playSong(nextSong.id, nextSong.name);
}

function playPrevious() {
    if (currentPlaylist.length === 0) return;

    // Move to previous track, loop to end if at start
    currentTrackIndex = (currentTrackIndex - 1 + currentPlaylist.length) % currentPlaylist.length;
    const prevSong = currentPlaylist[currentTrackIndex];
    playSong(prevSong.id, prevSong.name);
}

function updateProgress() {
    const player = document.getElementById("player");
    const fill = document.getElementById("progress-fill");
    const currentTime = document.getElementById("current-time");
    const totalTime = document.getElementById("total-time");

    if (!player.duration) return;

    const percent = (player.currentTime / player.duration) * 100;
    fill.style.width = percent + "%";

    currentTime.textContent = formatTime(player.currentTime);
    totalTime.textContent = formatTime(player.duration);

    // Trigger prefetch for the next track when within threshold
    try {
        const remaining = player.duration - player.currentTime;
        if (remaining <= PREFETCH_THRESHOLD && currentPlaylist && currentPlaylist.length > 0) {
            const nextIndex = (currentTrackIndex + 1) % currentPlaylist.length;
            const nextSong = currentPlaylist[nextIndex];
            if (nextSong && !preloadedTracks[nextSong.id] && !prefetchControllers[nextSong.id]) {
                console.debug('updateProgress: prefetching next song', { nextId: nextSong.id, remaining });
                prefetchNextTrack(nextSong.id, nextSong.name, nextSong.mimeType);
            }
        }
    } catch (e) { console.debug('updateProgress prefetch check failed', e); }
}

function seekByClick(e) {
    const player = document.getElementById("player");
    if (!player.duration) return;

    const bar = e.currentTarget;
    const rect = bar.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    player.currentTime = percent * player.duration;
}

function setVolume(e) {
    const player = document.getElementById("player");
    const slider = e.currentTarget;
    const fill = document.getElementById("volume-fill");
    const rect = slider.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;

    player.volume = Math.max(0, Math.min(1, percent));
    fill.style.width = (percent * 100) + "%";
}

function formatTime(seconds) {
    if (isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/* ================= SEARCH ================= */
function handleSearch(query) {
    // Debounce search
    clearTimeout(searchTimeout);

    searchTimeout = setTimeout(() => {
        const searchTerm = query.toLowerCase().trim();

        if (searchTerm === "") {
            // Show all items if search is empty
            displayItems(allItems);
            return;
        }

        // Filter items by name
        const filteredItems = allItems.filter(item =>
            item.name.toLowerCase().includes(searchTerm)
        );

        displayItems(filteredItems);
    }, 300); // Wait 300ms after user stops typing
}

/* ================= NAVIGATION ================= */
function goBack() {
    if (folderStack.length === 0) return;

    const prev = folderStack.pop();

    // If returning to root, load root folders; otherwise load previous folder without pushing history
    if (prev.id === ROOT_MUSIC_FOLDER_ID) {
        loadRootFolders();
    } else {
        loadFolder(prev.id, prev.name, false);
    }

    updateBreadcrumb();
}

function updateBreadcrumb() {
    const crumb = document.getElementById("breadcrumb");
    if (folderStack.length === 0) {
        crumb.textContent = "Music Library";
        return;
    }
    crumb.textContent = ["Music Library", ...folderStack.map(f => f.name)].join(" › ");
}

// Expose handlers to the global scope
window.login = login;
window.goBack = goBack;
window.playSong = playSong;
window.shuffleFolder = shuffleFolder;
window.shuffleCurrentFolder = shuffleCurrentFolder;

// Attach event listeners to elements now that functions are defined
const _loginBtn = document.getElementById('login-btn');
if (_loginBtn) _loginBtn.addEventListener('click', () => login());

// Initialize volume
document.getElementById("player").volume = 1;

// Robust loader for mp4box with multiple CDN fallbacks and user notification
(function () {
    const urls = [
        'https://cdn.jsdelivr.net/npm/mp4box/dist/mp4box.all.min.js',
        'https://unpkg.com/mp4box/dist/mp4box.all.min.js',
        'https://cdn.jsdelivr.net/npm/mp4box@0.4.2/dist/mp4box.all.min.js'
    ];
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.onload = () => resolve(src);
            s.onerror = () => { s.remove(); reject(new Error('Failed to load ' + src)); };
            document.head.appendChild(s);
        });
    }
    (async function tryLoad() {
        for (const u of urls) {
            try {
                await loadScript(u);
                console.debug('mp4box loaded from', u);
                try { showMessage('mp4box successfully loaded', false, 2500); } catch (e) { console.debug('mp4box loaded (no UI)'); }
                document.dispatchEvent(new Event('mp4box-loaded'));
                return;
            } catch (err) {
                console.debug('mp4box load failed for', u, err);
            }
        }
        console.warn('mp4box failed to load from all CDNs — falling back to simple concat method');
        try { showMessage('Warning: mp4box failed to load; some files may not stream correctly.', true, 8000); } catch (e) { }
    })();
})();
