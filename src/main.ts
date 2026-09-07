/// <reference types="@songloft/plugin-sdk" />
import { createMusicUrlHandler, createRouter, jsonResponse, parseQuery, type HTTPRequest, type HTTPResponse } from '@songloft/plugin-sdk';
import { HlsPlayback, speakerPlaylistBase, type HlsSession } from './hls';

type ImportTitleFormat = 'source' | 'book-source' | 'book-index-source';
type Config = {
  serverUrl: string;
  apiKey: string;
  authMode?: 'api-key' | 'password';
  username?: string;
  refreshToken?: string;
  libraryId?: string;
  playbackPreference?: 'resume' | 'from-start';
  importTitleFormat?: ImportTitleFormat;
  pauseLocalOnPush?: boolean;
  playlistNamePrefixEnabled?: boolean;
  speakerHlsEnabled?: boolean;
  speakerHlsStartMode?: 'selected' | 'book';
  speakerHlsHostUrl?: string;
};
type AnyMap = Record<string, any>;
type SyncRecord = {
  itemId: string;
  playlistId?: number;
  songIds: number[];
  fileKeys: string[];
  fingerprint: string;
  importTitleFormat?: ImportTitleFormat;
  createPlaylist?: boolean;
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
const PLAY_HISTORY_KEY = 'abs_play_history_v1';
const MAX_PLAY_HISTORY = 50;
const DEFAULT_IMPORT_TITLE_FORMAT: ImportTitleFormat = 'book-index-source';
const HLS_SESSION_KEY = 'abs_speaker_hls_session_v1';
const hlsPlayback = new HlsPlayback({
  read: async () => (await songloft.persistentStorage.get(HLS_SESSION_KEY) || null) as HlsSession | null,
  write: async value => { await songloft.persistentStorage.set(HLS_SESSION_KEY, value); },
  request: (path, init) => absFetch(path, init),
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
  createKey: () => crypto.randomBytes(24).toString('hex')
});

function importTitleFormat(value: unknown): ImportTitleFormat {
  return value === 'source' || value === 'book-source' || value === 'book-index-source'
    ? value
    : DEFAULT_IMPORT_TITLE_FORMAT;
}

function audioFileName(file: AnyMap, index: number): string {
  return String(file.metadata?.filename || file.filename || `音频 ${index + 1}`);
}

function withoutAudioExtension(fileName: string): string {
  return fileName.replace(/\.(?:aac|aiff?|alac|ape|flac|m4[abp]|mp3|oga|ogg|opus|wav|wma)$/i, '');
}

function importedSongTitle(bookTitle: string, file: AnyMap, index: number, fileCount: number, format: ImportTitleFormat): string {
  const fileName = audioFileName(file, index);
  if (format === 'source') return fileName;
  if (format === 'book-source') return `${bookTitle} - ${withoutAudioExtension(fileName)}`;
  if (fileCount === 1) return bookTitle;
  return `${bookTitle} - ${String(index + 1).padStart(2, '0')} - ${fileName}`;
}

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
  for (let index = 0; index < chapters.length; index++) {
    const chapter = chapters[index];
    const title = normalizeSearch(chapter.title || chapter.name || '');
    if (!title) continue;
    let score = 0;
    if (normalized.includes(title)) score += 120;
    if (title.includes(normalized) && normalized.length >= 2) score += 60;
    if (score && (!best || score > best.score)) best = { chapter, index, score };
  }
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
  const config: Config = {
    serverUrl: cleanUrl(saved.serverUrl || DEFAULT_SERVER_URL),
    apiKey: String(saved.apiKey || ''),
    authMode: saved.authMode === 'password' ? 'password' : 'api-key',
    username: String(saved.username || ''),
    refreshToken: String(saved.refreshToken || ''),
    libraryId: saved.libraryId,
    playbackPreference: saved.playbackPreference === 'from-start' ? 'from-start' : 'resume',
    importTitleFormat: importTitleFormat(saved.importTitleFormat),
    pauseLocalOnPush: saved.pauseLocalOnPush !== false,
    playlistNamePrefixEnabled: saved.playlistNamePrefixEnabled !== false,
    speakerHlsEnabled: saved.speakerHlsEnabled === true,
    speakerHlsStartMode: saved.speakerHlsStartMode === 'book' ? 'book' : 'selected',
    speakerHlsHostUrl: String(saved.speakerHlsHostUrl || '')
  };
  if (!config.serverUrl || (requireKey && !config.apiKey)) throw new Error('请先填写服务器地址和 API 密钥');
  return config;
}

async function getSyncRecords(): Promise<Record<string, SyncRecord>> {
  return (await songloft.persistentStorage.get(SYNC_KEY) || {}) as Record<string, SyncRecord>;
}

function authTokens(payload: AnyMap): { accessToken: string; refreshToken: string; username: string } {
  const user = payload?.user || {};
  return {
    accessToken: String(user.accessToken || user.token || payload?.accessToken || payload?.token || ''),
    refreshToken: String(user.refreshToken || payload?.refreshToken || ''),
    username: String(user.username || payload?.username || '')
  };
}

async function loginWithPassword(serverUrl: string, username: string, password: string): Promise<{ accessToken: string; refreshToken: string; username: string }> {
  const response = await fetch(`${serverUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Fetch-Timeout-Ms': '15000', 'x-return-tokens': 'true' },
    body: JSON.stringify({ username, password })
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('Audiobookshelf 用户名或密码错误');
    throw new Error(`Audiobookshelf 登录失败：${response.status} ${response.statusText || ''}`.trim());
  }
  const tokens = authTokens(await response.json());
  if (!tokens.accessToken) throw new Error('Audiobookshelf 登录成功，但没有返回访问令牌');
  return tokens;
}

let refreshPromise: Promise<Config> | null = null;

async function refreshPasswordToken(config: Config): Promise<Config> {
  if (!config.refreshToken) throw new Error('Audiobookshelf 登录已过期，请重新输入账号密码');
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const response = await fetch(`${config.serverUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fetch-Timeout-Ms': '15000', 'x-refresh-token': config.refreshToken || '' }
    });
    if (!response.ok) throw new Error('Audiobookshelf 登录已过期，请重新输入账号密码');
    const tokens = authTokens(await response.json());
    if (!tokens.accessToken) throw new Error('Audiobookshelf 刷新登录失败，请重新输入账号密码');
    const next: Config = {
      ...config,
      apiKey: tokens.accessToken,
      refreshToken: tokens.refreshToken || config.refreshToken,
      username: tokens.username || config.username
    };
    await songloft.persistentStorage.set(CONFIG_KEY, next);
    return next;
  })();
  try { return await refreshPromise; } finally { refreshPromise = null; }
}

async function getPlaybackHistory(): Promise<AnyMap[]> {
  const stored = await songloft.persistentStorage.get(PLAY_HISTORY_KEY);
  return Array.isArray(stored) ? stored : [];
}

async function absFetch(path: string, init: AnyMap = {}): Promise<any> {
  let config = await getConfig();
  const { allowNotFound, ...requestInit } = init;
  const request = (activeConfig: Config) => fetch(activeConfig.serverUrl + path, {
    ...requestInit,
    headers: { Authorization: `Bearer ${activeConfig.apiKey}`, 'Content-Type': 'application/json', 'X-Fetch-Timeout-Ms': '15000', ...(init.headers || {}) }
  });
  let response = await request(config);
  if (response.status === 401 && config.authMode === 'password' && config.refreshToken) {
    config = await refreshPasswordToken(config);
    response = await request(config);
  }
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(config.authMode === 'password' ? 'Audiobookshelf 登录已失效或无权访问该书库' : 'API 密钥无效、已停用或无权访问该书库');
    }
    throw new Error(`Audiobookshelf 返回 ${response.status} ${response.statusText || ''}`.trim());
  }
  const contentType = String(response.headers?.get?.('content-type') || '');
  return contentType.includes('json') ? response.json() : response.text();
}

async function callMiot(path: string, init: RequestInit = {}): Promise<any> {
  const host = (await songloft.plugin.getHostUrl()).replace(/\/$/, '');
  const token = await songloft.plugin.getToken();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init.headers) Object.assign(headers, init.headers as Record<string, string>);
  if (init.body != null) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${host}/api/v1/jsplugin/miot${path}`, { ...init, headers });
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok || body?.success === false) {
    const detail = body?.error || body?.message || text || `HTTP ${response.status}`;
    throw new Error(`MIoT 插件调用失败：${String(detail)}`);
  }
  return body;
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

async function importOrSync(itemId: string, requestedCreatePlaylist?: boolean): Promise<AnyMap> {
  const config = await getConfig();
  const titleFormat = importTitleFormat(config.importTitleFormat);
  const records = await getSyncRecords();
  const item = await absFetch(`/api/items/${encodeURIComponent(itemId)}?expanded=1&include=progress`);
  const meta = metadataOf(item);
  const title = meta.title || '未命名有声书';
  const playlistName = config.playlistNamePrefixEnabled === false ? title : `【有声书】${title}`;
  const author = meta.authorName || meta.authors?.map((x: AnyMap) => x.name).join('、') || '未知作者';
  const files = item.media?.audioFiles || [];
  if (!files.length) throw new Error('这本书没有可导入的音频文件');

  const currentFingerprint = fingerprint(files);
  const previous = records[itemId];
  const createPlaylist = requestedCreatePlaylist ?? previous?.createPlaylist ?? true;
  let playlist: AnyMap | undefined;
  let playlistRenamed = false;
  if (createPlaylist && previous?.playlistId) playlist = await songloft.playlists.getById(previous.playlistId).then(value => value || undefined).catch(() => undefined);
  if (createPlaylist && playlist && playlist.name !== playlistName) {
    playlist = await songloft.playlists.update(Number(playlist.id), { name: playlistName });
    playlistRenamed = true;
  }
  if (createPlaylist && !playlist) {
    playlist = (await songloft.playlists.search(playlistName, { limit: 50 })).find((x: AnyMap) => x.name === playlistName);
  }
  if (createPlaylist && !playlist) {
    playlist = await songloft.playlists.create({
      name: playlistName,
      description: `Audiobookshelf · ${author}`,
      coverUrl: coverUrl(config, itemId)
    });
  }

  const existing = playlist
    ? await songloft.playlists.getSongs(playlist.id, { limit: 10000, offset: 0 })
    : (await Promise.all((previous?.songIds || []).map(id => songloft.songs.getById(id).catch(() => null)))).filter(Boolean) as AnyMap[];
  const existingById = new Map((existing || []).map((song: AnyMap) => [Number(song.id), song]));
  const desiredTitles = files.map((file: AnyMap, index: number) => importedSongTitle(title, file, index, files.length, titleFormat));
  const remoteSongs = await songloft.songs.create(files.map((file: AnyMap, index: number) => ({
    title: desiredTitles[index],
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

  let renamed = 0;
  const syncedSongs = await Promise.all(remoteSongs.map(async (song: AnyMap, index: number) => {
    const previousSong = existingById.get(Number(song.id)) as AnyMap | undefined;
    if (previousSong && previousSong.title !== desiredTitles[index]) renamed += 1;
    if (!previousSong || song.title === desiredTitles[index]) return song;
    return songloft.songs.update(Number(song.id), { title: desiredTitles[index] });
  }));

  const existingIds = new Set(existingById.keys());
  const toAdd = remoteSongs.filter((song: AnyMap) => !existingIds.has(Number(song.id)));
  if (playlist && toAdd.length) await songloft.playlists.addSongs(playlist.id, toAdd.map((song: AnyMap) => song.id));

  const record: SyncRecord = {
    itemId,
    ...(playlist ? { playlistId: Number(playlist.id) } : {}),
    songIds: syncedSongs.map((song: AnyMap) => Number(song.id)),
    fileKeys: files.map((file: AnyMap, index: number) => fileKey(itemId, file, index)),
    fingerprint: currentFingerprint,
    importTitleFormat: titleFormat,
    createPlaylist,
    syncedAt: new Date().toISOString()
  };
  records[itemId] = record;
  await songloft.persistentStorage.set(SYNC_KEY, records);

  return {
    playlistId: playlist?.id || null,
    playlistName: playlist?.name || null,
    playlistRenamed,
    playlistCreated: Boolean(playlist),
    total: syncedSongs.length,
    added: toAdd.length,
    renamed,
    unchanged: Boolean(previous && previous.fingerprint === currentFingerprint && previous.importTitleFormat === titleFormat && toAdd.length === 0 && renamed === 0 && !playlistRenamed),
    changed: !previous || previous.fingerprint !== currentFingerprint || previous.importTitleFormat !== titleFormat || renamed > 0 || playlistRenamed
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
    hasCredential: Boolean(config.apiKey),
    authMode: config.authMode || 'api-key',
    username: config.username || '',
    playbackPreference: config.playbackPreference || 'resume',
    importTitleFormat: importTitleFormat(config.importTitleFormat),
    pauseLocalOnPush: config.pauseLocalOnPush !== false,
    playlistNamePrefixEnabled: config.playlistNamePrefixEnabled !== false,
    speakerHlsEnabled: config.speakerHlsEnabled === true,
    speakerHlsStartMode: config.speakerHlsStartMode,
    speakerHlsHostUrl: config.speakerHlsHostUrl
  });
});

router.post('/api/config', async (req) => {
  try {
    return await hlsPlayback.exclusive(async () => {
    const body = JSON.parse(String(req.body || '{}'));
    const previous = await getConfig(false);
    const serverUrl = cleanUrl(body.serverUrl || previous.serverUrl || DEFAULT_SERVER_URL);
    const authMode = body.authMode === 'password' ? 'password' : body.authMode === 'api-key' ? 'api-key' : (previous.authMode || 'api-key');
    const serverChanged = serverUrl !== previous.serverUrl;
    if ((serverChanged || authMode !== previous.authMode || body.password ||
        (body.apiKey && body.apiKey !== previous.apiKey) ||
        (body.username && body.username !== previous.username)) && await hlsPlayback.current()) {
      throw new Error('请先在播放页停止或清理连续流会话，再更换服务器或认证信息');
    }
    let apiKey = previous.apiKey;
    let refreshToken = previous.refreshToken || '';
    let username = previous.username || '';
    if (authMode === 'password') {
      const requestedUsername = String(body.username || username || '').trim();
      const password = String(body.password || '');
      if (password) {
        if (!requestedUsername) throw new Error('用户名不能为空');
        const tokens = await loginWithPassword(serverUrl, requestedUsername, password);
        apiKey = tokens.accessToken;
        refreshToken = tokens.refreshToken;
        username = tokens.username || requestedUsername;
      } else if (previous.authMode !== 'password' || serverChanged || !apiKey) {
        throw new Error('请输入 Audiobookshelf 用户名和密码');
      }
    } else {
      const requestedKey = String(body.apiKey || '').trim();
      if (requestedKey) apiKey = requestedKey;
      else if (previous.authMode !== 'api-key' || serverChanged || !apiKey) throw new Error('API 密钥不能为空');
      username = '';
      refreshToken = '';
    }
    const config: Config = {
      serverUrl,
      apiKey,
      authMode,
      username,
      refreshToken,
      libraryId: String(body.libraryId || previous.libraryId || ''),
      playbackPreference: body.playbackPreference === 'from-start' ? 'from-start' : (previous.playbackPreference || 'resume'),
      importTitleFormat: body.importTitleFormat === undefined
        ? importTitleFormat(previous.importTitleFormat)
        : importTitleFormat(body.importTitleFormat),
      pauseLocalOnPush: body.pauseLocalOnPush === undefined ? previous.pauseLocalOnPush !== false : body.pauseLocalOnPush !== false,
      playlistNamePrefixEnabled: body.playlistNamePrefixEnabled === undefined ? previous.playlistNamePrefixEnabled !== false : body.playlistNamePrefixEnabled !== false,
      speakerHlsEnabled: body.speakerHlsEnabled === undefined ? previous.speakerHlsEnabled === true : body.speakerHlsEnabled === true,
      speakerHlsStartMode: body.speakerHlsStartMode === undefined ? previous.speakerHlsStartMode : body.speakerHlsStartMode === 'book' ? 'book' : 'selected',
      speakerHlsHostUrl: body.speakerHlsHostUrl === undefined ? previous.speakerHlsHostUrl : String(body.speakerHlsHostUrl || '').trim()
    };
    if (config.speakerHlsHostUrl) config.speakerHlsHostUrl = speakerPlaylistBase(config.speakerHlsHostUrl);
    if (!config.serverUrl || !config.apiKey) throw new Error('服务器地址和认证信息不能为空');
    await songloft.persistentStorage.set(CONFIG_KEY, config);
    return jsonResponse({ ok: true });
    });
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
          songCount: records[item.id].songIds.length,
          hasPlaylist: Boolean(records[item.id].playlistId)
        } : null
      };
    });
    return jsonResponse({ ok: true, items, total: result.total || items.length, page });
  } catch (error) { return safeError(error); }
});

router.get('/api/items/:id/playback', async (_req, params) => {
  try {
    const config = await getConfig();
    const itemId = String(params.id);
    const item = await absFetch(`/api/items/${encodeURIComponent(itemId)}?expanded=1&include=progress`);
    const meta = metadataOf(item);
    const files = item.media?.audioFiles || [];
    if (!files.length) throw new Error('这本书没有可播放的音频文件');
    const selected = chooseAudioFile(item, '', config.playbackPreference || 'resume') || { file: files[0], index: 0, offset: 0 };
    const tracks = files.map((file: AnyMap, index: number) => ({
      index,
      title: audioFileName(file, index),
      duration: Number(file.duration || 0),
      url: audioFileUrl(config, itemId, file, index)
    }));
    const chapters = chaptersOf(item).map((chapter: AnyMap, index: number) => {
      const start = chapterStart(chapter);
      const end = chapterEnd(chapter, start);
      const located = locateGlobalTime(files, start);
      return {
        index,
        title: String(chapter.title || chapter.name || `第 ${index + 1} 章`),
        start,
        end,
        duration: Math.max(0, end - start),
        fileIndex: located.index,
        offset: located.offset
      };
    });
    const currentTime = Number(progressOf(item)?.currentTime || 0);
    const startChapterIndex = chapters.findIndex((chapter: AnyMap) => currentTime >= chapter.start && currentTime < chapter.end);
    await songloft.persistentStorage.set(LAST_PLAY_KEY, {
      itemId,
      fileIndex: selected.index,
      at: new Date().toISOString()
    });
    return jsonResponse({
      ok: true,
      item: {
        id: itemId,
        title: meta.title || '未命名有声书',
        author: meta.authorName || meta.authors?.map((x: AnyMap) => x.name).join('、') || '未知作者',
        coverUrl: coverUrl(config, itemId)
      },
      tracks,
      chapters,
      progress: progressOf(item),
      startIndex: selected.index,
      startChapterIndex,
      startPosition: Math.floor(selected.offset || 0)
    });
  } catch (error) { return safeError(error); }
});

router.get('/api/play-history', async () => {
  try {
    const config = await getConfig(false);
    const history = await getPlaybackHistory();
    return jsonResponse({
      ok: true,
      items: history.map(entry => ({
        ...entry,
        coverUrl: config.apiKey && entry.itemId ? coverUrl(config, String(entry.itemId)) : ''
      }))
    });
  } catch (error) { return safeError(error); }
});

router.post('/api/play-history', async (req) => {
  try {
    const body = JSON.parse(String(req.body || '{}')) as AnyMap;
    const itemId = String(body.itemId || '').trim();
    if (!itemId) throw new Error('缺少有声书标识');
    const history = await getPlaybackHistory();
    const entry = {
      itemId,
      title: String(body.title || '未命名有声书').slice(0, 300),
      author: String(body.author || '未知作者').slice(0, 300),
      trackIndex: Math.max(0, Number(body.trackIndex || 0)),
      chapterIndex: Math.max(-1, Number(body.chapterIndex ?? -1)),
      trackTitle: String(body.trackTitle || '').slice(0, 500),
      chapterTitle: String(body.chapterTitle || '').slice(0, 500),
      positionSeconds: Math.max(0, Number(body.positionSeconds || 0)),
      duration: Math.max(0, Number(body.duration || 0)),
      mode: body.mode === 'speaker' ? 'speaker' : 'local',
      deviceName: body.mode === 'speaker' ? String(body.deviceName || '').slice(0, 200) : '',
      playedAt: new Date().toISOString()
    };
    const next = [entry, ...history.filter(item => String(item.itemId) !== itemId)].slice(0, MAX_PLAY_HISTORY);
    await songloft.persistentStorage.set(PLAY_HISTORY_KEY, next);
    return jsonResponse({ ok: true, item: entry, count: next.length });
  } catch (error) { return safeError(error); }
});

router.post('/api/play-history/remove/:id', async (_req, params) => {
  try {
    const itemId = String(params.id || '');
    const history = await getPlaybackHistory();
    const next = history.filter(item => String(item.itemId) !== itemId);
    await songloft.persistentStorage.set(PLAY_HISTORY_KEY, next);
    return jsonResponse({ ok: true, count: next.length });
  } catch (error) { return safeError(error); }
});

router.post('/api/play-history/clear', async () => {
  try {
    await songloft.persistentStorage.set(PLAY_HISTORY_KEY, []);
    return jsonResponse({ ok: true });
  } catch (error) { return safeError(error); }
});

router.post('/api/import/:id', async (req, params) => {
  try {
    const body = JSON.parse(String(req.body || '{}'));
    return jsonResponse({ ok: true, ...(await importOrSync(String(params.id), body.createPlaylist !== false)) });
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
    let renamed = 0;
    let playlistsRenamed = 0;
    while (true) {
      const result = await absFetch(`/api/libraries/${encodeURIComponent(libraryId)}/items?limit=100&page=${page}`);
      const items = result.results || [];
      for (const item of items) {
        try {
          const synced = await importOrSync(String(item.id));
          success += 1;
          added += Number(synced.added || 0);
          renamed += Number(synced.renamed || 0);
          playlistsRenamed += synced.playlistRenamed ? 1 : 0;
        } catch (error) {
          failed += 1;
          songloft.log.warn(`同步 ${item.id} 失败: ${String(error)}`);
        }
      }
      if (!items.length || (page + 1) * 100 >= Number(result.total || 0)) break;
      page += 1;
    }
    return jsonResponse({ ok: true, success, failed, added, renamed, playlistsRenamed });
  } catch (error) { return safeError(error); }
});

router.get('/api/miot/devices', async () => {
  try {
    const response = await callMiot('/mina/devices');
    return jsonResponse({ ok: true, accounts: response?.data || [] });
  } catch (error) { return safeError(error); }
});

router.post('/api/miot/play', async (req) => {
  try {
    return await hlsPlayback.exclusive(async () => {
    const body = JSON.parse(String(req.body || '{}'));
    const accountId = String(body.accountId || '');
    const deviceId = String(body.deviceId || '');
    const itemId = String(body.itemId || '');
    const fileIndex = Number(body.fileIndex ?? 0);
    if (!accountId || !deviceId) throw new Error('请选择智能音箱');
    if (!itemId) throw new Error('请先选择要播放的有声书');
    const config = await getConfig();
    const item = await absFetch(`/api/items/${encodeURIComponent(itemId)}?expanded=1&include=progress`);
    const files = item.media?.audioFiles || [];
    if (config.speakerHlsEnabled) {
      if (!files.length) throw new Error('这本书没有可播放音频');
      let requestedStart = 0, startLabel = '整本书开头';
      const chapters = chaptersOf(item);
      if (config.speakerHlsStartMode !== 'book') {
        const chapterIndex = Number(body.chapterIndex ?? -1);
        if (!Number.isInteger(fileIndex) || !files[fileIndex] || !Number.isInteger(chapterIndex) || chapterIndex < -1) throw new Error('请重新选择有效的播放目录');
        if (chapterIndex >= 0) {
          const chapter = chapters[chapterIndex];
          if (!chapter) throw new Error('所选章节不存在，请刷新目录');
          requestedStart = chapterStart(chapter);
          startLabel = String(chapter.title || chapter.name || `第 ${chapterIndex + 1} 章`);
        } else {
          for (let i = 0; i < fileIndex; i++) {
            const duration = Number(files[i].duration);
            if (!Number.isFinite(duration) || duration <= 0) throw new Error('音频时长不完整，无法定位起播位置');
            requestedStart += duration;
          }
          startLabel = audioFileName(files[fileIndex], fileIndex);
        }
        if (!Number.isFinite(requestedStart) || requestedStart < 0) throw new Error('章节起播位置无效');
      }
      const hostBase = requestedStart > 0 ? speakerPlaylistBase(config.speakerHlsHostUrl || await songloft.plugin.getHostUrl()) : '';
      const prepared = await hlsPlayback.prepare(config.serverUrl, accountId, deviceId, itemId, String(metadataOf(item).title || '有声书'), requestedStart, startLabel);
      const streamUrl = prepared.session.playlistKey
        ? `${hostBase}/api/v1/jsplugin/audiobookshelf/speaker-stream/${prepared.session.playlistKey}/index.m3u8` : prepared.url;
      try {
        await callMiot('/mina/play-url', {
          method: 'POST', body: JSON.stringify({ account_id: accountId, device_id: deviceId, url: streamUrl })
        });
      } catch (_) {
        try { await hlsPlayback.close(config.serverUrl); }
        catch (_) { throw new Error('连续流推送失败，且会话未清理，请点击“清理连续流会话”'); }
        throw new Error('MIoT 未确认连续流推送成功，会话已清理；未自动回退为单集播放');
      }
      await hlsPlayback.markSent(prepared.session);
      const actualStart = prepared.session.actualStart || 0;
      const located = locateGlobalTime(files, actualStart);
      const chapterIndex = chapters.findIndex((chapter, i) => actualStart >= chapterStart(chapter) && actualStart < chapterEnd(chapter, chapters[i + 1] ? chapterStart(chapters[i + 1]) : Infinity));
      const earlySeconds = Math.max(0, requestedStart - actualStart);
      return jsonResponse({ ok: true, mode: 'hls', startPosition: actualStart, requestedStart, startLabel, earlySeconds,
        history: { trackIndex: located.index, chapterIndex, trackTitle: audioFileName(located.file, located.index),
          chapterTitle: chapterIndex >= 0 ? String(chapters[chapterIndex].title || '') : '', positionSeconds: located.offset },
        warning: `连续流指令已发送：从“${startLabel}”连续播放到结尾${earlySeconds > 0 ? `（分片对齐，约提前 ${earlySeconds.toFixed(1)} 秒）` : ''}。请确认音箱实际起播位置及跨集播放。` });
    }
    const active = await hlsPlayback.current();
    if (active && active.accountId === accountId && active.deviceId === deviceId) await hlsPlayback.close(config.serverUrl);
    const file = files[fileIndex];
    if (!file) throw new Error('所选音频不存在，请重新选择目录');
    const url = audioFileUrl(config, itemId, file, fileIndex);
    const response = await callMiot('/mina/play-url', {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId, device_id: deviceId, url })
    });
    await songloft.persistentStorage.set(LAST_PLAY_KEY, { itemId, fileIndex, at: new Date().toISOString() });
    return jsonResponse({
      ok: true,
      mode: 'single',
      data: response?.data || null,
      warning: Number(body.startPosition || 0) > 0 ? '当前 MIoT URL 推送不支持文件内跳转，音箱将从该音频文件开头播放。' : ''
    });
    });
  } catch (error) { return safeError(error); }
});

router.post('/api/import/:id/remove', async (_req, params) => {
  try {
    const itemId = String(params.id || '');
    const records = await getSyncRecords();
    const record = records[itemId];
    if (!record) return jsonResponse({ ok: true, removedSongs: 0, removedPlaylist: false, alreadyClean: true, complete: true });
    let removedPlaylist = false;
    let playlistId = record.playlistId;
    if (playlistId) {
      const playlist = await songloft.playlists.getById(playlistId);
      if (!playlist) playlistId = undefined;
      else {
        try { await songloft.playlists.delete(playlistId); playlistId = undefined; removedPlaylist = true; }
        catch (_) {}
      }
    }
    let removedSongs = 0;
    let missingSongs = 0;
    const remainingSongIds: number[] = [];
    for (const id of [...new Set(record.songIds.map(Number).filter(Number.isInteger))]) {
      const song = await songloft.songs.getById(id);
      if (!song) { missingSongs += 1; continue; }
      try { await songloft.songs.delete(id); removedSongs += 1; }
      catch (_) { remainingSongIds.push(id); }
    }
    const failedSongs = remainingSongIds.length;
    const failedPlaylist = Boolean(playlistId);
    if (!failedSongs && !failedPlaylist) delete records[itemId];
    else records[itemId] = { ...record, songIds: remainingSongIds, playlistId };
    await songloft.persistentStorage.set(SYNC_KEY, records);
    return jsonResponse({ ok: true, removedSongs, missingSongs, removedPlaylist, failedSongs, failedPlaylist,
      complete: !failedSongs && !failedPlaylist });
  } catch (error) { return safeError(error); }
});

router.post('/api/miot/control', async (req) => {
  try {
    return await hlsPlayback.exclusive(async () => {
    const body = JSON.parse(String(req.body || '{}'));
    const accountId = String(body.accountId || '');
    const deviceId = String(body.deviceId || '');
    const action = String(body.action || '');
    if (!accountId || !deviceId) throw new Error('请选择智能音箱');
    if (!['pause', 'resume', 'stop'].includes(action)) throw new Error('不支持的音箱控制操作');
    const response = await callMiot(`/mina/${action}`, {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId, device_id: deviceId })
    });
    if (action === 'stop') {
      const active = await hlsPlayback.current();
      if (active?.accountId === accountId && active.deviceId === deviceId) await hlsPlayback.close((await getConfig()).serverUrl);
    }
    return jsonResponse({ ok: true, data: response?.data || null });
    });
  } catch (error) { return safeError(error); }
});

router.get('/api/miot/hls', async () => {
  const active = await hlsPlayback.current();
  return jsonResponse({ ok: true, session: active ? {
    title: active.title, phase: active.phase, createdAt: active.createdAt,
    accountId: active.accountId, deviceId: active.deviceId,
    startLabel: active.startLabel, requestedStart: active.requestedStart, actualStart: active.actualStart
  } : null });
});

router.post('/api/miot/hls/close', async () => {
  try {
    return await hlsPlayback.exclusive(async () => {
      await hlsPlayback.close((await getConfig()).serverUrl);
      return jsonResponse({ ok: true });
    });
  } catch (_) { return jsonResponse({ ok: false, error: '连续流会话清理失败，请检查连接后重试；必要时在 Audiobookshelf 中结束会话' }, 400); }
});

// Narrow anonymous capability route: no credentials, proxy parameters or media writes.
router.get('/speaker-stream/:key/index.m3u8', async (_req, params) => {
  try {
    const playlist = await hlsPlayback.publicPlaylist(String(params.key || ''));
    return { statusCode: playlist ? 200 : 404,
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
      body: playlist || '' };
  } catch (_) { return { statusCode: 503, body: '' }; }
});

router.get('/api/miot/status', async (req) => {
  try {
    const query = parseQuery(req.query || '');
    if (!query.accountId || !query.deviceId) throw new Error('请选择智能音箱');
    const response = await callMiot(`/mina/status?account_id=${encodeURIComponent(query.accountId)}&device_id=${encodeURIComponent(query.deviceId)}`);
    return jsonResponse({ ok: true, data: response?.data || null });
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
  songloft.log.info('Audiobookshelf plugin v0.9.2-beta.3 initialized');
  await registerToMiot();
}
async function onDeinit(): Promise<void> {
  try { await hlsPlayback.exclusive(async () => hlsPlayback.close((await getConfig(false)).serverUrl)); }
  catch (_) { songloft.log.warn('停用时连续流会话未清理，请重新启用后清理或在 Audiobookshelf 中结束会话'); }
  try {
    if (songloft.comm && typeof songloft.comm.call === 'function') {
      await songloft.comm.call('miot', 'unregister-search-provider', {});
    }
  } catch (_) {}
  songloft.log.info('Audiobookshelf plugin deinitialized');
}
async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  if (req.method.toUpperCase() === 'HEAD' && req.path.startsWith('/speaker-stream/')) {
    const response = await router.handle({ ...req, method: 'GET' });
    return { ...response, body: '' };
  }
  return router.handle(req);
}

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
