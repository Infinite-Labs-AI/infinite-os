import { MetaCreativeSpecError } from './meta-creative-specs.js';
import type { MetaCreativeCreateInput } from './index.js';

export type MetaVideoThumbnail = { imageUrl: string; imageHash?: never } | { imageHash: string; imageUrl?: never };
/** Canonical v25 video shape; raw CLI and Graph submit the same creative fields. CTA is normalized by the caller. */
export function buildMetaVideoCreativePayload(input: MetaCreativeCreateInput, videoId: string, thumbnail: MetaVideoThumbnail): Record<string, unknown> {
  if (!input.pageId?.trim() || !/^\d+$/.test(videoId)) throw new MetaCreativeSpecError('A video creative needs its posting Page and uploaded video ID');
  const imageUrl = thumbnail.imageUrl, imageHash = thumbnail.imageHash;
  if (!!imageUrl === !!imageHash || imageUrl && !/^https:\/\//i.test(imageUrl)) throw new MetaCreativeSpecError('A video creative needs exactly one HTTPS thumbnail URL or image hash');
  const video: Record<string, unknown> = { video_id: videoId, ...(imageUrl ? { image_url: imageUrl } : { image_hash: imageHash }) };
  if (input.title) video.title = input.title;
  if (input.body) video.message = input.body;
  if (input.description) video.link_description = input.description;
  if (input.linkUrl) video.call_to_action = { type: input.callToAction ?? 'LEARN_MORE', value: { link: input.linkUrl } };
  else if (input.callToAction) video.call_to_action = { type: input.callToAction };
  return {
    name: input.name,
    object_story_spec: { page_id: input.pageId, ...(input.instagramUserId ? { instagram_user_id: input.instagramUserId } : {}), video_data: video },
    ...(input.urlTags ? { url_tags: input.urlTags } : {}),
    ...(input.degreesOfFreedomSpec ? { degrees_of_freedom_spec: input.degreesOfFreedomSpec } : {}),
  };
}
