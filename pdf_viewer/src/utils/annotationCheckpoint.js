export function collectChangedAnnotationPages(previous, next) {
  const pages = new Set([...(previous?.byPage?.keys() || []), ...(next?.byPage?.keys() || [])]);
  return Array.from(pages).filter(page => previous?.byPage?.get(page) !== next?.byPage?.get(page));
}

export function acknowledgeCheckpointPages(pending, saved) {
  saved.forEach((revision, page) => {
    if (pending.get(page) === revision) pending.delete(page);
  });
}
