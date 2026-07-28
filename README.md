# Songloft Audiobookshelf Plugin

将 Audiobookshelf 有声书接入 Songloft。主模式通过 MIoT 外部搜索直接播放，不向 Songloft 曲库写入歌曲；原有导入和增量同步保留为兼容模式。

## v0.3.0 测试版

- 自动通过 `songloft.comm` 注册为 MIoT 外部搜索源
- 实现 `POST /api/search/topone`
- 支持按书名、作者、系列及“第 N 章/集/回”等关键词搜索
- “继续/接着/上次/续播”会依据 Audiobookshelf 进度选择当前音频文件
- 返回智能音箱可直接访问的 Audiobookshelf 局域网音频 URL
- MIoT 开启“不入库直接播放”后，不创建 Songloft 歌曲或歌单
- 保留 v0.2.0 的浏览、导入去重与增量同步功能
- 默认服务器地址：`http://192.168.1.1:13378`

## 安装与设置

1. 在 Audiobookshelf“设置 → API 密钥”中创建密钥，代理平时收听的普通用户。
2. 安装并启用本插件，填写局域网地址、API 密钥并选择有声书书库。
3. 安装支持搜索源注册的新版 MIoT 插件。
4. 在 MIoT“外部搜索”中选择“Audiobookshelf 有声书”。
5. 开启外部搜索和“不入库直接播放”。
6. 先用书名测试，再测试“继续播放 + 书名”和“书名 + 第 N 章”。

> Songloft 服务端和智能音箱都必须能够访问 Audiobookshelf 的局域网地址。

## 当前边界

- Songloft 插件 HTTP 接口会将响应完整缓存在内存后返回，不能安全承载数小时音频的流式代理。因此 v0.3.0 使用 Audiobookshelf 支持的 `token` 查询参数生成直链；密钥不会写入 Songloft 曲库，但会存在于推送给局域网音箱的临时播放 URL 中。请仅在可信局域网使用，并为插件配置普通用户、最小权限的独立 API 密钥。
- “继续播放”目前能定位到包含上次进度的音频文件，但 MIoT 尚不能把文件内起始秒数传给音箱，因此会从该文件开头播放。
- 单个 M4B 的内嵌章节定点播放仍依赖 MIoT/音箱支持起始时间。

## 兼容导入模式

仍支持一本书对应一个 Songloft 歌单、重复导入去重、单本检查更新及整个书库增量同步。

## 开发

```bash
npm install
npm run build
npm run validate
```
