# Songloft Audiobookshelf Plugin

将 Audiobookshelf 有声书书库连接到 Songloft，使书库内容可通过 Songloft 及智能音响插件播放。

## 0.1.0 测试版

- Audiobookshelf API 密钥认证（兼容代理用户）
- 连接测试与有声书书库选择
- 浏览书籍、作者、封面和时长
- 一本书导入为一个 Songloft 歌单
- 每个 Audiobookshelf 音频文件导入为一首远程歌曲
- 播放时由 Songloft 动态解析音频 URL 并附加认证请求头，不把 API 密钥写入歌曲播放地址
- 按 `libraryItemId + inode` 去重导入

## 安装

1. 在 Audiobookshelf 的“设置 → API 密钥”中创建密钥，代理你平时收听的普通用户。
2. 下载 `dist/audiobookshelf.jsplugin.zip`。
3. 在 Songloft V2.11.0 的插件管理页面上传并启用。
4. 打开插件，填写局域网地址（例如 `http://10.10.10.20:13378`）和 API 密钥。
5. 保存并测试连接，选择书库后加载、导入有声书。

> Songloft 服务端必须能访问填写的 Audiobookshelf 局域网地址。智能音响通过 Songloft 的统一播放入口取流，不需要直接保存 API 密钥。

## 当前限制

- 首版按“音频文件”导入；单个 M4B 内部章节会显示在 API 数据中，但暂不能拆成独立可跳转歌曲。
- 尚未将 Songloft 播放进度回传到 Audiobookshelf。
- API 密钥变化后，需要重新导入歌曲以更新播放 URL。

## 开发

```bash
npm install
npm run validate
npm run build
```

构建产物位于 `dist/audiobookshelf.jsplugin.zip`。
