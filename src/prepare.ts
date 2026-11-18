import { Page, delay } from './cdp';
import type { Draft } from './draft';
import * as scripts from './page-scripts';

export type Progress = (fraction: number, message: string) => void;

export async function preparePage(page: Page, draft: Draft, progress: Progress, options: { timeout?: number } = {}): Promise<string[]> {
  const timeout = options.timeout ?? 10 * 60_000;
  progress(0.1, '正在打开 B 站视频投稿页');
  await page.waitFor(scripts.hasUpload, Math.min(timeout, 90_000), '找不到 B 站视频上传入口，请检查登录状态', scripts.videoInput);
  await page.upload(scripts.videoInput, draft.video);
  progress(0.2, '正在上传视频，请保留 B 站窗口');
  const deadline = Date.now() + timeout;
  for (;;) {
    const status = await page.evaluate(scripts.videoStatus);
    if (status === 'ready') break;
    if (status === 'failed') throw Error('B 站显示视频上传失败，请在窗口检查');
    if (Date.now() >= deadline) throw Error('等待 B 站上传完成超时，请在窗口检查');
    await delay(Math.min(500, timeout));
  }

  progress(0.55, '正在填写标题、简介和标签');
  await page.fillTitle(draft.title);
  await page.fillContent(draft.content);
  for (const tag of draft.tags) {
    await page.evaluate(scripts.addTag, tag);
  }
  const form = await page.evaluate(scripts.readForm);
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  if (form.title !== draft.title || normalize(form.content) !== normalize(draft.content)) {
    throw Error('B 站页面上的标题或简介与项目发布信息不符，请在窗口检查');
  }
  const warnings = draft.tags.filter(tag => !form.tags.includes(tag)).map(tag => `请在 B 站检查标签「${tag}」。`);

  const cover = draft.covers['16:10'];
  if (cover) {
    progress(0.8, '正在上传 B 站封面');
    try { await setCover(page, cover, Math.min(timeout, 30_000)); }
    catch (error) { warnings.push(`封面需要手动确认：${error instanceof Error ? error.message : '封面操作失败'}`); }
  } else {
    warnings.push('发布信息里没有登记 16:10 封面，请在 B 站设置封面。');
  }
  progress(1, '视频和文案已填好，请在 B 站检查投稿选项');
  return warnings;
}

async function setCover(page: Page, file: string, timeout: number): Promise<void> {
  const previous = await page.evaluate(scripts.appliedCover);
  let selector = scripts.initialCoverInput;
  if (!await page.evaluate(scripts.hasUpload, selector)) {
    if (!await page.click('.cover-content .cover-upload .img')) throw Error('找不到封面入口');
    selector = scripts.coverInput;
    await page.waitFor(scripts.hasUpload, timeout, '找不到封面上传控件', selector);
  }
  await page.upload(selector, file);
  await page.waitFor(scripts.coverCropReady, timeout, '封面裁切预览尚未载入');
  await page.waitFor(scripts.clickControl, timeout, '无法应用封面裁切', {
    selector: '.cover-select .cover-select-footer :is(button, [role="button"])',
    exactText: '完成',
  });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!await page.evaluate(scripts.coverDialogOpen)) {
      const current = await page.evaluate(scripts.appliedCover);
      if (current && current !== previous) return;
    }
    await delay(Math.min(timeout, 250));
  }
  throw Error('B 站页面未确认应用新封面');
}
