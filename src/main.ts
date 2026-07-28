/// <reference types="@songloft/plugin-sdk" />
import { createMusicUrlHandler, createRouter, jsonResponse, parseQuery } from '@songloft/plugin-sdk';

type Config = { serverUrl: string; apiKey: string; libraryId?: string };
type AnyMap = Record<string, any>;
type SyncRecord = {
  itemId: string;
  playlistId: number;
  songIds: number[];
  fileKeys: string[];
  fingerprint: string;
  syncedAt: string;
};

const router = createRouter();
const CONFIG_KEY = 'abs_config';
const SYNC_KEY = 'abs_sync_records_v1';
const DEFAULT_SERVER_URL = 'http://192.168.1.1:13378';

function cleanUrl(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function getConfig(requireKey = true): Promise<Config> {
  const saved = (await songloft.persistentStorage.get(CONFIG_KEY) || {}) as Partial<Config>;
  const config = {
    serverUrl: cleanUrl(saved.serverUrl || DEFAULT_SERVER_URL),
    apiKey: String(saved.apiKey || ''),
    libraryId: saved.libraryId
  };
  if (!config.serverUrl || (requireKey && !config.apiKey)) throw new Error('请先填写服务器地址和 API 密钥');
  return config;
}

async function getSyncRecords(): Promise<Record<string, SyncRecord>> {
  return (await songloft.persistentStorage.get(SYNC_KEY) || {}) as Record<string, SyncRecord>;
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
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('API 密钥无效、已停用或无权访问该书库');
    throw new Error(`Audiobookshelf 返回 ${response.status} ${response.statusText || ''}`.trim());
  }
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

function progressOf(item: AnyMap): AnyMap | null {
  return item.userMediaProgress || item.mediaProgress || item.progress || null;
}

function fileKey(itemId: string, file: AnyMap, index: number): string {
  return `${itemId}:${String(file.ino ?? file.id ?? index)}`;
}

function fingerprint(files: AnyMap[]): string {
  return files.map((file, index) => [
    file.ino ?? file.id ?? index,
    file.metadata?.filename || file.filename || '',
    Number(file.duration || 0).toFixed(3)
  ].join(':')).join('|');
}

function coverUrl(config: Config, itemId: string): string {
  return `${config.serverUrl}/api/items/${encodeURIComponent(itemId)}/cover?token=${encodeURIComponent(config.apiKey)}`;
}

async function importOrSync(itemId: string): Promise<AnyMap> {
  const config = await getConfig();
  const records = await getSyncRecords();
  const item = await absFetch(`/api/items/${encodeURIComponent(itemId)}?expanded=1&include=progress`);
  const meta = metadataOf(item);
  const title = meta.title || '未命名有声书';
  const author = meta.authorName || meta.authors?.map((x: AnyMap) => x.name).join('、') || '未知作者';
  const files = item.media?.audioFiles || [];
  if (!files.length) throw new Error('这本书没有可导入的音频文件');

  const currentFingerprint = fingerprint(files);
  const previous = records[itemId];
  let playlist: AnyMap | undefined;
  if (previous?.playlistId) playlist = await songloft.playlists.getById(previous.playlistId).catch(() => undefined);
  if (!playlist) {
    playlist = (await songloft.playlists.search(title, { limit: 50 })).find((x: AnyMap) => x.name === title);
  }
  if (!playlist) {
    playlist = await songloft.playlists.create({
      name: title,
      description: `Audiobookshelf · ${author}`,
      coverUrl: coverUrl(config, itemId)
    });
  }

  const remoteSongs = await songloft.songs.create(files.map((file: AnyMap, index: number) => ({
    title: files.length === 1
      ? title
      : `${title} - ${String(index + 1).padStart(2, '0')} - ${file.metadata?.filename || `音频 ${index + 1}`}`,
    artist: author,
    album: title,
    duration: Number(file.duration || 0),
    coverUrl: coverUrl(config, itemId),
    dedupKey: `audiobookshelf:${fileKey(itemId, file, index)}`,
    sourceData: JSON.stringify({
      provider: 'audiobookshelf',
      itemId,
      ino: file.ino ?? file.id,
      fileIndex: index
    })
  })));

  const existing = await songloft.playlists.getSongs(playlist.id, { limit: 10000, offset: 0 });
  const existingIds = new Set((existing || []).map((song: AnyMap) => Number(song.id)));
  const toAdd = remoteSongs.filter((song: AnyMap) => !existingIds.has(Number(song.id)));
  if (toAdd.length) await songloft.playlists.addSongs(playlist.id, toAdd.map((song: AnyMap) => song.id));

  const record: SyncRecord = {
    itemId,
    playlistId: Number(playlist.id),
    songIds: remoteSongs.map((song: AnyMap) => Number(song.id)),
    fileKeys: files.map((file: AnyMap, index: number) => fileKey(itemId, file, index)),
    fingerprint: currentFingerprint,
    syncedAt: new Date().toISOString()
  };
  records[itemId] = record;
  await songloft.persistentStorage.set(SYNC_KEY, records);

  return {
    playlistId: playlist.id,
    total: remoteSongs.length,
    added: toAdd.length,
    unchanged: Boolean(previous && previous.fingerprint === currentFingerprint && toAdd.length === 0),
    changed: !previous || previous.fingerprint !== currentFingerprint
  };
}

router.get('/api/config', async () => {
  const config = await getConfig(false);
  return jsonResponse({
    serverUrl: config.serverUrl || DEFAULT_SERVER_URL,
    libraryId: config.libraryId || '',
    hasApiKey: Boolean(config.apiKey)
  });
});

router.post('/api/config', async (req) => {
  try {
    const body = JSON.parse(String(req.body || '{}'));
    const previous = await getConfig(false);
    const config: Config = {
      serverUrl: cleanUrl(body.serverUrl || DEFAULT_SERVER_URL),
      apiKey: String(body.apiKey || previous.apiKey || '').trim(),
      libraryId: String(body.libraryId || previous.libraryId || '')
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

router.get('/api/items', async (req) => {
  try {
    const config = await getConfig();
    const records = await getSyncRecords();
    const query = parseQuery(req.query || '');
    const libraryId = String(query.libraryId || config.libraryId || '');
    if (!libraryId) throw new Error('请选择有声书书库');
    const page = Math.max(0, Number(query.page || 0));
    const limit = Math.min(100, Math.max(1, Number(query.limit || 30)));
    const result = await absFetch(`/api/libraries/${encodeURIComponent(libraryId)}/items?limit=${limit}&page=${page}&sort=media.metadata.title&include=progress`);
    const items = (result.results || []).map((item: AnyMap) => {
      const meta = metadataOf(item);
      const progress = progressOf(item);
      return {
        id: item.id,
        title: meta.title || '未命名有声书',
        author: meta.authorName || meta.authors?.map((x: AnyMap) => x.name).join('、') || '',
        duration: item.media?.duration || 0,
        coverUrl: coverUrl(config, item.id),
        progress: progress ? {
          currentTime: Number(progress.currentTime || 0),
          progress: Number(progress.progress || 0),
          isFinished: Boolean(progress.isFinished || progress.finished)
        } : null,
        sync: records[item.id] ? {
          syncedAt: records[item.id].syncedAt,
          songCount: records[item.id].songIds.length
        } : null
      };
    });
    return jsonResponse({ ok: true, items, total: result.total || items.length, page });
  } catch (error) { return safeError(error); }
});

router.post('/api/import/:id', async (_req, params) => {
  try {
    return jsonResponse({ ok: true, ...(await importOrSync(String(params.id))) });
  } catch (error) { return safeError(error); }
});

router.post('/api/sync-all', async (req) => {
  try {
    const body = JSON.parse(String(req.body || '{}'));
    const config = await getConfig();
    const libraryId = String(body.libraryId || config.libraryId || '');
    if (!libraryId) throw new Error('请选择有声书书库');
    let page = 0;
    let success = 0;
    let failed = 0;
    let added = 0;
    while (true) {
      const result = await absFetch(`/api/libraries/${encodeURIComponent(libraryId)}/items?limit=100&page=${page}`);
      const items = result.results || [];
      for (const item of items) {
        try {
          const synced = await importOrSync(String(item.id));
          success += 1;
          added += Number(synced.added || 0);
        } catch (error) {
          failed += 1;
          songloft.log.warn(`同步 ${item.id} 失败: ${String(error)}`);
        }
      }
      if (!items.length || (page + 1) * 100 >= Number(result.total || 0)) break;
      page += 1;
    }
    return jsonResponse({ ok: true, success, failed, added });
  } catch (error) { return safeError(error); }
});

router.post('/api/music/url', createMusicUrlHandler({
  resolveUrl: async (sourceData) => {
    if (sourceData.provider !== 'audiobookshelf' || !sourceData.itemId) {
      throw new Error('无效的 Audiobookshelf 音频来源');
    }
    const config = await getConfig();
    const filePart = sourceData.ino !== undefined && sourceData.ino !== null
      ? String(sourceData.ino)
      : String(sourceData.fileIndex);
    return {
      url: `${config.serverUrl}/api/items/${encodeURIComponent(String(sourceData.itemId))}/file/${encodeURIComponent(filePart)}`,
      headers: { Authorization: `Bearer ${config.apiKey}` }
    };
  }
}));

async function onInit(): Promise<void> {
  songloft.log.info('Audiobookshelf plugin v0.2.0 initialized');
}
async function onDeinit(): Promise<void> {
  songloft.log.info('Audiobookshelf plugin deinitialized');
}
async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return router.handle(req);
}

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
