# Songloft Audiobookshelf Plugin

将自建 Audiobookshelf 有声书库接入 Songloft，并通过 MIoT 插件的外部搜索功能直接推送到小米智能音箱播放。

插件默认采用“不入库直接播放”模式：无需把有声书导入 Songloft，也不会在歌曲和歌单中产生大量重复条目。原有的导入、去重和增量同步功能仍作为兼容模式保留。

## 下载

当前版本：**v0.6.0**

[下载 Audiobookshelf 插件 v0.6.0](https://github.com/NeoHeee/songloft-plugin-audiobookshelf/releases/download/v0.6.0/audiobookshelf.jsplugin.zip)

> 本插件需配合支持外部搜索源的新版 [Songloft MIoT 插件](https://github.com/songloft-org/songloft-plugin-miot) 使用。

## 插件源订阅

在 Songloft 中进入「设置 → JS 插件管理 → 插件商店 → 管理订阅源」，添加以下地址：

```text
https://raw.githubusercontent.com/NeoHeee/songloft-plugin-audiobookshelf/main/registry.json
```

当前插件源包含：

- Audiobookshelf 书库
- 洛雪音源（LXMusic）

添加后即可在插件商店中查看、安装和更新，无需手动下载插件包。

## 主要功能

### 外部搜索直接播放

- 自动注册为 MIoT 外部搜索源
- 不导入 Songloft，搜索后直接推送音频地址至智能音箱
- 支持书名、作者、演播者、副标题和系列名综合匹配
- 支持同名书籍排序，优先选择正在收听的版本
- 提供外部搜索测试工具和最近 50 条搜索日志

### 有声书语音搜索

支持以下类型的搜索表达：

- 书名：`播放 明朝那些事儿`
- 继续收听：`继续播放 明朝那些事儿`
- 指定章节：`播放 明朝那些事儿 第五章`
- 系列册数：`播放 鬼吹灯 第二部`
- 上下集：`播放下一集`、`播放上一集`
- 分类点播：`播放最近添加的有声书`、`继续收听`、`播放我的收藏`

插件兼容中文数字、阿拉伯数字和零填充编号，例如“第五集”“第 5 集”“05”“005”。

### 续播与章节定位

- 读取 Audiobookshelf 的收听进度
- 多文件有声书可定位到当前收听的音频文件
- 当前文件听完后自动选择下一集
- 支持 M4B 内嵌章节识别
- 支持按“第 N 章”或章节名称搜索
- 可计算章节和续播位置在文件内的准确秒数
- 提供“优先继续收听”和“默认从头播放”两种点播策略

### Songloft 兼容导入

如需在 Songloft 内浏览或使用歌单，仍可启用兼容导入模式：

- 一本书对应一个 Songloft 歌单
- 重复导入自动去重
- 单本有声书检查更新
- 整个书库增量同步
- 新增音频自动补入原歌单

## 安装与配置

1. 在 Audiobookshelf 的“设置 → API 密钥”中创建密钥。建议使用普通用户，并仅授予必要权限。
2. 下载并安装本插件，在 Songloft 中启用。
3. 填写 Audiobookshelf 地址和 API 密钥，然后选择有声书书库。
4. 选择默认点播策略：“优先继续收听”或“默认从头播放”。
5. 安装并启用新版 Songloft MIoT 插件。
6. 在 MIoT 插件的“外部搜索”中选择“Audiobookshelf 有声书”。
7. 开启“外部搜索”和“不入库直接播放”。

默认 Audiobookshelf 地址：

```text
http://192.168.1.1:13378
```

请根据自己的服务器地址进行修改。

## 网络要求

- Songloft 服务端必须能够访问 Audiobookshelf。
- 小米智能音箱也必须能够直接访问 Audiobookshelf 返回的局域网音频地址。
- 请勿填写 `127.0.0.1` 或仅服务器自身可访问的地址。
- 建议在可信局域网内使用。

## 安全说明

受 Songloft V2.11.0 插件 HTTP 接口限制，插件暂时无法对数小时音频进行低内存、边下载边播放的流式代理，因此当前版本使用 Audiobookshelf Token 直链供音箱播放。

建议：

- 为本插件单独创建 Audiobookshelf 普通用户
- 使用最小权限的独立 API 密钥
- 仅在可信局域网中使用
- 不要公开分享播放链接、配置截图或搜索日志中的完整地址

## 已知限制

- 插件可以准确识别 M4B 章节和续播秒数，并返回 `start_position`，但 MIoT/智能音箱当前没有开放起始秒数控制，因此单文件 M4B 仍可能从文件开头播放。
- 多文件有声书可以准确续播到当前音频文件，但文件内部仍可能从头开始。
- “下一集/上一集”依赖插件最近一次直接播放记录；重装插件或清除配置后，需要先正常点播一本书。
- “我的收藏”依赖 Audiobookshelf 返回收藏标记；部分服务器版本未提供该字段时可能没有匹配结果。
- Songloft V2.11.0 尚未向 JS 插件开放播放位置、暂停和结束事件，因此插件暂时无法将智能音箱的实时播放进度自动回传至 Audiobookshelf。

## 版本说明

### v0.6.0

- 新增 M4B 内嵌章节识别与章节搜索
- 新增系列册数、下一集、上一集匹配
- 新增最近添加、正在收听和收藏内容点播
- 新增语音搜索别名与综合排序
- 新增默认续播策略
- 保留 MIoT 不入库直接播放与 Songloft 兼容导入模式

## 开发与验证

```bash
npm install
npm run build
npm run validate
```

## 相关项目

- [Songloft](https://github.com/songloft-org/songloft)
- [Songloft MIoT 插件](https://github.com/songloft-org/songloft-plugin-miot)
- [Audiobookshelf](https://github.com/advplyr/audiobookshelf)

## 说明

本项目为社区插件，与 Audiobookshelf、Songloft 及小米官方无隶属关系。
