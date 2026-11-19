import path from 'node:path';
import { Page, delay } from './cdp';
import type { Draft } from './draft';
import * as scripts from './page-scripts';

export type Progress = (fraction: number, message: string) => void;
export interface PrepareOptions {
  /** 单步等待（上传入口、封面弹窗）的上限。 */
  timeout?: number;
  /** 窗口里已经是这个成片的编辑区（上次的等待中断了），接着它继续，不重新上传。 */
  resume?: boolean;
  /** 视频已交给 B 站页面，调用方记下来，下次可以据此续接。 */
  onUpload?: () => void;
  /** B 站弹出验证：调用方揭开遮罩交给用户（onPause）；验证没了、接着自动操作前再盖上（onResume）。 */
  onPause?: () => void;
  onResume?: () => void;
  /** 这个成片已经投过也照样上传（用户在插件页面点了「仍然上传」）。 */
  again?: boolean;
}

/** 这个成片已经在这个账号投过（或在审核）：不上传，交给用户决定。 */
export class AlreadyPublished extends Error {
  constructor(readonly work: scripts.PublishedWork) {
    const day = new Date(work.time * 1000);
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const notes = [work.reviewing ? (work.state || '正在审核') : '', work.is_private ? '仅自己可见' : ''].filter(Boolean).map(note => '，' + note).join('');
    super(`这个成片 ${date} 已经投到这个 B 站账号了（「${work.title}」${notes}），这次没有上传。确实要再投一次，请点「仍然上传」`);
  }
}

/** 已投稿件里有没有这个成片：标题相同、时长相差不到 1.5 秒（读不出成片时长时只看标题）。 */
export function findPublished(works: scripts.PublishedWork[], draft: Draft): scripts.PublishedWork | undefined {
  const same = (a: string, b: string) => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
  return works.find(work => same(work.title, draft.title)
    && (draft.videoDuration == null || Math.abs(work.duration - draft.videoDuration) <= 1500));
}

/**
 * B 站本地记录里的视频是不是这个成片：B 站只记文件名（不含扩展名）与大小，没有修改时间和时长，
 * 所以要大小完全一样、记了文件名时文件名也一样。
 */
export function sameFilm(saved: { name: string; size: number }, draft: Draft): boolean {
  if (draft.videoSize === undefined || saved.size !== draft.videoSize) return false;
  return !saved.name || saved.name === path.basename(draft.video, path.extname(draft.video));
}

/**
 * 上传页上有「本地浏览器存在 N 个未提交的视频」时：只有一个、就是这个成片，就点「继续编辑」接着用（返回 true）；
 * 否则停下请用户在窗口里处理，不替用户点「不用了」，也不另传一份。没有提示返回 false。
 */
async function restoreDraft(page: Page, draft: Draft, timeout: number): Promise<boolean> {
  // 提示比上传框晚一点出来：稍等一下再判断。
  try { await page.waitFor(scripts.draftPromptOpen, Math.min(timeout, 3000), ''); }
  catch { return false; }
  const saved = await page.evaluate(scripts.savedDrafts);
  const ours = saved.filter(item => item.files.some(file => sameFilm(file, draft)));
  if (saved.length === 1 && ours.length === 1) {
    if (!await page.evaluate(scripts.continueDraft)) throw Error('B 站里没投稿的视频就是这个成片，但没点到「继续编辑」，请在 B 站窗口里点一下后再试');
    await page.waitFor(scripts.editorOpen, Math.min(timeout, 60_000), '点了「继续编辑」，但 B 站编辑区没有打开，请在窗口检查');
    return true;
  }
  const mb = (size: number) => `${(size / 1024 / 1024).toFixed(1)} MB`;
  const names = saved.flatMap(item => item.files.map(file => `${file.name || item.title || '未命名'}，${mb(file.size)}`)).slice(0, 3);
  const listed = names.length ? `（${names.join('；')}）` : '';
  if (ours.length) {
    throw Error(`这个 B 站账号的浏览器里有 ${saved.length} 个没投稿的视频${listed}，其中有这个成片。请在 B 站窗口点「继续编辑」接着投它，或点「不用了」，再回来点「上传并填写」`);
  }
  throw Error(`这个 B 站账号的浏览器里还有没投稿的视频${listed}，插件没有替你放弃，也没有上传。请先在 B 站窗口处理：点「继续编辑」投稿，或点「不用了」，再回来点「上传并填写」`);
}

/**
 * B 站弹出验证（极验滑块、短信、身份确认）时：揭开遮罩、把窗口拿到前面，自动操作全部停下，等验证没了再接着做。
 * 等多久都行（用户可能要去拿手机）；想停可以在片场取消任务。返回停了多少毫秒。
 */
function verificationGuard(page: Page, progress: Progress, last: () => number, options: PrepareOptions): () => Promise<number> {
  const open = async (navigating: boolean) => {
    try { return await page.evaluate(scripts.verificationOpen); }
    catch (err) { if (/context/i.test(String(err))) return navigating; throw err; }
  };
  return async () => {
    if (!await open(false)) return 0;
    const started = Date.now();
    options.onPause?.();
    progress(last(), 'B 站要求验证：请在 B 站窗口完成验证，完成后自动继续');
    await page.raw('Page.bringToFront').catch(() => {});
    while (await open(true)) await delay(1000);
    // 验证刚关掉，页面可能还在刷新：稍等再接着做。
    await delay(1000);
    options.onResume?.();
    return Date.now() - started;
  };
}

export async function preparePage(page: Page, draft: Draft, report: Progress, options: PrepareOptions = {}): Promise<string[]> {
  const timeout = options.timeout ?? 10 * 60_000;
  let fraction = 0;
  const progress: Progress = (value, message) => { fraction = value; report(value, message); };
  // 视频交给 B 站之后才检查验证：之前用户本来就在页面上操作（登录），不用停。
  const guard = () => { page.guard = verificationGuard(page, report, () => fraction, options); };
  try {
    return await fillPage(page, draft, progress, options, timeout, guard);
  } finally {
    page.guard = undefined;
  }
}

async function fillPage(page: Page, draft: Draft, progress: Progress, options: PrepareOptions, timeout: number, guard: () => void): Promise<string[]> {
  const warnings: string[] = [];
  if (options.resume) {
    guard();
    progress(0.2, 'B 站窗口里已有这个成片，接着上次的上传继续');
  } else {
    progress(0.1, '正在打开 B 站视频投稿页');
    await page.waitFor(scripts.hasUpload, Math.min(timeout, 90_000), '找不到 B 站视频上传入口，请检查登录状态', scripts.videoInput);
    if (await restoreDraft(page, draft, timeout)) {
      progress(0.2, 'B 站里没投稿的就是这个成片，接着上次的上传继续');
    } else {
      if (!options.again) {
        progress(0.15, '正在检查这个成片是否已经投过');
        const works = await page.evaluate(scripts.recentWorks, 2).catch(() => null);
        const published = works && findPublished(works, draft);
        if (published) throw new AlreadyPublished(published);
        if (!works) warnings.push('没能读到这个账号已投的稿件，没有检查这个成片是否投过，请在 B 站页面留意。');
      }
      progress(0.2, '正在上传视频，请保留 B 站窗口');
      await page.upload(scripts.videoInput, draft.video);
    }
    options.onUpload?.();
    guard();
  }
  await waitForVideo(page, progress);

  progress(0.55, '正在填写标题、简介和标签');
  await page.checkpoint();
  await page.fillTitle(draft.title);
  await page.checkpoint();
  await page.fillContent(draft.content);
  // B 站会自己预填几个标签（「生活记录」之类），先删掉清单里没有的，再一个个输入、按回车（标签框只认真回车）。
  for (let round = 0; round < 20; round++) {
    await page.checkpoint();
    if (!await page.evaluate(scripts.removeExtraTag, draft.tags)) break;
    await delay(200);
  }
  for (const tag of draft.tags) {
    if ((await page.evaluate(scripts.currentTags)).includes(tag)) continue;
    await page.checkpoint();
    if (!await page.evaluate(scripts.focusTagInput)) break;
    await page.insertText(tag);
    if (!await page.press('Enter')) break;
    await delay(300);
  }
  await page.checkpoint();
  const form = await page.evaluate(scripts.readForm);
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  if (form.title !== draft.title || normalize(form.content) !== normalize(draft.content)) {
    throw Error('B 站页面上的标题或简介与项目发布信息不符，请在窗口检查');
  }
  warnings.push(...draft.tags.filter(tag => !form.tags.includes(tag)).map(tag => `请在 B 站检查标签「${tag}」。`));

  const cover = draft.covers['16:10'];
  if (cover) {
    progress(0.8, '正在上传 B 站封面');
    await page.checkpoint();
    try { await setCover(page, cover, Math.min(timeout, 30_000)); }
    catch (error) { warnings.push(`封面需要手动确认：${error instanceof Error ? error.message : '封面操作失败'}`); }
  } else {
    warnings.push('发布信息里没有登记 16:10 封面，请在 B 站设置封面。');
  }
  // 创作声明是必填项，要用户自己判断内容性质，插件不替用户选，只提醒。
  if (!await page.evaluate(scripts.statementChosen)) warnings.push('请在 B 站选择「创作声明」（必填）。');
  progress(1, '视频和文案已填好，请在 B 站检查投稿选项');
  return warnings;
}

/**
 * 等 B 站传完视频，不设时限：窗口开着、B 站没报失败，就一直等到传完再接着填写（大视频传多久都行）。
 * 想停可以在片场取消任务；页面跳转中读不到就下一轮再看，离开创作中心或窗口关掉照常报错。
 */
async function waitForVideo(page: Page, progress: Progress): Promise<void> {
  let reported: number | null | undefined;
  for (;;) {
    await page.checkpoint();
    let status: scripts.VideoStatus | undefined;
    try { status = await page.evaluate(scripts.videoStatus); }
    catch (err) { if (!/context/i.test(String(err))) throw err; }
    if (status?.state === 'ready') return;
    if (status?.state === 'failed') throw Error('B 站显示视频上传失败，请在窗口检查');
    const percent = status?.percent == null ? null : Math.floor(status.percent);
    if (status && percent !== reported) {
      reported = percent;
      progress(0.2 + 0.35 * (percent ?? 0) / 100, percent === null ? '正在上传视频，请保留 B 站窗口' : `正在上传视频 ${percent}%，请保留 B 站窗口`);
    }
    await delay(500);
  }
}

/**
 * 编辑区里的视频是不是这个成片：时长与成片相差不到 50 毫秒。插件没记下指纹时（例如在 B 站里点了「继续编辑」）靠它认。
 */
export async function editorHoldsFilm(page: Page, draft: Draft): Promise<boolean> {
  if (draft.videoDuration == null) return false;
  try {
    const seconds = await page.evaluate(scripts.editorVideoDuration);
    return seconds !== null && Math.abs(seconds * 1000 - draft.videoDuration) <= 50;
  } catch { return false; }
}

/** 上次的操作中断后再点：窗口停在编辑区、视频还在传或已传好，就能接着用（是不是同一个成片由调用方核对）。 */
export async function canResume(page: Page): Promise<boolean> {
  try {
    if (!await page.evaluate(scripts.editorOpen)) return false;
    const status = await page.evaluate(scripts.videoStatus);
    return status?.state === 'uploading' || status?.state === 'ready';
  } catch { return false; }
}

/**
 * 设封面（2026-11-19 在真实投稿页上走通）：点封面位置打开「封面制作」→ 勾「双比例同步改动」→ 把图放进上传框 →
 * 等两个比例的预览换上 →「完成」→ 编辑页上的封面换成新图。
 */
async function setCover(page: Page, file: string, timeout: number): Promise<void> {
  if (!await page.evaluate(scripts.openCoverEditor)) throw Error('找不到封面入口');
  await page.waitFor(scripts.hasUpload, timeout, '封面制作没有打开', scripts.coverInput);
  if (!await page.evaluate(scripts.syncCoverRatios)) throw Error('没能勾上「双比例同步改动」，16:9 封面请手动确认');
  await page.checkpoint();
  await page.upload(scripts.coverInput, file);
  // 图要先传到 B 站再放进两个比例的裁切框：等一会儿再点完成。
  await delay(Math.min(timeout, 2500));
  await page.waitFor(scripts.finishCover, timeout, '没找到「封面制作」的「完成」');
  let deadline = Date.now() + timeout;
  while ((deadline += await page.checkpoint(), Date.now() < deadline)) {
    // 对话框关了、编辑页上有封面就算设好了。传的是同一张图时 B 站给的还是同一个地址，不能要求它变。
    if (!await page.evaluate(scripts.coverDialogOpen) && await page.evaluate(scripts.appliedCover)) return;
    await delay(Math.min(timeout, 250));
  }
  throw Error('B 站页面未确认应用新封面');
}
