import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { projectFile } from './files';

export const coverRatios = ['16:10'] as const;
export type CoverRatio = typeof coverRatios[number];
export interface Draft {
  title: string;
  content: string;
  tags: string[];
  video: string;
  videoHash: string;
  /** 文件大小与修改时间（毫秒）。B 站把没投稿的视频记在网页本地存储里（带文件大小），据此认出是不是这个成片。 */
  videoSize?: number;
  videoModified?: number;
  /** 成片时长（毫秒），读不出来为 null：和已投稿件的时长比对。 */
  videoDuration?: number | null;
  covers: Partial<Record<CoverRatio, string>>;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('发布信息格式不正确');
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw Error(`${field}不能为空`);
  return value.trim();
}
export async function readDraft(root: string): Promise<Draft> {
  const file = projectFile(root, 'publish.md');
  if (fs.statSync(file).size > 262_144) throw Error('publish.md 太大');
  const raw = fs.readFileSync(file, 'utf8');
  const match = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw Error('publish.md 缺少 YAML 发布信息');
  const doc = parseDocument(match[1], { uniqueKeys: true });
  if (doc.errors.length) throw Error('publish.md 的 YAML 格式有误');
  const d = record(doc.toJS({ maxAliasCount: 20 }));
  // 只看 B 站自己要的数据够不够：platform 是这次发布的主平台、publish_status 是按主平台查的结果，
  // B 站可能只是其中之一，主平台还缺什么不该挡住这里。标题与封面优先用为 B 站单独登记的。
  const copy = record(d.copy), video = record(d.video), cover = record(d.cover ?? {});
  if (video.replacement_in_progress === true) throw Error('成片仍在替换中');
  const platformTitles = copy.platform_titles ? record(copy.platform_titles) : {};
  const ownTitle = typeof platformTitles.bilibili === 'string' && platformTitles.bilibili.trim() !== '';
  const title = text(ownTitle ? platformTitles.bilibili : copy.primary_title, '标题');
  if ([...title].length > 80) {
    throw Error(ownTitle ? 'B 站标题超过 80 字，请先修改' : '标题超过 80 字（B 站的上限）：请在片场给 B 站单独写一个标题（copy.platform_titles.bilibili）');
  }
  let content = text(copy.introduction, '正文');
  const credits = d.credits ? record(d.credits) : null;
  if (credits?.required === true) {
    const attribution = text(credits.text, '素材署名');
    if (!content.includes(attribution)) content += `\n\n${attribution}`;
  }
  // 话题优先用为 B 站单独写的完整列表（copy.platform_hashtags.bilibili，空列表就是不带话题），没写才用通用的 copy.hashtags。
  const platformTags = copy.platform_hashtags ? record(copy.platform_hashtags) : {};
  const ownTags = Object.hasOwn(platformTags, 'bilibili');
  const tags = ownTags ? platformTags.bilibili : copy.hashtags ?? [];
  if (!Array.isArray(tags) || tags.length > 10) throw Error(ownTags ? 'B 站话题（copy.platform_hashtags.bilibili）应是最多 10 项的列表' : '话题应是最多 10 项的列表');
  const normalizedTags = [...new Set(tags.map(tag => {
    const normalized = text(tag, '话题').replace(/^#/, '');
    if (!normalized || [...normalized].length > 20 || /[#\x00-\x1f]/.test(normalized)) throw Error('标签须在 20 字以内，不能有控制字符或多余的 #');
    return normalized;
  }))];
  if ([...content].length > 2000) throw Error('简介超过 2000 字，请先精简');
  const videoPath = projectFile(root, text(video.path, '视频路径'));
  if (!['.mp4', '.mov', '.m4v'].includes(path.extname(videoPath).toLowerCase()) || fs.statSync(videoPath).size === 0) throw Error('请选择非空的 MP4、MOV 或 M4V 视频');
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(videoPath)) hash.update(chunk);
  const videoHash = hash.digest('hex');
  if (video.sha256 && video.sha256 !== videoHash) throw Error('成片已变动，请先刷新发布信息');
  const covers = pickCovers(root, cover.images);
  const stat = fs.statSync(videoPath);
  return {
    title, content, tags: normalizedTags, video: videoPath, videoHash, covers,
    videoSize: stat.size, videoModified: Math.floor(stat.mtimeMs), videoDuration: mp4Duration(videoPath),
  };
}

/**
 * 读 MP4 / MOV 的时长（moov/mvhd，毫秒）。只按盒子头跳着读，不读整个文件；读不出来返回 null。
 */
export function mp4Duration(file: string): number | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const read = (offset: number, length: number) => {
      const buffer = Buffer.alloc(length);
      return buffer.subarray(0, fs.readSync(fd!, buffer, 0, length, offset));
    };
    const boxes = function* (start: number, end: number) {
      let offset = start;
      while (offset + 8 <= end) {
        const head = read(offset, 16);
        if (head.length < 8) return;
        let length = head.readUInt32BE(0), header = 8;
        if (length === 1) { if (head.length < 16) return; length = Number(head.readBigUInt64BE(8)); header = 16; }
        else if (length === 0) length = end - offset;
        if (length < header) return;
        yield { type: head.toString('latin1', 4, 8), start: offset + header, end: Math.min(offset + length, end) };
        offset += length;
      }
    };
    for (const top of boxes(0, size)) {
      if (top.type !== 'moov') continue;
      for (const box of boxes(top.start, top.end)) {
        if (box.type !== 'mvhd') continue;
        const body = read(box.start, 32);
        const version = body[0];
        const scale = version === 1 ? body.readUInt32BE(20) : body.readUInt32BE(12);
        const duration = version === 1 ? Number(body.readBigUInt64BE(24)) : body.readUInt32BE(16);
        return scale ? Math.round(duration * 1000 / scale) : null;
      }
    }
    return null;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function pickCovers(root: string, images: unknown): Draft['covers'] {
  if (images === undefined) return {};
  if (!Array.isArray(images)) throw Error('封面登记格式不正确');
  const all = images.map(record);
  const covers: Draft['covers'] = {};
  for (const ratio of coverRatios) {
    const sameRatio = all.filter(cover => cover.ratio === ratio);
    const own = sameRatio.filter(cover => cover.platform === 'bilibili');
    const paths = [...new Set((own.length ? own : sameRatio).map(cover => text(cover.path, '封面路径')))];
    if (!paths.length) continue;
    if (paths.length > 1) throw Error(`有多张 ${ratio} 候选封面，请在片场为 B 站登记一张明确的封面`);
    const file = projectFile(root, paths[0]);
    if (!['.png', '.jpg', '.jpeg'].includes(path.extname(file).toLowerCase()) || fs.statSync(file).size === 0) {
      throw Error('封面需要非空的 PNG 或 JPEG 图片');
    }
    covers[ratio] = file;
  }
  return covers;
}
