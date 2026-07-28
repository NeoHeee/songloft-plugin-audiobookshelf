const { apiGet, apiPost } = SongloftPlugin;
const DEFAULT_SERVER = 'http://192.168.1.1:13378';
const $ = (id) => document.getElementById(id);
const status = (text, ok = true) => {
  $('status').textContent = text;
  $('status').className = `status ${ok ? 'ok' : 'error'}`;
};

async function init() {
  try {
    const config = await apiGet('/api/config');
    $('server').value = config.serverUrl || DEFAULT_SERVER;
    if (config.hasApiKey) $('key').placeholder = '已保存，如不更换可留空';
    if (config.serverUrl && config.hasApiKey) await test(false, config.libraryId);
  } catch (e) { status(e.message, false); }
}

async function save() {
  try {
    status('正在保存并连接…');
    await apiPost('/api/config', {
      serverUrl: $('server').value || DEFAULT_SERVER,
      apiKey: $('key').value,
      libraryId: $('library').value
    });
    $('key').value = '';
    await test(true, $('library').value);
  } catch (e) { status(e.message, false); }
}

async function test(showMessage = true, selected = '') {
  const data = await apiPost('/api/test', {});
  const select = $('library');
  select.innerHTML = '<option value="">请选择书库</option>' +
    data.libraries.map(x => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('');
  if (selected) select.value = selected;
  if (showMessage) {
    status(`连接成功${data.username ? `，用户：${data.username}` : ''}，找到 ${data.libraries.length} 个有声书书库`);
  }
}

async function loadBooks() {
  try {
    const libraryId = $('library').value;
    if (!libraryId) throw new Error('请先选择书库');
    await apiPost('/api/config', { serverUrl: $('server').value, apiKey: '', libraryId });
    status('正在读取书库…');
    const data = await apiGet(`/api/items?libraryId=${encodeURIComponent(libraryId)}&limit=100`);
    $('books').innerHTML = data.items.map(book => {
      const progress = progressText(book.progress, book.duration);
      const sync = book.sync ? `已同步 ${book.sync.songCount} 个音频` : '尚未同步';
      return `<article class="card book">
        <img src="${book.coverUrl}" alt="">
        <div><h3>${escapeHtml(book.title)}</h3><p>${escapeHtml(book.author || '未知作者')}</p>
        <p>${formatTime(book.duration)} · ${escapeHtml(progress)}</p>
        <p class="sync-state">${escapeHtml(sync)}</p>
        <button data-import="${escapeHtml(book.id)}">${book.sync ? '检查更新' : '导入 Songloft'}</button></div>
      </article>`;
    }).join('');
    status(`已加载 ${data.items.length} / ${data.total} 本`);
  } catch (e) { status(e.message, false); }
}

async function importBook(id, button) {
  try {
    button.disabled = true;
    button.textContent = '正在同步…';
    const result = await apiPost(`/api/import/${encodeURIComponent(id)}`, {});
    button.textContent = result.unchanged ? '已是最新' : `已同步，新增 ${result.added}`;
    status(result.unchanged
      ? '没有发现变化，未重复添加歌曲'
      : `同步成功，共 ${result.total} 个音频，本次新增到歌单 ${result.added} 个`);
  } catch (e) {
    button.disabled = false;
    button.textContent = '重新同步';
    status(e.message, false);
  }
}

async function syncAll() {
  try {
    const libraryId = $('library').value;
    if (!libraryId) throw new Error('请先选择书库');
    $('syncAll').disabled = true;
    status('正在增量同步整个书库，请勿关闭页面…');
    const result = await apiPost('/api/sync-all', { libraryId });
    status(`同步完成：成功 ${result.success} 本，失败 ${result.failed} 本，新增 ${result.added} 个音频`);
    await loadBooks();
  } catch (e) {
    status(e.message, false);
  } finally {
    $('syncAll').disabled = false;
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
$('load').addEventListener('click', loadBooks);
$('syncAll').addEventListener('click', syncAll);
$('books').addEventListener('click', e => {
  const id = e.target.dataset.import;
  if (id) importBook(id, e.target);
});
document.addEventListener('DOMContentLoaded', init);
