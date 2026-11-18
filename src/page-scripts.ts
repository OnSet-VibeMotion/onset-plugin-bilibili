/** 在创作中心页面执行的函数必须可以单独序列化。 */
export const videoInput = '#bili-upload-btn input[type="file"], .upload-v2-step1-container input[type="file"], input[type="file"][accept*="video/"]';
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

export function videoStatus(): 'ready' | 'waiting' | 'failed' {
  const rows = [...document.querySelectorAll<HTMLElement>('.upload-status-intro')].filter(node => node.getClientRects().length);
  if (rows.some(row => /上传错误|上传失败|处理失败/.test(row.innerText))) return 'failed';
  return rows.length === 1 && /^(上传完成|上传成功)$/.test(rows[0].innerText.trim()) ? 'ready' : 'waiting';
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
