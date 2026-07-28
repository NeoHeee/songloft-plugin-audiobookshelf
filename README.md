# Songloft Audiobookshelf Plugin

将 Audiobookshelf 有声书书库连接到 Songloft，使书库内容可通过 Songloft 及智能音响插件播放。

## v0.2.0 测试版

- 默认服务器地址调整为 `http://192.168.1.1:13378`
- Audiobookshelf API 密钥认证与连接测试
- 浏览有声书、作者、封面、总时长及当前收听进度
- 一本书对应一个 Songloft 歌单
- 使用稳定去重键复用已导入歌曲，重复同步不再重复添加
- 保存 Audiobookshelf 条目、Songloft 歌单和歌曲的同步关系
- 支持单本检查更新及整个书库增量同步
- 新增音频文件自动补入原歌单
- 播放时动态读取当前 API 密钥并附加认证请求头

## 安装与测试

1. 在 Audiobookshelf 的“设置 → API 密钥”中创建密钥，代理平时收听的普通用户。
2. 下载 `dist/audiobookshelf.jsplugin.zip`。
3. 在 Songloft V2.11.0 插件管理页面上传并启用。
4. 打开插件，确认局域网地址并填写 API 密钥。
5. 点击“保存并测试”，选择书库后加载内容。
6. 先选择一本书导入并测试 Songloft 播放，再测试“增量同步全部”和智能音响调用。

> Songloft 服务端必须能够访问所填写的 Audiobookshelf 局域网地址。

## 当前能力边界

- Songloft V2.11.0 未向 JS 插件提供播放位置、暂停或结束事件，因此本版只能读取并展示 Audiobookshelf 已有进度，暂不能把 Songloft 播放进度自动回传。
- 单个 M4B 的章节定点播放需要宿主支持起始时间或可控转码区间；本版仍按音频文件导入。
- 智能音响精确续播依赖宿主向插件传递播放位置并支持带起点播放，待 Songloft 接口具备后接入。

## 开发

```bash
npm install
npm run build
```

构建产物位于 `dist/audiobookshelf.jsplugin.zip`。成品包解压后可运行 `songloft-plugin validate` 校验。
