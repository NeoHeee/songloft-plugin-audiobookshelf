/// <reference types="@songloft/plugin-sdk" />
import { createMusicUrlHandler, createRouter, jsonResponse, parseQuery } from '@songloft/plugin-sdk';

type Config = { serverUrl: string; apiKey: string; libraryId?: string };
type AnyMap = Record<string, any>;

const router = createRouter();
const CONFIG_KEY = 'abs_config';

function cleanUrl(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function getConfig(requireKey = true): Promise<Config> {
  const saved = (await songloft.persistentStorage.get(CONFIG_KEY) || {}) as Partial<Config>;
  const config = { serverUrl: cleanUrl(saved.serverUrl || ''), apiKey: String(saved.apiKey || ''), libraryId: saved.libraryId };
  if (!config.serverUrl || (requireKey && !config.apiKey)) throw new Error('请先填写服务器地址和 API 密钥');
  return config;
}

async function absFetch(path: string, init: AnyMap = {}): Promise<any> {
  const config = await getConfig();
  const response = await fetch(config.serverUrl + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'X-Fetch-Timeout-Ms': '15000',
      ...(init.headers || {})
    }
  });
  if (!response.ok) throw new Error(`Audiobookshelf 返回 ${response.status} ${response.statusText || ''}`.trim());
  const contentType = String(response.headers?.['content-type'] || response.headers?.['Content-Type'] || '');
  return contentType.includes('json') ? response.json() : response.text();
}

function safeError(error: unknown): HTTPResponse {
  const message = error instanceof Error ? error.message : String(error);
  songloft.log.warn(message);
  return jsonResponse({ ok: false, error: message }, 400);
}

function metadataOf(item: AnyMap): AnyMap {
  return item.media?.metadata || item.mediaMetadata || {};
}

function coverUrl(config: Config, itemId: string): string {
  return `${config.serverUrl}/api/items/${encodeURIComponent(itemId)}/cover?token=${encodeURIComponent(config.apiKey)}`;
}

router.get('/api/config', async () => {
  const config = await getConfig(false).catch(() => ({ serverUrl: '', apiKey: '' }));
  return jsonResponse({ serverUrl: config.serverUrl, libraryId: config.libraryId || '', hasApiKey: Boolean(config.apiKey) });
});

router.post('/api/config', async (req) => {
  try {
    const body = JSON.parse(String(req.body || '{}'));
    const previous = await getConfig(false).catch(() => ({ serverUrl: '', apiKey: '' }));
    const config: Config = {
      serverUrl: cleanUrl(body.serverUrl),
      apiKey: String(body.apiKey || previous.apiKey || '').trim(),
      libraryId: String(body.libraryId || '')
    };
    if (!config.serverUrl || !config.apiKey) throw new Error('服务器地址和 API 密钥不能为空');
    await songloft.persistentStorage.set(CONFIG_KEY, config);
    return jsonResponse({ ok: true });
  } catch (error) { return safeError(error); }
});

router.post('/api/test', async () => {
  try {
    const [user, result] = await Promise.all([absFetch('/api/me'), absFetch('/api/libraries')]);
    const libraries = (result.libraries || []).filter((library: AnyMap) => library.mediaType === 'book');
    return jsonResponse({ ok: true, username: user.username || user.name || '', libraries });
  } catch (error) { return safeError(error); }
});

router.get('/api/libraries', async () => {
  try {
    const result = await absFetch('/api/libraries');
    return jsonResponse({ ok: true, libraries: (result.libraries || []).filter((x: AnyMap) => x.mediaType === 'book') });
  } catch (error) { return safeError(error); }
});

router.get('/api/items', async (req) => {
  try {
    const config = await getConfig();
    const query = parseQuery(req.query || '');
    const libraryId = String(query.libraryId || config.libraryId || '');
    if (!libraryId) throw new Error('请选择有声书书库');
    const page = Math.max(0, Number(query.page || 0));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 30)));
    const result = await absFetch(`/api/libraries/${encodeURIComponent(libraryId)}/items?limit=${limit}&page=${page}&sort=media.metadata.title`);
    const items = (result.results || []).map((item: AnyMap) => {
      const meta = metadataOf(item);
      return {
        id: item.id, title: meta.title || item.media?.metadata?.title || '未命名有声书',
        author: meta.authorName || meta.authors?.map((x: AnyMap) => x.name).join('、') || '',
        duration: item.media?.duration || 0, coverUrl: coverUrl(config, item.id)
      };
    });
    return jsonResponse({ ok: true, items, total: result.total || items.length, page });
  } catch (error) { return safeError(error); }
});

router.get('/api/items/:id', async (_req, params) => {
  try {
    const item = await absFetch(`/api/items/${encodeURIComponent(params.id)}?expanded=1&include=progress`);
    const meta = metadataOf(item);
    return jsonResponse({
      ok: true,
      item: {
        id: item.id, title: meta.title || '未命名有声书',
        author: meta.authorName || meta.authors?.map((x: AnyMap) => x.name).join('、') || '',
        duration: item.media?.duration || 0,
        chapters: item.media?.chapters || [],
        audioFiles: (item.media?.audioFiles || []).map((file: AnyMap) => ({
          ino: file.ino, index: file.index, duration: file.duration || 0,
          filename: file.metadata?.filename || file.filename || `音频 ${file.index + 1}`
        }))
      }
    });
  } catch (error) { return safeError(error); }
});

router.post('/api/import/:id', async (_req, params) => {
  try {
    const config = await getConfig();
    const itemId = String(params.id);
    const item = await absFetch(`/api/items/${encodeURIComponent(itemId)}?expanded=1`);
    const meta = metadataOf(item);
    const title = meta.title || '未命名有声书';
    const author = meta.authorName || meta.authors?.map((x: AnyMap) => x.name).join('、') || '未知作者';
    const files = item.media?.audioFiles || [];
    if (!files.length) throw new Error('这本书没有可导入的音频文件');
    const created = await songloft.songs.create(files.map((file: AnyMap, index: number) => ({
      title: files.length === 1 ? title : `${title} - ${String(index + 1).padStart(2, '0')} - ${file.metadata?.filename || `音频 ${index + 1}`}`,
      artist: author, album: title, duration: Number(file.duration || 0),
      coverUrl: coverUrl(config, itemId),
      dedupKey: `audiobookshelf:${itemId}:${file.ino}`,
      sourceData: JSON.stringify({ provider: 'audiobookshelf', itemId, ino: file.ino })
    })));
    let playlist = (await songloft.playlists.search(title, { limit: 20 })).find((x: AnyMap) => x.name === title);
    if (!playlist) playlist = await songloft.playlists.create({ name: title, description: `Audiobookshelf · ${author}`, coverUrl: coverUrl(config, itemId) });
    const added = await songloft.playlists.addSongs(playlist.id, created.map((song: AnyMap) => song.id));
    return jsonResponse({ ok: true, playlistId: playlist.id, created: created.length, added });
  } catch (error) { return safeError(error); }
});

router.post('/api/music/url', createMusicUrlHandler({
  resolveUrl: async (sourceData) => {
    if (sourceData.provider !== 'audiobookshelf' || !sourceData.itemId || !sourceData.ino) {
      throw new Error('无效的 Audiobookshelf 音频来源');
    }
    const config = await getConfig();
    return {
      url: `${config.serverUrl}/api/items/${encodeURIComponent(String(sourceData.itemId))}/file/${encodeURIComponent(String(sourceData.ino))}`,
      headers: { Authorization: `Bearer ${config.apiKey}` }
    };
  }
}));

async function onInit(): Promise<void> { songloft.log.info('Audiobookshelf plugin initialized'); }
async function onDeinit(): Promise<void> { songloft.log.info('Audiobookshelf plugin deinitialized'); }
async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> { return router.handle(req); }

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
