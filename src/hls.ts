// Experimental ABS HLS transport. No Songloft songs, playlists or progress writes.
export type HlsSession = {
  id: string; serverUrl: string; accountId: string; deviceId: string;
  itemId: string; title: string; createdAt: number; duration: number;
  phase: 'preparing' | 'ready' | 'sent';
  requestedStart?: number; actualStart?: number; startLabel?: string;
  playlistKey?: string; playlist?: string;
};
type Dependencies = {
  read: () => Promise<HlsSession | null>;
  write: (value: HlsSession | null) => Promise<void>;
  request: (path: string, init?: any) => Promise<any>;
  fetch: typeof fetch;
  now: () => number;
  delay: (ms: number) => Promise<void>;
  createKey: () => string;
};

type StreamAddress = { href: string };

export function streamLocation(serverUrl: string, id: string, contentUrl: string): StreamAddress {
  if (!/^[\w-]{1,128}$/.test(id)) throw new Error('连续流会话标识无效');
  // QuickJS hosts need not provide the browser URL constructor. Only accept the
  // exact ABS path here, rather than resolving arbitrary URLs with a partial polyfill.
  const base = serverUrl.replace(/\/+$/, '');
  if (!/^https?:\/\/[a-z0-9.\-\[\]:]+(?:\/[^?#\\\s]*)?$/i.test(base) || /%(?:2f|5c|2e)/i.test(base)) {
    throw new Error('连续流服务器地址无效');
  }
  // ABS returns /hls/... even when hosted under a reverse-proxy subpath.
  const suffix = `/hls/${id}/output.m3u8`;
  const expected = base + suffix;
  if (![suffix, suffix.slice(1), expected].includes(contentUrl)) {
    throw new Error('服务器未返回预期的 ABS HLS 地址，已取消推送');
  }
  return { href: expected };
}

export function cutPlaylist(manifest: string, playlistUrl: StreamAddress, requestedStart = 0) {
  if (!Number.isFinite(requestedStart) || requestedStart < 0) throw new Error('连续流起播时间无效');
  if (manifest.length > 2_000_000 || !manifest.trimStart().startsWith('#EXTM3U')) throw new Error('连续流清单无效');
  const lines = manifest.split(/\r?\n/).map(line => line.trim());
  if (lines.some(line => /^#EXT-X-(KEY|MAP|STREAM-INF):/.test(line))) throw new Error('此版本仅支持 ABS MPEG-TS 音频清单');
  const paths = lines.filter(line => line && !line.startsWith('#'));
  if (!paths.length || paths.some((p, i) => p !== `output-${i}.ts`)) throw new Error('连续流分片格式不受支持，已取消推送');
  if (lines.some(line => line.startsWith('#EXT-X-MEDIA-SEQUENCE:') && line !== '#EXT-X-MEDIA-SEQUENCE:0') ||
      !lines.includes('#EXT-X-ENDLIST')) throw new Error('连续流必须是完整的 ABS 点播清单');
  const durations: number[] = [];
  let pending: number | null = null;
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      if (pending !== null) throw new Error('连续流分片时长无效');
      pending = Number(line.slice(8).split(',')[0]);
      if (!Number.isFinite(pending) || pending <= 0 || pending > 60) throw new Error('连续流分片时长无效');
    } else if (line && !line.startsWith('#')) {
      if (pending === null) throw new Error('连续流缺少分片时长');
      durations.push(pending); pending = null;
    } else if (/^#EXT-X-(DISCONTINUITY|BYTERANGE|GAP)/.test(line)) {
      throw new Error('连续流分片格式不受支持');
    }
  }
  if (pending !== null || durations.length !== paths.length) throw new Error('连续流分片时长无效');
  const total = durations.reduce((sum, value) => sum + value, 0);
  if (requestedStart >= total) throw new Error('连续流起播位置已超出书籍结尾');
  let index = 0, actualStart = 0;
  while (index < durations.length - 1 && actualStart + durations[index] <= requestedStart) {
    actualStart += durations[index++];
  }
  const prefix = playlistUrl.href.slice(0, playlistUrl.href.lastIndexOf('/') + 1);
  const selected = paths.slice(index);
  const output = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(durations.reduce((max, value) => Math.max(max, value), 0))}`,
    `#EXT-X-MEDIA-SEQUENCE:${index}`, '#EXT-X-PLAYLIST-TYPE:VOD'];
  selected.forEach((p, offset) => output.push(`#EXTINF:${durations[index + offset]},`, prefix + p));
  output.push('#EXT-X-ENDLIST');
  return { playlist: output.join('\n') + '\n', actualStart, requestedStart,
    segments: selected.slice(0, 2).map(p => ({ href: prefix + p })) };
}

export function firstSegments(manifest: string, playlistUrl: StreamAddress): StreamAddress[] {
  return cutPlaylist(manifest, playlistUrl).segments;
}

export function speakerPlaylistBase(value: string): string {
  const base = String(value || '').trim().replace(/\/+$/, '');
  const match = /^https?:\/\/([a-z0-9.\-\[\]:]+)(?:\/[^?#\\\s]*)?$/i.exec(base);
  if (!match || /@|%(?:2f|5c|2e)|\/\.\.(?:\/|$)/i.test(base)) throw new Error('请填写音箱可访问的 Songloft 地址（不含账号、令牌或查询参数）');
  const host = match[1].replace(/:\d+$/, '').toLowerCase();
  if (/^(?:localhost(?:\.|$)|127\.|0\.0\.0\.0$|\[::(?:1)?\]$)/.test(host)) {
    throw new Error('Songloft 地址不能是回环地址，请在设置中填写音箱可访问的局域网地址');
  }
  return base;
}

export class HlsPlayback {
  private busy = false;
  constructor(private deps: Dependencies) {}

  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('音箱操作正在进行，请稍后再试');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }

  async current() { return this.deps.read(); }

  async publicPlaylist(key: string): Promise<string | null> {
    if (!/^[a-f0-9]{48}$/.test(key)) return null;
    const session = await this.current();
    if (!session || session.playlistKey !== key || session.phase === 'preparing' ||
        this.deps.now() - session.createdAt >= 36 * 3600 * 1000) return null;
    return session.playlist || null;
  }

  async close(serverUrl: string): Promise<void> {
    const session = await this.current();
    if (!session) return;
    if (session.serverUrl !== serverUrl) throw new Error('请恢复原 Audiobookshelf 服务器设置后清理连续流会话');
    await this.deps.request(`/api/session/${encodeURIComponent(session.id)}/close`, {
      method: 'POST', body: '{}', allowNotFound: true
    });
    await this.deps.write(null);
  }

  async prepare(serverUrl: string, accountId: string, deviceId: string, itemId: string, title: string, requestedStart = 0, startLabel = '整本书开头') {
    const old = await this.current();
    if (old && (old.accountId !== accountId || old.deviceId !== deviceId)) {
      throw new Error('实验版同一时间仅支持一个连续流，请先停止或清理上一台音箱的会话');
    }
    await this.close(serverUrl);
    const response = await this.deps.request(`/api/items/${encodeURIComponent(itemId)}/play`, {
      method: 'POST', body: JSON.stringify({
        forceTranscode: true, forceDirectPlay: false, supportedMimeTypes: [],
        mediaPlayer: 'abs-speaker-hls-experimental',
        deviceInfo: { deviceId: `songloft-abs-hls:${accountId}:${deviceId}`, clientName: 'ABS Speaker HLS', clientVersion: '0.9.2-beta.3' }
      })
    });
    const id = String(response?.id || '');
    if (!/^[\w-]{1,128}$/.test(id)) throw new Error('Audiobookshelf 未返回有效会话，请在服务器中检查转码任务');
    const session: HlsSession = {
      id, serverUrl, accountId, deviceId, itemId, title, createdAt: this.deps.now(),
      duration: Number(response.duration) || 0, phase: 'preparing'
    };
    try {
      await this.deps.write(session);
      if (Number(response.playMethod) !== 2 || response.audioTracks?.length !== 1) throw new Error('Audiobookshelf 未启用连续流转码');
      const url = streamLocation(serverUrl, id, String(response.audioTracks[0].contentUrl || ''));
      const playlist = await this.deps.fetch(url.href, {
        headers: { 'X-Fetch-Timeout-Ms': '5000' }, redirect: 'error'
      });
      if (!playlist.ok) throw new Error(`连续流清单无法直接访问（HTTP ${playlist.status}），请检查反向代理或认证设置`);
      const cut = cutPlaylist(await playlist.text(), url, requestedStart);
      const segments = cut.segments;
      // Probe the selected segment: ABS resets conversion around it if necessary.
      // Never modify saved listening progress to force a different start position.
      const deadline = this.deps.now() + 20000;
      for (const segment of segments) {
        let ready = false;
        while (this.deps.now() < deadline) {
          const result = await this.deps.fetch(segment.href, {
            headers: { Range: 'bytes=0-1023', 'X-Fetch-Timeout-Ms': '3000' }, redirect: 'error'
          });
          if ((result.status === 200 || result.status === 206) && !String(result.headers.get('content-type') || '').includes('text/html')) {
            const bytes = new Uint8Array(await result.arrayBuffer());
            if (bytes.length >= 188 && bytes[0] === 0x47) { ready = true; break; }
            throw new Error('连续流分片不是有效 MPEG-TS 音频');
          }
          if (result.status !== 404 && result.status !== 503) throw new Error(`连续流分片无法直接访问（HTTP ${result.status}）`);
          await this.deps.delay(700);
        }
        if (!ready) throw new Error('等待连续流分片超时，请检查 NAS 转码能力后重试');
      }
      session.phase = 'ready';
      session.requestedStart = requestedStart;
      session.actualStart = cut.actualStart;
      session.startLabel = startLabel;
      if (cut.actualStart > 0) {
        session.playlistKey = this.deps.createKey();
        if (!/^[a-f0-9]{48}$/.test(session.playlistKey)) throw new Error('连续流安全链接生成失败');
        session.playlist = cut.playlist;
      }
      await this.deps.write(session);
      return { session, url: url.href };
    } catch (error) {
      try {
        // Close even if recording the session initially failed.
        await this.deps.request(`/api/session/${encodeURIComponent(id)}/close`, { method: 'POST', body: '{}', allowNotFound: true });
        await this.deps.write(null);
      } catch (_) {
        throw new Error('连续流准备失败，且会话未能清理；请点击“清理连续流会话”或在 Audiobookshelf 中结束会话');
      }
      // Never surface fetch exceptions containing session URLs to the UI or logs.
      const message = String((error as Error)?.message || '');
      throw new Error(/^(Audiobookshelf|连续流|服务器|此版本|等待连续流)/.test(message) ? message : '连续流准备失败，请检查服务器网络和转码日志');
    }
  }

  async markSent(session: HlsSession) { await this.deps.write({ ...session, phase: 'sent' }); }
}
