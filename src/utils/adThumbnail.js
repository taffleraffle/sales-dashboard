/*
  Shared thumbnail-source picker for ads. Used by AdCard, AdThumbnail,
  and any creative-list rendering.

  Precedence (matches what metaAdsSync stores):
    1. asset_url (for both image and video — populated for both)
    2. thumbnail_url (Meta-generated poster for video; fallback for image)
*/

export function pickThumbnail(ad) {
  if (!ad) return null
  if (ad.asset_type === 'image' && ad.asset_url) return ad.asset_url
  if (ad.asset_type === 'video' && ad.asset_url) return ad.asset_url
  return ad.thumbnail_url || null
}
