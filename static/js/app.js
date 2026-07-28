const { apiGet, apiPost } = SongloftPlugin;
const $ = (id) => document.getElementById(id);
const status = (text, ok = true) => { $('status').textContent = text; $('status').className = `status ${ok ? 'ok' : 'error'}`; };

async function init() {
  try {
    const config = await apiGet('/api/config');
    $('server').value = config.serverUrl || '';
    if (config.hasApiKey) $('key').placeholder = '已保存，如不更换可留空';
    if (config.serverUrl && config.hasApiKey) await test(false, config.libraryId);
  } catch (e) { status(e.message, false); }
}

async function save() {
  try {
    status('正在保存并连接…');
    await apiPost('/api/config', { serverUrl: $('server').value, apiKey: $('key').value, libraryId: $('library').value });
    $('key').value = '';
    await test(true);
  } catch (e) { status(e.message, false); }
}

async function test(showMessage = true, selected = '') {
  const data = await apiPost('/api/test', {});
  const select = $('library');
  select.innerHTML = '<option value="">请选择书库</option>' + data.libraries.map(x => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');
  if (selected) select.value = selected;
  if (showMessage) status(`连接成功${data.username ? `，用户：${data.username}` : ''}，找到 ${data.libraries.length} 个有声书书库`);
}

async function loadBooks() {
  try {
    const libraryId = $('library').value;
    if (!libraryId) throw new Error('请先选择书库');
    await apiPost('/api/config', { serverUrl: $('server').value, apiKey: '', libraryId });
    status('正在读取书库…');
    const data = await apiGet(`/api/items?libraryId=${encodeURIComponent(libraryId)}&limit=100`);
    $('books').innerHTML = data.items.map(book => `<article class="card book">
      <img src="${book.coverUrl}" alt="">
      <div><h3>${escapeHtml(book.title)}</h3><p>${escapeHtml(book.author || '未知作者')}</p>
      <p>${formatTime(book.duration)}</p><button data-import="${book.id}">导入 Songloft</button></div>
    </article>`).join('');
    status(`已加载 ${data.items.length} / ${data.total} 本`);
  } catch (e) { status(e.message, false); }
}

async function importBook(id, button) {
  try {
    button.disabled = true; button.textContent = '正在导入…';
    const result = await apiPost(`/api/import/${encodeURIComponent(id)}`, {});
    button.textContent = `已导入 ${result.created} 个音频`;
    status('导入成功，可在 Songloft 歌单中播放，也可交给智能音响插件调用');
  } catch (e) { button.disabled = false; button.textContent = '重新导入'; status(e.message, false); }
}

function formatTime(seconds) { const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60); return h ? `${h} 小时 ${m} 分` : `${m} 分钟`; }
function escapeHtml(value) { return String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

$('save').addEventListener('click', save);
$('load').addEventListener('click', loadBooks);
$('books').addEventListener('click', e => { const id = e.target.dataset.import; if (id) importBook(id, e.target); });
document.addEventListener('DOMContentLoaded', init);
