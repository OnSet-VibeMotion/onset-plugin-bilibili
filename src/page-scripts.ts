/**
 * 在创作中心页面执行的函数必须可以单独序列化。
 * 视频上传框：.bcc-upload-wrapper 里的那个是 2026-11-19 在真实投稿页（/platform/upload/video/frame）上核对过的
 * （页面另有两个 name="buploader" 的隐藏上传框，不用）；其余两个是旧版页面的写法。
 */
export const videoInput = '.bcc-upload-wrapper input[type="file"], #bili-upload-btn input[type="file"], .upload-v2-step1-container input[type="file"]';
export const coverInput = '.cover-select .cover-select-content-upload input[type="file"]';
export const initialCoverInput = '.cover-content .cover-upload input[type="file"]';

export function query(selector: string): HTMLInputElement | null {
  const inputs = [...document.querySelectorAll<HTMLInputElement>(selector)]
    .filter(input => !input.disabled && input.parentElement?.getClientRects().length);
  return inputs.length === 1 ? inputs[0] : null;
}

export function hasUpload(selector: string): boolean {
  return [...document.querySelectorAll<HTMLInputElement>(selector)]
    .filter(input => !input.disabled && input.parentElement?.getClientRects().length).length === 1;
}

/**
 * 上传状态。B 站在文件条目上写「上传中 45%」「上传完成」，有的版本只有进度条：百分比先取文字里的，再看进度条的
 * aria-valuenow / aria-valuemax，读不到为 null。none 表示页面上还没有上传条目（还在上传入口页）。
 * 2026-11-19 没在真实页面上传过视频，这些上传条目与失败文字的写法未核对，是按旧版页面推测的。
 */
export interface VideoStatus { state: 'none' | 'uploading' | 'ready' | 'failed'; text: string; percent: number | null }
export function videoStatus(): VideoStatus {
  const visible = (node: Element) => node.getClientRects().length > 0;
  const rows = [...document.querySelectorAll<HTMLElement>('.upload-status-intro')].filter(visible);
  const nodes = [...document.querySelectorAll<HTMLElement>('.upload-status-intro, [class*="file-item-content-status"], [class*="upload-progress"], [class*="progress-text"], [role="progressbar"]')]
    .filter(visible);
  const text = nodes.map(node => node.innerText.trim()).filter(Boolean).join('\n').slice(0, 500);
  const bars = nodes.flatMap(node => [node, ...node.querySelectorAll<HTMLElement>('[role="progressbar"]')]);
  const match = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  const bar = bars.find(node => node.hasAttribute('aria-valuenow'));
  const value = Number(bar?.getAttribute('aria-valuenow')), max = Number(bar?.getAttribute('aria-valuemax') || 100);
  const percent = match ? Math.min(100, Number(match[1]))
    : bar && Number.isFinite(value) && max > 0 ? Math.min(100, Math.max(0, value / max * 100)) : null;
  if (/上传错误|上传失败|处理失败|转码失败/.test(text)) return { state: 'failed', text, percent };
  if (rows.length === 1 && /^(上传完成|上传成功)$/.test(rows[0].innerText.trim())) return { state: 'ready', text, percent };
  return { state: nodes.length ? 'uploading' : 'none', text, percent };
}

/** 页面停在稿件编辑区（选好视频后才有标题框）。标题框的写法同上，未在 2026-11-19 的真实页面上核对。 */
export function editorOpen(): boolean {
  return [...document.querySelectorAll<HTMLInputElement>('.content-title-v2-input-wrp input')]
    .some(input => input.getClientRects().length > 0 && !input.disabled);
}

/**
 * B 站弹出了要用户自己做的验证：极验（geetest）滑块或点选验证码、验证码 iframe，或短信 / 身份确认弹窗（按文字认）。
 * 只认看得见的；封面裁切弹窗（.cover-select）不算。2026-11-19 没碰到验证，这些写法按 B 站常用的极验组件推测。
 */
export function verificationOpen(): boolean {
  const visible = (node: Element) => node.getClientRects().length > 0 && (node as HTMLElement).offsetWidth > 20 && (node as HTMLElement).offsetHeight > 20;
  const cover = (node: Element) => !!node.closest('.cover-select') || !!node.querySelector('.cover-select');
  const widgets = '.geetest_panel, .geetest_box, .geetest_holder, .geetest_popup_wrap, [class*="geetest"], iframe[src*="captcha"], iframe[src*="geetest"], iframe[src*="verify"]';
  if ([...document.querySelectorAll(widgets)].some(node => visible(node) && !cover(node))) return true;
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], [class*="bcc-dialog"], [class*="dialog"], [class*="modal"]')]
    .some(dialog => visible(dialog) && !cover(dialog)
      && /安全验证|身份验证|身份校验|短信验证|请完成.{0,6}验证|验证码|滑块|拖动.{0,4}完成/.test(dialog.innerText.slice(0, 300)));
}

export function clickControl({ selector, exactText }: { selector: string; exactText?: string }): boolean {
  const matches = [...document.querySelectorAll<HTMLElement>(selector)]
    .filter(node => node.getClientRects().length && (!exactText || node.textContent?.trim() === exactText));
  if (matches.length !== 1) return false;
  const node = matches[0];
  const control = node.closest('button, [role="button"], input[type="submit"]') ?? node;
  if (/投稿|发布|提交/.test(control.textContent?.trim() ?? '') || control.matches('input[type="submit"]')) {
    throw Error('插件不允许点击投稿按钮');
  }
  if (control.matches(':disabled, [disabled], [aria-disabled="true"], [class*="loading"]')) return false;
  node.click();
  return true;
}

export function fillTitle(title: string): void {
  const fields = [...document.querySelectorAll<HTMLInputElement>('.content-title-v2-input-wrp input')]
    .filter(field => field.getClientRects().length && !field.disabled);
  if (fields.length !== 1) throw Error('找不到唯一的 B 站稿件标题输入框');
  fields[0].value = title;
  fields[0].dispatchEvent(new Event('input', { bubbles: true }));
}

export function selectContent(): void {
  const fields = [...document.querySelectorAll<HTMLElement>('.content-desc-v2-text-wrp [contenteditable="true"]')]
    .filter(field => field.getClientRects().length);
  if (fields.length !== 1) throw Error('找不到唯一的 B 站简介输入框');
  const field = fields[0];
  field.focus();
  const range = document.createRange();
  range.selectNodeContents(field);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function addTag(tag: string): void {
  const chips = document.querySelectorAll('.content-tag-v2-pre-wrp .label-item-v2-content, .content-tag-v2-pre-wrp > span');
  if ([...chips].some(chip => chip.textContent?.trim() === tag)) return;
  const fields = [...document.querySelectorAll<HTMLInputElement>('#content-tag-v2-container input')]
    .filter(field => !field.disabled && field.getClientRects().length);
  if (fields.length !== 1) return;
  const field = fields[0];
  field.value = tag;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
}

export function readForm(): { title: string; content: string; tags: string[] } {
  const title = document.querySelector<HTMLInputElement>('.content-title-v2-input-wrp input')?.value ?? '';
  const content = document.querySelector<HTMLElement>('.content-desc-v2-text-wrp [contenteditable="true"]')?.innerText ?? '';
  const tags = [...document.querySelectorAll('.content-tag-v2-pre-wrp .label-item-v2-content, .content-tag-v2-pre-wrp > span')]
    .map(chip => chip.textContent?.trim() ?? '');
  return { title, content, tags };
}

export function appliedCover(): string {
  const preview = document.querySelector<HTMLElement>('.cover-content .cover-upload .img');
  const source = preview?.style.backgroundImage ?? '';
  let checksum = 0;
  for (let i = 0; i < source.length; i++) checksum = (Math.imul(checksum, 31) + source.charCodeAt(i)) | 0;
  return source ? `${source.length}:${checksum}` : '';
}

export function coverDialogOpen(): boolean {
  return [...document.querySelectorAll('.cover-select')].some(dialog => dialog.getClientRects().length);
}

export function coverCropReady(): boolean {
  return [...document.querySelectorAll<HTMLImageElement>('.cover-select .cover-cropper img')]
    .some(img => img.complete && img.naturalWidth > 0 && img.getClientRects().length);
}

export interface LoginInfo { name: string; avatar: string; user_id: string }
export async function loginInfo(): Promise<LoginInfo | null> {
  try {
    const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const result = JSON.parse(await response.text(), (key, value: unknown, context?: { source: string }) =>
      key === 'mid' && typeof value === 'number' ? context?.source ?? (Number.isSafeInteger(value) ? String(value) : '') : value,
    ) as { code?: unknown; data?: { isLogin?: unknown; mid?: unknown; uname?: unknown; face?: unknown } } | null;
    const profile = result?.data;
    const uid = typeof profile?.mid === 'string' ? profile.mid : '';
    if (result?.code !== 0 || profile?.isLogin !== true || !/^[1-9][0-9]{0,79}$/.test(uid)) return null;
    const name = typeof profile.uname === 'string' ? profile.uname.trim() : '';
    const face = typeof profile.face === 'string' ? profile.face.trim() : '';
    const avatar = face.startsWith('//') ? 'https:' + face : face.replace(/^http:\/\//, 'https://');
    return { user_id: uid, name, avatar };
  } catch { return null; }
}

/**
 * 上传页上的「本地浏览器存在 2 个未提交的视频」提示（2026-11-19 在真实页面上核对过：.entrance-tip .content 里
 * .tip-text 的文字，后面 .tip-btn-group 里是「继续编辑」与「不用了」两个 div）。
 */
export function draftPromptOpen(): boolean {
  return [...document.querySelectorAll<HTMLElement>('span, div, p')].some(node =>
    node.childElementCount === 0 && node.getClientRects().length > 0 && /存在\s*\d+\s*个未提交的视频/.test(node.textContent ?? ''));
}

/**
 * 那些没投稿的视频：B 站存在网页本地存储 bili_videoup_record 的 data[] 里，每条有 videos[]，带文件名（fileTitle，
 * 不含扩展名）与大小（size，字节），已经传上去的还有 cid；没有修改时间和时长（2026-11-19 在真实页面上核对过）。读不到为空列表。
 */
export interface SavedDraft { title: string; files: { name: string; size: number }[] }
export function savedDrafts(): SavedDraft[] {
  try {
    const value = JSON.parse(localStorage.getItem('bili_videoup_record') ?? 'null');
    if (!Array.isArray(value?.data)) return [];
    return value.data.map((item: any) => ({
      title: String(item?.title ?? ''),
      files: (Array.isArray(item?.videos) ? item.videos : [])
        .filter((video: any) => typeof video?.size === 'number')
        .map((video: any) => ({ name: String(video.fileTitle ?? ''), size: video.size })),
    }));
  } catch { return []; }
}

/** 点草稿提示里的「继续编辑」。只点这一个，不碰「不用了」。 */
export function continueDraft(): boolean {
  const nearPrompt = (node: HTMLElement) => {
    let parent = node.parentElement;
    for (let level = 0; parent && level < 4; level++, parent = parent.parentElement) {
      if (/个未提交的视频/.test(parent.innerText.slice(0, 200))) return true;
    }
    return false;
  };
  const buttons = [...document.querySelectorAll<HTMLElement>('div, span, button, [role="button"]')].filter(node =>
    node.getClientRects().length > 0 && node.textContent?.trim() === '继续编辑' && nearPrompt(node));
  const candidates = buttons.filter(node => !buttons.some(other => other !== node && node.contains(other)));
  if (candidates.length !== 1) return false;
  candidates[0].click();
  return true;
}

export interface PublishedWork { title: string; duration: number; time: number; state: string; reviewing: boolean; is_private: boolean }
/**
 * 这个账号最近的稿件：创作中心「稿件管理」用的 /x/web/archives，只要已开放和审核中的（status=is_pubing,pubed）。
 * 2026-11-19 在真实页面上核对过：data.arc_audits[].Archive 里 title、duration（整秒）、ptime / ctime（秒）、
 * state（0 为开放浏览，负数为审核中等）、state_desc、is_only_self；data.page.count 是总数。读不到返回 null。
 */
export async function recentWorks(pages: number): Promise<PublishedWork[] | null> {
  const works: PublishedWork[] = [];
  for (let page = 1; page <= pages; page++) {
    let data: any;
    try {
      const response = await fetch(`/x/web/archives?status=is_pubing%2Cpubed&pn=${page}&ps=30`, {
        credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return page > 1 ? works : null;
      data = await response.json();
    } catch { return page > 1 ? works : null; }
    const list = data?.data?.arc_audits ?? [];
    if (data?.code !== 0 || !Array.isArray(list)) return page > 1 ? works : null;
    for (const item of list) {
      const archive = item?.Archive ?? {};
      const state = Number(archive.state ?? 0);
      works.push({
        title: String(archive.title ?? ''), duration: Number(archive.duration ?? 0) * 1000,
        time: Number(archive.ptime || archive.ctime || 0), state: String(archive.state_desc ?? ''),
        reviewing: state < 0, is_private: Number(archive.is_only_self ?? 0) === 1,
      });
    }
    if (list.length < 30 || works.length >= Number(data.data.page?.count ?? 0)) break;
  }
  return works;
}

/** 编辑区里预览视频的时长（秒）。没有为 null。推测：B 站编辑区可能没有预览播放器，未在真实页面上核对。 */
export function editorVideoDuration(): number | null {
  const durations = [...document.querySelectorAll('video')].map(video => video.duration).filter(value => Number.isFinite(value) && value > 0);
  return durations.length ? Math.max(...durations) : null;
}
