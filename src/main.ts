/// <reference types="@songloft/plugin-sdk" />
import { createMusicUrlHandler, createRouter, jsonResponse, parseQuery } from '@songloft/plugin-sdk';

type Config = { serverUrl: string; apiKey: string; libraryId?: string; playbackPreference?: 'resume' | 'from-start' };
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
const SEARCH_PATH = '/api/search/topone';
const SEARCH_LOG_KEY = 'abs_search_logs_v1';
const MAX_SEARCH_LOGS = 50;
const LAST_PLAY_KEY = 'abs_last_direct_play_v1';

function chineseNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  if ([...value].every(char => char in digits)) return Number([...value].map(char => digits[char]).join(''));
  let total = 0;
  let current = 0;
  const units: Record<string, number> = { '十': 10, '百': 100, '千': 1000 };
  for (const char of value) {
    if (char in digits) current = digits[char];
    else if (char in units) {
      total += (current || 1) * units[char];
      current = 0;
    } else return null;
  }
  return total + current;
}

function normalizeOrdinals(value: string): string {
  return String(value || '').replace(/第?([零〇一二两三四五六七八九十百千\d]+)(章|集|回|节|卷|部)/g, (_all, numberText, unit) => {
    const parsed = chineseNumber(numberText);
    return parsed === null ? _all : `第${parsed}${unit}`;
  });
}

function normalizeSearch(value: unknown): string {
  return normalizeOrdinals(String(value || '').toLowerCase())
    .replace(/[“”"'《》【】\[\]()（）·•:：,，.。!！?？\s_-]+/g, '');
}

function requestedOrdinal(keyword: string): number | null {
  const match = normalizeOrdinals(keyword).match(/第?(\d+)(?:章|集|回|节|卷|部)/);
  return match ? Number(match[1]) : null;
}

function stripIntent(keyword: string): string {
  return normalizeOrdinals(keyword)
    .replace(/(请|帮我|我要|想听|播放|有声书|继续|接着|上次|续播|从头|重新|最近添加|最新添加|正在收听|最近收听|我的收藏|收藏内容|下一集|上一集)/g, '')
    .replace(/第?\d+(章|集|回|节|卷|部)/g, '')
    .trim();
}

async function appendSearchLog(entry: AnyMap): Promise<void> {
  try {
    const current = (await songloft.persistentStorage.get(SEARCH_LOG_KEY) || []) as AnyMap[];
    current.unshift({ at: new Date().toISOString(), ...entry });
    await songloft.persistentStorage.set(SEARCH_LOG_KEY, current.slice(0, MAX_SEARCH_LOGS));
  } catch (_) {}
}

function firstHeader(headers: Record<string, string>, name: string): string {
  const key = Object.keys(headers || {}).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || '') : '';
}

function audioFileUrl(config: Config, itemId: string, file: AnyMap, index: number): string {
  const filePart = file.ino !== undefined && file.ino !== null ? String(file.ino) : String(file.id ?? index);
  return `${config.serverUrl}/api/items/${encodeURIComponent(itemId)}/file/${encodeURIComponent(filePart)}?token=${encodeURIComponent(config.apiKey)}`;
}

type ChapterSelection = {
  chapter: AnyMap;
  chapterIndex: number;
  start: number;
  end: number;
};

type AudioSelection = {
  file: AnyMap;
  index: number;
  offset: number;
  chapter?: ChapterSelection;
};

function chaptersOf(item: AnyMap): AnyMap[] {
  const chapters = item.media?.chapters || item.chapters || [];
  return Array.isArray(chapters) ? chapters : [];
}

function chapterStart(chapter: AnyMap): number {
  return Number(chapter.start ?? chapter.startTime ?? chapter.time ?? 0);
}

function chapterEnd(chapter: AnyMap, fallback: number): number {
  return Number(chapter.end ?? chapter.endTime ?? fallback);
}

function requestedChapter(keyword: string, chapters: AnyMap[]): { chapter: AnyMap; index: number } | null {
  const normalized = normalizeSearch(keyword);
  const ordinalMatch = normalizeOrdinals(keyword).match(/第?(\d+)(?:章|回|节)/);
  if (ordinalMatch) {
    const ordinal = Number(ordinalMatch[1]);
    if (ordinal > 0 && ordinal <= chapters.length) return { chapter: chapters[ordinal - 1], index: ordinal - 1 };
  }
  let best: { chapter: AnyMap; index: number; score: number } | null = null;
  chapters.forEach((chapter, index) => {
    const title = normalizeSearch(chapter.title || chapter.name || '');
    if (!title) return;
    let score = 0;
    if (normalized.includes(title)) score += 120;
    if (title.includes(normalized) && normalized.length >= 2) score += 60;
    if (score && (!best || score > best.score)) best = { chapter, index, score };
  });
  return best ? { chapter: best.chapter, index: best.index } : null;
}

function locateGlobalTime(files: AnyMap[], globalTime: number): { file: AnyMap; index: number; offset: number } {
  let elapsed = 0;
  for (let index = 0; index < files.length; index++) {
    const duration = Number(files[index].duration || 0);
    if (globalTime < elapsed + duration || index === files.length - 1) {
      return { file: files[index], index, offset: Math.max(0, globalTime - elapsed) };
    }
    elapsed += duration;
  }
  return { file: files[0], index: 0, offset: 0 };
}

function chooseAudioFile(item: AnyMap, keyword: string, preference: 'resume' | 'from-start' = 'resume'): AudioSelection | null {
  const files = item.media?.audioFiles || [];
  if (!files.length) return null;

  const chapters = chaptersOf(item);
  const chapterMatch = requestedChapter(keyword, chapters);
  if (chapterMatch) {
    const start = chapterStart(chapterMatch.chapter);
    const located = locateGlobalTime(files, start);
    return {
      ...located,
      chapter: {
        chapter: chapterMatch.chapter,
        chapterIndex: chapterMatch.index,
        start,
        end: chapterEnd(chapterMatch.chapter, start)
      }
    };
  }

  const wanted = requestedOrdinal(keyword);
  if (wanted !== null) {
    const byName = files.findIndex((file: AnyMap) => {
      const name = normalizeSearch(file.metadata?.filename || file.filename || '');
      const numbers = name.match(/\d+/g)?.map(Number) || [];
      return numbers.includes(wanted) || normalizeSearch(normalizeOrdinals(file.metadata?.filename || file.filename || '')).includes(`第${wanted}`);
    });
    if (byName >= 0) return { file: files[byName], index: byName, offset: 0 };
    if (wanted > 0 && wanted <= files.length) return { file: files[wanted - 1], index: wanted - 1, offset: 0 };
  }

  const progress = progressOf(item);
  const currentTime = Number(progress?.currentTime || 0);
  const explicitResume = /(继续|接着|上次|续播)/.test(keyword);
  const explicitRestart = /(从头|重新)/.test(keyword);
  if (!explicitRestart && currentTime > 0 && (explicitResume || preference === 'resume')) {
    return locateGlobalTime(files, currentTime);
  }
  return { file: files[0], index: 0, offset: 0 };
}

function isRecentIntent(keyword: string): boolean {
  return /(最近添加|最新添加|新书)/.test(keyword);
}

function isListeningIntent(keyword: string): boolean {
  return /(正在收听|最近收听|继续收听)/.test(keyword) && !stripIntent(keyword);
}

function isFavoriteIntent(keyword: string): boolean {
  return /(我的收藏|收藏内容|收藏的书)/.test(keyword);
}

async function fetchCategoryCandidates(libraryId: string, keyword: string): Promise<AnyMap[]> {
  const result = await absFetch(`/api/libraries/${encodeURIComponent(libraryId)}/items?limit=50&page=0&sort=addedAt&desc=1&include=progress`);
  let items = result.results || result.libraryItems || [];
  if (isListeningIntent(keyword)) {
    items = items.filter((item: AnyMap) => {
      const progress = progressOf(item);
      return Number(progress?.currentTime || 0) > 0 && !Boolean(progress?.isFinished || progress?.finished);
    });
    items.sort((a: AnyMap, b: AnyMap) => Number(progressOf(b)?.lastUpdate || progressOf(b)?.updatedAt || 0) - Number(progressOf(a)?.lastUpdate || progressOf(a)?.updatedAt || 0));
  } else if (isFavoriteIntent(keyword)) {
    items = items.filter((item: AnyMap) => Boolean(item.isFavorite || item.media?.isFavorite || item.userMediaProgress?.isFavorite));
  }
  return items;
}

async function searchAudiobook(keyword: string): Promise<AnyMap | null> {
  const config = await getConfig();
  const libraryId = String(config.libraryId || '');
  if (!libraryId) throw new Error('请先在插件设置中选择有声书书库');

  const categoryIntent = isRecentIntent(keyword) || isListeningIntent(keyword) || isFavoriteIntent(keyword);
  let candidates: AnyMap[] = [];
  if (categoryIntent) {
    candidates = await fetchCategoryCandidates(libraryId, keyword);
  } else {
    const query = stripIntent(keyword) || keyword;
    const result = await absFetch(`/api/libraries/${encodeURIComponent(libraryId)}/search?q=${encodeURIComponent(query)}&limit=20`);
    candidates = [
      ...(result.book || []),
      ...(result.books || []),
      ...(result.results || []),
      ...(result.libraryItems || [])
    ].map((x: AnyMap) => x.libraryItem || x);
  }
  if (!candidates.length) return null;

  const needle = normalizeSearch(stripIntent(keyword));
  const volumeMatch = normalizeOrdinals(keyword).match(/第?(\d+)(?:卷|部|册)/);
  candidates.sort((a: AnyMap, b: AnyMap) => {
    const score = (item: AnyMap) => {
      const meta = metadataOf(item);
      const title = normalizeSearch(meta.title);
      const subtitle = normalizeSearch(meta.subtitle);
      const author = normalizeSearch(meta.authorName || meta.authors?.map((x: AnyMap) => x.name).join(''));
      const series = normalizeSearch(meta.seriesName || meta.series?.map((x: AnyMap) => `${x.name || ''}${x.sequence || ''}`).join(''));
      const narrator = normalizeSearch(meta.narratorName || meta.narrators?.join(''));
      const progress = progressOf(item);
      let value = 0;
      if (!needle && categoryIntent) value += 100;
      if (title === needle) value += 240;
      else if (needle && (title.includes(needle) || needle.includes(title))) value += 140;
      if (needle && (subtitle.includes(needle) || author.includes(needle) || series.includes(needle) || narrator.includes(needle))) value += 70;
      if (needle && normalizeSearch([title, subtitle, author, series, narrator].join('')).includes(needle)) value += 35;
      if (volumeMatch) {
        const volume = Number(volumeMatch[1]);
        const haystack = normalizeSearch([meta.title, meta.subtitle, meta.seriesName, ...(meta.series || []).map((x: AnyMap) => `${x.name || ''}第${x.sequence || ''}部`)].join(''));
        if ((haystack.match(/\d+/g) || []).map(Number).includes(volume)) value += 100;
      }
      if (/(继续|接着|上次|续播)/.test(keyword) && Number(progress?.currentTime || 0) > 0 && !progress?.isFinished) value += 90;
      value += Math.min(20, Number(item.addedAt || item.createdAt || 0) / 100000000000);
      return value;
    };
    return score(b) - score(a);
  });
  return absFetch(`/api/items/${encodeURIComponent(String(candidates[0].id))}?expanded=1&include=progress`);
}

async function resolvePreviousOrAdjacent(keyword: string): Promise<{ item: AnyMap; selected: AudioSelection } | null> {
  if (!/(下一集|上一集)/.test(keyword)) return null;
  const previous = await songloft.persistentStorage.get(LAST_PLAY_KEY) as AnyMap | null;
  if (!previous?.itemId) throw new Error('还没有上一次播放记录，先点播一本有声书');
  const item = await absFetch(`/api/items/${encodeURIComponent(String(previous.itemId))}?expanded=1&include=progress`);
  const files = item.media?.audioFiles || [];
  const delta = /上一集/.test(keyword) ? -1 : 1;
  const index = Math.max(0, Math.min(files.length - 1, Number(previous.fileIndex || 0) + delta));
  if (!files[index]) throw new Error('没有可播放的上一集或下一集');
  return { item, selected: { file: files[index], index, offset: 0 } };
}

async function registerToMiot(): Promise<void> {
  let attempts = 0;
  const tryRegister = async () => {
    attempts += 1;
    try {
      if (!songloft.comm || typeof songloft.comm.call !== 'function') return;
      await songloft.comm.call('miot', 'register-search-provider', {
        name: 'Audiobookshelf 有声书',
        searchPath: SEARCH_PATH,
        icon: ''
      });
      songloft.log.info('已注册为 MIoT 外部搜索源');
    } catch (error) {
      if (attempts < 5) setTimeout(tryRegister, 3000);
      else songloft.log.warn('注册 MIoT 搜索源失败: ' + String(error));
    }
  };
  setTimeout(tryRegister, 2000);
}

function cleanUrl(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function getConfig(requireKey = true): Promise<Config> {
  const saved = (await songloft.persistentStorage.get(CONFIG_KEY) || {}) as Partial<Config>;
  const config = {
    serverUrl: cleanUrl(saved.serverUrl || DEFAULT_SERVER_URL),
    apiKey: String(saved.apiKey || ''),
    libraryId: saved.libraryId,
    playbackPreference: saved.playbackPreference === 'from-start' ? 'from-start' : 'resume'
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

router.post(SEARCH_PATH, async (req) => {
  let keyword = '';
  try {
    const body = JSON.parse(String(req.body || '{}'));
    keyword = String(body.keyword || body.hint?.title || '').trim();
    if (!keyword) {
      await appendSearchLog({ keyword, ok: false, message: '搜索词为空' });
      return jsonResponse({ code: 1, msg: '搜索词为空', data: null });
    }

    const config = await getConfig();
    const adjacent = await resolvePreviousOrAdjacent(keyword);
    const item = adjacent?.item || await searchAudiobook(keyword);
    if (!item) {
      await appendSearchLog({ keyword, ok: false, message: '未找到匹配的有声书' });
      return jsonResponse({ code: 1, msg: '未找到匹配的有声书', data: null });
    }

    const meta = metadataOf(item);
    const selected = adjacent?.selected || chooseAudioFile(item, keyword, config.playbackPreference || 'resume');
    if (!selected) {
      await appendSearchLog({ keyword, ok: false, itemId: item.id, message: '有声书没有可播放的音频文件' });
      return jsonResponse({ code: 1, msg: '有声书没有可播放的音频文件', data: null });
    }

    const title = meta.title || '未命名有声书';
    const author = meta.authorName || meta.authors?.map((x: AnyMap) => x.name).join('、') || '未知作者';
    const fileName = selected.file.metadata?.filename || selected.file.filename || '';
    const chapterTitle = selected.chapter?.chapter?.title || selected.chapter?.chapter?.name || '';
    const displaySuffix = chapterTitle || ((item.media?.audioFiles || []).length > 1 ? fileName : '');
    const responseData = {
      title: displaySuffix ? `${title} - ${displaySuffix}` : title,
      artist: author,
      album: title,
      duration: selected.chapter
        ? Math.max(0, selected.chapter.end - selected.chapter.start)
        : Number(selected.file.duration || item.media?.duration || 0),
      cover_url: coverUrl(config, String(item.id)),
      url: audioFileUrl(config, String(item.id), selected.file, selected.index),
      dedup_key: `audiobookshelf-direct:${fileKey(String(item.id), selected.file, selected.index)}`,
      start_position: Math.floor(selected.offset),
      chapter: selected.chapter ? {
        index: selected.chapter.chapterIndex + 1,
        title: chapterTitle || `第 ${selected.chapter.chapterIndex + 1} 章`,
        start: selected.chapter.start,
        end: selected.chapter.end
      } : null
    };

    await songloft.persistentStorage.set(LAST_PLAY_KEY, {
      itemId: String(item.id),
      fileIndex: selected.index,
      chapterIndex: selected.chapter?.chapterIndex,
      at: new Date().toISOString()
    });
    await appendSearchLog({
      keyword,
      ok: true,
      itemId: item.id,
      title: responseData.title,
      fileIndex: selected.index,
      offset: selected.offset,
      chapterIndex: selected.chapter?.chapterIndex,
      chapterTitle
    });

    const located = selected.chapter
      ? `已定位章节“${chapterTitle || `第 ${selected.chapter.chapterIndex + 1} 章`}”（文件内约 ${Math.floor(selected.offset)} 秒）`
      : selected.offset > 0
        ? `已定位到上次收听文件（文件内约 ${Math.floor(selected.offset)} 秒）`
        : '搜索成功';
    return jsonResponse({ code: 0, msg: located, data: responseData });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    songloft.log.warn('外部搜索失败: ' + message);
    await appendSearchLog({ keyword, ok: false, message });
    return jsonResponse({ code: 2, msg: message, data: null });
  }
});

router.get('/api/search/logs', async () => {
  const logs = (await songloft.persistentStorage.get(SEARCH_LOG_KEY) || []) as AnyMap[];
  return jsonResponse({ ok: true, logs });
});

router.post('/api/search/logs/clear', async () => {
  await songloft.persistentStorage.set(SEARCH_LOG_KEY, []);
  return jsonResponse({ ok: true });
});

router.get('/api/config', async () => {
  const config = await getConfig(false);
  return jsonResponse({
    serverUrl: config.serverUrl || DEFAULT_SERVER_URL,
    libraryId: config.libraryId || '',
    hasApiKey: Boolean(config.apiKey),
    playbackPreference: config.playbackPreference || 'resume'
  });
});

router.post('/api/config', async (req) => {
  try {
    const body = JSON.parse(String(req.body || '{}'));
    const previous = await getConfig(false);
    const config: Config = {
      serverUrl: cleanUrl(body.serverUrl || DEFAULT_SERVER_URL),
      apiKey: String(body.apiKey || previous.apiKey || '').trim(),
      libraryId: String(body.libraryId || previous.libraryId || ''),
      playbackPreference: body.playbackPreference === 'from-start' ? 'from-start' : (previous.playbackPreference || 'resume')
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
  songloft.log.info('Audiobookshelf plugin v0.4.0 initialized');
  await registerToMiot();
}
async function onDeinit(): Promise<void> {
  try {
    if (songloft.comm && typeof songloft.comm.call === 'function') {
      await songloft.comm.call('miot', 'unregister-search-provider', {});
    }
  } catch (_) {}
  songloft.log.info('Audiobookshelf plugin deinitialized');
}
async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return router.handle(req);
}

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
