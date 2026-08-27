const { apiGet, apiPost } = SongloftPlugin;
const DEFAULT_SERVER = 'http://192.168.1.1:13378';
const PAGE_SIZE = 30;
const COVER_PLACEHOLDER = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 220"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#30275d"/><stop offset="1" stop-color="#7560df"/></linearGradient></defs><rect width="160" height="220" rx="18" fill="url(#g)"/><path d="M48 58h64v104H62a14 14 0 0 0-14 14V58Z" fill="none" stroke="#fff" stroke-width="5"/><path d="M68 84h27M68 104h27" stroke="#fff" stroke-width="4" stroke-linecap="round"/></svg>');
const $ = (id) => document.getElementById(id);
let toastTimer = null;
let booksState = [];
let libraryPage = 0;
let libraryTotal = 0;
let libraryLoaded = false;
let retryAction = null;
let confirmResolver = null;
let pendingImport = null;
let playbackState = { book: null, tracks: [], chapters: [], progress: null, index: 0, chapterIndex: -1, candidates: [], candidateIndex: 0, startPosition: 0 };
let speakerDevices = [];

function getAuthToken() {
  try { return String(window.SongloftPlugin?.getAuthToken?.() || ''); } catch (_) { return ''; }
}

function songloftAudioProxyUrl(url) {
  const proxy = new URL('/api/v1/proxy', window.location.origin);
  proxy.searchParams.set('url', String(url || ''));
  const token = getAuthToken();
  if (token) proxy.searchParams.set('access_token', token);
  return proxy.pathname + proxy.search;
}

function playbackCandidates(url) {
  const direct = String(url || '').trim();
  if (!direct) return [];
  const proxy = songloftAudioProxyUrl(direct);
  let preferProxy = false;
  try { preferProxy = new URL(direct, window.location.origin).protocol === 'http:' && window.location.protocol === 'https:'; } catch (_) {}
  return (preferProxy ? [proxy, direct] : [direct, proxy]).filter((item, index, items) => item && items.indexOf(item) === index);
}

function showWorkspace(view, persist = true) {
  const selected = ['library', 'player', 'settings', 'diagnostics'].includes(view) ? view : 'library';
  document.querySelectorAll('[data-workspace]').forEach(page => page.classList.toggle('active', page.dataset.workspace === selected));
  document.querySelectorAll('[data-view]').forEach(button => {
    const active = button.dataset.view === selected;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  if (persist) localStorage.setItem('audiobookshelf:workspace', selected);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setBusy(button, busy, busyText = '处理中…') {
  if (busy) {
    button.dataset.label = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.classList.add('is-busy');
    button.textContent = busyText;
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.classList.remove('is-busy');
    if (button.dataset.label) button.textContent = button.dataset.label;
  }
}

function showActionNotice(title, message, retry = null) {
  retryAction = retry;
  $('actionNoticeTitle').textContent = title;
  $('actionNoticeMessage').textContent = message;
  $('actionRetry').classList.toggle('hidden', !retry);
  $('actionNotice').className = 'action-notice error';
}

function dismissActionNotice() {
  retryAction = null;
  $('actionNotice').className = 'action-notice hidden';
}

function confirmAction(title, message, confirmLabel = '确认') {
  $('confirmTitle').textContent = title;
  $('confirmMessage').textContent = message;
  $('confirmAccept').textContent = confirmLabel;
  $('confirmDialog').classList.remove('hidden');
  $('confirmAccept').focus();
  return new Promise(resolve => { confirmResolver = resolve; });
}

function closeConfirm(accepted) {
  $('confirmDialog').classList.add('hidden');
  if (confirmResolver) confirmResolver(accepted);
  confirmResolver = null;
}

function updateSetupProgress(stage) {
  const order = ['Connection', 'Library', 'Browse'];
  order.forEach((name, index) => {
    const step = $(`step${name}`);
    step.classList.toggle('done', index < stage);
    step.classList.toggle('active', index === stage);
    step.querySelector('span').textContent = index < stage ? '✓' : String(index + 1);
  });
}

function applyTheme(theme) {
  const selected = ['system', 'light', 'dark'].includes(theme) ? theme : 'system';
  document.documentElement.dataset.themeMode = selected;
  if (selected === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = selected;
  localStorage.setItem('audiobookshelf:theme', selected);
  document.querySelectorAll('[data-theme-choice]').forEach(button => button.classList.toggle('active', button.dataset.themeChoice === selected));
}

function setRuntime(tone, title, subtitle) {
  $('runtimeStatus').dataset.tone = tone;
  $('runtimeTitle').textContent = title;
  $('runtimeSubtitle').textContent = subtitle;
  const diagnostic = $('diagnosticConnection');
  if (diagnostic) {
    diagnostic.textContent = tone === 'success' ? '连接正常' : tone === 'danger' ? '连接异常' : tone === 'running' ? '正在检测' : '等待检测';
    diagnostic.dataset.tone = tone;
  }
}

function toast(text, ok = true) {
  const element = $('toast');
  element.textContent = text;
  element.className = `toast show${ok ? '' : ' error'}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = 'toast'; }, 4200);
}

const status = (text, ok = true) => {
  toast(text, ok);
};

const connectionStatus = (text, ok = true) => {
  $('connectionStatus').textContent = text;
  $('connectionStatus').className = `operation-status ${ok ? 'ok' : 'error'}`;
  toast(text, ok);
};

async function init() {
  try {
    applyTheme(document.documentElement.dataset.themeMode || 'system');
    $('bookSearch').value = localStorage.getItem('audiobookshelf:book-search') || '';
    $('syncFilter').value = localStorage.getItem('audiobookshelf:sync-filter') || 'all';
    $('bookSort').value = localStorage.getItem('audiobookshelf:book-sort') || 'title';
    const config = await apiGet('/api/config');
    $('server').value = config.serverUrl || DEFAULT_SERVER;
    $('playbackPreference').value = config.playbackPreference || 'resume';
    $('importTitleFormat').value = config.importTitleFormat || 'book-index-source';
    $('pauseLocalOnPush').checked = config.pauseLocalOnPush !== false;
    if (config.hasApiKey) $('key').placeholder = '已保存，如不更换可留空';
    if (config.serverUrl && config.hasApiKey) {
      setRuntime('running', '正在检测连接', config.serverUrl);
      await test(false, config.libraryId);
      if (config.libraryId) {
        const savedWorkspace = localStorage.getItem('audiobookshelf:workspace');
        showWorkspace(['library', 'player', 'settings', 'diagnostics'].includes(savedWorkspace) ? savedWorkspace : 'library', false);
        await loadBooks(true);
        if (savedWorkspace === 'diagnostics') await refreshLogs();
      } else showWorkspace('settings');
    } else {
      showWorkspace('settings');
    }
  } catch (e) {
    showWorkspace('settings');
    setRuntime('danger', '连接不可用', e.message);
    connectionStatus(e.message, false);
  }
}

async function save() {
  try {
    setBusy($('save'), true, '正在连接…');
    connectionStatus('正在保存并连接…');
    setRuntime('running', '正在连接', $('server').value || DEFAULT_SERVER);
    await apiPost('/api/config', {
      serverUrl: $('server').value || DEFAULT_SERVER,
      apiKey: $('key').value,
      libraryId: $('library').value,
      playbackPreference: $('playbackPreference').value,
      importTitleFormat: $('importTitleFormat').value,
      pauseLocalOnPush: $('pauseLocalOnPush').checked
    });
    $('key').value = '';
    await test(true, $('library').value);
    dismissActionNotice();
  } catch (e) {
    setRuntime('danger', '连接失败', e.message);
    connectionStatus(e.message, false);
    showActionNotice('连接失败', e.message, save);
  } finally { setBusy($('save'), false); }
}

async function test(showMessage = true, selected = '') {
  const data = await apiPost('/api/test', {});
  const select = $('library');
  select.innerHTML = '<option value="">请选择书库</option>' +
    data.libraries.map(x => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('');
  if (selected) select.value = selected;
  updateSetupProgress(selected ? 2 : 1);
  setRuntime('success', 'Audiobookshelf 已连接', data.username ? `用户：${data.username}` : `${data.libraries.length} 个书库`);
  if (showMessage) {
    connectionStatus(`连接成功${data.username ? `，用户：${data.username}` : ''}，找到 ${data.libraries.length} 个有声书书库`);
  }
}

async function loadBooks(quiet = false) {
  try {
    const libraryId = $('library').value;
    if (!libraryId) throw new Error('请先选择书库');
    await apiPost('/api/config', { serverUrl: $('server').value, apiKey: '', libraryId, playbackPreference: $('playbackPreference').value, importTitleFormat: $('importTitleFormat').value, pauseLocalOnPush: $('pauseLocalOnPush').checked });
    setBusy($('load'), true, '正在加载…');
    if (!quiet) status('正在读取书库…');
    $('books').innerHTML = '<div class="empty-state"><strong>正在加载书库…</strong><p>正在读取书籍、封面和收听进度。</p></div>';
    libraryPage = 0;
    libraryLoaded = false;
    booksState = [];
    await fetchBooksPage(libraryId, true);
    libraryLoaded = true;
    renderLibrary();
    updateSetupProgress(2);
    dismissActionNotice();
    if (!quiet) status(`已加载 ${booksState.length} / ${libraryTotal} 本`);
  } catch (e) {
    status(e.message, false);
    showActionNotice('书库加载失败', e.message, () => loadBooks(false));
  }
  finally { setBusy($('load'), false); }
}

async function fetchBooksPage(libraryId, reset = false) {
  const data = await apiGet(`/api/items?libraryId=${encodeURIComponent(libraryId)}&limit=${PAGE_SIZE}&page=${libraryPage}`);
  libraryTotal = Number(data.total || data.items.length);
  booksState = reset ? data.items : [...booksState, ...data.items.filter(item => !booksState.some(existing => existing.id === item.id))];
  renderLibrary();
}

async function loadMoreBooks() {
  try {
    setBusy($('loadMore'), true, '正在加载…');
    libraryPage += 1;
    await fetchBooksPage($('library').value);
    dismissActionNotice();
  } catch (e) {
    libraryPage = Math.max(0, libraryPage - 1);
    status(e.message, false);
    showActionNotice('无法加载更多书籍', e.message, loadMoreBooks);
  } finally { setBusy($('loadMore'), false); }
}

function getProgressPercent(book) {
  const duration = Number(book.duration || 0);
  if (book.progress?.isFinished) return 100;
  const current = Number(book.progress?.currentTime || (book.progress?.progress || 0) * duration);
  return duration > 0 ? Math.min(100, Math.round(current / duration * 100)) : Math.round((book.progress?.progress || 0) * 100);
}

function renderLibrary() {
  const query = $('bookSearch').value.trim().toLocaleLowerCase();
  const syncFilter = $('syncFilter').value;
  const sort = $('bookSort').value;
  let books = booksState.filter(book => {
    const matchesQuery = !query || `${book.title} ${book.author || ''}`.toLocaleLowerCase().includes(query);
    const matchesSync = syncFilter === 'all' || (syncFilter === 'synced' ? Boolean(book.sync) : !book.sync);
    return matchesQuery && matchesSync;
  });
  books = [...books].sort((a, b) => {
    if (sort === 'progress') return getProgressPercent(b) - getProgressPercent(a);
    if (sort === 'recent') return Number(Boolean(a.progress?.isFinished)) - Number(Boolean(b.progress?.isFinished)) || getProgressPercent(b) - getProgressPercent(a);
    return String(a.title).localeCompare(String(b.title), 'zh-CN');
  });
  const synced = booksState.filter(book => book.sync).length;
  const active = booksState.filter(book => getProgressPercent(book) > 0 && getProgressPercent(book) < 100).length;
  $('libraryStats').innerHTML = `<span><small>书库总数</small><span class="metric-value"><strong>${libraryTotal}</strong><b>本</b></span></span><span><small>已加载在听</small><span class="metric-value"><strong>${active}</strong><b>本</b></span></span><span><small>已加载同步</small><span class="metric-value"><strong>${synced}</strong><b>本</b></span></span>`;
  $('libraryStats').classList.toggle('hidden', !libraryLoaded);
  $('libraryToolbar').classList.toggle('hidden', !booksState.length);
  const hasMore = booksState.length < libraryTotal;
  $('loadMore').classList.toggle('hidden', !hasMore);
  $('loadProgress').classList.toggle('hidden', !libraryLoaded);
  $('loadProgress').textContent = `已加载 ${booksState.length} / ${libraryTotal} 本`;
  $('books').innerHTML = books.length ? books.map(book => {
    const percent = getProgressPercent(book);
    const progress = progressText(book.progress, book.duration);
    const sync = book.sync ? `已同步 ${book.sync.songCount} 个音频` : '尚未同步';
    return `<article class="book-card">
      <img class="book-cover" src="${book.coverUrl}" alt="${escapeHtml(book.title)}封面" loading="lazy">
      <div class="book-body"><h3 class="book-title">${escapeHtml(book.title)}</h3><p class="book-author">${escapeHtml(book.author || '未知作者')}</p>
      <p class="book-meta">${formatTime(book.duration)} · ${escapeHtml(progress)}</p>
      <div class="progress-track" title="收听进度 ${percent}%"><span style="width:${percent}%"></span></div>
      <div class="book-actions"><span class="sync-badge ${book.sync ? '' : 'muted'}">${escapeHtml(sync)}</span></div>
      <div class="book-action-buttons"><button class="secondary play-button" data-play="${escapeHtml(book.id)}">播放</button><button class="${book.sync ? 'secondary' : 'primary'}" data-import="${escapeHtml(book.id)}">${book.sync ? '检查更新' : '导入'}</button></div></div>
    </article>`;
  }).join('') : libraryLoaded && libraryTotal === 0
    ? '<div class="empty-state"><strong>这个书库暂时没有有声书</strong><p>在 Audiobookshelf 中添加内容后重新加载。</p></div>'
    : '<div class="empty-state compact"><strong>没有符合条件的书籍</strong><p>尝试清除搜索词或更改同步状态。</p></div>';
}

async function saveImportOptions() {
  await apiPost('/api/config', {
    serverUrl: $('server').value || DEFAULT_SERVER,
    apiKey: '',
    libraryId: $('library').value,
    playbackPreference: $('playbackPreference').value,
    importTitleFormat: $('importTitleFormat').value,
    pauseLocalOnPush: $('pauseLocalOnPush').checked
  });
}

function openImportDialog(id, button) {
  const book = booksState.find(item => String(item.id) === String(id));
  if (book?.sync) return importBook(id, button, Boolean(book.sync.hasPlaylist));
  pendingImport = { id, button };
  $('importDialogTitle').textContent = `导入《${book?.title || '有声书'}》`;
  $('importDialogMessage').textContent = '音频会写入 Songloft 歌曲库；是否生成同名歌单由你决定。';
  $('importCreatePlaylist').checked = true;
  $('importDialog').classList.remove('hidden');
  $('importAccept').focus();
}

function closeImportDialog(accepted) {
  $('importDialog').classList.add('hidden');
  const current = pendingImport;
  pendingImport = null;
  if (accepted && current) importBook(current.id, current.button, $('importCreatePlaylist').checked);
}

async function importBook(id, button, createPlaylist = true) {
  try {
    setBusy(button, true, '正在同步…');
    await saveImportOptions();
    const result = await apiPost(`/api/import/${encodeURIComponent(id)}`, { createPlaylist });
    const book = booksState.find(item => String(item.id) === String(id));
    if (book) book.sync = { ...(book.sync || {}), songCount: Number(result.total || book.sync?.songCount || 0), hasPlaylist: Boolean(result.playlistId) };
    $('syncSummary').className = 'sync-summary success';
    $('syncSummary').innerHTML = `<strong>${escapeHtml(book?.title || '有声书')}同步完成</strong><span>共 ${Number(result.total || 0)} 个音频，新增 ${Number(result.added || 0)} 个，改名 ${Number(result.renamed || 0)} 个</span>`;
    renderLibrary();
    dismissActionNotice();
    status(result.unchanged
      ? '没有发现变化，未重复添加歌曲'
      : `同步成功，共 ${result.total} 个音频，本次新增 ${result.added} 个，改名 ${result.renamed || 0} 个${result.playlistId ? '，已关联歌单' : '，未生成歌单'}`);
  } catch (e) {
    status(e.message, false);
    showActionNotice('单本同步失败', e.message, () => importBook(id, button));
  } finally {
    if (button.isConnected) setBusy(button, false);
  }
}

function updatePlayer() {
  const track = playbackState.tracks[playbackState.index];
  const book = playbackState.book;
  $('playerTitle').textContent = book?.title || '未在播放';
  $('playerMeta').textContent = track ? `${book?.author || '未知作者'} · ${track.title} · ${playbackState.index + 1}/${playbackState.tracks.length}` : '从书库选择一本有声书开始播放';
  $('playerCover').src = book?.coverUrl || COVER_PLACEHOLDER;
  $('playerPrevious').disabled = playbackState.index <= 0;
  $('playerNext').disabled = playbackState.index >= playbackState.tracks.length - 1;
  renderPlayerPage();
}

function compactTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const secs = value % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function renderPlayerPage() {
  const hasBook = Boolean(playbackState.book);
  $('playerEmpty').classList.toggle('hidden', hasBook);
  $('playerDetail').classList.toggle('hidden', !hasBook);
  if (!hasBook) return;
  const book = playbackState.book;
  $('detailCover').src = book.coverUrl || COVER_PLACEHOLDER;
  $('detailTitle').textContent = book.title || '未命名有声书';
  $('detailAuthor').textContent = book.author || '未知作者';
  const duration = playbackState.tracks.reduce((sum, track) => sum + Number(track.duration || 0), 0);
  const current = Number(playbackState.progress?.currentTime || 0);
  const percent = playbackState.progress?.isFinished ? 100 : duration > 0 ? Math.min(100, Math.round(current / duration * 100)) : 0;
  $('detailProgressBar').style.width = `${percent}%`;
  $('detailProgressText').textContent = current > 0 ? `Audiobookshelf 进度 ${compactTime(current)} / ${compactTime(duration)} · ${percent}%` : `总时长 ${compactTime(duration)}`;
  const entries = playbackState.chapters.length
    ? playbackState.chapters.map(chapter => ({ ...chapter, kind: 'chapter' }))
    : playbackState.tracks.map(track => ({ ...track, fileIndex: track.index, offset: 0, kind: 'track' }));
  $('directoryHeading').textContent = playbackState.chapters.length ? '章节目录' : '音频目录';
  $('directorySummary').textContent = `共 ${entries.length} ${playbackState.chapters.length ? '章' : '个音频'}，点击任意一项开始播放`;
  $('directoryList').innerHTML = entries.map((entry, index) => {
    const active = entry.kind === 'chapter' ? playbackState.chapterIndex === index : playbackState.chapterIndex < 0 && playbackState.index === entry.fileIndex;
    return `<button class="directory-item${active ? ' active' : ''}" type="button" data-directory-index="${index}" data-directory-kind="${entry.kind}"><span class="directory-number">${String(index + 1).padStart(2, '0')}</span><span class="directory-copy"><strong>${escapeHtml(entry.title)}</strong><small>${entry.kind === 'chapter' ? `章节时长 ${compactTime(entry.duration)}` : `音频时长 ${compactTime(entry.duration)}`}</small></span><span class="directory-play">${active ? '正在播放' : '播放'}</span></button>`;
  }).join('');
}

async function playDirectoryEntry(index, kind) {
  const entry = kind === 'chapter' ? playbackState.chapters[index] : playbackState.tracks[index];
  if (!entry) return;
  playbackState.chapterIndex = kind === 'chapter' ? index : -1;
  playbackState.startPosition = Number(entry.offset || 0);
  await loadPlaybackTrack(Number(entry.fileIndex ?? entry.index), true);
}

async function loadPlaybackTrack(index, autoplay = true) {
  const track = playbackState.tracks[index];
  if (!track) return;
  const audio = $('previewAudio');
  playbackState.index = index;
  playbackState.candidates = playbackCandidates(track.url);
  playbackState.candidateIndex = 0;
  audio.pause();
  audio.src = playbackState.candidates[0] || track.url;
  audio.load();
  const seekTo = Number(playbackState.startPosition || 0);
  playbackState.startPosition = 0;
  if (seekTo > 0) audio.addEventListener('loadedmetadata', () => { audio.currentTime = Math.min(seekTo, Math.max(0, audio.duration || seekTo)); }, { once: true });
  updatePlayer();
  if (autoplay) await audio.play();
}

async function playBook(id, button) {
  try {
    setBusy(button, true, '正在准备…');
    await saveImportOptions();
    const data = await apiGet(`/api/items/${encodeURIComponent(id)}/playback`);
    playbackState = { book: data.item, tracks: data.tracks || [], chapters: data.chapters || [], progress: data.progress || null, index: Number(data.startIndex || 0), chapterIndex: Number(data.startChapterIndex ?? -1), candidates: [], candidateIndex: 0, startPosition: Number(data.startPosition || 0) };
    if (!playbackState.tracks.length) throw new Error('这本书没有可播放的音频');
    $('playerDock').classList.remove('hidden');
    showWorkspace('player');
    if (!speakerDevices.length) loadSpeakers(true).catch(() => {});
    await loadPlaybackTrack(playbackState.index, true);
  } catch (e) {
    status(`播放失败：${e.message}`, false);
  } finally { if (button.isConnected) setBusy(button, false); }
}

function closePlayer() {
  const audio = $('previewAudio');
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  $('playerDock').classList.add('hidden');
  playbackState = { book: null, tracks: [], chapters: [], progress: null, index: 0, chapterIndex: -1, candidates: [], candidateIndex: 0, startPosition: 0 };
  renderPlayerPage();
}

function selectedSpeaker() {
  const index = Number($('speakerDevice').value);
  return Number.isInteger(index) && index >= 0 ? speakerDevices[index] : null;
}

async function loadSpeakers(quiet = false) {
  try {
    setBusy($('refreshSpeakers'), true, '正在刷新…');
    const result = await apiGet('/api/miot/devices');
    speakerDevices = [];
    (result.accounts || []).forEach(account => {
      (account.devices || []).forEach(device => {
        const deviceId = String(device.device_id || device.deviceID || device.did || device.id || '');
        if (!deviceId) return;
        speakerDevices.push({
          accountId: String(account.account_id || account.id || ''),
          accountName: String(account.account_name || account.name || ''),
          deviceId,
          name: String(device.name || device.device_name || device.alias || deviceId)
        });
      });
    });
    const saved = localStorage.getItem('audiobookshelf:speaker-device') || '';
    $('speakerDevice').innerHTML = speakerDevices.length
      ? speakerDevices.map((device, index) => `<option value="${index}">${escapeHtml(device.name)}${device.accountName ? ` · ${escapeHtml(device.accountName)}` : ''}</option>`).join('')
      : '<option value="">没有可用设备</option>';
    const savedIndex = speakerDevices.findIndex(device => `${device.accountId}:${device.deviceId}` === saved);
    if (savedIndex >= 0) $('speakerDevice').value = String(savedIndex);
    $('speakerStatus').textContent = speakerDevices.length ? `已发现 ${speakerDevices.length} 台设备` : 'MIoT 中没有可用设备';
    if (!quiet) status(speakerDevices.length ? `已发现 ${speakerDevices.length} 台智能音箱` : '没有找到可用智能音箱', speakerDevices.length > 0);
  } catch (e) {
    $('speakerStatus').textContent = e.message;
    if (!quiet) status(e.message, false);
    throw e;
  } finally { setBusy($('refreshSpeakers'), false); }
}

async function pushCurrentToSpeaker() {
  const device = selectedSpeaker();
  const track = playbackState.tracks[playbackState.index];
  if (!device) return status('请先选择智能音箱', false);
  if (!playbackState.book || !track) return status('请先选择要播放的有声书目录', false);
  try {
    setBusy($('pushToSpeaker'), true, '正在推送…');
    const result = await apiPost('/api/miot/play', {
      accountId: device.accountId,
      deviceId: device.deviceId,
      itemId: playbackState.book.id,
      fileIndex: playbackState.index,
      startPosition: Number($('previewAudio').currentTime || 0)
    });
    localStorage.setItem('audiobookshelf:speaker-device', `${device.accountId}:${device.deviceId}`);
    if ($('pauseLocalOnPush').checked) $('previewAudio').pause();
    $('speakerStatus').textContent = `${device.name} · 已开始播放`;
    status(result.warning || `已推送到 ${device.name}`, true);
  } catch (e) {
    $('speakerStatus').textContent = `推送失败：${e.message}`;
    status(e.message, false);
  } finally { setBusy($('pushToSpeaker'), false); }
}

async function controlSpeaker(action, button) {
  const device = selectedSpeaker();
  if (!device) return status('请先选择智能音箱', false);
  try {
    setBusy(button, true, '处理中…');
    await apiPost('/api/miot/control', { accountId: device.accountId, deviceId: device.deviceId, action });
    const labels = { pause: '已暂停', resume: '正在播放', stop: '已停止' };
    $('speakerStatus').textContent = `${device.name} · ${labels[action] || '操作完成'}`;
  } catch (e) { status(e.message, false); }
  finally { setBusy(button, false); }
}

async function refreshSpeakerStatus(quiet = false) {
  const device = selectedSpeaker();
  if (!device) return quiet ? undefined : status('请先选择智能音箱', false);
  try {
    setBusy($('refreshSpeakerStatus'), true, '刷新中…');
    const result = await apiGet(`/api/miot/status?accountId=${encodeURIComponent(device.accountId)}&deviceId=${encodeURIComponent(device.deviceId)}`);
    const stateLabels = { playing: '正在播放', paused: '已暂停', stopped: '已停止', idle: '空闲', unknown: '状态未知' };
    const state = stateLabels[result.data?.state] || result.data?.state || '状态未知';
    const volume = result.data?.volume == null ? '' : ` · 音量 ${result.data.volume}`;
    $('speakerStatus').textContent = `${device.name} · ${state}${volume}`;
  } catch (e) {
    $('speakerStatus').textContent = `状态获取失败：${e.message}`;
    if (!quiet) status(e.message, false);
  } finally { setBusy($('refreshSpeakerStatus'), false); }
}

async function syncAll() {
  const libraryId = $('library').value;
  if (!libraryId) {
    status('请先选择书库', false);
    showActionNotice('无法开始同步', '请先在“连接与设置”中选择有声书书库。', () => showWorkspace('settings'));
    return;
  }
  const confirmed = await confirmAction('增量同步全部书籍', `将检查当前书库中的 ${libraryTotal || '全部'} 本有声书，并新增或更新对应歌曲。同步期间请保持页面开启。`, '开始同步');
  if (!confirmed) return;
  try {
    setBusy($('syncAll'), true, '正在同步全部…');
    await saveImportOptions();
    status('正在增量同步整个书库，请勿关闭页面…');
    const result = await apiPost('/api/sync-all', { libraryId });
    $('syncSummary').className = `sync-summary ${result.failed ? 'warning' : 'success'}`;
    $('syncSummary').innerHTML = `<strong>全库同步完成</strong><span>成功 ${result.success} 本 · 失败 ${result.failed} 本 · 新增 ${result.added} 个音频 · 改名 ${result.renamed || 0} 个</span>`;
    dismissActionNotice();
    status(`同步完成：成功 ${result.success} 本，失败 ${result.failed} 本，新增 ${result.added} 个音频，改名 ${result.renamed || 0} 个`);
    await loadBooks(true);
  } catch (e) {
    status(e.message, false);
    showActionNotice('全库同步失败', e.message, syncAll);
  } finally {
    setBusy($('syncAll'), false);
  }
}

async function testSearch() {
  try {
    const keyword = $('searchKeyword').value.trim();
    if (!keyword) throw new Error('请输入测试搜索词');
    setBusy($('testSearch'), true, '正在搜索…');
    $('searchResult').className = 'result-panel loading-result';
    $('searchResult').innerHTML = '<strong>正在匹配书籍与章节…</strong>';
    const result = await apiPost('/api/search/topone', { keyword });
    const ok = result.code === 0;
    $('diagnosticLastTest').textContent = ok ? '测试成功' : '测试失败';
    $('diagnosticLastTest').dataset.tone = ok ? 'success' : 'danger';
    $('searchResult').className = `result-panel ${ok ? 'success-result' : 'error-result'}`;
    $('searchResult').innerHTML = ok
      ? `<span class="result-label">匹配成功</span><strong>${escapeHtml(result.data?.title || keyword)}</strong><span>${escapeHtml(result.msg || '已返回可播放内容')}</span><details><summary>查看原始响应</summary><pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre></details>`
      : `<span class="result-label">未找到结果</span><strong>${escapeHtml(result.msg || '搜索失败')}</strong><span>请尝试完整书名，或检查书库是否已连接。</span>`;
    status(result.code === 0 ? `搜索成功：${result.data?.title || ''}` : result.msg, result.code === 0);
    if (ok) dismissActionNotice();
    await refreshLogs();
  } catch (e) {
    $('diagnosticLastTest').textContent = '测试失败';
    $('diagnosticLastTest').dataset.tone = 'danger';
    $('searchResult').className = 'result-panel error-result';
    $('searchResult').innerHTML = `<strong>${escapeHtml(e.message)}</strong>`;
    status(e.message, false);
    showActionNotice('搜索测试失败', e.message, testSearch);
  } finally { setBusy($('testSearch'), false); }
}

async function refreshLogs() {
  try {
    const data = await apiGet('/api/search/logs');
    $('diagnosticLogCount').textContent = `${data.logs.length} 条`;
    $('searchLogs').innerHTML = data.logs.length ? data.logs.map(log =>
      `<div class="log-item"><strong>${escapeHtml(log.keyword || '未知搜索')} · ${log.ok ? '成功' : '失败'}</strong><br>${escapeHtml(log.title || log.message || '')}<span>${escapeHtml(log.at || '')}</span></div>`
    ).join('') : '<div class="empty-state compact"><strong>暂无搜索日志</strong><p>完成一次测试后，结果会显示在这里。</p></div>';
  } catch (e) {
    status(e.message, false);
    showActionNotice('日志读取失败', e.message, refreshLogs);
  }
}

async function clearLogs() {
  try {
    await apiPost('/api/search/logs/clear', {});
    await refreshLogs();
    dismissActionNotice();
  } catch (e) {
    status(e.message, false);
    showActionNotice('无法清空日志', e.message, clearLogs);
  }
}

function progressText(progress, duration) {
  if (!progress) return '暂无收听进度';
  if (progress.isFinished) return '已听完';
  const current = Number(progress.currentTime || (progress.progress || 0) * duration);
  const percent = duration > 0 ? Math.min(100, Math.round(current / duration * 100)) : Math.round((progress.progress || 0) * 100);
  return current > 0 ? `听到 ${formatTime(current)}（${percent}%）` : '尚未开始';
}

function formatTime(seconds) {
  const h = Math.floor(Number(seconds || 0) / 3600);
  const m = Math.floor(Number(seconds || 0) % 3600 / 60);
  return h ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

$('save').addEventListener('click', save);
$('load').addEventListener('click', () => loadBooks(false));
$('loadMore').addEventListener('click', loadMoreBooks);
$('syncAll').addEventListener('click', syncAll);
$('testSearch').addEventListener('click', testSearch);
$('refreshLogs').addEventListener('click', refreshLogs);
$('clearLogs').addEventListener('click', clearLogs);
$('bookSearch').addEventListener('input', () => { localStorage.setItem('audiobookshelf:book-search', $('bookSearch').value); renderLibrary(); });
$('syncFilter').addEventListener('change', () => { localStorage.setItem('audiobookshelf:sync-filter', $('syncFilter').value); renderLibrary(); });
$('bookSort').addEventListener('change', () => { localStorage.setItem('audiobookshelf:book-sort', $('bookSort').value); renderLibrary(); });
$('searchKeyword').addEventListener('keydown', e => { if (e.key === 'Enter') testSearch(); });
$('library').addEventListener('change', () => updateSetupProgress($('library').value ? 2 : 1));
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', async () => {
  showWorkspace(button.dataset.view);
  if (button.dataset.view === 'diagnostics') await refreshLogs();
}));
document.querySelectorAll('[data-open-view]').forEach(link => link.addEventListener('click', e => { e.preventDefault(); showWorkspace(link.dataset.openView); }));
document.querySelectorAll('[data-go-library]').forEach(button => button.addEventListener('click', () => showWorkspace('library')));
document.querySelectorAll('[data-theme-choice]').forEach(button => button.addEventListener('click', () => applyTheme(button.dataset.themeChoice)));
$('books').addEventListener('click', e => {
  const button = e.target.closest('button');
  if (!button) return;
  if (button.dataset.play) playBook(button.dataset.play, button);
  if (button.dataset.import) openImportDialog(button.dataset.import, button);
});
$('books').addEventListener('error', e => {
  if (e.target.matches('.book-cover') && e.target.src !== COVER_PLACEHOLDER) {
    e.target.src = COVER_PLACEHOLDER;
    e.target.classList.add('cover-fallback');
  }
}, true);
$('actionDismiss').addEventListener('click', dismissActionNotice);
$('actionRetry').addEventListener('click', async () => {
  const action = retryAction;
  if (!action) return;
  setBusy($('actionRetry'), true, '重试中…');
  try { await action(); } finally { setBusy($('actionRetry'), false); }
});
$('confirmCancel').addEventListener('click', () => closeConfirm(false));
$('confirmAccept').addEventListener('click', () => closeConfirm(true));
$('confirmDialog').addEventListener('click', e => { if (e.target === $('confirmDialog')) closeConfirm(false); });
$('importCancel').addEventListener('click', () => closeImportDialog(false));
$('importAccept').addEventListener('click', () => closeImportDialog(true));
$('importDialog').addEventListener('click', e => { if (e.target === $('importDialog')) closeImportDialog(false); });
$('directoryList').addEventListener('click', e => {
  const button = e.target.closest('[data-directory-index]');
  if (button) playDirectoryEntry(Number(button.dataset.directoryIndex), button.dataset.directoryKind).catch(error => status(`播放失败：${error.message}`, false));
});
$('detailResume').addEventListener('click', () => {
  const audio = $('previewAudio');
  if (audio.src) audio.play().catch(e => status(`播放失败：${e.message}`, false));
  else loadPlaybackTrack(playbackState.index, true).catch(e => status(`播放失败：${e.message}`, false));
});
$('refreshSpeakers').addEventListener('click', () => loadSpeakers(false));
$('pushToSpeaker').addEventListener('click', pushCurrentToSpeaker);
$('refreshSpeakerStatus').addEventListener('click', () => refreshSpeakerStatus(false));
$('speakerDevice').addEventListener('change', () => {
  const device = selectedSpeaker();
  if (!device) return;
  localStorage.setItem('audiobookshelf:speaker-device', `${device.accountId}:${device.deviceId}`);
  refreshSpeakerStatus(true);
});
document.querySelectorAll('[data-speaker-action]').forEach(button => button.addEventListener('click', () => controlSpeaker(button.dataset.speakerAction, button)));
$('playerPrevious').addEventListener('click', () => { playbackState.chapterIndex = -1; loadPlaybackTrack(playbackState.index - 1, true).catch(e => status(`播放失败：${e.message}`, false)); });
$('playerNext').addEventListener('click', () => { playbackState.chapterIndex = -1; loadPlaybackTrack(playbackState.index + 1, true).catch(e => status(`播放失败：${e.message}`, false)); });
$('closePlayer').addEventListener('click', closePlayer);
$('previewAudio').addEventListener('ended', () => {
  if (playbackState.index < playbackState.tracks.length - 1) {
    playbackState.chapterIndex = -1;
    loadPlaybackTrack(playbackState.index + 1, true).catch(e => status(`播放失败：${e.message}`, false));
  }
});
$('previewAudio').addEventListener('timeupdate', () => {
  if (!playbackState.chapters.length) return;
  const elapsedBefore = playbackState.tracks.slice(0, playbackState.index).reduce((sum, track) => sum + Number(track.duration || 0), 0);
  const globalTime = elapsedBefore + Number($('previewAudio').currentTime || 0);
  const chapterIndex = playbackState.chapters.findIndex(chapter => globalTime >= Number(chapter.start || 0) && globalTime < Number(chapter.end || 0));
  if (chapterIndex >= 0 && chapterIndex !== playbackState.chapterIndex) {
    playbackState.chapterIndex = chapterIndex;
    renderPlayerPage();
  }
});
$('previewAudio').addEventListener('error', () => {
  const audio = $('previewAudio');
  if (!audio.src || playbackState.candidateIndex + 1 >= playbackState.candidates.length) return;
  playbackState.candidateIndex += 1;
  const currentTime = Number(audio.currentTime || 0);
  audio.src = playbackState.candidates[playbackState.candidateIndex];
  audio.load();
  if (currentTime > 0) audio.addEventListener('loadedmetadata', () => { audio.currentTime = currentTime; }, { once: true });
  audio.play().catch(e => status(`播放失败：${e.message}`, false));
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('importDialog').classList.contains('hidden')) closeImportDialog(false);
  else if (!$('confirmDialog').classList.contains('hidden')) closeConfirm(false);
});
document.addEventListener('DOMContentLoaded', init);
