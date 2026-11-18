# B 站上传助手

片场的独立发布插件。在项目的「发布」页选择 B 站账号，插件会在片场内嵌的 B 站创作中心上传成片、填写标题与简介、添加标签并设置封面。检查分区、稿件类型和裁切效果后，在 B 站页面手动投稿。

## 使用

1. 在片场设置中安装插件，打开项目的「发布」页。
2. 点「登录新账号」，在 B 站页面完成扫码或登录。多个账号的会话各自独立。
3. 准备 `publish.md` 中的成片路径、标题、简介和封面。插件优先采用 `copy.platform_titles.bilibili`、`copy.platform_hashtags.bilibili` 和 `cover.images` 中标为 `bilibili` 的 16:10 PNG 或 JPEG。专属标签为空列表时保持空白。
4. 选择账号，点「上传并填写」。确认 B 站页面上的封面裁切、分区、类型和标签，再手动投稿。

「打开 B 站」会回到所选账号的窗口，可用来续登或检查当前投稿。项目状态 `ready_to_publish` 表示可以开始人工检查，投稿结果以 B 站为准。

## 开发验证

`npm ci` 后可运行 `npm run check`、`npm run test:coverage` 和 `npm run test:browser`。用已构建的片场源码运行 `node scripts/check-host.mjs <片场源码目录>` 与 `node scripts/check-desktop.mjs <片场源码目录>`。修改源码后需重建随插件交付的 `dist/plugin.cjs`。

投稿界面依据 B 站创作中心提供的视频投稿页。 [B 站创作中心](https://member.bilibili.com/platform/upload/video/frame)
