// Server images may be reduced to satisfy a pixel cap. Their raster scale is
// not necessarily 1.25; persist the same geometry used by the direct loader.
export const getRemotePageSnapshotScale = pageInfo => {
  const renderScale = Number(pageInfo?.renderScale);
  // Legacy manifests predate adaptive raster scaling and used 1.25 throughout.
  return Number.isFinite(renderScale) && renderScale > 0 ? renderScale / 2 : 0.625;
};

export const createRemotePageSnapshotRecord = ({ key, scope, pageNumber, pageInfo, blob }) => ({
  key,
  scope,
  pageNumber: Number(pageNumber),
  scale: getRemotePageSnapshotScale(pageInfo),
  blob,
  cssWidth: Number(pageInfo?.width || 1),
  cssHeight: Number(pageInfo?.height || 1),
  size: blob.size
});
