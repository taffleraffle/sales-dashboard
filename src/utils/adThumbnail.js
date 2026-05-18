/*
  Shared thumbnail-source picker for ads. Used by AdCard, AdThumbnail,
  and any creative-list rendering.

  Precedence (matches what metaAdsSync stores):
    1. asset_url (for both image and video — populated for both)
    2. thumbnail_url (Meta-generated poster for video; fallback for image)
*/

export function pickThumbnail(ad) {
  if (!ad) return null
  // asset_url is the highest-fidelity image we extracted (image_url, photo_data,
  // video poster, link picture, or first carousel card). It works for every
  // asset_type — don't gate on asset_type since 'carousel' and 'unknown' rows
  // still have valid asset_urls now (see metaAdsSync.extractImageUrl).
  return ad.asset_url || ad.thumbnail_url || null
}
