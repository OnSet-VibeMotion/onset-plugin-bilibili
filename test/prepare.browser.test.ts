import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openBrowser, findBrowser } from './support/browser';
import { CDP, Page } from '../src/cdp';
import { preparePage } from '../src/prepare';
import * as scripts from '../src/page-scripts';

let root: string, origin: string, server: http.Server;
const browsers: Awaited<ReturnType<typeof openBrowser>>[] = [];
const fixture = fs.readFileSync(new URL('./fixtures/creator.html', import.meta.url), 'utf8');
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-bilibili-browser-'));
  server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fixture);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
});
afterAll(async () => {
  const ownedProcesses = new Set<number>();
  for (const browser of browsers) {
    try {
      const info = await browser.send('SystemInfo.getProcessInfo');
      for (const processInfo of info.processInfo) ownedProcesses.add(processInfo.id);
      await browser.send('Browser.close');
    } catch {} finally { browser.disconnect(); }
  }
  await new Promise<void>(r => server.close(() => r()));
  // Browser.close acknowledges the request before Chromium and its children have
  // exited. Only these test-owned PIDs may be stopped; never touch normal Chrome.
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 5000;
  while ([...ownedProcesses].some(alive) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  for (const pid of ownedProcesses) if (alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  await new Promise(r => setTimeout(r, 300));
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
async function pageFor(name: string) {
  const profile = path.join(root, name); fs.mkdirSync(profile, { recursive: true });
  const browser = await openBrowser(profile, { headless: true }); browsers.push(browser);
  const page = await Page.create(browser, origin); await page.navigate(origin + '/video/upload.html');
  await page.waitFor(() => document.querySelector('#bili-upload-btn input') !== null, 5000, '测试上传页未加载');
  return { page, browser, profile };
}
function media() {
  const video = path.join(root, 'video.mp4'), cover = path.join(root, 'cover.png');
  for (const file of [video, cover]) fs.writeFileSync(file, 'fixture');
  return { title: '发布标题', content: '视频简介', tags: ['科技', '开源'], video, videoHash: 'hash', covers: { '16:10': cover } };
}

it('上传视频、填写标题简介标签并应用封面，等待人工投稿', async () => {
  const { page } = await pageFor('upload');
  await expect(preparePage(page, media(), () => {}, { timeout: 4000 })).resolves.toEqual([]);
  expect(await page.evaluate(() => ({
    title: document.querySelector<HTMLInputElement>('.content-title-v2-input-wrp input')?.value,
    desc: document.querySelector<HTMLElement>('.ql-editor')?.innerText,
    tags: [...document.querySelectorAll('.content-tag-v2-pre-wrp span')].map(el => el.textContent),
    video: (window as any).video, cover: (window as any).cover, submits: (window as any).submits,
  }))).toEqual({ title: '发布标题', desc: '视频简介', tags: ['科技', '开源'], video: 'video.mp4', cover: 'cover.png', submits: 0 });
  await expect(page.click('#submit')).rejects.toThrow('不允许');
});
it('视频上传失败时保留页面，停止填表', async () => {
  const { page } = await pageFor('failed');
  await page.evaluate(() => { (window as any).failVideo = true; });
  await expect(preparePage(page, media(), () => {}, { timeout: 3500 })).rejects.toThrow('上传失败');
  expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('.content-title-v2-input-wrp input')?.value)).toBe('');
});
it('只保存已登录用户的精确 UID、昵称和 B 站头像', async () => {
  const { page } = await pageFor('profile');
  await page.evaluate(() => {
    window.fetch = async (url, options) => {
      if (url !== 'https://api.bilibili.com/x/web-interface/nav' || options?.credentials !== 'include') throw Error('profile request');
      return new Response('{"code":0,"data":{"isLogin":true,"mid":12345678901234567890,"uname":"创作者","face":"//i0.hdslb.com/face.jpg"}}');
    };
  });
  expect(await page.evaluate(scripts.loginInfo)).toEqual({ user_id: '12345678901234567890', name: '创作者', avatar: 'https://i0.hdslb.com/face.jpg' });
  await page.evaluate(() => { window.fetch = async () => Response.json({ code: -101, data: { isLogin: false } }); });
  expect(await page.evaluate(scripts.loginInfo)).toBeNull();
});
