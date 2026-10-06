# Standard video creative contract

The standard video shortcut in official meta-ads CLI 1.1.0 emits unsupported `video_data.description` and `video_data.link_url`. Video URL creates therefore use the same canonical builder on both transports: one Graph URL upload, bounded metadata reads, then official CLI raw JSON or the existing native Graph creative POST. The installed CLI is unchanged.

| Engine input / value | Creative field | Contract |
|---|---|---|
| Posting Page | `object_story_spec.page_id` | Existing verified identity binding |
| Instagram identity | `object_story_spec.instagram_user_id` | Omitted for verified Page-only identity |
| Uploaded video ID | `object_story_spec.video_data.video_id` | Graph `/act_ACCOUNT/advideos` response; not a root creative field |
| Thumbnail | `video_data.image_url` | HTTPS picture from that video; preferred thumbnail edge fallback if absent |
| Thumbnail alternative | `video_data.image_hash` | Canonical builder supports exactly one URL or hash; automatic URL workflow uses URL |
| Headline | `video_data.title` | No image-ad `name` alias |
| Primary text | `video_data.message` | Passed unchanged |
| Description | `video_data.link_description` | Never `video_data.description` |
| Destination / CTA | `video_data.call_to_action.{type,value.link}` | Never `video_data.link_url`; default LEARN_MORE for a link |
| Tracking | root `url_tags` | Verbatim dynamic macros |
| Enhancement choices | root `degrees_of_freedom_spec` | Existing validated caller choice / handler's all-off default |

`buildMetaVideoCreativePayload` is exported for payload validation. The raw CLI create uses only name, object-story-spec, url-tags and degrees-of-freedom-spec flags; no video/body/title/link-url/description shortcut is combined with raw mode. Direct Graph uses the same payload. Existing image and asset-feed transports retain their contracts; this does not change multi-video placement eligibility or revive the retired desktop local write lane.

Media upload uses form-encoded `file_url`, name and title on the account's `advideos` edge. Native requests carry the stored token only in the Authorization header. CLI credentials must carry that stored token for this video workflow; ambient CLI authentication alone cannot authorize native media requests.

Every media HTTP request is single-attempt. Only HTTP 200 with `status.video_status=processing` permits another read, at most ten status reads separated by three seconds. The optional thumbnail edge adds one request. Preparation therefore costs at most twelve HTTP requests (upload + ten status reads + thumbnail); the final creative adds one request. The embedding cloud host meters that final create separately. A throttle, transport failure, terminal processing state or missing thumbnail stops immediately. Processing-phase error codes/messages are retained and redacted. Once upload succeeds, any later failure retains partial-write uncertainty and never retries the upload/create automatically. Ad creation remains separately forced PAUSED.

Evidence: installed official CLI 1.1.0 offline expansion and SDK 25.0.2; SDK `AdCreativeVideoData`, `AdCreativeObjectStorySpec`, `AdAccount.create_ad_video`, `AdAccount.create_ad_creative`, and `VideoStatus` declarations. An authorized operator separately validated the complete image_url + link_description + Page/Instagram + tracking + all-off enhancement payload with `execution_options=[validate_only]` and received success. This does not certify every objective, placement or account; provider validation remains authoritative. Regression fixtures preserve both recorded exit-4 refusals with media names redacted.
