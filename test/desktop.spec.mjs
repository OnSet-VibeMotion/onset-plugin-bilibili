import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';

const host = process.env.ONSET_BILIBILI_HOST;
const { test, expect, openProject } = await import(pathToFileURL(path.join(host, 'apps/desktop/e2e/fixtures.mjs')).href);
const plugin = path.resolve(import.meta.dirname, '..');
const fixture = fs.readFileSync(new URL('./fixtures/creator.html', import.meta.url), 'utf8');
const account = '00000000-0000-4000-8000-000000000001';

test('从片场发布页打开 B 站，完成上传与填表并保留人工投稿', async ({ electronApp, page, project, sandbox }) => {
  const id = 'bilibili-upload';
  await page.locator('#settings-trigger').click();
  const stations = page.locator('#settings-dialog section.stations[aria-label="我的插件"]');
  await stations.getByLabel('插件来源').fill('link:' + plugin);
  await stations.getByRole('button', { name: '添加' }).click();
  const preview = stations.getByRole('alertdialog', { name: '确认添加插件' });
  await expect(preview).toContainText('B 站上传助手');
  await preview.getByRole('button', { name: '装上' }).click();
  await expect(stations.locator('li[data-station="bilibili-upload"]')).toBeVisible();
  await page.locator('#settings-dialog').getByRole('button', { name: '关闭' }).click();

  const dir = path.join(sandbox.stations, id, 'data', 'accounts', account);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ id: account, name: '测试工作号', user_id: '1234', created_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(project.path, 'final.mp4'), 'fixture-video');
  fs.writeFileSync(path.join(project.path, 'cover.png'), 'fixture-cover');
  fs.writeFileSync(path.join(project.path, 'publish.md'), `---
${stringify({
  platform: 'bilibili',
  video: { path: 'final.mp4' },
  copy: { primary_title: '片场内自动填写', introduction: '检查稿件后再投稿', hashtags: ['开源'] },
  cover: { images: [{ platform: 'bilibili', ratio: '16:10', path: 'cover.png' }] },
})}---
`);
  await electronApp.evaluate(({ session }, { sessionDir, html }) => {
    session.fromPath(sessionDir).protocol.handle('https', request => {
      const url = new URL(request.url);
      if (url.hostname === 'api.bilibili.com' && url.pathname === '/x/web-interface/nav') {
        return Response.json({ code: 0, data: { isLogin: true, mid: 1234, uname: '测试工作号' } }, { headers: {
          'access-control-allow-origin': 'https://member.bilibili.com', 'access-control-allow-credentials': 'true',
        } });
      }
      // 稿件列表：这个账号还没投过稿。
      if (url.hostname === 'member.bilibili.com' && url.pathname === '/x/web/archives') return Response.json({ code: 0, data: { arc_audits: [], page: { pn: 1, ps: 30, count: 0 } } });
      if (url.hostname === 'member.bilibili.com') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      return new Response('', { status: 404 });
    });
  }, { sessionDir: path.join(sandbox.userData, 'station-sessions', id, account), html: fixture });

  await openProject(page, project);
  await page.locator('[data-tab="publish"]').click();
  const card = page.frameLocator('.station-slots[data-slot="publish"] .station-frame');
  await expect(card.getByLabel('发布到哪个账号')).toHaveValue(account);
  const confirmation = page.locator('.station-confirm');
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown')));
    await card.getByRole('button', { name: '上传并填写' }).click();
    await expect(confirmation).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
  await confirmation.getByRole('button', { name: '执行', exact: true }).click();

  await expect.poll(() => {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(project.path, 'production/bilibili/state.json'), 'utf8'));
      return { status: state.status, warnings: state.warnings, message: state.status === 'error' ? state.message : undefined };
    } catch { return {}; }
  }, { timeout: 25_000 }).toEqual({ status: 'ready_to_publish', warnings: [], message: undefined });

  expect(await electronApp.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find(w => w.getURL() === 'https://member.bilibili.com/york/videoup');
    return wc.executeJavaScript(`({
      title: document.querySelector('.content-title-v2-input-wrp input').value,
      desc: document.querySelector('.ql-editor').innerText,
      tag: document.querySelector('.content-tag-v2-pre-wrp').innerText,
      cover: window.cover, video: window.video, submits: window.submits
    })`);
  })).toEqual({ title: '片场内自动填写', desc: '检查稿件后再投稿', tag: '开源', cover: 'cover.png', video: 'final.mp4', submits: 0 });
});
