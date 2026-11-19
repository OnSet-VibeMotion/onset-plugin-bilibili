import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openBrowser, findBrowser } from './support/browser';
import { CDP, Page } from '../src/cdp';
import { AlreadyPublished, canResume, preparePage } from '../src/prepare';
import * as scripts from '../src/page-scripts';

let root: string, origin: string, server: http.Server;
const browsers: Awaited<ReturnType<typeof openBrowser>>[] = [];
const fixture = fs.readFileSync(new URL('./fixtures/creator.html', import.meta.url), 'utf8');
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-bilibili-browser-'));
  server = http.createServer((req, res) => {
    // 稿件列表接口：默认这个账号还没投过任何稿件。
    if (req.url?.startsWith('/x/web/archives')) { res.setHeader('Content-Type', 'application/json'); res.end('{"code":0,"data":{"arc_audits":[],"page":{"pn":1,"ps":30,"count":0}}}'); return; }
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
  const page = await Page.create(browser, origin); await page.navigate(origin + '/york/videoup');
  await page.waitFor(() => document.querySelector('.bcc-upload-wrapper input') !== null, 5000, '测试上传页未加载');
  return { page, browser, profile };
}
function media() {
  const video = path.join(root, 'video.mp4'), cover = path.join(root, 'cover.png');
  for (const file of [video, cover]) fs.writeFileSync(file, 'fixture');
  const stat = fs.statSync(video);
  return { title: '发布标题', content: '视频简介', tags: ['科技', '开源'], video, videoHash: 'hash', covers: { '16:10': cover },
    videoSize: stat.size, videoModified: Math.floor(stat.mtimeMs), videoDuration: 180_000 };
}

it('上传视频、填写标题简介标签并应用封面，等待人工投稿', async () => {
  const { page } = await pageFor('upload');
  await expect(preparePage(page, media(), () => {}, { timeout: 4000 })).resolves.toEqual([]);
  expect(await page.evaluate(() => ({
    title: document.querySelector<HTMLInputElement>('.video-title input')?.value,
    desc: document.querySelector<HTMLElement>('.ql-editor')?.innerText,
    tags: [...document.querySelectorAll('#tag-container .label-item-v2-content')].map(el => el.textContent),
    video: (window as any).video, cover: (window as any).cover, submits: (window as any).submits,
  }))).toEqual({ title: '发布标题', desc: '视频简介', tags: ['科技', '开源'], video: 'video.mp4', cover: 'cover.png', submits: 0 });
  await expect(page.click('#submit')).rejects.toThrow('不允许');
});
it('视频上传失败时保留页面，停止填表', async () => {
  const { page } = await pageFor('failed');
  await page.evaluate(() => { (window as any).failVideo = true; });
  await expect(preparePage(page, media(), () => {}, { timeout: 3500 })).rejects.toThrow('上传失败');
  expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('.video-title input')?.value)).toBe('');
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

const title = () => document.querySelector<HTMLInputElement>('.video-title input')?.value;
/** 选好视频后切到编辑区，状态文字交给测试控制（window.showEditor）。 */
async function installEditor(page: Page) {
  await page.evaluate(() => {
    (window as any).showEditor = (text: string) => {
      document.querySelector<HTMLElement>('.upload-v2-step1-container')!.hidden = true;
      document.querySelector<HTMLElement>('.upload-v2-step2-container')!.hidden = false;
      document.querySelector('#status')!.textContent = text;
    };
  });
}

it('大视频上传超过单步时限也一直等，进度在走就传完接着填写', async () => {
  const { page } = await pageFor('slow-upload');
  await page.evaluate(() => {
    const video = document.querySelector<HTMLInputElement>('.bcc-upload-wrapper input')!;
    video.onchange = () => {
      (window as any).video = video.files![0].name;
      document.querySelector<HTMLElement>('.upload-v2-step1-container')!.hidden = true;
      document.querySelector<HTMLElement>('.upload-v2-step2-container')!.hidden = false;
      const status = document.querySelector<HTMLElement>('#status')!;
      let percent = 0;
      status.textContent = '上传中 0%';
      const timer = setInterval(() => {
        percent += 10;
        if (percent < 100) { status.textContent = `上传中 ${percent}%`; return; }
        clearInterval(timer);
        status.textContent = '上传完成';
      }, 150);
    };
  });
  const messages: string[] = [];
  const uploads: number[] = [];
  const started = Date.now();
  await expect(preparePage(page, media(), (_f, message) => messages.push(message),
    { timeout: 600, onUpload: () => uploads.push(Date.now()) })).resolves.toEqual([]);
  expect(Date.now() - started).toBeGreaterThan(1000);
  expect(uploads).toHaveLength(1);
  expect(messages).toEqual(expect.arrayContaining([expect.stringMatching(/^正在上传视频 \d+%/), '正在填写标题、简介和标签']));
  expect(await page.evaluate(title)).toBe('发布标题');
});

it('窗口开着时上传卡住也不设时限，等 B 站传完照样接着填写', async () => {
  const { page } = await pageFor('stalled-upload');
  await installEditor(page);
  await page.evaluate(() => {
    document.querySelector<HTMLInputElement>('.bcc-upload-wrapper input')!.onchange = () => {
      (window as any).showEditor('上传中 40%');
      setTimeout(() => { document.querySelector('#status')!.textContent = '上传完成'; }, 2500);
    };
  });
  await expect(preparePage(page, media(), () => {}, { timeout: 1000 })).resolves.toEqual([]);
  expect(await page.evaluate(title)).toBe('发布标题');
});

it('页面离开创作中心时停止等待', async () => {
  const { page } = await pageFor('left-page');
  await installEditor(page);
  await page.evaluate(() => {
    document.querySelector<HTMLInputElement>('.bcc-upload-wrapper input')!.onchange = () => {
      (window as any).showEditor('上传中 40%');
      setTimeout(() => { location.href = 'about:blank'; }, 300);
    };
  });
  await expect(preparePage(page, media(), () => {}, { timeout: 500 })).rejects.toThrow('页面已离开');
});

it('窗口停在编辑区时接着上次的上传填写，不再上传一次视频', async () => {
  const { page } = await pageFor('resume');
  expect(await canResume(page)).toBe(false);
  // 上次的操作在等上传时中断了：编辑区开着，视频还在传。
  await installEditor(page);
  await page.evaluate(() => {
    (window as any).videoUploads = 0;
    document.querySelector<HTMLInputElement>('.bcc-upload-wrapper input')!.onchange = () => { (window as any).videoUploads++; };
    (window as any).showEditor('上传中 40%');
  });
  expect(await canResume(page)).toBe(true);
  await page.evaluate(() => setTimeout(() => { document.querySelector('#status')!.textContent = '上传完成'; }, 500));
  const uploaded = vi.fn();
  await expect(preparePage(page, media(), () => {}, { timeout: 2000, resume: true, onUpload: uploaded })).resolves.toEqual([]);
  expect(uploaded).not.toHaveBeenCalled();
  expect(await page.evaluate(() => ({
    uploads: (window as any).videoUploads,
    title: document.querySelector<HTMLInputElement>('.video-title input')?.value,
    cover: (window as any).cover,
    submits: (window as any).submits,
  }))).toEqual({ uploads: 0, title: '发布标题', cover: 'cover.png', submits: 0 });
});

it('上传失败的编辑区不续接', async () => {
  const { page } = await pageFor('resume-failed');
  await installEditor(page);
  await page.evaluate(() => (window as any).showEditor('上传失败'));
  expect(await canResume(page)).toBe(false);
});

it('只有进度条在走、文字不变时不算卡住，并按进度条报百分比', async () => {
  const { page } = await pageFor('bar-only');
  await installEditor(page);
  await page.evaluate(() => {
    document.querySelector<HTMLInputElement>('.bcc-upload-wrapper input')!.onchange = () => {
      (window as any).showEditor('上传中');
      const status = document.querySelector<HTMLElement>('#status')!;
      status.insertAdjacentHTML('afterend', '<div class="bar" role="progressbar" aria-valuemax="200" aria-valuenow="0" style="width: 1%; height: 2px"></div>');
      const bar = document.querySelector<HTMLElement>('.bar')!;
      let value = 0;
      const timer = setInterval(() => {
        value += 20;
        if (value < 200) { bar.setAttribute('aria-valuenow', String(value)); bar.style.width = `${value / 2}%`; return; }
        clearInterval(timer);
        bar.remove();
        status.textContent = '上传完成';
      }, 120);
    };
  });
  const messages: string[] = [];
  await expect(preparePage(page, media(), (_f, message) => messages.push(message), { timeout: 1000 })).resolves.toEqual([]);
  expect(messages).toEqual(expect.arrayContaining([expect.stringMatching(/^正在上传视频 [1-9]\d*%/)]));
});

it('上传中弹出验证：停下全部自动操作交给用户，验证没了再接着填写', async () => {
  const { page } = await pageFor('verification');
  await installEditor(page);
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div class="geetest_panel" style="display:none;width:300px;height:200px"></div>');
    document.querySelector<HTMLInputElement>('.bcc-upload-wrapper input')!.onchange = () => {
      (window as any).showEditor('上传中 30%');
      // 上传途中 B 站弹出安全验证（普通弹窗）；隐藏着的极验容器不算。
      setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<div role="dialog" id="verify" style="width:320px;height:200px">安全验证 请完成下列验证后继续</div>'), 200);
      setTimeout(() => { document.querySelector('#status')!.textContent = '上传完成'; }, 400);
    };
  });
  const events: string[] = [];
  const done = preparePage(page, media(), (_f, message) => { if (message.includes('验证')) events.push('message'); }, {
    timeout: 1000,
    onPause: () => events.push('pause'),
    onResume: () => events.push('resume'),
  });
  await expect.poll(() => events.includes('pause'), { timeout: 5000 }).toBe(true);
  // 等用户验证的时候不填表，也不因为单步时限放弃。
  await new Promise(r => setTimeout(r, 1500));
  expect(await page.evaluate(title)).toBe('');
  expect(events).toEqual(['pause', 'message']);
  await page.evaluate(() => document.querySelector('#verify')!.remove());
  await expect(done).resolves.toEqual([]);
  expect(events).toEqual(['pause', 'message', 'resume']);
  expect(await page.evaluate(title)).toBe('发布标题');
});

it('认得出极验验证码与身份确认弹窗，不把封面裁切弹窗当成验证', async () => {
  const { page } = await pageFor('verification-kinds');
  expect(await page.evaluate(scripts.verificationOpen)).toBe(false);
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="geetest_box" style="display:none;width:300px;height:200px"></div><div class="geetest_tiny" style="width:4px;height:4px"></div>'));
  expect(await page.evaluate(scripts.verificationOpen)).toBe(false);
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="bcc-dialog" id="cover" style="width:300px;height:200px"><div class="cover-editor">封面制作 请拖动选框后完成验证码无关</div></div>'));
  expect(await page.evaluate(scripts.verificationOpen)).toBe(false);
  await page.evaluate(() => { document.querySelector('#cover')!.remove(); document.body.insertAdjacentHTML('beforeend', '<div class="geetest_panel" id="geetest" style="width:300px;height:200px"></div>'); });
  expect(await page.evaluate(scripts.verificationOpen)).toBe(true);
  await page.evaluate(() => { document.querySelector('#geetest')!.remove(); document.body.insertAdjacentHTML('beforeend', '<iframe id="frame" src="about:blank#captcha" style="width:300px;height:200px"></iframe>'); });
  expect(await page.evaluate(scripts.verificationOpen)).toBe(true);
  await page.evaluate(() => { document.querySelector('#frame')!.remove(); document.body.insertAdjacentHTML('beforeend', '<div class="bcc-dialog" style="width:300px;height:200px">身份验证 请输入短信验证码</div>'); });
  expect(await page.evaluate(scripts.verificationOpen)).toBe(true);
});

/** 上传页上的「本地浏览器存在 N 个未提交的视频」提示，结构照真实页面（2026-11-19 核对）；记录在本地存储里。 */
async function withSavedDrafts(page: Page, files: { fileTitle: string; size: number }[]) {
  await page.evaluate((videos) => {
    localStorage.setItem('bili_videoup_record', JSON.stringify({ mid: 1, generation: 0, data: videos.map((video, i) => ({ id: `archive_id_${i}`, version: 2, title: video.fileTitle, videos: [{ filename: 'n2611', cid: 1, ...video }] })) }));
    (window as any).videoUploads = 0; (window as any).gaveUp = 0;
    document.querySelector<HTMLInputElement>('.bcc-upload-wrapper input')!.addEventListener('change', () => (window as any).videoUploads++);
    document.body.insertAdjacentHTML('afterbegin', `<div class="entrance-tip"><div class="content"><div class="tip-text"><span>本地浏览器存在${videos.length}个未提交的视频</span></div><div class="tip-btn-group"><div id="continue"> 继续编辑 </div><div id="give-up"> 不用了 </div></div></div></div>`);
    document.querySelector<HTMLElement>('#continue')!.onclick = () => {
      document.querySelector('.entrance-tip')!.remove();
      document.querySelector<HTMLElement>('.upload-v2-step1-container')!.hidden = true;
      document.querySelector<HTMLElement>('.upload-v2-step2-container')!.hidden = false;
      document.querySelector('#status')!.textContent = '上传完成';
    };
    document.querySelector<HTMLElement>('#give-up')!.onclick = () => (window as any).gaveUp++;
  }, files);
}
const draftState = () => ({ uploads: (window as any).videoUploads, gaveUp: (window as any).gaveUp, prompt: !!document.querySelector('.entrance-tip'),
  title: document.querySelector<HTMLInputElement>('.video-title input')?.value, submits: (window as any).submits });

it('B 站里没投稿的就是这个成片：点「继续编辑」接着填写，不重新上传', async () => {
  const { page } = await pageFor('draft-same');
  const draft = media();
  await withSavedDrafts(page, [{ fileTitle: 'video', size: draft.videoSize }]);
  const uploaded = vi.fn();
  await expect(preparePage(page, draft, () => {}, { timeout: 2000, onUpload: uploaded })).resolves.toEqual([]);
  expect(uploaded).toHaveBeenCalledOnce();
  expect(await page.evaluate(draftState)).toEqual({ uploads: 0, gaveUp: 0, prompt: false, title: '发布标题', submits: 0 });
});

it('B 站里没投稿的是别的视频：停下请用户处理，不替用户点「不用了」，也不另传一份', async () => {
  const { page } = await pageFor('draft-other');
  const draft = media();
  await withSavedDrafts(page, [{ fileTitle: 'video', size: draft.videoSize + 1 }]);
  await expect(preparePage(page, draft, () => {}, { timeout: 2000 })).rejects.toThrow(/还有没投稿的视频（video，0\.0 MB）.*不用了/);
  expect(await page.evaluate(draftState)).toEqual({ uploads: 0, gaveUp: 0, prompt: true, title: '', submits: 0 });
});

it('B 站里有好几个没投稿的视频、其中一个是这个成片：不猜「继续编辑」会打开哪个，请用户选', async () => {
  const { page } = await pageFor('draft-many');
  const draft = media();
  await withSavedDrafts(page, [{ fileTitle: 'final', size: 169_883_431 }, { fileTitle: 'video', size: draft.videoSize }]);
  await expect(preparePage(page, draft, () => {}, { timeout: 2000 })).rejects.toThrow(/有 2 个没投稿的视频（final，162\.0 MB；video，0\.0 MB），其中有这个成片/);
  expect(await page.evaluate(draftState)).toEqual({ uploads: 0, gaveUp: 0, prompt: true, title: '', submits: 0 });
});

it('这个成片已经投过：不上传，说明何时投的；点了「仍然上传」才上传', async () => {
  const { page } = await pageFor('published');
  await page.evaluate(() => {
    (window as any).videoUploads = 0;
    document.querySelector<HTMLInputElement>('.bcc-upload-wrapper input')!.addEventListener('change', () => (window as any).videoUploads++);
    const real = window.fetch;
    window.fetch = async (input, init) => String(input).startsWith('/x/web/archives')
      ? Response.json({ code: 0, data: { page: { count: 2 }, arc_audits: [
        { Archive: { title: '别的稿件', duration: 180, ptime: 1795000000, state: 0, state_desc: '开放浏览' } },
        { Archive: { title: '发布 标题', duration: 181, ctime: 1795007766, ptime: 0, state: -1, state_desc: '待审' } },
      ] } })
      : real(input, init);
  });
  const error = await preparePage(page, media(), () => {}, { timeout: 2000 }).catch(err => err);
  expect(error).toBeInstanceOf(AlreadyPublished);
  expect(error.message).toMatch(/已经投到这个 B 站账号了（「发布 标题」，待审）.*仍然上传/);
  expect(await page.evaluate(() => (window as any).videoUploads)).toBe(0);
  await expect(preparePage(page, media(), () => {}, { timeout: 2000, again: true })).resolves.toEqual([]);
  expect(await page.evaluate(() => (window as any).videoUploads)).toBe(1);
});

it('读不到已投稿件时照常上传，并提醒用户留意', async () => {
  const { page } = await pageFor('works-unreadable');
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = async (input, init) => String(input).startsWith('/x/web/') ? new Response('', { status: 500 }) : real(input, init);
  });
  await expect(preparePage(page, media(), () => {}, { timeout: 2000 })).resolves.toEqual([expect.stringContaining('没能读到这个账号已投的稿件')]);
  expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('.video-title input')?.value)).toBe('发布标题');
});

it('读稿件列表：翻页读完为止，整秒时长换成毫秒', async () => {
  const { page } = await pageFor('works-pages');
  await page.evaluate(() => {
    window.fetch = async (input) => {
      const pn = Number(new URL(String(input), location.href).searchParams.get('pn'));
      const item = (n: number) => ({ Archive: { title: `稿件${n}`, duration: n, ptime: 1795000000 + n, state: 0, state_desc: '开放浏览', is_only_self: n === 31 ? 1 : 0 } });
      return Response.json({ code: 0, data: { page: { count: 31 }, arc_audits: pn === 1 ? Array.from({ length: 30 }, (_, i) => item(i + 1)) : [item(31)] } });
    };
  });
  const works = await page.evaluate(scripts.recentWorks, 3);
  expect(works).toHaveLength(31);
  expect(works![30]).toEqual({ title: '稿件31', duration: 31_000, time: 1795000031, state: '开放浏览', reviewing: false, is_private: true });
  await page.evaluate(() => { window.fetch = async () => Response.json({ code: -101 }); });
  expect(await page.evaluate(scripts.recentWorks, 3)).toBeNull();
});

it('删掉 B 站预填的标签、封面勾上双比例同步；创作声明没选时提醒用户，不替用户选', async () => {
  const { page } = await pageFor('statement-and-cover');
  await page.evaluate(() => { document.querySelector<HTMLInputElement>('.statement-content input')!.value = ''; });
  const warnings = await preparePage(page, media(), () => {}, { timeout: 5000 });
  expect(warnings).toEqual(['请在 B 站选择「创作声明」（必填）。']);
  expect(await page.evaluate(() => ({
    tags: [...document.querySelectorAll('#tag-container .label-item-v2-content')].map(el => el.textContent),
    synced: (window as any).coverSynced, statement: document.querySelector<HTMLInputElement>('.statement-content input')!.value,
  }))).toEqual({ tags: media().tags, synced: true, statement: '' });
});
