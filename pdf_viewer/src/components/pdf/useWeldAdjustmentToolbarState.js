import {useCallback, useEffect, useLayoutEffect, useRef} from 'react';

// Parent callbacks may change on every render. Publish a stable action entry
// so reporting toolbar state cannot trigger another parent/child update cycle.
// Update its target after commit to keep page/annotation data current.
export function useWeldAdjustmentToolbarState({available, mode, handleAction, onStateChange}) {
  const actionRef = useRef(handleAction);
  useLayoutEffect(() => {
    actionRef.current = handleAction;
  }, [handleAction]);

  const dispatchAction = useCallback(action => actionRef.current?.(action), []);
  useEffect(() => {
    onStateChange?.({available, mode, handleAction: dispatchAction});
  }, [available, mode, onStateChange, dispatchAction]);
}
