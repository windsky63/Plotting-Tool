import { useEffect, useLayoutEffect, useRef } from 'react';

// Recognition belongs to a document/page/mode session, not a render. Publishing
// progress or updating annotations must neither cancel nor repeat the request.
export function useWeldAdjustmentPipelineSync(options) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });
  const { page, mode, documentKey } = options;
  useEffect(() => {
    if (!mode) return undefined;
    let cancelled = false;
    const isCurrent = () => !cancelled && latest.current.page === page &&
      latest.current.mode === mode && latest.current.documentKey === documentKey;
    const initial = latest.current;
    const context = initial.context;
    const task = Number(context?.page) === Number(page) && context?.status === 'resolved'
      ? Promise.resolve(context)
      : initial.resolve(page, initial.welds, isCurrent);
    Promise.resolve(task).then(result => {
      if (isCurrent()) latest.current.apply(result);
    }).catch(error => {
      if (isCurrent()) console.error('焊点调整管线号回填失败:', error);
    });
    return () => { cancelled = true; };
  }, [page, mode, documentKey]);
}
