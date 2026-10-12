import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Document, Page, pdfjs } from 'react-pdf';
import { Spin, Alert, Empty, message, Modal, Input, Button, Table, Drawer, Select, Space, InputNumber, Progress } from 'antd';
import {
  ViewerContainer,
  PageViewport,
  PageContainer,
  AnnotationLayer,
  LoadingContainer,
  EmptyContainer,
  MaterialInputContainer,
  SmoothLoader,
  PageSkeleton,
  FadeInPage,
  MaterialInputTitle,
  MaterialInputRow,
  MaterialInputField,
  MaterialInputSeparator,
  MaterialInputButton,
  SelectionRectangle
} from './pdf/styles/PDFViewerStyles';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { ScanOutlined, TableOutlined, DownloadOutlined, PlusOutlined, ScissorOutlined, DeleteOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import { OCRRegionSelector, OCRResultVisualization } from './OCR';
import { useOCRContext } from '../contexts/OCRContext';
import { usePDFDocumentManager } from './pdf/PDFDocumentManager';
import { usePDFEventHandlers } from './pdf/PDFEventHandlers';
import { usePDFAnnotations } from './pdf/PDFAnnotations';
import { useMaterialInput } from './pdf/MaterialInput';
import MemoizedAnnotationWrapper from './pdf/MemoizedAnnotationWrapper';
import AnnotationDragPreview from './pdf/AnnotationDragPreview';
import { useWeldAdjustmentPipelineSync } from './pdf/useWeldAdjustmentPipelineSync';
import { usePDFUtils } from './pdf/PDFUtils';
import { OCRUtils } from '../utils/ocrUtils';
import auditLogService from '../services/auditLogService';
import { enrichTextDetectionResult, sanitizeRecognizedPipelineNumber } from '../utils/pipelineDetectionUtils';
import { VectorExtractionUtils } from '../utils/vectorExtractionUtils';
import { VectorVisualizer } from './debug/VectorVisualizer';
import { VectorDebugToggle } from './debug/VectorDebugToggle';
import { WeldDebugToggle } from './debug/WeldDebugToggle';
import { WeldBatchNumberToggle } from './debug/WeldBatchNumberToggle';
import { WeldNumberOverlay } from './debug/WeldNumberOverlay';
import { calculateWeldLayout, PDF_LAYOUT_BASE_SCALE } from '../utils/WeldLayoutEngine';
import { TextDetectionToggle } from './debug/TextDetectionToggle';
import { WeldRuleConfig } from './debug/WeldRuleConfig';
import { DebugExportButton } from './debug/DebugExportButton';
import { WeldExportButton } from './debug/WeldExportButton';
import { PipelineDebugToggle } from './debug/PipelineDebugToggle';
import { PipelineOverlay } from './debug/PipelineOverlay';
import { MultiPageProcessPanel } from './debug/MultiPageProcessPanel';
import { MaterialRecognitionPanel } from './debug/MaterialRecognitionPanel';
import BookmarkPanel from './BookmarkPanel';
import { BookOutlined, BranchesOutlined } from '@ant-design/icons';
import { initGlobalWeldTextCheck } from '../utils/QuickWeldTextCheck';
import { associateWeldsWithSingleSegmentVectors } from '../utils/PipelineNetworkUtils';
import { ObjectRecognizer } from '../utils/ObjectRecognizer';
import { VectorSpatialIndex } from '../utils/VectorSpatialIndex';
import { getWeldSelectionKey } from '../utils/WeldSmartSorter';
import { initGlobalPipelineCheck } from '../utils/QuickPipelineCheck';
import {
  getAnnotationPageSizeFromSnapshot,
  getFixedA3TenMmFrameSize,
  isFixedA3TenMmShape,
  scaleAnnotationValue
} from '../utils/pageAnnotationScale';
import {
  assignCompactWeldNumbers,
  bindPipelineToMatchingPages,
  buildCrossPageNumberingScopes,
  getPageScopedNumberingSegmentPatternKey,
  getOverlappingSegmentIndexes,
  insertManualWeldIntoSequence,
  moveWeldRangeInSequence,
  removeManualWeldFromSequence,
  removeWeldsFromSequence,
  resolveManualInsertContext,
  resolvePipelineNumberConflicts,
  reserveManualInsertNumber
} from '../utils/manualWeldSequenceUtils';
import multiPageBatchService from '../services/multiPageBatchService';
import {
  buildReopenedAnnotationRule,
  buildReopenedWeldSequence,
  findReopenedWeldTemplate,
  isRecoverableWeldAnnotation,
  resolvePipelineFromWeldAnnotations
} from '../utils/reopenedWeldSequenceUtils';
import {
  buildWeldAdjustmentDelta,
  compactReplacementSourceIds,
  prepareWeldAdjustmentPreview
} from '../utils/weldAdjustmentDeltaUtils';
import { getWeldDisplayAffixKey } from '../utils/weldDisplayNumberUtils';
import {
  closePdfPageSnapshotCache,
  getPdfPageSnapshot,
  listPdfSnapshotPages,
  pruneLegacyScalePdfPageSnapshots,
  pruneOldPdfPageSnapshots,
  putPdfPageSnapshot
} from '../utils/pdfPageSnapshotCache';
import { formatSplitCircleTopText } from '../utils/splitCircleTextUtils';
import {
  inferSheetPdfPageRange,
  parseSheetPageReference,
  validateSheetPdfPageRange
} from '../utils/sheetPageGroupUtils';
import { buildAnnotationPipelineUpdates } from '../utils/annotationPipelineUtils';
import {
  BACKGROUND_CACHE_INTERACTION_QUIET_MS,
  getBackgroundCacheCooldown,
  getBackgroundCacheDeferral
} from '../utils/backgroundPdfCacheScheduling';
import { touchBoundedMapEntry, touchExistingMapEntry } from '../utils/boundedLruCache';
import { configurePdfJsRuntime, PDFJS_WORKER_FILE } from '../utils/pdfjsRuntime';
import {
  getCanvasDevicePixelRatio,
  getCanvasPerformanceProfile
} from '../utils/canvasPerformanceProfiles';
import {
  acquireDirectionalPreviewRequest,
  getDirectionalPreviewCacheKey,
  getDirectionalPreviewPages,
  isDirectionalPreviewStateForScope,
  releaseDirectionalPreviewRequest
} from '../utils/directionalPreviewCache';
import {
  buildPreviewPageAnnotationMap,
  createPageAnnotationIndex,
  getPageAnnotationRevision,
  getPageAnnotations as getIndexedPageAnnotations
} from '../utils/pageAnnotationIndex';
import {
  createAnnotationRenderCacheEntry,
  createPageSelectionKey,
  isAnnotationRenderCacheHit
} from '../utils/annotationRenderCache';
import '../utils/DiagnoseWeldTextCoordinates';
import '../utils/DebugWeldTextMatch';

// Bundle the exact worker paired with react-pdf/pdfjs-dist. This avoids API and
// worker version drift and keeps production independent from a public CDN.
const pdfWorkerUrl = `${process.env.PUBLIC_URL || ''}/${PDFJS_WORKER_FILE}`;
configurePdfJsRuntime(pdfjs, pdfWorkerUrl);
VectorExtractionUtils.configurePdfJs(pdfjs);

// Keep the expensive PDF Canvas independent from annotation/sidebar state.
// Fresh callback props previously allowed react-pdf to redraw cached pages.
const CachedPdfCanvasPage = React.memo(({
  pageNumber,
  renderScale,
  devicePixelRatio,
  onLoadSuccess,
  onRenderSuccess,
  onRenderError
}) => {
  const handleRenderSuccess = useCallback(
    () => onRenderSuccess(pageNumber),
    [onRenderSuccess, pageNumber]
  );
  const handleRenderError = useCallback(
    error => onRenderError(error, pageNumber),
    [onRenderError, pageNumber]
  );
  return (
    <Page
      pageNumber={pageNumber}
      scale={renderScale}
      devicePixelRatio={devicePixelRatio}
      onLoadSuccess={onLoadSuccess}
      onRenderSuccess={handleRenderSuccess}
      onRenderError={handleRenderError}
      renderTextLayer={false}
      renderAnnotationLayer={false}
      loading={(
        <SmoothLoader>
          <Spin size="large" tip="页面加载中..." />
        </SmoothLoader>
      )}
    />
  );
});

CachedPdfCanvasPage.displayName = 'CachedPdfCanvasPage';


// 样式组件已移动到 ./pdf/styles/PDFViewerStyles.js



const PDFViewer = ({
  file,
  pdfFilePath,
  currentPage,
  scale,
  canvasPerformanceMode = 'smooth',
  onPageChange,
  onScaleChange,
  onTotalPagesChange,
  onPageSizeChange,
  onPdfDocumentChange,
  searchText,
  searchResults,
  currentSearchIndex,
  annotationMode,
  annotations,
  annotationPageIndex = null,
  batchSequenceState = null,
  onBatchSequenceStateChange,
  annotationColor,
  annotationFontSize,
  annotationTopFontSize,
  annotationBottomFontSize,
  annotationFrameSize,
  annotationBorderShape,
  annotationPipeTagRotation,
  annotationPipeTagZeroPadCount = 0,
  activeAnnotationRule,
  annotationRules = [],
  onAnnotationAdd,
  onAnnotationUpdate,
  onAnnotationMoveCommit,
  onBatchAnnotationUpdates,
  onAnnotationDelete,
  onAddScaffoldAnnotation,
  onBatchAddScaffoldAnnotations,
  onBatchAddAnnotations, // 新增：通用批量添加标注回调
  onApplyWeldAdjustment,
  onBatchDeleteAnnotations, // 新增：批量删除标注回调
  selectedAnnotation,
  selectedAnnotationIds = [],
  onAnnotationClick,
  onAnnotationSelectionChange,
  onAnnotationEdit, // 新增：用于双击直接编辑标注
  pipeSegmentMode,
  pipeSegmentCounter,
  onPipeSegmentCounterUpdate,
  generatePipeSegmentLetter,
  pipeSegmentFontSize,
  pipeSegmentZeroPadWidth = 0,
  viewMode = 'single',
  pageRecognitionData = {},
  onPageTextDetectionsChange,
  onMaterialRowsChange,
  materialRows = [],
  materialScope = 'pipeline',
  projectName = '',
  onExecuteUndoableCommand,
  recognitionCache = null, // 识别数据缓存管理器，批量识别时优先从此获取数据
  rulesPanelVisible, // 新增：控制右侧规则面板可见性时的布局调整
  areaDeleteMode, // 新增：区域删除模式
  onAreaDelete, // 新增：区域删除回调
  onPdfPointerPositionChange,
  debugButtonsContainerRef, // 新增：调试按钮容器的ref，用于Portal渲染
  onWeldAdjustmentStateChange
}) => {
  // Server-side page snapshots are used by both the 3004 mirror and the
  // validated production deployment. Keep the test flag as an alias so
  // the mirror remains backwards compatible, while production opts in via a
  // separate build-time switch.
  const serverPageCacheMode = (
    process.env.REACT_APP_TEST_MIRROR === 'true' ||
    process.env.REACT_APP_SERVER_PAGE_CACHE === 'true'
  );
  // 3004-only experiment: a completed server snapshot may paint before
  // react-pdf finishes parsing the document, and cached pages do not need a
  // second PDF.js Canvas render just to remain visible.
  const imageFirstPdfMode = (
    process.env.REACT_APP_TEST_MIRROR === 'true' ||
    process.env.REACT_APP_IMAGE_FIRST_PDF === 'true'
  );
  const annotationDragPreviewRefs = useRef(new Map());
  const handleAnnotationDragPreview = useCallback((previewAnnotations) => {
    const pages = new Map();
    previewAnnotations.forEach(annotation => {
      const page = Number(annotation.page);
      if (!pages.has(page)) pages.set(page, []);
      pages.get(page).push(annotation);
    });
    annotationDragPreviewRefs.current.forEach((preview, page) => {
      if (pages.has(page)) preview.update(pages.get(page));
      else preview.clear();
    });
  }, []);

  // 使用PDF文档管理Hook
  const {
    numPages,
    loading,
    error,
    pageRefs,
    pageCache,
    pageSize,
    setNumPages,
    setLoading,
    setError,
    setPageSize,
    onDocumentLoadSuccess,
    onDocumentLoadError,
    onPageLoadSuccess,
    setPageRef,
    createPageRefCallback,
    cleanupCache,
    pageRefsRef,
    pageObjectsRef,
    scrollTimeoutRef
  } = usePDFDocumentManager({
    currentPage,
    onTotalPagesChange,
    onPageSizeChange
  });
  const containerRef = useRef(null);
  const wheelThrottleRef = useRef(null); // 滚轮事件节流引用
  const pdfPointerFrameRef = useRef(null);
  const latestPdfPointerRef = useRef(null);
  const singlePageRenderAttemptRef = useRef({ key: '', page: 0, startedAt: 0 });
  const renderedSinglePagesRef = useRef(new Set());
  const singlePageSnapshotCacheRef = useRef(new Map());
  const singlePagePreviewCacheRef = useRef(new Map());
  const singlePagePreviewPendingRef = useRef(new Map());
  const singlePageSnapshotPendingRef = useRef(new Set());
  const singlePageSnapshotPrefetchRef = useRef(new Set());
  const singlePageSnapshotGenerationRef = useRef(0);
  const lastPdfInteractionAtRef = useRef(Date.now());
  const pdfHiddenSinceRef = useRef(0);
  const lastIdleRuntimeReleaseAtRef = useRef(0);
  const snapshotLoadsSuspendedRef = useRef(false);
  const [singlePageSnapshotVersion, setSinglePageSnapshotVersion] = useState(0);
  const [singlePagePreviewVersion, setSinglePagePreviewVersion] = useState(0);
  const [singlePageLiveCanvasKey, setSinglePageLiveCanvasKey] = useState('');
  const [remotePageCacheState, setRemotePageCacheState] = useState({
    scope: '', cacheId: '', pages: {}, previews: {}, status: 'idle'
  });
  const [remoteCanvasFallbackPage, setRemoteCanvasFallbackPage] = useState(0);
  const [remotePageCacheRetryNonce, setRemotePageCacheRetryNonce] = useState(0);
  const remotePageCacheAbortRef = useRef(null);
  const currentRemotePageFetchRef = useRef({ page: 0, key: '', controller: null });
  const remotePageWarmRef = useRef(new Set());
  const fullPagePrefetchBlockedRef = useRef({ scope: '', blocked: false });
  const singlePageSnapshotDecodeHandlesRef = useRef(new Map());
  const singlePageSnapshotDiskIndexRef = useRef({ scope: '', ready: false, pages: new Set() });
  const singlePageSnapshotScopeRef = useRef('');
  const [singlePageSnapshotDiskIndexVersion, setSinglePageSnapshotDiskIndexVersion] = useState(0);
  const singlePagePreloadTaskRef = useRef(null);
  const singlePagePreloadQueueRef = useRef([]);
  const singlePageCurrentRef = useRef(Number(currentPage) || 1);
  const singlePagePreviousRef = useRef(Number(currentPage) || 1);
  const singlePageDirectionRef = useRef(0);
  const singlePageScaleRef = useRef(Number(scale) || 1);
  const [singlePageMountedPages, setSinglePageMountedPages] = useState(() => [Number(currentPage) || 1]);
  // Rendering hidden neighbouring pages made rapid paging slower: an already
  // started pdf.js Canvas task cannot be cancelled by cancelling our idle
  // timer, so old hidden-page work accumulated ahead of the visible page.
  // Keep only the visible page mounted; PDF.js still retains its lightweight
  // document/page caches without competing full-resolution Canvas renders.
  const singlePageCacheRadius = 0;
  const singlePageCacheLimit = singlePageCacheRadius * 2 + 1;
  const [renderMode, setRenderMode] = useState('svg'); // Default to SVG for better quality

  singlePageScaleRef.current = Number(scale) || 1;

  const singlePageSnapshotDocumentKey = useMemo(() => {
    if (pdfFilePath) return String(pdfFilePath);
    return [file?.name || 'pdf', file?.size || 0, file?.lastModified || 0].join(':');
  }, [file, pdfFilePath]);
  const canvasPerformanceProfile = useMemo(() => getCanvasPerformanceProfile(
    canvasPerformanceMode,
    {
      deviceMemoryGb: typeof navigator !== 'undefined' ? navigator.deviceMemory : 0,
      hardwareConcurrency: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0
    }
  ), [canvasPerformanceMode]);
  const singlePageSnapshotLimitBytes = canvasPerformanceProfile.snapshotLimitBytes;
  const singlePageSnapshotMaxEntries = canvasPerformanceProfile.snapshotMaxEntries;
  const singlePageSnapshotMaxPixels = canvasPerformanceProfile.snapshotMaxPixels;
  const getPageBasePixels = useCallback((pageNumber) => {
    const pageInfo = pageCache.get(Number(pageNumber));
    const resolutionWidth = Number(pageInfo?.resolution?.width || 0);
    const resolutionHeight = Number(pageInfo?.resolution?.height || 0);
    if (resolutionWidth > 0 && resolutionHeight > 0) return resolutionWidth * resolutionHeight;
    // PDFDocumentManager stores dimensions at the fixed 2x display baseline.
    // This fallback is mainly used while a new page's own metadata is loading.
    const fallbackWidth = Number(pageSize?.width || 0) / 2;
    const fallbackHeight = Number(pageSize?.height || 0) / 2;
    return fallbackWidth > 0 && fallbackHeight > 0 ? fallbackWidth * fallbackHeight : 0;
  }, [pageCache, pageSize]);
  const getForegroundCanvasDpr = useCallback((pageNumber, renderScale) => getCanvasDevicePixelRatio({
    profile: canvasPerformanceProfile,
    renderScale,
    basePagePixels: getPageBasePixels(pageNumber),
    nativeDevicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1
  }), [canvasPerformanceProfile, getPageBasePixels]);
  useEffect(() => {
    window.__pdfCanvasPerformanceInfo = {
      ...canvasPerformanceProfile,
      nativeDevicePixelRatio: Number(window.devicePixelRatio || 1),
      currentPage: Number(currentPage) || 1,
      currentRenderScale: (Number(scale) || 1) * 2,
      currentDevicePixelRatio: getForegroundCanvasDpr(
        Number(currentPage) || 1,
        (Number(scale) || 1) * 2
      )
    };
  }, [canvasPerformanceProfile, currentPage, getForegroundCanvasDpr, scale]);
  // Keep one durable snapshot per PDF page. UI zoom only changes its CSS
  // dimensions; it must not create another full-document IndexedDB cache.
  // The version suffix prevents old scale-specific records from colliding
  // with the new coordinate-independent key format.
  const singlePageSnapshotScope = useMemo(() => (
    `${singlePageSnapshotDocumentKey}|snapshot:v2`
  ), [singlePageSnapshotDocumentKey]);
  const remotePageCacheStateMatchesScope = isDirectionalPreviewStateForScope(
    remotePageCacheState,
    singlePageSnapshotScope
  );
  singlePageSnapshotScopeRef.current = singlePageSnapshotScope;
  useEffect(() => {
    singlePageSnapshotDiskIndexRef.current = {
      scope: singlePageSnapshotScope,
      ready: false,
      pages: new Set()
    };
    fullPagePrefetchBlockedRef.current = { scope: singlePageSnapshotScope, blocked: false };
    setSinglePageSnapshotDiskIndexVersion(version => version + 1);
  }, [singlePageSnapshotScope]);
  useEffect(() => {
    if (!serverPageCacheMode) return undefined;
    let cancelled = false;
    Promise.allSettled([
      pruneOldPdfPageSnapshots(),
      pruneLegacyScalePdfPageSnapshots()
    ]).then(() => listPdfSnapshotPages(singlePageSnapshotScope)).then(pages => {
      if (cancelled) return;
      const index = singlePageSnapshotDiskIndexRef.current;
      if (index.scope !== singlePageSnapshotScope) return;
      pages.forEach(page => index.pages.add(Number(page)));
      index.ready = true;
      setSinglePageSnapshotDiskIndexVersion(version => version + 1);
    }).catch(error => {
      if (cancelled) return;
      console.warn('[PDF页面缓存] 读取本机快照索引失败:', error);
      const index = singlePageSnapshotDiskIndexRef.current;
      if (index.scope !== singlePageSnapshotScope) return;
      index.ready = true;
      setSinglePageSnapshotDiskIndexVersion(version => version + 1);
    });
    return () => { cancelled = true; };
  }, [serverPageCacheMode, singlePageSnapshotScope]);
  const getSinglePageSnapshotKey = useCallback(pageNumber => (
    `${singlePageSnapshotScope}|page:${Number(pageNumber)}`
  ), [singlePageSnapshotScope]);
  const notifySinglePageSnapshotPersisted = useCallback((pageNumber) => {
    const normalizedPage = Number(pageNumber);
    if (!Number.isInteger(normalizedPage) || normalizedPage < 1) return;
    const index = singlePageSnapshotDiskIndexRef.current;
    if (index.scope !== singlePageSnapshotScope) return;
    if (!index.pages.has(normalizedPage)) {
      index.pages.add(normalizedPage);
      setSinglePageSnapshotDiskIndexVersion(version => version + 1);
    }
    window.dispatchEvent(new CustomEvent('pdf-page-snapshot-cached', {
      detail: {
        scope: singlePageSnapshotScope,
        pageNumber: normalizedPage
      }
    }));
  }, [singlePageSnapshotScope]);
  const invalidateSinglePageSnapshotDiskEntry = useCallback((pageNumber) => {
    const index = singlePageSnapshotDiskIndexRef.current;
    if (index.scope !== singlePageSnapshotScope) return;
    if (index.pages.delete(Number(pageNumber))) {
      setSinglePageSnapshotDiskIndexVersion(version => version + 1);
    }
  }, [singlePageSnapshotScope]);
  const clearSinglePageSnapshots = useCallback(() => {
    singlePageSnapshotGenerationRef.current += 1;
    const activeFetch = currentRemotePageFetchRef.current;
    activeFetch?.controller?.abort?.();
    if (activeFetch?.key) singlePageSnapshotPendingRef.current.delete(activeFetch.key);
    currentRemotePageFetchRef.current = { page: 0, key: '', controller: null };
    singlePageSnapshotDecodeHandlesRef.current.forEach((handle, key) => {
      handle.image.onload = null;
      handle.image.onerror = null;
      try { handle.image.src = ''; } catch (error) { /* already released */ }
      if (handle.url) URL.revokeObjectURL(handle.url);
      singlePageSnapshotPendingRef.current.delete(key);
    });
    singlePageSnapshotDecodeHandlesRef.current.clear();
    const removed = singlePageSnapshotCacheRef.current.size;
    singlePageSnapshotCacheRef.current.forEach(item => {
      if (item?.url) URL.revokeObjectURL(item.url);
    });
    singlePageSnapshotCacheRef.current.clear();
    singlePageSnapshotPendingRef.current.clear();
    singlePagePreviewCacheRef.current.forEach(item => {
      if (item?.decodedImage) {
        try { item.decodedImage.src = ''; } catch (error) { /* already released */ }
      }
      if (item?.url) URL.revokeObjectURL(item.url);
    });
    singlePagePreviewCacheRef.current.clear();
    singlePagePreviewPendingRef.current.clear();
    setSinglePageSnapshotVersion(version => version + 1);
    setSinglePagePreviewVersion(version => version + 1);
    return removed;
  }, []);

  const trimSinglePageSnapshotsToCurrent = useCallback(() => {
    const keepKey = getSinglePageSnapshotKey(singlePageCurrentRef.current);
    singlePageSnapshotGenerationRef.current += 1;
    singlePageSnapshotDecodeHandlesRef.current.forEach((handle, key) => {
      if (key === keepKey) return;
      handle.image.onload = null;
      handle.image.onerror = null;
      try { handle.image.src = ''; } catch (error) { /* already released */ }
      if (handle.url) URL.revokeObjectURL(handle.url);
      singlePageSnapshotDecodeHandlesRef.current.delete(key);
      singlePageSnapshotPendingRef.current.delete(key);
    });
    Array.from(singlePageSnapshotPendingRef.current).forEach(key => {
      if (key !== keepKey) singlePageSnapshotPendingRef.current.delete(key);
    });
    singlePageSnapshotPrefetchRef.current.clear();
    let removed = 0;
    singlePageSnapshotCacheRef.current.forEach((item, key) => {
      if (key === keepKey) return;
      if (item?.url) URL.revokeObjectURL(item.url);
      singlePageSnapshotCacheRef.current.delete(key);
      removed += 1;
    });
    if (removed > 0) setSinglePageSnapshotVersion(version => version + 1);
    return removed;
  }, [getSinglePageSnapshotKey]);

  const installSinglePageSnapshot = useCallback(({
    pageNumber,
    blob,
    cssWidth,
    cssHeight,
    snapshotScale,
    persist = false
  }) => {
    if (!blob) return;
    const key = getSinglePageSnapshotKey(pageNumber);
    const generation = singlePageSnapshotGenerationRef.current;
    const url = URL.createObjectURL(blob);
    const preloadImage = new Image();
    const previousDecode = singlePageSnapshotDecodeHandlesRef.current.get(key);
    if (previousDecode) {
      previousDecode.image.onload = null;
      previousDecode.image.onerror = null;
      try { previousDecode.image.src = ''; } catch (error) { /* already released */ }
      if (previousDecode.url) URL.revokeObjectURL(previousDecode.url);
    }
    const decodeHandle = { image: preloadImage, url };
    singlePageSnapshotDecodeHandlesRef.current.set(key, decodeHandle);
    const releasePreloadImage = (revokeUrl = false) => {
      preloadImage.onload = null;
      preloadImage.onerror = null;
      try { preloadImage.src = ''; } catch (error) { /* already released */ }
      if (singlePageSnapshotDecodeHandlesRef.current.get(key) === decodeHandle) {
        singlePageSnapshotDecodeHandlesRef.current.delete(key);
      }
      if (revokeUrl) URL.revokeObjectURL(url);
    };
    preloadImage.onload = () => {
      if (singlePageSnapshotGenerationRef.current !== generation) {
        singlePageSnapshotPendingRef.current.delete(key);
        releasePreloadImage(true);
        return;
      }
      singlePageSnapshotPendingRef.current.delete(key);
      const cache = singlePageSnapshotCacheRef.current;
      const previous = cache.get(key);
      if (previous?.url) URL.revokeObjectURL(previous.url);
      cache.set(key, {
        url,
        size: blob.size,
        cssWidth,
        cssHeight,
        snapshotScale: Number(snapshotScale) || 1,
        lastUsed: Date.now()
      });
      let totalBytes = Array.from(cache.values()).reduce(
        (total, item) => total + Number(item?.size || 0),
        0
      );
      if (cache.size > singlePageSnapshotMaxEntries || totalBytes > singlePageSnapshotLimitBytes) {
        const candidates = Array.from(cache.entries())
          .filter(([candidateKey]) => candidateKey !== key)
          .sort((left, right) => Number(left[1]?.lastUsed || 0) - Number(right[1]?.lastUsed || 0));
        while ((cache.size > singlePageSnapshotMaxEntries || totalBytes > singlePageSnapshotLimitBytes) && candidates.length > 0) {
          const [expiredKey, expired] = candidates.shift();
          cache.delete(expiredKey);
          totalBytes -= Number(expired?.size || 0);
          if (expired?.url) URL.revokeObjectURL(expired.url);
        }
      }
      window.__pdfVisitedPageCacheInfo = {
        pages: cache.size,
        bytes: totalBytes,
        limitBytes: singlePageSnapshotLimitBytes,
        maxEntries: singlePageSnapshotMaxEntries
      };
      setSinglePageSnapshotVersion(version => version + 1);
      if (persist) {
        putPdfPageSnapshot({
          key,
          scope: singlePageSnapshotScope,
          pageNumber: Number(pageNumber),
          scale: Number(snapshotScale) || 1,
          blob,
          cssWidth,
          cssHeight,
          size: blob.size
        }).then(() => {
          notifySinglePageSnapshotPersisted(pageNumber);
        }).catch(error => console.warn('[PDF页面缓存] 写入磁盘失败:', error));
      } else {
        // persist=false is used only for a snapshot that has just been read
        // from IndexedDB, so it is already a completed persistent cache entry.
        notifySinglePageSnapshotPersisted(pageNumber);
      }
      releasePreloadImage();
    };
    preloadImage.onerror = () => {
      singlePageSnapshotPendingRef.current.delete(key);
      releasePreloadImage(true);
    };
    preloadImage.src = url;
  }, [
    getSinglePageSnapshotKey,
    notifySinglePageSnapshotPersisted,
    singlePageSnapshotLimitBytes,
    singlePageSnapshotMaxEntries
  ]);

  const installSinglePagePreview = useCallback(({
    pageNumber,
    blob,
    cssWidth,
    cssHeight,
    snapshotScale,
    scope,
    pendingKey,
    requestToken
  }) => {
    if (!blob) return;
    const page = Number(pageNumber);
    const cacheKey = getDirectionalPreviewCacheKey(scope, page);
    const generation = singlePageSnapshotGenerationRef.current;
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      releaseDirectionalPreviewRequest(
        singlePagePreviewPendingRef.current,
        pendingKey,
        requestToken
      );
      const current = Number(singlePageCurrentRef.current) || 1;
      const direction = singlePageDirectionRef.current || 1;
      const isCurrentTarget = page === current || page === current + direction;
      if (
        singlePageSnapshotGenerationRef.current !== generation ||
        singlePageSnapshotScopeRef.current !== scope ||
        !isCurrentTarget
      ) {
        URL.revokeObjectURL(url);
        return;
      }
      const cache = singlePagePreviewCacheRef.current;
      const previous = cache.get(cacheKey);
      if (previous?.decodedImage) {
        try { previous.decodedImage.src = ''; } catch (error) { /* already released */ }
      }
      if (previous?.url) URL.revokeObjectURL(previous.url);
      cache.set(cacheKey, {
        pageNumber: page,
        scope,
        url,
        decodedImage: image,
        size: blob.size,
        cssWidth,
        cssHeight,
        snapshotScale: Number(snapshotScale) || 1,
        lastUsed: Date.now(),
        preview: true
      });
      const preferred = new Set([
        getDirectionalPreviewCacheKey(scope, current),
        getDirectionalPreviewCacheKey(scope, current + direction)
      ]);
      const evictionCandidates = Array.from(cache.entries())
        .filter(([candidate]) => !preferred.has(candidate))
        .sort((left, right) => Number(left[1]?.lastUsed || 0) - Number(right[1]?.lastUsed || 0));
      while (cache.size > 2) {
        const currentKey = getDirectionalPreviewCacheKey(scope, current);
        const [expiredKey, expired] = evictionCandidates.shift() || Array.from(cache.entries())
          .filter(([candidate]) => candidate !== currentKey)
          .sort((left, right) => Number(left[1]?.lastUsed || 0) - Number(right[1]?.lastUsed || 0))[0] || [];
        if (!expiredKey) break;
        cache.delete(expiredKey);
        if (expired?.decodedImage) {
          try { expired.decodedImage.src = ''; } catch (error) { /* already released */ }
        }
        if (expired?.url) URL.revokeObjectURL(expired.url);
      }
      image.onload = null;
      image.onerror = null;
      setSinglePagePreviewVersion(version => version + 1);
    };
    image.onerror = () => {
      releaseDirectionalPreviewRequest(
        singlePagePreviewPendingRef.current,
        pendingKey,
        requestToken
      );
      image.onload = null;
      image.onerror = null;
      URL.revokeObjectURL(url);
    };
    image.src = url;
  }, []);

    const captureSinglePageSnapshot = useCallback((pageNumber) => {
      const key = getSinglePageSnapshotKey(pageNumber);
      if (singlePageSnapshotCacheRef.current.has(key) || singlePageSnapshotPendingRef.current.has(key)) return 'ready';
      const canvas = containerRef.current?.querySelector(
        `[data-page-number="${Number(pageNumber)}"] canvas`
      );
      if (!canvas?.toBlob || !canvas.width || !canvas.height) return 'unavailable';
      if (canvas.width * canvas.height > singlePageSnapshotMaxPixels) {
        // Keep the visible PDF Canvas as-is. Skipping its PNG clone prevents a
        // transient second canvas from pushing a large drawing over memory.
        return 'skipped';
      }
      singlePageSnapshotPendingRef.current.add(key);
    const cssWidth = canvas.clientWidth || canvas.width;
    const cssHeight = canvas.clientHeight || canvas.height;
    canvas.toBlob(blob => {
      if (!blob) {
        singlePageSnapshotPendingRef.current.delete(key);
        return;
      }
      installSinglePageSnapshot({
        pageNumber,
        blob,
        cssWidth,
        cssHeight,
        snapshotScale: singlePageScaleRef.current,
        persist: true
      });
    }, 'image/png');
      return 'pending';
    }, [getSinglePageSnapshotKey, installSinglePageSnapshot, singlePageSnapshotMaxPixels]);

  const activeSinglePageSnapshot = useMemo(() => {
    // The version is intentionally part of this lookup so an asynchronously
    // completed PNG snapshot replaces the Canvas without another page change.
    void singlePageSnapshotVersion;
    const item = singlePageSnapshotCacheRef.current.get(getSinglePageSnapshotKey(currentPage));
    if (item) item.lastUsed = Date.now();
    return item || null;
  }, [currentPage, getSinglePageSnapshotKey, singlePageSnapshotVersion]);

  const activeSinglePagePreview = useMemo(() => {
    void singlePagePreviewVersion;
    const item = singlePagePreviewCacheRef.current.get(
      getDirectionalPreviewCacheKey(singlePageSnapshotScope, currentPage)
    );
    if (item) item.lastUsed = Date.now();
    return item || null;
  }, [currentPage, singlePagePreviewVersion, singlePageSnapshotScope]);
  const activeDisplayedPageSnapshot = activeSinglePageSnapshot || activeSinglePagePreview;

  const getAnnotationPageSize = useCallback((pageNumber) => {
    const normalizedPage = Number(pageNumber);
    const livePageSize = Number.isFinite(normalizedPage)
      ? pageCache.get(normalizedPage)?.size
      : null;
    if (livePageSize?.width > 0 && livePageSize?.height > 0) return livePageSize;

    // In image-first mode a cached page replaces the PDF.js <Page>, so
    // onPageLoadSuccess never fills pageCache. Recover the page dimensions
    // from the cached image instead of silently treating every page as A3.
    if (normalizedPage === Number(currentPage) && activeDisplayedPageSnapshot) {
      const snapshotPageSize = getAnnotationPageSizeFromSnapshot(activeDisplayedPageSnapshot);
      if (snapshotPageSize) return snapshotPageSize;
    }

    return pageSize;
  }, [
    activeDisplayedPageSnapshot,
    currentPage,
    pageCache,
    pageSize
  ]);
  const getWeldPreviewFrameSize = useCallback((pageNumber) => {
    const pendingRule = multiPageBatchService.getPendingBatchAnnotationRule();
    const shape = pendingRule?.borderShape || annotationBorderShape;
    return isFixedA3TenMmShape(shape)
      ? getFixedA3TenMmFrameSize(getAnnotationPageSize(pageNumber))
      : (Number(pendingRule?.frameSize) || Number(annotationFrameSize) || 56.7);
  }, [annotationBorderShape, annotationFrameSize, getAnnotationPageSize]);

  const activeSinglePageSnapshotDisplaySize = useMemo(() => {
    if (!activeDisplayedPageSnapshot) return null;
    const cachedScale = Number(activeDisplayedPageSnapshot.snapshotScale) || 1;
    const displayRatio = (Number(scale) || 1) / cachedScale;
    return {
      width: Math.max(1, Number(activeDisplayedPageSnapshot.cssWidth || 1) * displayRatio),
      height: Math.max(1, Number(activeDisplayedPageSnapshot.cssHeight || 1) * displayRatio)
    };
  }, [activeDisplayedPageSnapshot, scale]);

  const activeSinglePageSnapshotKnownOnDisk = useMemo(() => {
    void singlePageSnapshotDiskIndexVersion;
    const index = singlePageSnapshotDiskIndexRef.current;
    return index.scope === singlePageSnapshotScope &&
      index.ready &&
      index.pages.has(Number(currentPage));
  }, [currentPage, singlePageSnapshotDiskIndexVersion, singlePageSnapshotScope]);

  singlePageCurrentRef.current = Number(currentPage) || 1;

  const cancelSinglePagePreloadTask = useCallback(() => {
    const task = singlePagePreloadTaskRef.current;
    if (!task) return;
    if (task.type === 'idle' && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(task.id);
    } else {
      clearTimeout(task.id);
    }
    singlePagePreloadTaskRef.current = null;
  }, []);

  const scheduleNextSinglePagePreload = useCallback(() => {
    cancelSinglePagePreloadTask();
    const centerPage = singlePageCurrentRef.current;
    if (!renderedSinglePagesRef.current.has(centerPage)) return;
    const nextPage = singlePagePreloadQueueRef.current.shift();
    if (!Number.isFinite(nextPage)) return;

    const preload = () => {
      singlePagePreloadTaskRef.current = null;
      if (singlePageCurrentRef.current !== centerPage) return;
      setSinglePageMountedPages(previous => {
        if (previous.includes(nextPage)) return previous;
        return [...previous, nextPage].sort((left, right) => left - right);
      });
    };

    if (typeof window.requestIdleCallback === 'function') {
      singlePagePreloadTaskRef.current = {
        type: 'idle',
        id: window.requestIdleCallback(preload, { timeout: 800 })
      };
    } else {
      singlePagePreloadTaskRef.current = { type: 'timeout', id: setTimeout(preload, 120) };
    }
  }, [cancelSinglePagePreloadTask]);

  const scheduleAdjacentPagePreload = useCallback((pageNumber) => {
    cancelSinglePagePreloadTask();
    const centerPage = Number(pageNumber);
    if (!Number.isFinite(centerPage) || !numPages) return;

    const targetPages = Array.from(
      { length: singlePageCacheRadius * 2 + 1 },
      (_, index) => centerPage - singlePageCacheRadius + index
    ).filter(page => page >= 1 && page <= numPages);
    const targetSet = new Set(targetPages);
    setSinglePageMountedPages(previous => {
      const nextPages = previous.filter(page => targetSet.has(page));
      if (!nextPages.includes(centerPage)) nextPages.push(centerPage);
      nextPages.sort((left, right) => left - right);
      return previous.length === nextPages.length && previous.every((page, index) => page === nextPages[index])
        ? previous
        : nextPages;
    });

    const direction = singlePageDirectionRef.current;
    const offsets = [];
    for (let distance = 1; distance <= singlePageCacheRadius; distance += 1) {
      if (direction < 0) {
        offsets.push(-distance, distance);
      } else {
        offsets.push(distance, -distance);
      }
    }
    singlePagePreloadQueueRef.current = offsets
      .map(offset => centerPage + offset)
      .filter(page => targetSet.has(page) && !renderedSinglePagesRef.current.has(page));

    window.__pdfPageCanvasCacheInfo = {
      centerPage,
      cacheLimit: singlePageCacheLimit,
      cacheRadius: singlePageCacheRadius,
      direction,
      mountedPages: [],
      queuedPages: [...singlePagePreloadQueueRef.current],
      deviceMemoryGb: typeof navigator !== 'undefined' ? Number(navigator.deviceMemory) || null : null
    };
    scheduleNextSinglePagePreload();
  }, [
    cancelSinglePagePreloadTask,
    numPages,
    scheduleNextSinglePagePreload,
    singlePageCacheLimit,
    singlePageCacheRadius
  ]);

  const singlePageRenderKey = `${currentPage}:${scale}`;
  if (singlePageRenderAttemptRef.current.key !== singlePageRenderKey) {
    singlePageRenderAttemptRef.current = {
      key: singlePageRenderKey,
      page: Number(currentPage),
      startedAt: performance.now()
    };
  }

  const handleSinglePageRenderSuccess = useCallback((pageNumber) => {
    renderedSinglePagesRef.current.add(Number(pageNumber));
    if (singlePageCurrentRef.current !== Number(pageNumber)) {
      scheduleNextSinglePagePreload();
      return;
    }
    // In the mirror build page snapshots are produced by the server process.
    // Avoid Canvas.toBlob here so the renderer never performs cache work.
    if (!serverPageCacheMode) captureSinglePageSnapshot(pageNumber);
    if (serverPageCacheMode) {
      setSinglePageLiveCanvasKey(`${Number(pageNumber)}:${Number(singlePageScaleRef.current) || 1}`);
    }
    const attempt = singlePageRenderAttemptRef.current;
    if (attempt.page === Number(pageNumber) && attempt.startedAt) {
      const durationMs = Math.round(performance.now() - attempt.startedAt);
      const timing = {
        page: Number(pageNumber),
        durationMs,
        scale: Number(scale),
        renderScale: Number(scale) * 2,
        measuredAt: new Date().toISOString()
      };
      window.__lastPdfPageRenderTiming = timing;
      const logger = durationMs >= 1000 ? console.warn : console.info;
      logger(`[PDF翻页耗时] 第${pageNumber}页 Canvas 渲染 ${durationMs}ms`, timing);
    }
    // Render adjacent pages only after the visible page is ready. Their Page
    // components remain mounted, so a normal previous/next turn reuses the
    // already drawn Canvas instead of starting from an empty page.
    scheduleAdjacentPagePreload(pageNumber);
  }, [captureSinglePageSnapshot, scale, scheduleAdjacentPagePreload, scheduleNextSinglePagePreload, serverPageCacheMode]);

  const handleSinglePageRenderError = useCallback((error, pageNumber) => {
    const attempt = singlePageRenderAttemptRef.current;
    console.error(`[PDF翻页耗时] 第${pageNumber || attempt.page || 1}页 Canvas 渲染失败`, error);
  }, []);

  useEffect(() => {
    const pageNumber = Number(currentPage) || 1;
    const currentKey = getSinglePageSnapshotKey(pageNumber);
    const activeFetch = currentRemotePageFetchRef.current;
    if (activeFetch?.controller && activeFetch.page !== pageNumber) {
      activeFetch.controller.abort();
      if (activeFetch.key) singlePageSnapshotPendingRef.current.delete(activeFetch.key);
      currentRemotePageFetchRef.current = { page: 0, key: '', controller: null };
    }
    // A fast page turn must not leave obsolete PNG decodes queued behind the
    // visible page. Keep only the decoder for the page the user can still see.
    singlePageSnapshotDecodeHandlesRef.current.forEach((handle, key) => {
      if (key === currentKey) return;
      handle.image.onload = null;
      handle.image.onerror = null;
      try { handle.image.src = ''; } catch (error) { /* already released */ }
      if (handle.url) URL.revokeObjectURL(handle.url);
      singlePageSnapshotDecodeHandlesRef.current.delete(key);
      singlePageSnapshotPendingRef.current.delete(key);
    });
    if (serverPageCacheMode) setSinglePageLiveCanvasKey('');
    const previousPage = singlePagePreviousRef.current;
    singlePageDirectionRef.current = Math.sign(pageNumber - previousPage);
    singlePagePreviousRef.current = pageNumber;
    cancelSinglePagePreloadTask();
    singlePagePreloadQueueRef.current = [];
    setSinglePageMountedPages(previous => {
      const nearbyPages = previous
        .filter(page => Math.abs(page - pageNumber) <= singlePageCacheRadius)
        .sort((left, right) => Math.abs(left - pageNumber) - Math.abs(right - pageNumber))
        .slice(0, singlePageCacheLimit);
      if (!nearbyPages.includes(pageNumber)) nearbyPages.push(pageNumber);
      nearbyPages.sort((left, right) => left - right);
      return previous.length === nearbyPages.length && previous.every((page, index) => page === nearbyPages[index])
        ? previous
        : nearbyPages;
    });
    if (renderedSinglePagesRef.current.has(pageNumber)) {
      scheduleAdjacentPagePreload(pageNumber);
    }
    return cancelSinglePagePreloadTask;
  }, [
    cancelSinglePagePreloadTask,
    currentPage,
    getSinglePageSnapshotKey,
    scheduleAdjacentPagePreload,
    singlePageCacheLimit,
    singlePageCacheRadius,
    serverPageCacheMode
  ]);

  useEffect(() => {
    // Cached pages bypass PDF.js Canvas rendering, but decoding a large PNG
    // only after a click is still visible as a delay. Decode one likely next
    // page while idle; the existing 1-3 entry LRU remains the hard memory cap.
    if (
      snapshotLoadsSuspendedRef.current ||
      !activeSinglePageSnapshot ||
      !numPages ||
      singlePageSnapshotMaxEntries < 2
    ) return undefined;
    const direction = singlePageDirectionRef.current || 1;
    const forward = Number(currentPage) + direction;
    const fallback = Number(currentPage) - direction;
    const pageNumber = forward >= 1 && forward <= Number(numPages) ? forward : fallback;
    if (pageNumber < 1 || pageNumber > Number(numPages)) return undefined;

    const key = getSinglePageSnapshotKey(pageNumber);
    const diskIndex = singlePageSnapshotDiskIndexRef.current;
    if (
      diskIndex.scope !== singlePageSnapshotScope ||
      !diskIndex.ready ||
      !diskIndex.pages.has(pageNumber) ||
      singlePageSnapshotCacheRef.current.has(key) ||
      singlePageSnapshotPendingRef.current.has(key) ||
      singlePageSnapshotPrefetchRef.current.has(key)
    ) {
      return undefined;
    }

    let cancelled = false;
    let scheduledTask = null;
    const prefetch = async () => {
      scheduledTask = null;
      if (cancelled || navigator.scheduling?.isInputPending?.()) return;
      singlePageSnapshotPrefetchRef.current.add(key);
      singlePageSnapshotPendingRef.current.add(key);
      try {
        const record = await getPdfPageSnapshot(key);
        if (cancelled || !record?.blob) {
          singlePageSnapshotPendingRef.current.delete(key);
          return;
        }
        installSinglePageSnapshot({
          pageNumber,
          blob: record.blob,
          cssWidth: record.cssWidth,
          cssHeight: record.cssHeight,
          snapshotScale: record.scale,
          persist: false
        });
      } catch (error) {
        singlePageSnapshotPendingRef.current.delete(key);
        console.debug('[PDF页面缓存] 相邻页预解码跳过:', error?.message || error);
      } finally {
        singlePageSnapshotPrefetchRef.current.delete(key);
      }
    };

    if (typeof window.requestIdleCallback === 'function') {
      scheduledTask = { type: 'idle', id: window.requestIdleCallback(prefetch) };
    } else {
      scheduledTask = { type: 'timeout', id: setTimeout(prefetch, 250) };
    }
    return () => {
      cancelled = true;
      if (scheduledTask?.type === 'idle' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(scheduledTask.id);
      } else if (scheduledTask?.id) {
        clearTimeout(scheduledTask.id);
      }
      singlePageSnapshotPrefetchRef.current.delete(key);
      singlePageSnapshotPendingRef.current.delete(key);
    };
  }, [
    activeSinglePageSnapshot,
    currentPage,
    getSinglePageSnapshotKey,
    installSinglePageSnapshot,
    numPages,
    singlePageSnapshotDiskIndexVersion,
    singlePageSnapshotMaxEntries,
    singlePageSnapshotScope,
    singlePageSnapshotVersion
  ]);

  useEffect(() => {
    const mountedSet = new Set(singlePageMountedPages);
    Array.from(renderedSinglePagesRef.current).forEach(page => {
      if (!mountedSet.has(page)) renderedSinglePagesRef.current.delete(page);
    });
    if (window.__pdfPageCanvasCacheInfo) {
      window.__pdfPageCanvasCacheInfo = {
        ...window.__pdfPageCanvasCacheInfo,
        mountedPages: [...singlePageMountedPages],
        renderedPages: Array.from(renderedSinglePagesRef.current).sort((left, right) => left - right)
      };
    }
  }, [singlePageMountedPages]);

  useEffect(() => {
    snapshotLoadsSuspendedRef.current = false;
    cancelSinglePagePreloadTask();
    singlePagePreloadQueueRef.current = [];
    renderedSinglePagesRef.current.clear();
    clearSinglePageSnapshots();
    setSinglePageMountedPages([singlePageCurrentRef.current]);
    return () => {
      cancelSinglePagePreloadTask();
      clearSinglePageSnapshots();
    };
  }, [cancelSinglePagePreloadTask, clearSinglePageSnapshots, file]);
  
  // 图纸拖拽和缩放状态
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [viewOffset, setViewOffset] = useState({ x: 0, y: 0 });
  const [dragStartOffset, setDragStartOffset] = useState({ x: 0, y: 0 });
  
  // 可见页面范围状态（用于性能优化）
  const [visiblePageRange, setVisiblePageRange] = useState({ start: 1, end: 3 });
  
  // 矢量数据状态
  const [pageVectors, setPageVectors] = useState({}); 
  
  // 矢量可视化调试开关
  const [showVectorDebug, setShowVectorDebug] = useState(false);
  
  // 焊点识别开关（独立）
  const [showWeldDebug, setShowWeldDebug] = useState(false);
  const [rulesVersion, setRulesVersion] = useState(0);
  
  // 管道识别开关
  const [showPipelineDebug, setShowPipelineDebug] = useState(false);
  const [showFittingDebug, setShowFittingDebug] = useState(false);
  const [showPipeLengthDebug, setShowPipeLengthDebug] = useState(false);
  const [pipeLengthRecognizing, setPipeLengthRecognizing] = useState(false);
  
  // 焊点批量编号开关
  const [showWeldNumbers, setShowWeldNumbers] = useState(false);
  const [displayedWelds, setDisplayedWelds] = useState([]);
  const displayedWeldSignaturesRef = useRef(new Map());
  const displayedWeldPendingRef = useRef(new Map());
  const pendingWeldRefreshPagesRef = useRef(new Set());
  const currentPageRef = useRef(currentPage);
  const pageVectorsRef = useRef(pageVectors);
  const textLikeDetectionsCacheRef = useRef(new Map());
  const showWeldDebugRef = useRef(showWeldDebug);
  const multiPageNumberPreviewRef = useRef(false);
  const multiPagePreviewPageRangeRef = useRef(batchSequenceState?.multiPagePreviewPageRange || null);
  const [pageWeldsVersion, setPageWeldsVersion] = useState(0);
  const [weldNumberAnimationSpeed, setWeldNumberAnimationSpeed] = useState(100); // 焊点编号动画速度（毫秒）
  const [isWeldStartPickMode, setIsWeldStartPickMode] = useState(false);
  const [selectedStartWeldId, setSelectedStartWeldId] = useState(null);
  const [selectedStartWeld, setSelectedStartWeld] = useState(null);
  const [numberingSegments, setNumberingSegments] = useState(() => batchSequenceState?.numberingSegments || []);
  const [numberlessNumberingSegmentKeys, setNumberlessNumberingSegmentKeys] = useState([]);
  const [orderedNumberingWelds, setOrderedNumberingWelds] = useState([]);
  
  // 多页编号预览
  const [multiPageNumberPreview, setMultiPageNumberPreview] = useState(false);
  const [multiPageNumberWelds, setMultiPageNumberWelds] = useState(
    () => batchSequenceState?.multiPageNumberWelds || []
  );
  const [multiPageOriginalNumberWelds, setMultiPageOriginalNumberWelds] = useState(
    () => batchSequenceState?.multiPageOriginalNumberWelds || []
  );
  // Reopened-PDF adjustment needs an immutable baseline. React parent-state
  // echoes and page recognition refreshes must never replace this snapshot.
  const reopenedOriginalWeldsRef = useRef(
    batchSequenceState?.sequenceSource === 'reopened-annotations'
      ? (batchSequenceState?.multiPageOriginalNumberWelds || batchSequenceState?.multiPageNumberWelds || [])
      : []
  );
  const [multiPagePreviewPageRange, setMultiPagePreviewPageRange] = useState(
    () => batchSequenceState?.multiPagePreviewPageRange || null
  );
  const [manualWeldInsertMode, setManualWeldInsertMode] = useState(false);
  const [manualWeldDeleteMode, setManualWeldDeleteMode] = useState(false);
  const [pendingManualWeldDelete, setPendingManualWeldDelete] = useState([]);
  const pendingManualWeldDeleteKeys = useMemo(
    () => pendingManualWeldDelete.map(item => item.weldKey).filter(Boolean),
    [pendingManualWeldDelete]
  );
  const manualWeldDeleteHistoryRef = useRef([]);
  const numberingPreviewReturnModeRef = useRef('idle');
  const [reopenedPdfSupplementMode, setReopenedPdfSupplementMode] = useState(false);
  const [pendingNumberingAnnotations, setPendingNumberingAnnotations] = useState([]);
  const [manualWeldInsertPosition, setManualWeldInsertPosition] = useState(1);
  const [manualInsertPipelineContext, setManualInsertPipelineContext] = useState({
    page: null,
    status: 'idle',
    pipelineNumber: '',
    candidates: [],
    matchedPage: null
  });
  const manualWeldInsertPositionRef = useRef(1);
  const manualWeldInsertPageRef = useRef(currentPage);
  const updateManualWeldInsertPosition = useCallback((valueOrUpdater) => {
    const nextValue = typeof valueOrUpdater === 'function'
      ? valueOrUpdater(manualWeldInsertPositionRef.current)
      : valueOrUpdater;
    const normalizedValue = Number(nextValue);
    if (!Number.isFinite(normalizedValue)) return manualWeldInsertPositionRef.current;
    manualWeldInsertPositionRef.current = normalizedValue;
    setManualWeldInsertPosition(normalizedValue);
    return normalizedValue;
  }, []);
  const [pagePipelineAlerts, setPagePipelineAlerts] = useState({});
  const [pipelineComparisonSummary, setPipelineComparisonSummary] = useState(null);
  const lastRestoredBatchSequenceRef = useRef('');
  const lastEmittedBatchSequenceRef = useRef('');
  const emittedBatchSequenceSignaturesRef = useRef(new Set());
  const hadBatchSequenceRef = useRef(!!batchSequenceState);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useEffect(() => {
    if (multiPageNumberPreview) return;
    setManualWeldDeleteMode(false);
    setPendingManualWeldDelete([]);
    manualWeldDeleteHistoryRef.current = [];
  }, [multiPageNumberPreview]);

  useEffect(() => {
    if (!manualWeldDeleteMode) setPendingManualWeldDelete([]);
  }, [manualWeldDeleteMode]);

  useEffect(() => {
    pageVectorsRef.current = pageVectors;
  }, [pageVectors]);

  useEffect(() => {
    showWeldDebugRef.current = showWeldDebug;
  }, [showWeldDebug]);

  useEffect(() => {
    multiPageNumberPreviewRef.current = multiPageNumberPreview;
  }, [multiPageNumberPreview]);

  useEffect(() => {
    multiPagePreviewPageRangeRef.current = multiPagePreviewPageRange;
  }, [multiPagePreviewPageRange]);

  const isPageInsideMultiPagePreview = useCallback((pageNum) => {
    if (!multiPageNumberPreviewRef.current) return true;
    const range = multiPagePreviewPageRangeRef.current;
    const page = Number(pageNum);
    const start = Number(range?.startPage ?? range?.start);
    const end = Number(range?.endPage ?? range?.end);
    if (!Number.isFinite(page) || !Number.isFinite(start) || !Number.isFinite(end)) return true;
    return page >= Math.min(start, end) && page <= Math.max(start, end);
  }, []);

  // 补点允许覆盖同一管线号的完整页组，即使该页不在当前焊点预览区间内。
  // 其他管线号或未确认管线号的页面仍禁止补点，避免编号串线。
  const isPageInManualInsertPipelineScope = useCallback((pageNum, context = manualInsertPipelineContext) => {
    if (isPageInsideMultiPagePreview(pageNum)) return true;
    if (context?.status !== 'resolved' || !context?.pipelineNumber) return false;
    const page = Number(pageNum);
    return (Array.isArray(context.matchedPages) ? context.matchedPages : [])
      .some(item => Number(item) === page);
  }, [isPageInsideMultiPagePreview, manualInsertPipelineContext]);

  const getBatchSequenceSignature = useCallback((state) => {
    const compactWeld = weld => ({
      key: getWeldSelectionKey(weld),
      page: weld?.page || weld?.pageNum,
      number: weld?.weldNumber ?? weld?.number,
      manualInsertId: weld?.manualInsertId || null
    });
    return JSON.stringify({
      multiPageNumberWelds: (state?.multiPageNumberWelds || []).map(compactWeld),
      multiPageOriginalNumberWelds: (state?.multiPageOriginalNumberWelds || []).map(compactWeld),
      numberingSegments: (state?.numberingSegments || []).map(segment => ({
        page: segment?.page,
        pipelineNumber: segment?.pipelineNumber,
        startKey: segment?.startKey,
        endKey: segment?.endKey,
        startOrderIndex: segment?.startOrderIndex,
        endOrderIndex: segment?.endOrderIndex,
        targetStartNumber: segment?.targetStartNumber ?? segment?.moveTargetNumber,
        sourceRangeKeys: (segment?.sourceRangeWelds || []).map(getWeldSelectionKey)
      })),
      numberlessNumberingSegmentKeys: state?.numberlessNumberingSegmentKeys || [],
      multiPagePreviewPageRange: state?.multiPagePreviewPageRange || null,
      sequenceSource: state?.sequenceSource || 'automatic',
      pendingBatchRule: state?.pendingBatchRule
        ? {
            id: state.pendingBatchRule.id,
            currentNumber: state.pendingBatchRule.currentNumber,
            startNumber: state.pendingBatchRule.startNumber,
            increment: state.pendingBatchRule.increment
          }
        : null
    });
  }, []);

  useEffect(() => {
    if (!batchSequenceState) return;
    const signature = getBatchSequenceSignature(batchSequenceState);
    // Parent state updates are asynchronous. A fast local edit can emit A and B
    // before the parent echoes A back; that old echo must never restore over B.
    if (emittedBatchSequenceSignaturesRef.current.has(signature)) {
      lastRestoredBatchSequenceRef.current = signature;
      return;
    }
    if (signature === lastRestoredBatchSequenceRef.current) return;
    lastRestoredBatchSequenceRef.current = signature;
    lastEmittedBatchSequenceRef.current = signature;
    hadBatchSequenceRef.current = true;

    const restoredWelds = batchSequenceState.multiPageNumberWelds || [];
    setMultiPageNumberWelds(restoredWelds);
    const restoredOriginalWelds = batchSequenceState.multiPageOriginalNumberWelds || restoredWelds;
    setMultiPageOriginalNumberWelds(restoredOriginalWelds);
    if (batchSequenceState.sequenceSource === 'reopened-annotations') {
      reopenedOriginalWeldsRef.current = restoredOriginalWelds;
    }
    setNumberingSegments(batchSequenceState.numberingSegments || []);
    setReopenedPdfSupplementMode(batchSequenceState.sequenceSource === 'reopened-annotations');
    setNumberlessNumberingSegmentKeys([]);
    const restoredPages = restoredWelds
      .map(weld => Number(weld?.page || weld?.pageNum))
      .filter(Number.isFinite);
    const restoredRange = batchSequenceState.multiPagePreviewPageRange || (restoredPages.length > 0
      ? { startPage: Math.min(...restoredPages), endPage: Math.max(...restoredPages) }
      : null);
    multiPagePreviewPageRangeRef.current = restoredRange;
    setMultiPagePreviewPageRange(restoredRange);
    if (batchSequenceState.pendingBatchRule) {
      multiPageBatchService.setPendingBatchAnnotationRule(batchSequenceState.pendingBatchRule);
    }
  }, [batchSequenceState, getBatchSequenceSignature]);

  useEffect(() => {
    if (!onBatchSequenceStateChange) return;
    const hasSequence = multiPageNumberWelds.length > 0 ||
      numberingSegments.length > 0 ||
      numberlessNumberingSegmentKeys.length > 0;
    if (!hasSequence && !hadBatchSequenceRef.current) return;

    const nextState = hasSequence ? {
      multiPageNumberWelds,
      multiPageOriginalNumberWelds,
      numberingSegments,
      numberlessNumberingSegmentKeys,
      multiPagePreviewPageRange,
      sequenceSource: reopenedPdfSupplementMode ? 'reopened-annotations' : 'automatic',
      pendingBatchRule: multiPageBatchService.getPendingBatchAnnotationRule(),
      updatedAt: new Date().toISOString()
    } : null;
    const signature = getBatchSequenceSignature(nextState);
    if (signature === lastEmittedBatchSequenceRef.current) return;
    lastEmittedBatchSequenceRef.current = signature;
    emittedBatchSequenceSignaturesRef.current.add(signature);
    if (emittedBatchSequenceSignaturesRef.current.size > 80) {
      const oldestSignature = emittedBatchSequenceSignaturesRef.current.values().next().value;
      emittedBatchSequenceSignaturesRef.current.delete(oldestSignature);
    }
    hadBatchSequenceRef.current = hasSequence;
    onBatchSequenceStateChange(nextState);
  }, [
    getBatchSequenceSignature,
    multiPageNumberWelds,
    multiPageOriginalNumberWelds,
    numberingSegments,
    numberlessNumberingSegmentKeys,
    multiPagePreviewPageRange,
    reopenedPdfSupplementMode,
    onBatchSequenceStateChange
  ]);
  
  // OCR文字过滤开关
  const [enableOCRFilter, setEnableOCRFilter] = useState(true);
  
  // 文字识别状态（用于焊点过滤）
  const [textDetecting, setTextDetecting] = useState(false);
  const [textDetections, setTextDetections] = useState({})  // {pageNum: {detections, page_info}}
  
  // 用于存储第一个页面的 VectorVisualizer ref（用于获取 RuleManager）
  const firstPageVisualizerRef = useRef(null);
  
  // 区域删除状态
  const [areaSelection, setAreaSelection] = useState(null); // { startX, startY, endX, endY }
  const [isSelectingArea, setIsSelectingArea] = useState(false);

  // 选中状态（用于导出按钮）
  const [hasSelection, setHasSelection] = useState(false);

  // 对照落图：Ep3d 标注 PDF -> 设计院 PDF
  const [compareLayoutVisible, setCompareLayoutVisible] = useState(false);
  const [compareSourceFile, setCompareSourceFile] = useState(null);
  const [compareSourceAnnotations, setCompareSourceAnnotations] = useState([]);
  const [compareSourcePageCount, setCompareSourcePageCount] = useState(0);
  const [compareSourcePage, setCompareSourcePage] = useState(1);
  const [compareTargetPage, setCompareTargetPage] = useState(currentPage || 1);
  const [compareMatches, setCompareMatches] = useState([]);
  const [compareSummary, setCompareSummary] = useState(null);
  const [compareProcessing, setCompareProcessing] = useState(false);

  useEffect(() => {
    const handleOpenCompareLayout = () => {
      setCompareTargetPage(currentPage || 1);
      setCompareLayoutVisible(true);
    };
    window.addEventListener('compare-layout-open', handleOpenCompareLayout);
    return () => window.removeEventListener('compare-layout-open', handleOpenCompareLayout);
  }, [currentPage]);

  // 多页批量处理面板状态
  const [showMultiPagePanel, setShowMultiPagePanel] = useState(false);
  const [showMaterialRecognitionPanel, setShowMaterialRecognitionPanel] = useState(false);
  const [pdfDocumentRef, setPdfDocumentRef] = useState(null); // 存储PDF文档引用
  const [pdfDocumentCacheKey, setPdfDocumentCacheKey] = useState('');
  const backgroundPageCacheGenerationRef = useRef(0);
  const backgroundPageCacheRenderRef = useRef(null);
  const backgroundPageCachePauseUntilRef = useRef(0);
  const backgroundPageCacheTerminalRef = useRef({ key: '', progress: null });
  const [backgroundPageCachePaused, setBackgroundPageCachePaused] = useState(false);
  const [backgroundPageCacheProgress, setBackgroundPageCacheProgress] = useState({
    completed: 0,
    total: 0,
    running: false,
    failed: 0,
    skipped: 0,
    error: '',
    stage: '',
    uploadedBytes: 0,
    sourceSize: 0
  });

  useEffect(() => {
    if (snapshotLoadsSuspendedRef.current) return undefined;
    const key = getSinglePageSnapshotKey(currentPage);
    if (singlePageSnapshotCacheRef.current.has(key)) return undefined;
    const diskIndex = singlePageSnapshotDiskIndexRef.current;
    if (diskIndex.scope === singlePageSnapshotScope && diskIndex.ready && !diskIndex.pages.has(Number(currentPage))) {
      return undefined;
    }
    let cancelled = false;
    singlePageSnapshotPendingRef.current.add(key);
    getPdfPageSnapshot(key).then(record => {
      if (cancelled) {
        singlePageSnapshotPendingRef.current.delete(key);
        return;
      }
      if (!record?.blob) {
        singlePageSnapshotPendingRef.current.delete(key);
        invalidateSinglePageSnapshotDiskEntry(currentPage);
        return;
      }
      installSinglePageSnapshot({
        pageNumber: currentPage,
        blob: record.blob,
        cssWidth: record.cssWidth,
        cssHeight: record.cssHeight,
        snapshotScale: record.scale,
        persist: false
      });
    }).catch(error => {
      singlePageSnapshotPendingRef.current.delete(key);
      console.warn('[PDF页面缓存] 读取磁盘快照失败:', error);
      if (!cancelled) invalidateSinglePageSnapshotDiskEntry(currentPage);
    });
    return () => {
      cancelled = true;
      singlePageSnapshotPendingRef.current.delete(key);
    };
  }, [
    currentPage,
    getSinglePageSnapshotKey,
    installSinglePageSnapshot,
    invalidateSinglePageSnapshotDiskEntry,
    singlePageSnapshotDiskIndexVersion,
    singlePageSnapshotScope,
    singlePageSnapshotVersion
  ]);

  const loadRemotePageSnapshot = useCallback(async (pageNumber, state) => {
    if (
      !serverPageCacheMode ||
      !isDirectionalPreviewStateForScope(state, singlePageSnapshotScope) ||
      !state?.cacheId ||
      !state?.pages?.[pageNumber]
    ) return false;
    const key = getSinglePageSnapshotKey(pageNumber);
    if (singlePageSnapshotCacheRef.current.has(key) || singlePageSnapshotPendingRef.current.has(key)) return true;
    const previousFetch = currentRemotePageFetchRef.current;
    if (previousFetch?.controller) {
      previousFetch.controller.abort();
      if (previousFetch.key) singlePageSnapshotPendingRef.current.delete(previousFetch.key);
    }
    const controller = new AbortController();
    currentRemotePageFetchRef.current = { page: Number(pageNumber), key, controller };
    singlePageSnapshotPendingRef.current.add(key);
    try {
      const response = await fetch(`/api/pdf-page-cache/page/${state.cacheId}/${Number(pageNumber)}`, {
        cache: 'force-cache',
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (controller.signal.aborted || Number(singlePageCurrentRef.current) !== Number(pageNumber)) {
        singlePageSnapshotPendingRef.current.delete(key);
        return false;
      }
      const pageInfo = state.pages[pageNumber];
      installSinglePageSnapshot({
        pageNumber,
        blob,
        cssWidth: Number(pageInfo.width),
        cssHeight: Number(pageInfo.height),
        // Server rasterizes at 1.25 PDF units. Existing display geometry stores
        // the equivalent UI scale (react-pdf renders at UI scale * 2).
        snapshotScale: Number(pageInfo.renderScale || 0) > 0
          ? Number(pageInfo.renderScale) / 2
          : 0.625,
        // A server snapshot is only an HTTP response until it is persisted.
        // Keep it in IndexedDB so later page turns do not download it again.
        persist: true
      });
      return true;
    } catch (error) {
      singlePageSnapshotPendingRef.current.delete(key);
      if (error?.name !== 'AbortError') {
        console.debug('[PDF服务端页面缓存] 页面尚未就绪:', pageNumber, error?.message || error);
      }
      return false;
    } finally {
      if (currentRemotePageFetchRef.current.controller === controller) {
        currentRemotePageFetchRef.current = { page: 0, key: '', controller: null };
      }
    }
  }, [getSinglePageSnapshotKey, installSinglePageSnapshot, serverPageCacheMode, singlePageSnapshotScope]);

  const loadRemotePagePreview = useCallback(async (pageNumber, state, signal) => {
    const page = Number(pageNumber);
    const scope = singlePageSnapshotScope;
    const pendingKey = getDirectionalPreviewCacheKey(scope, page);
    const requestToken = {};
    let handedToDecoder = false;
    if (
      !imageFirstPdfMode ||
      !isDirectionalPreviewStateForScope(state, scope) ||
      !state?.cacheId ||
      !state?.previews?.[page] ||
      singlePagePreviewCacheRef.current.has(pendingKey) ||
      !acquireDirectionalPreviewRequest(
        singlePagePreviewPendingRef.current,
        pendingKey,
        signal,
        requestToken
      )
    ) return false;
    try {
      const response = await fetch(`/api/pdf-page-cache/preview/${state.cacheId}/${page}`, {
        cache: 'force-cache',
        signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (signal?.aborted) return false;
      const previewInfo = state.previews[page];
      const standardInfo = state.pages?.[page];
      const renderScale = Number(previewInfo.renderScale || 0);
      const inferredSnapshotScale = standardInfo?.width > 0
        ? 0.625 * (Number(previewInfo.width) / Number(standardInfo.width))
        : 0.625;
      installSinglePagePreview({
        pageNumber: page,
        blob,
        cssWidth: Number(previewInfo.width),
        cssHeight: Number(previewInfo.height),
        snapshotScale: renderScale > 0 ? renderScale / 2 : inferredSnapshotScale,
        scope,
        pendingKey,
        requestToken
      });
      handedToDecoder = true;
      return true;
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.debug('[PDF preview cache] preview unavailable:', page, error?.message || error);
      }
      return false;
    } finally {
      if (!handedToDecoder) {
        releaseDirectionalPreviewRequest(
          singlePagePreviewPendingRef.current,
          pendingKey,
          requestToken
        );
      }
    }
  }, [imageFirstPdfMode, installSinglePagePreview, singlePageSnapshotScope]);

  useEffect(() => {
    if (!imageFirstPdfMode || !remotePageCacheStateMatchesScope || !remotePageCacheState?.cacheId) {
      return undefined;
    }
    const current = Number(currentPage) || 1;
    const direction = singlePageDirectionRef.current || 1;
    const targets = getDirectionalPreviewPages({
      currentPage: current,
      direction,
      totalPages: Number(backgroundPageCacheProgress.total || numPages || 0)
    }).filter(page => remotePageCacheState.previews?.[page]);
    const controller = new AbortController();
    targets.forEach(page => {
      loadRemotePagePreview(page, remotePageCacheState, controller.signal);
    });
    const keep = new Set(targets.map(page => (
      getDirectionalPreviewCacheKey(singlePageSnapshotScope, page)
    )));
    let removed = false;
    singlePagePreviewCacheRef.current.forEach((item, key) => {
      if (keep.has(key)) return;
      if (item?.decodedImage) {
        try { item.decodedImage.src = ''; } catch (error) { /* already released */ }
      }
      if (item?.url) URL.revokeObjectURL(item.url);
      singlePagePreviewCacheRef.current.delete(key);
      removed = true;
    });
    if (removed) {
      setSinglePagePreviewVersion(version => version + 1);
    }
    return () => controller.abort();
  }, [
    backgroundPageCacheProgress.total,
    currentPage,
    imageFirstPdfMode,
    loadRemotePagePreview,
    numPages,
    remotePageCacheState,
    remotePageCacheStateMatchesScope,
    singlePageSnapshotScope
  ]);

  useEffect(() => {
    if (!imageFirstPdfMode || !file || !singlePageSnapshotDocumentKey) return undefined;
    const controller = new AbortController();
    const serverDocumentKey = encodeURIComponent(singlePageSnapshotDocumentKey);

    // Query an existing server cache before PDF.js onLoadSuccess. This is what
    // lets a previously cached page paint while the PDF document is still
    // being parsed in the background.
    fetch(`/api/pdf-page-cache/status?key=${encodeURIComponent(serverDocumentKey)}`, {
      cache: 'no-store',
      signal: controller.signal
    })
      .then(response => response.json())
      .then(status => {
        if (controller.signal.aborted || !status?.found) return;
        const pages = status.pages || {};
        const previews = status.previews || {};
        const total = Number(status.total || 0);
        setRemotePageCacheState({
          scope: singlePageSnapshotScope,
          cacheId: status.cacheId || '',
          pages,
          previews,
          status: status.status || 'missing'
        });
        setBackgroundPageCacheProgress({
          completed: Object.keys(pages).length,
          total,
          running: !['complete', 'error'].includes(status.status),
          failed: Array.isArray(status.failed) ? status.failed.length : 0,
          skipped: 0,
          stage: status.status || '',
          uploadedBytes: Number(status.uploadedBytes || 0),
          sourceSize: Number(status.sourceSize || 0)
        });
      })
      .catch(error => {
        if (error?.name !== 'AbortError') {
          console.debug('[PDF image-first] early cache lookup failed:', error?.message || error);
        }
      });

    return () => controller.abort();
  }, [file, imageFirstPdfMode, singlePageSnapshotDocumentKey, singlePageSnapshotScope]);

  useEffect(() => {
    if (!serverPageCacheMode || snapshotLoadsSuspendedRef.current) return undefined;
    const page = Number(currentPage);
    const previewAvailable = remotePageCacheStateMatchesScope && Boolean(remotePageCacheState.previews?.[page]);
    const previewDecoded = singlePagePreviewCacheRef.current.has(
      getDirectionalPreviewCacheKey(singlePageSnapshotScope, page)
    );
    // Give a not-yet-decoded preview a small head start so its much smaller
    // request is not competing with the full-resolution page on a slow link.
    const delay = previewAvailable && !previewDecoded ? 100 : 0;
    const timer = setTimeout(() => {
      loadRemotePageSnapshot(page, remotePageCacheState);
    }, delay);
    return () => clearTimeout(timer);
  }, [
    currentPage,
    loadRemotePageSnapshot,
    remotePageCacheState,
    remotePageCacheStateMatchesScope,
    serverPageCacheMode,
    singlePagePreviewVersion,
    singlePageSnapshotScope,
    singlePageSnapshotDiskIndexVersion,
    singlePageSnapshotVersion
  ]);

  useEffect(() => {
    setRemoteCanvasFallbackPage(0);
    const pageNumber = Number(currentPage) || 1;
    if (
      !imageFirstPdfMode ||
      !remotePageCacheStateMatchesScope ||
      !remotePageCacheState.pages?.[pageNumber] ||
      snapshotLoadsSuspendedRef.current
    ) return undefined;
    const key = getSinglePageSnapshotKey(pageNumber);
    if (singlePageSnapshotCacheRef.current.has(key)) return undefined;

    // Do not start a full PDF.js render for pages that the user is merely
    // passing through. If the cached PNG is delayed or unavailable after the
    // page settles, the live Canvas becomes a guaranteed display fallback.
    const timer = setTimeout(() => {
      if (
        Number(singlePageCurrentRef.current) === pageNumber &&
        !singlePageSnapshotCacheRef.current.has(key)
      ) {
        // The first request may have been aborted while the user was still
        // paging. Retry after the page settles before enabling the Canvas.
        loadRemotePageSnapshot(pageNumber, remotePageCacheState);
        setRemoteCanvasFallbackPage(pageNumber);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [
    currentPage,
    getSinglePageSnapshotKey,
    imageFirstPdfMode,
    loadRemotePageSnapshot,
    remotePageCacheState,
    remotePageCacheState.pages,
    remotePageCacheStateMatchesScope,
    singlePageSnapshotVersion
  ]);

  useEffect(() => {
    remotePageWarmRef.current.clear();
    setRemotePageCacheState({
      scope: singlePageSnapshotScope,
      cacheId: '',
      pages: {},
      previews: {},
      status: 'idle'
    });
    window.__pdfLocalPagePrefetch = null;
  }, [singlePageSnapshotDocumentKey, singlePageSnapshotScope]);

  useEffect(() => {
    if (!imageFirstPdfMode || !remotePageCacheStateMatchesScope || !remotePageCacheState?.cacheId) {
      return undefined;
    }
    const total = Number(backgroundPageCacheProgress.total || 0);
    if (total <= 0) return undefined;
    const controller = new AbortController();
    const current = Number(currentPage) || 1;
    const direction = singlePageDirectionRef.current || 1;
    const candidates = [
      current + direction,
      current - direction,
      current + direction * 2
    ].filter((page, index, pages) => (
      page >= 1 &&
      page <= total &&
      pages.indexOf(page) === index &&
      remotePageCacheState.pages?.[page]
    ));

    // Persist nearby server snapshots without decoding them. The next page
    // turn is then local while decoded image memory remains bounded.
    const warm = async () => {
      for (const page of candidates) {
        if (controller.signal.aborted) return;
        const warmKey = `${remotePageCacheState.cacheId}:${page}`;
        if (remotePageWarmRef.current.has(warmKey)) continue;
        remotePageWarmRef.current.add(warmKey);
        try {
          const response = await fetch(
            `/api/pdf-page-cache/page/${remotePageCacheState.cacheId}/${page}`,
            { cache: 'force-cache', signal: controller.signal }
          );
          if (response.ok) {
            const blob = await response.blob();
            const pageInfo = remotePageCacheState.pages?.[page];
            await putPdfPageSnapshot({
              key: getSinglePageSnapshotKey(page),
              scope: singlePageSnapshotScope,
              pageNumber: Number(page),
              scale: 0.625,
              blob,
              cssWidth: Number(pageInfo?.width || 1),
              cssHeight: Number(pageInfo?.height || 1),
              size: blob.size
            });
            notifySinglePageSnapshotPersisted(page);
          } else remotePageWarmRef.current.delete(warmKey);
        } catch (error) {
          remotePageWarmRef.current.delete(warmKey);
          if (error?.name === 'AbortError') return;
        }
      }
    };
    const timer = setTimeout(warm, 80);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    backgroundPageCacheProgress.total,
    currentPage,
    getSinglePageSnapshotKey,
    imageFirstPdfMode,
    notifySinglePageSnapshotPersisted,
    remotePageCacheState,
    remotePageCacheStateMatchesScope,
    singlePageSnapshotScope
  ]);

  // Keep all completed server PNGs on the user's disk, one request at a time.
  // The nearby-page loader above retains priority; this queue never decodes
  // distant images or grows the live image LRU.
  const fullPagePrefetchIndexReady = singlePageSnapshotDiskIndexRef.current.scope === singlePageSnapshotScope &&
    singlePageSnapshotDiskIndexRef.current.ready;
  useEffect(() => {
    const cacheId = remotePageCacheState?.cacheId;
    if (
      !imageFirstPdfMode ||
      !serverPageCacheMode ||
      !remotePageCacheStateMatchesScope ||
      !cacheId ||
      !fullPagePrefetchIndexReady
    ) return undefined;
    const availablePages = Object.keys(remotePageCacheState.pages || {})
      .map(Number)
      .filter(page => Number.isInteger(page) && page > 0)
      .sort((left, right) => left - right);
    if (!availablePages.length) return undefined;

    const controller = new AbortController();
    const failedPages = new Set();
    const retryAfter = new Map();
    const failureCounts = new Map();
    let disposed = false;
    let timer = null;
    let idleTask = null;
    const schedule = (delay = 350) => {
      if (disposed) return;
      timer = setTimeout(() => {
        timer = null;
        if (typeof window.requestIdleCallback === 'function') {
          idleTask = window.requestIdleCallback(() => {
            idleTask = null;
            fetchNext();
          }, { timeout: 1200 });
        } else {
          fetchNext();
        }
      }, delay);
    };
    const fetchNext = async () => {
      if (disposed || controller.signal.aborted) return;
      const index = singlePageSnapshotDiskIndexRef.current;
      if (index.scope !== singlePageSnapshotScope || !index.ready) return;
      if (fullPagePrefetchBlockedRef.current.scope === singlePageSnapshotScope &&
          fullPagePrefetchBlockedRef.current.blocked) return;
      if (
        window.__pdfExportInProgress ||
        navigator.scheduling?.isInputPending?.() ||
        Date.now() - lastPdfInteractionAtRef.current < BACKGROUND_CACHE_INTERACTION_QUIET_MS
      ) {
        schedule(700);
        return;
      }

      const current = Number(singlePageCurrentRef.current) || 1;
      const pending = availablePages.filter(page => !index.pages.has(page));
      const candidates = pending.filter(page =>
        !failedPages.has(page) &&
        Date.now() >= Number(retryAfter.get(page) || 0) &&
        !remotePageWarmRef.current.has(`${cacheId}:${page}`)
      );
      // Nearby pages are handled by the fast loader. Finish distant pages
      // first, then fill any gaps left by that loader.
      const page = candidates.find(candidate => Math.abs(candidate - current) > 2) ?? candidates[0];
      window.__pdfLocalPagePrefetch = {
        cacheId,
        completed: availablePages.length - pending.length,
        available: availablePages.length,
        activePage: page || 0,
        failed: failedPages.size
      };
      if (!page) {
        if (pending.length > 0) schedule(1500);
        return;
      }

      try {
        const response = await fetch(`/api/pdf-page-cache/page/${cacheId}/${page}`, {
          cache: 'force-cache', signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (disposed || controller.signal.aborted) return;
        const pageInfo = remotePageCacheState.pages[page];
        const savedKey = await putPdfPageSnapshot({
          key: getSinglePageSnapshotKey(page),
          scope: singlePageSnapshotScope,
          pageNumber: page,
          scale: 0.625,
          blob,
          cssWidth: Number(pageInfo?.width || 1),
          cssHeight: Number(pageInfo?.height || 1),
          size: blob.size
        });
        if (!savedKey) throw new Error('浏览器本地缓存不可用');
        const currentIndex = singlePageSnapshotDiskIndexRef.current;
        if (currentIndex.scope === singlePageSnapshotScope) {
          currentIndex.pages.add(page);
          if (Number(singlePageCurrentRef.current) === page) notifySinglePageSnapshotPersisted(page);
        }
      } catch (error) {
        if (disposed || error?.name === 'AbortError') return;
        if (error?.name === 'QuotaExceededError' || error?.message === '浏览器本地缓存不可用') {
          fullPagePrefetchBlockedRef.current = { scope: singlePageSnapshotScope, blocked: true };
          console.warn('[PDF页面缓存] 本机空间不足或缓存不可用，已停止全量预取:', error);
          return;
        }
        const failures = Number(failureCounts.get(page) || 0) + 1;
        failureCounts.set(page, failures);
        if (failures >= 3) failedPages.add(page);
        else retryAfter.set(page, Date.now() + failures * 2000);
        console.debug('[PDF页面缓存] 后台预取单页失败:', page, error?.message || error);
      }
      schedule();
    };
    schedule(500);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (idleTask !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleTask);
      }
      controller.abort();
    };
  }, [
    currentPage,
    fullPagePrefetchIndexReady,
    getSinglePageSnapshotKey,
    imageFirstPdfMode,
    notifySinglePageSnapshotPersisted,
    remotePageCacheState,
    remotePageCacheStateMatchesScope,
    serverPageCacheMode,
    singlePageSnapshotScope
  ]);

  useEffect(() => {
    if (!serverPageCacheMode) return undefined;
    // numPages and pdfDocumentRef briefly still belong to the previous file
    // during a document switch. Register only after the current file's own
    // Document.onLoadSuccess has supplied its page count.
    if (pdfDocumentCacheKey !== singlePageSnapshotDocumentKey) return undefined;
    const totalPages = Number(pdfDocumentRef?.numPages || 0);
    if (!totalPages || !file) return undefined;
    // Show the cache status as soon as the current PDF is ready. Previously
    // `total` stayed at zero until the server had received the whole PDF, so
    // the status window was invisible throughout a large-file upload.
    setBackgroundPageCacheProgress({
      completed: 0,
      total: totalPages,
      running: true,
      failed: 0,
      skipped: 0,
      error: '',
      stage: 'preparing',
      uploadedBytes: 0,
      sourceSize: Number(file?.size || 0)
    });
    window.__pdfBackgroundSnapshotProgress = {
      completed: 0,
      total: totalPages,
      running: true,
      failed: 0,
      skipped: 0,
      source: 'server-disk-cache-preparing',
      cacheId: ''
    };
    remotePageCacheAbortRef.current?.abort?.();
    const controller = new AbortController();
    remotePageCacheAbortRef.current = controller;
    const cacheKey = encodeURIComponent(singlePageSnapshotDocumentKey);
    let pollTimer = null;
    let stopped = false;
    let uploadRetryCount = 0;

    const applyStatus = status => {
      if (stopped) return;
      const pages = status?.pages || {};
      const previews = status?.previews || {};
      setRemotePageCacheState({
        scope: singlePageSnapshotScope,
        cacheId: status?.cacheId || '',
        pages,
        previews,
        status: status?.status || 'missing'
      });
      const completed = Object.keys(pages).length;
      setBackgroundPageCacheProgress({
        completed,
        total: totalPages,
        running: !['complete', 'error'].includes(status?.status),
        failed: Array.isArray(status?.failed) ? status.failed.length : 0,
        skipped: 0,
        error: status?.error || '',
        stage: status?.status || '',
        uploadedBytes: Number(status?.uploadedBytes || 0),
        sourceSize: Number(status?.sourceSize || file?.size || 0)
      });
      if (status?.status === 'complete') {
        const terminalProgress = {
          completed,
          total: totalPages,
          running: false,
          failed: Array.isArray(status?.failed) ? status.failed.length : 0,
          skipped: 0
        };
        backgroundPageCacheTerminalRef.current = {
          key: `${singlePageSnapshotScope}|total:${totalPages}`,
          progress: terminalProgress
        };
      }
      window.__pdfBackgroundSnapshotProgress = {
        completed, total: totalPages, running: status?.status !== 'complete',
        failed: Array.isArray(status?.failed) ? status.failed.length : 0,
        skipped: 0, source: 'server-disk-cache', cacheId: status?.cacheId || ''
      };
      loadRemotePageSnapshot(Number(singlePageCurrentRef.current), {
        cacheId: status?.cacheId || '', pages, status: status?.status || ''
      });
    };

    const getSourceBlob = async () => {
      if (typeof Blob !== 'undefined' && file instanceof Blob) return file;
      const response = await fetch(file, { signal: controller.signal });
      if (!response.ok) throw new Error(`读取PDF失败 HTTP ${response.status}`);
      return response.blob();
    };

    const uploadSource = source => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abortUpload = () => xhr.abort();
      controller.signal.addEventListener('abort', abortUpload, { once: true });
      xhr.open('POST', '/api/pdf-page-cache/register');
      xhr.responseType = 'json';
      xhr.setRequestHeader('Content-Type', 'application/pdf');
      xhr.setRequestHeader('X-Pdf-Cache-Key', cacheKey);
      xhr.setRequestHeader('X-Pdf-Page-Count', String(totalPages));
      xhr.upload.onprogress = event => {
        if (stopped) return;
        const sourceSize = Number(event.total || source?.size || file?.size || 0);
        const uploadedBytes = Number(event.loaded || 0);
        setBackgroundPageCacheProgress(previous => ({
          ...previous,
          running: true,
          stage: 'uploading',
          uploadedBytes,
          sourceSize
        }));
        window.__pdfBackgroundSnapshotProgress = {
          ...(window.__pdfBackgroundSnapshotProgress || {}),
          running: true,
          source: 'server-disk-cache-uploading',
          stage: 'uploading',
          uploadedBytes,
          sourceSize
        };
      };
      xhr.onerror = () => {
        controller.signal.removeEventListener('abort', abortUpload);
        reject(new Error('上传PDF缓存源文件失败'));
      };
      xhr.onabort = () => {
        controller.signal.removeEventListener('abort', abortUpload);
        reject(Object.assign(new Error('缓存上传已取消'), { name: 'AbortError' }));
      };
      xhr.onload = () => {
        controller.signal.removeEventListener('abort', abortUpload);
        const result = xhr.response || {};
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(result?.error || `注册缓存失败 HTTP ${xhr.status}`));
          return;
        }
        resolve(result);
      };
      xhr.send(source);
    });

    const poll = async () => {
      if (stopped) return;
      try {
        const response = await fetch(`/api/pdf-page-cache/status?key=${encodeURIComponent(cacheKey)}`, {
          cache: 'no-store', signal: controller.signal
        });
        const status = await response.json();
        let effectiveStatus = status;
        if (!status.found || Number(status.total || 0) !== totalPages) {
          const source = await getSourceBlob();
          effectiveStatus = await uploadSource(source);
        }
        applyStatus(effectiveStatus);
        uploadRetryCount = 0;
        if (!stopped && effectiveStatus.status !== 'complete' && effectiveStatus.status !== 'error') {
          // Cache generation is background work.  A one-second poll rebuilt
          // the large PDF viewer repeatedly on every client; five seconds is
          // still responsive enough for progress while greatly reducing UI
          // and server pressure in a multi-user deployment.
          const firstPagePending = Object.keys(effectiveStatus.pages || {}).length === 0;
          pollTimer = setTimeout(poll, firstPagePending ? 1000 : 5000);
        }
      } catch (error) {
        if (error?.name === 'AbortError' || stopped) return;
        console.warn('[PDF服务端页面缓存] 任务失败:', error);
        uploadRetryCount += 1;
        const willRetry = uploadRetryCount <= 2;
        setBackgroundPageCacheProgress(previous => ({
          ...previous,
          running: willRetry,
          failed: uploadRetryCount,
          error: error?.message || String(error)
        }));
        if (willRetry && !stopped) {
          pollTimer = setTimeout(poll, uploadRetryCount * 5000);
        }
      }
    };
    poll();
    return () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      controller.abort();
      if (remotePageCacheAbortRef.current === controller) remotePageCacheAbortRef.current = null;
    };
  }, [file, loadRemotePageSnapshot, pdfDocumentCacheKey, pdfDocumentRef, remotePageCacheRetryNonce, singlePageSnapshotDocumentKey, serverPageCacheMode]);

  useEffect(() => {
    backgroundPageCachePauseUntilRef.current = Date.now() + 800;
    const active = backgroundPageCacheRenderRef.current;
    if (active?.continuationTimer) {
      clearTimeout(active.continuationTimer);
      active.continuationTimer = null;
    }
    if (active?.renderTask?.cancel) {
      try { active.renderTask.cancel(); } catch (error) { /* already completed */ }
    }
  }, [currentPage]);

  useEffect(() => {
    const pauseForInteraction = () => {
      lastPdfInteractionAtRef.current = Date.now();
      lastIdleRuntimeReleaseAtRef.current = 0;
      if (snapshotLoadsSuspendedRef.current) {
        snapshotLoadsSuspendedRef.current = false;
        setSinglePageSnapshotVersion(version => version + 1);
      }
      // Full-page snapshot rendering, PNG encoding and IndexedDB writes are
      // background-only. Keep extending the quiet period while the user moves
      // or drags so foreground annotation work always wins.
      backgroundPageCachePauseUntilRef.current = Date.now() + BACKGROUND_CACHE_INTERACTION_QUIET_MS;
      // Do not discard the page already in progress. Its PDF.js RenderTask is
      // cooperatively paused at the next onContinue boundary below and resumes
      // after the current gesture, so active users still make cache progress.
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        pdfHiddenSinceRef.current = Date.now();
      } else {
        pdfHiddenSinceRef.current = 0;
        pauseForInteraction();
      }
    };
    const handlePdfExportState = event => {
      if (!event?.detail?.active) {
        backgroundPageCachePauseUntilRef.current = Date.now() + 300;
        // The download Blob/bytes are already independent at this point. Drop
        // all rebuildable runtime objects immediately so the just-finished
        // export cannot remain near Edge's renderer heap limit while idle.
        renderedAnnotationsCacheRef.current.clear();
        textLikeDetectionsCacheRef.current.clear();
        multiPageBatchService.releaseTransientRecognitionCaches();
        VectorExtractionUtils.releasePdfLibSourceDocument();
        pageObjectsRef.current?.forEach?.(page => {
          try { page?.cleanup?.(); } catch (error) { /* already released */ }
        });
        pageObjectsRef.current?.clear?.();
        Promise.resolve(pdfDocumentRef?.cleanup?.())
          .then(() => {
            window.__lastPdfExportRuntimeRelease = {
              releasedAt: new Date().toISOString(),
              currentPage: Number(singlePageCurrentRef.current) || 1,
              persistentPageCachePreserved: true
            };
            console.info('[PDF导出内存释放] 已清理可重建运行资源，页面磁盘缓存与业务状态保留');
          })
          .catch(error => console.debug('[PDF导出内存释放] PDF.js 清理延后:', error?.message || error));
        return;
      }
      backgroundPageCachePauseUntilRef.current = Number.POSITIVE_INFINITY;
      // Export builds another complete PDF and lossless 2x annotation images.
      // Release only disposable in-memory page snapshots first; persistent
      // IndexedDB snapshots remain available and output quality is unchanged.
      clearSinglePageSnapshots();
      renderedSinglePagesRef.current.clear();
      renderedAnnotationsCacheRef.current.clear();
      textLikeDetectionsCacheRef.current.clear();
      multiPageBatchService.releaseTransientRecognitionCaches();
      VectorExtractionUtils.releasePdfLibSourceDocument();
      pageObjectsRef.current?.forEach?.(page => {
        try { page?.cleanup?.(); } catch (error) { /* already released */ }
      });
      pageObjectsRef.current?.clear?.();
      const active = backgroundPageCacheRenderRef.current;
      if (active?.continuationTimer) {
        clearTimeout(active.continuationTimer);
        active.continuationTimer = null;
      }
      if (active?.renderTask?.cancel) {
        try { active.renderTask.cancel(); } catch (error) { /* already completed */ }
      }
    };
    window.addEventListener('pointerdown', pauseForInteraction, true);
    window.addEventListener('pointermove', pauseForInteraction, { capture: true, passive: true });
    window.addEventListener('touchmove', pauseForInteraction, { capture: true, passive: true });
    window.addEventListener('wheel', pauseForInteraction, { capture: true, passive: true });
    window.addEventListener('keydown', pauseForInteraction, true);
    window.addEventListener('pdf-export-state', handlePdfExportState);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('pointerdown', pauseForInteraction, true);
      window.removeEventListener('pointermove', pauseForInteraction, true);
      window.removeEventListener('touchmove', pauseForInteraction, true);
      window.removeEventListener('wheel', pauseForInteraction, true);
      window.removeEventListener('keydown', pauseForInteraction, true);
      window.removeEventListener('pdf-export-state', handlePdfExportState);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [clearSinglePageSnapshots, pdfDocumentRef]);

  useEffect(() => {
    if (serverPageCacheMode) return undefined;
    const totalPages = Number(numPages || pdfDocumentRef?.numPages || 0);
    if (!pdfDocumentRef?.getPage || totalPages <= 0) {
      setBackgroundPageCacheProgress({ completed: 0, total: totalPages, running: false, failed: 0, skipped: 0 });
      return undefined;
    }

    const terminalKey = `${singlePageSnapshotScope}|total:${totalPages}`;
    const previousTerminal = backgroundPageCacheTerminalRef.current;
    if (previousTerminal.key === terminalKey && previousTerminal.progress) {
      setBackgroundPageCacheProgress(previousTerminal.progress);
      window.__pdfBackgroundSnapshotProgress = {
        ...previousTerminal.progress,
        paused: false,
        terminal: true,
        terminalKey
      };
      return undefined;
    }

    const generation = backgroundPageCacheGenerationRef.current + 1;
    backgroundPageCacheGenerationRef.current = generation;
    let disposed = false;
    let scheduledTask = null;
    const completedPages = new Set();
    const failedPages = new Set();
    const skippedPages = new Set();
    let pagesSinceCooldown = 0;
    const backgroundBatchSize = 4;
    let terminal = false;

    const getMemoryPressureDelay = () => {
      const memory = typeof performance !== 'undefined' ? performance.memory : null;
      const used = Number(memory?.usedJSHeapSize || 0);
      const limit = Number(memory?.jsHeapSizeLimit || 0);
      if (!used || !limit) return 0;
      const ratio = used / limit;
      if (ratio >= 0.75 || limit - used < 384 * 1024 * 1024) return 15000;
      if (ratio >= 0.62) return 5000;
      return 0;
    };

    const getEstimatedDecodedPageBytes = () => {
      let bytes = 0;
      singlePageSnapshotCacheRef.current.forEach(item => {
        bytes += Math.max(0, Number(item?.cssWidth || 0)) *
          Math.max(0, Number(item?.cssHeight || 0)) * 4;
      });
      const visibleCanvas = containerRef.current?.querySelector(
        `[data-page-number="${Number(singlePageCurrentRef.current) || 1}"] canvas`
      );
      if (visibleCanvas?.width && visibleCanvas?.height) {
        bytes += Number(visibleCanvas.width) * Number(visibleCanvas.height) * 4;
      }
      return bytes;
    };

    const reportProgress = running => {
      const completed = Math.min(totalPages, completedPages.size);
      const resolved = Math.min(totalPages, completedPages.size + failedPages.size);
      const nextProgress = {
        completed,
        total: totalPages,
        running: Boolean(running && resolved < totalPages),
        failed: failedPages.size,
        skipped: skippedPages.size
      };
      setBackgroundPageCacheProgress(previous => (
        previous.completed === nextProgress.completed &&
        previous.total === nextProgress.total &&
        previous.running === nextProgress.running &&
        previous.failed === nextProgress.failed &&
        previous.skipped === nextProgress.skipped
          ? previous
          : nextProgress
      ));
      window.__pdfBackgroundSnapshotProgress = {
        completed,
        total: totalPages,
        running: Boolean(running && resolved < totalPages),
        failed: failedPages.size,
        skipped: skippedPages.size,
        paused: backgroundPageCachePaused
      };
    };

    const handleSnapshotCached = event => {
      const detail = event?.detail || {};
      if (String(detail.scope || '') !== String(singlePageSnapshotScope || '')) return;
      const pageNumber = Number(detail.pageNumber);
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > totalPages) return;
      completedPages.add(pageNumber);
      failedPages.delete(pageNumber);
      reportProgress(!backgroundPageCachePaused);
    };
    window.addEventListener('pdf-page-snapshot-cached', handleSnapshotCached);

    const schedule = (delay = 0) => {
      if (terminal || disposed || backgroundPageCacheGenerationRef.current !== generation) return;
      const enqueue = () => {
        if (terminal || disposed || backgroundPageCacheGenerationRef.current !== generation) return;
        if (typeof window.requestIdleCallback === 'function') {
          // Do not supply a timeout. A timeout forced a full PDF render every
          // ten seconds even on a busy/slow terminal, producing a repeating
          // responsive/frozen cycle after the app had been left open.
          const id = window.requestIdleCallback(() => runNext());
          scheduledTask = { type: 'idle', id };
        } else {
          const id = setTimeout(() => runNext(), 100);
          scheduledTask = { type: 'timeout', id };
        }
      };
      if (delay > 0) {
        const id = setTimeout(enqueue, delay);
        scheduledTask = { type: 'timeout', id };
      } else {
        enqueue();
      }
    };

    const canvasToBlob = canvas => new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('页面快照生成失败')), 'image/png');
    });

    const releaseCompletedPdfResources = async (reason) => {
      if (disposed || backgroundPageCacheGenerationRef.current !== generation) return;
      // The durable PNG snapshot has already been committed to IndexedDB. PDF.js
      // still retains decoded operators/images for every getPage call unless the
      // document is explicitly cleaned. Releasing those transient resources does
      // not delete the completed page cache or annotation/recognition state.
      try {
        if (typeof pdfDocumentRef.cleanup === 'function') {
          await pdfDocumentRef.cleanup();
          console.debug('[PDF后台缓存] 已释放 PDF.js 临时页面资源', { reason });
        }
      } catch (error) {
        // A visible page may be painting at exactly this moment. Keep its render
        // intact and retry at the next completed batch/final cleanup.
        console.debug('[PDF后台缓存] 延后释放 PDF.js 临时资源', { reason, error: error?.message });
      }
    };

    const finishBackgroundCache = async reason => {
      if (terminal || disposed || backgroundPageCacheGenerationRef.current !== generation) return;
      terminal = true;
      await releaseCompletedPdfResources(reason);
      const finalProgress = {
        completed: Math.min(totalPages, completedPages.size),
        total: totalPages,
        running: false,
        failed: failedPages.size,
        skipped: skippedPages.size
      };
      backgroundPageCacheTerminalRef.current = { key: terminalKey, progress: finalProgress };
      setBackgroundPageCacheProgress(finalProgress);
      window.__pdfBackgroundSnapshotProgress = {
        ...finalProgress,
        paused: false,
        terminal: true,
        terminalKey,
        completedAt: Date.now(),
        finishReason: reason
      };
      // This closes only the connection. Cached PNG records remain available
      // and the database is reopened lazily when a page is requested later.
      await closePdfPageSnapshotCache();
    };

    const selectNextPage = () => {
      const visiblePage = Number(singlePageCurrentRef.current) || 1;
      for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
        if (singlePageSnapshotCacheRef.current.has(getSinglePageSnapshotKey(pageNumber))) {
          completedPages.add(pageNumber);
        }
      }
      const candidates = [];
      for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
        if (pageNumber === visiblePage || completedPages.has(pageNumber) || failedPages.has(pageNumber)) continue;
        candidates.push(pageNumber);
      }
      candidates.sort((left, right) => (
        Math.abs(left - visiblePage) - Math.abs(right - visiblePage) || left - right
      ));
      return candidates[0] || null;
    };

    const runNext = async () => {
      scheduledTask = null;
      if (terminal || disposed || backgroundPageCacheGenerationRef.current !== generation) return;
      const deferral = getBackgroundCacheDeferral({
        paused: backgroundPageCachePaused,
        exporting: window.__pdfExportInProgress,
        pauseUntil: backgroundPageCachePauseUntilRef.current,
        inputPending: Boolean(navigator.scheduling?.isInputPending?.())
      });
      if (deferral.defer) {
        reportProgress(false);
        schedule(deferral.delay);
        return;
      }
      const memoryPressureDelay = getMemoryPressureDelay();
      if (memoryPressureDelay > 0) {
        reportProgress(false);
        window.__pdfBackgroundSnapshotProgress = {
          ...(window.__pdfBackgroundSnapshotProgress || {}),
          paused: true,
          pauseReason: 'memory-pressure',
          resumeDelayMs: memoryPressureDelay
        };
        schedule(memoryPressureDelay);
        return;
      }
      // performance.memory excludes Canvas/Skia/GPU allocations. Use page
      // dimensions as a conservative native-memory guard before allocating
      // another full-page render target.
      const estimatedDecodedPageBytes = getEstimatedDecodedPageBytes();
      if (estimatedDecodedPageBytes >= 128 * 1024 * 1024) {
        const removedSnapshots = trimSinglePageSnapshotsToCurrent();
        reportProgress(false);
        window.__pdfBackgroundSnapshotProgress = {
          ...(window.__pdfBackgroundSnapshotProgress || {}),
          paused: true,
          pauseReason: 'estimated-canvas-memory',
          estimatedDecodedPageBytes,
          removedSnapshots,
          resumeDelayMs: 10000
        };
        await releaseCompletedPdfResources('estimated-canvas-memory');
        schedule(10000);
        return;
      }

      const pageNumber = selectNextPage();
      if (!pageNumber) {
        const visiblePage = Number(singlePageCurrentRef.current) || 1;
        // The background queue deliberately skips the visible page. When all
        // other pages are done, capture its already-rendered Canvas once and
        // stop instead of polling the whole document every 500 ms forever.
        if (!completedPages.has(visiblePage)) {
          const captureStatus = captureSinglePageSnapshot(visiblePage);
          if (captureStatus === 'skipped') {
            skippedPages.add(visiblePage);
            completedPages.add(visiblePage);
            await finishBackgroundCache('cache-complete-visible-skipped');
            return;
          }
          reportProgress(true);
          schedule(captureStatus === 'unavailable' ? 1000 : 300);
          return;
        }
        await finishBackgroundCache('cache-complete');
        return;
      }

      let page = null;
      let canvas = null;
      let context = null;
      let blob = null;
      const workStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
      try {
        reportProgress(true);
        page = await pdfDocumentRef.getPage(pageNumber);
        if (disposed || backgroundPageCacheGenerationRef.current !== generation) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const basePixels = Math.max(1, Math.ceil(baseViewport.width)) * Math.max(1, Math.ceil(baseViewport.height));
        const snapshotRenderScale = Math.max(
          0.1,
          Math.min(2, Math.sqrt(singlePageSnapshotMaxPixels / basePixels))
        );
        const viewport = page.getViewport({ scale: snapshotRenderScale });
        const canvasPixels = Math.max(1, Math.ceil(viewport.width)) * Math.max(1, Math.ceil(viewport.height));
        const skipSnapshot = canvasPixels > singlePageSnapshotMaxPixels;
        if (skipSnapshot) {
          // This cache is optional. Rendering a second high-resolution copy of
          // an oversized PDF page is a frequent source of renderer OOM, while
          // the normal visible-page render and PDF export must retain quality.
          skippedPages.add(pageNumber);
          completedPages.add(pageNumber);
          console.info('[PDF后台缓存] 跳过超大页面快照', {
            pageNumber,
            canvasPixels,
            maxPixels: singlePageSnapshotMaxPixels
          });
        } else {
          canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.ceil(viewport.width));
          canvas.height = Math.max(1, Math.ceil(viewport.height));
          context = canvas.getContext('2d', { alpha: false });
          context.fillStyle = '#fff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          const renderTask = page.render({ canvasContext: context, viewport });
          const activeRender = { pageNumber, renderTask, continuationTimer: null };
          backgroundPageCacheRenderRef.current = activeRender;
          // PDF.js normally runs a page paint as one long main-thread task.
          // Yield between its internal operator chunks so pointer/keyboard
          // events remain responsive while full-page caching continues.
          renderTask.onContinue = continueRendering => {
            const resumeWhenAllowed = () => {
              activeRender.continuationTimer = null;
              if (disposed || backgroundPageCacheGenerationRef.current !== generation) {
                try { renderTask.cancel(); } catch (error) { /* already completed */ }
                return;
              }
              const remainingQuietMs = Math.max(
                0,
                Number(backgroundPageCachePauseUntilRef.current || 0) - Date.now()
              );
              const hasPendingInput = Boolean(navigator.scheduling?.isInputPending?.());
              if (remainingQuietMs > 0 || hasPendingInput || window.__pdfExportInProgress) {
                activeRender.continuationTimer = setTimeout(
                  resumeWhenAllowed,
                  Math.max(50, Math.min(250, remainingQuietMs || 100))
                );
                return;
              }
              // A zero-delay task yields to queued input before the next PDF.js
              // operator chunk, while still progressing during normal use.
              activeRender.continuationTimer = setTimeout(continueRendering, 0);
            };
            resumeWhenAllowed();
          };
          await renderTask.promise;
          if (disposed || backgroundPageCacheGenerationRef.current !== generation) return;
          blob = await canvasToBlob(canvas);
          // putPdfPageSnapshot now resolves only after the IndexedDB write
          // transaction has fully committed, keeping this pipeline strictly
          // one-page-at-a-time.
          await putPdfPageSnapshot({
            key: getSinglePageSnapshotKey(pageNumber),
            scope: singlePageSnapshotScope,
            pageNumber,
            // Stored as the equivalent UI scale because visible pages render
            // with react-pdf scale = UI scale * 2.
            scale: snapshotRenderScale / 2,
            blob,
            cssWidth: Math.ceil(viewport.width),
            cssHeight: Math.ceil(viewport.height),
            size: blob.size
          });
          completedPages.add(pageNumber);
          notifySinglePageSnapshotPersisted(pageNumber);
        }
      } catch (error) {
        if (error?.name !== 'RenderingCancelledException') {
          failedPages.add(pageNumber);
          console.warn(`[PDF后台缓存] 第${pageNumber}页失败:`, error);
        }
      } finally {
        const activeRender = backgroundPageCacheRenderRef.current;
        if (activeRender?.pageNumber === pageNumber) {
          if (activeRender.continuationTimer) clearTimeout(activeRender.continuationTimer);
          backgroundPageCacheRenderRef.current = null;
        }
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
        context = null;
        blob = null;
        try { page?.cleanup?.(); } catch (error) { /* page may still be in use elsewhere */ }
      }
      reportProgress(true);
      pagesSinceCooldown += 1;
      const batchBoundary = pagesSinceCooldown >= backgroundBatchSize;
      if (batchBoundary) {
        pagesSinceCooldown = 0;
        await releaseCompletedPdfResources('batch-complete');
        // Closing the connection releases completed Blob transactions from the
        // renderer without deleting any persistent page snapshots.
        await closePdfPageSnapshotCache();
      }
      const workEndedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const workDurationMs = Math.max(0, workEndedAt - workStartedAt);
      window.__pdfBackgroundSnapshotLastTask = { pageNumber, workDurationMs, completedAt: Date.now() };
      if (batchBoundary) {
        const heap = typeof performance !== 'undefined' ? performance.memory : null;
        const diagnostic = {
          recordedAt: Date.now(),
          pageNumber,
          workDurationMs,
          completedPages: completedPages.size,
          totalPages,
          jsHeapUsed: Number(heap?.usedJSHeapSize || 0),
          jsHeapLimit: Number(heap?.jsHeapSizeLimit || 0),
          inMemorySnapshots: singlePageSnapshotCacheRef.current.size,
          textDerivedPages: textLikeDetectionsCacheRef.current.size,
          annotationRenderPages: renderedAnnotationsCacheRef.current.size,
          vectorCachePages: VectorExtractionUtils.vectorCache?.size || 0,
          pdfLibSourceDocuments: VectorExtractionUtils.pdfLibSourceCache?.size || 0,
          residentPdfBufferBytes: Number(window.__luotuPdfResidentBufferInfo?.retainedArrayBufferBytes || 0)
        };
        window.__luotuRendererMemoryDiagnostic = diagnostic;
        try {
          localStorage.setItem('luotu:last-renderer-memory-diagnostic', JSON.stringify(diagnostic));
        } catch (error) { /* diagnostics must never interrupt caching */ }
      }
      schedule(getBackgroundCacheCooldown({ workDurationMs, batchBoundary }));
    };

    listPdfSnapshotPages(singlePageSnapshotScope).then(pages => {
      if (disposed || backgroundPageCacheGenerationRef.current !== generation) return;
      const indexedPages = new Set(pages.map(pageNumber => Number(pageNumber)));
      const currentIndex = singlePageSnapshotDiskIndexRef.current;
      if (currentIndex.scope === singlePageSnapshotScope) {
        currentIndex.pages.forEach(pageNumber => indexedPages.add(Number(pageNumber)));
        singlePageSnapshotDiskIndexRef.current = {
          scope: singlePageSnapshotScope,
          ready: true,
          pages: indexedPages
        };
        setSinglePageSnapshotDiskIndexVersion(version => version + 1);
      }
      indexedPages.forEach(pageNumber => completedPages.add(Number(pageNumber)));
      reportProgress(true);
      schedule(1200);
      pruneLegacyScalePdfPageSnapshots()
        .then(removed => {
          if (removed > 0) console.info(`[PDF页面缓存] 已清理 ${removed} 个旧缩放缓存`);
        })
        .catch(error => console.warn('[PDF页面缓存] 旧缩放缓存清理失败:', error));
      pruneOldPdfPageSnapshots().catch(error => console.warn('[PDF页面缓存] 过期缓存清理失败:', error));
    }).catch(error => {
      console.warn('[PDF页面缓存] 缓存索引读取失败:', error);
      const currentIndex = singlePageSnapshotDiskIndexRef.current;
      if (currentIndex.scope === singlePageSnapshotScope) {
        currentIndex.ready = true;
        setSinglePageSnapshotDiskIndexVersion(version => version + 1);
      }
      reportProgress(true);
      schedule(1200);
    });

    return () => {
      disposed = true;
      window.removeEventListener('pdf-page-snapshot-cached', handleSnapshotCached);
      backgroundPageCacheGenerationRef.current += 1;
      if (scheduledTask?.type === 'idle' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(scheduledTask.id);
      } else if (scheduledTask?.id) {
        clearTimeout(scheduledTask.id);
      }
      const active = backgroundPageCacheRenderRef.current;
      if (active?.continuationTimer) clearTimeout(active.continuationTimer);
      if (active?.renderTask?.cancel) {
        try { active.renderTask.cancel(); } catch (error) { /* already completed */ }
      }
      backgroundPageCacheRenderRef.current = null;
    };
  }, [
    backgroundPageCachePaused,
    captureSinglePageSnapshot,
    getSinglePageSnapshotKey,
    notifySinglePageSnapshotPersisted,
    numPages,
    pdfDocumentRef,
    serverPageCacheMode,
    singlePageSnapshotScope,
    singlePageSnapshotMaxPixels,
    trimSinglePageSnapshotsToCurrent
  ]);

  // Long-lived tabs do not need PDF.js page objects, extra decoded snapshots
  // or recognizer spatial indexes while idle. This protection must not depend
  // on a cache job reaching a terminal state: a stalled/failed registration is
  // exactly when an overnight tab still needs reclamation. Business state and
  // persistent IndexedDB page snapshots remain intact.
  useEffect(() => {
    const releaseIdleRuntimeResources = async () => {
      if (window.__pdfExportInProgress || backgroundPageCacheRenderRef.current) return;

      const now = Date.now();
      const hiddenForMs = pdfHiddenSinceRef.current ? now - pdfHiddenSinceRef.current : 0;
      const idleForMs = now - Number(lastPdfInteractionAtRef.current || now);
      const heap = typeof performance !== 'undefined' ? performance.memory : null;
      const jsHeapUsed = Number(heap?.usedJSHeapSize || 0);
      const jsHeapLimit = Number(heap?.jsHeapSizeLimit || 0);
      const canvasElements = Array.from(containerRef.current?.querySelectorAll?.('canvas') || []);
      const canvasPixelBytes = canvasElements.reduce((total, canvas) => (
        total + Math.max(0, Number(canvas.width || 0)) * Math.max(0, Number(canvas.height || 0)) * 4
      ), 0);
      let decodedSnapshotBytes = 0;
      singlePageSnapshotCacheRef.current.forEach(item => {
        decodedSnapshotBytes += Math.max(0, Number(item?.cssWidth || 0)) *
          Math.max(0, Number(item?.cssHeight || 0)) * 4;
      });
      const jsHeapRatio = jsHeapUsed > 0 && jsHeapLimit > 0 ? jsHeapUsed / jsHeapLimit : 0;
      const memoryPressure = (
        jsHeapRatio >= 0.72 ||
        (jsHeapLimit > 0 && jsHeapLimit - jsHeapUsed < 384 * 1024 * 1024) ||
        canvasPixelBytes + decodedSnapshotBytes >= 192 * 1024 * 1024
      );
      const diagnostic = {
        recordedAt: now,
        currentPage: Number(singlePageCurrentRef.current) || 1,
        hiddenForMs,
        idleForMs,
        jsHeapUsed,
        jsHeapLimit,
        jsHeapRatio,
        canvasCount: canvasElements.length,
        canvasPixelBytes,
        decodedSnapshotBytes,
        inMemorySnapshots: singlePageSnapshotCacheRef.current.size,
        pendingSnapshots: singlePageSnapshotPendingRef.current.size,
        activeSnapshotDecodes: singlePageSnapshotDecodeHandlesRef.current.size,
        activeRemotePageFetches: currentRemotePageFetchRef.current?.controller ? 1 : 0,
        pdfPageObjects: Number(pageObjectsRef.current?.size || 0),
        annotationRenderPages: renderedAnnotationsCacheRef.current.size,
        textDerivedPages: textLikeDetectionsCacheRef.current.size,
        vectorCachePages: VectorExtractionUtils.vectorCache?.size || 0,
        pdfLibSourceDocuments: VectorExtractionUtils.pdfLibSourceCache?.size || 0,
        memoryPressure
      };
      window.__luotuRendererMemoryDiagnostic = diagnostic;
      try {
        localStorage.setItem('luotu:last-renderer-memory-diagnostic', JSON.stringify(diagnostic));
      } catch (error) { /* diagnostics must never affect the editor */ }

      // Native PDF/Skia allocations are not included in performance.memory.
      // Reclaim after five minutes without input so a large PDF cannot grow
      // for twenty minutes before the browser notices pressure. Current page
      // pixels and persistent snapshots remain intact.
      const eligible = memoryPressure || hiddenForMs >= 5 * 60 * 1000 || idleForMs >= 5 * 60 * 1000;
      // A release is deliberately repeatable. The old `> 0` guard allowed the
      // first pressure cleanup only; after memory grew again the renderer could
      // never reclaim another batch until the PDF was reopened.
      const releaseCooldownMs = 5 * 60 * 1000;
      if (!eligible || (
        lastIdleRuntimeReleaseAtRef.current > 0 &&
        now - lastIdleRuntimeReleaseAtRef.current < releaseCooldownMs
      )) return;
      lastIdleRuntimeReleaseAtRef.current = now;
      snapshotLoadsSuspendedRef.current = true;

      cancelSinglePagePreloadTask();
      singlePagePreloadQueueRef.current = [];
      // A hidden tab does not need even the current decoded image. Its disk
      // snapshot is preserved and is restored locally when the tab is shown.
      const removedSnapshots = hiddenForMs >= 5 * 60 * 1000
        ? clearSinglePageSnapshots()
        : trimSinglePageSnapshotsToCurrent();
      renderedAnnotationsCacheRef.current.clear();
      textLikeDetectionsCacheRef.current.clear();
      multiPageBatchService.releaseTransientRecognitionCaches();
      VectorExtractionUtils.releasePdfLibSourceDocument();
      pageObjectsRef.current?.forEach?.(page => {
        try { page?.cleanup?.(); } catch (error) { /* already released */ }
      });
      pageObjectsRef.current?.clear?.();
      renderedSinglePagesRef.current.clear();
      renderedSinglePagesRef.current.add(Number(singlePageCurrentRef.current) || 1);
      try { await pdfDocumentRef?.cleanup?.(); } catch (error) {
        console.debug('[PDF内存保护] PDF.js空闲清理延后:', error?.message || error);
      }
      await closePdfPageSnapshotCache();
      window.__luotuIdleRuntimeRelease = {
        releasedAt: now,
        hiddenForMs,
        idleForMs,
        removedSnapshots,
        reason: memoryPressure ? 'memory-pressure' : (hiddenForMs >= 5 * 60 * 1000 ? 'hidden' : 'idle'),
        beforeRelease: diagnostic,
        currentPage: Number(singlePageCurrentRef.current) || 1
      };
      console.info('[PDF内存保护] 已释放空闲运行资源，磁盘缓存和业务状态保持不变', window.__luotuIdleRuntimeRelease);
    };

    const timer = window.setInterval(releaseIdleRuntimeResources, 60 * 1000);
    return () => window.clearInterval(timer);
  }, [
    cancelSinglePagePreloadTask,
    clearSinglePageSnapshots,
    pdfDocumentRef,
    trimSinglePageSnapshotsToCurrent
  ]);

  const handleTogglePipeLengthDebug = useCallback(async () => {
    if (pipeLengthRecognizing) return;
    if (showPipeLengthDebug) {
      setShowPipeLengthDebug(false);
      return;
    }

    const cachedRecognitionData = recognitionCache?.getPageData?.(currentPage) || pageRecognitionData[currentPage]?.data;
    const hasReadableText = (...lists) => lists.some(list => (
      Array.isArray(list) && list.some(item => {
        const text = item?.text ?? item?.value ?? item?.content ?? item?.label ?? item?.scaffoldInfo ?? item?.originalText ?? '';
        return String(text || '').trim().length > 0;
      })
    ));

    const hasTextData = hasReadableText(
      textDetections[currentPage]?.detections,
      cachedRecognitionData?.detections,
      cachedRecognitionData?.scaffold,
      cachedRecognitionData?.scaffolds,
      cachedRecognitionData?.scaffoldData
    );

    if (!hasTextData) {
      try {
        setPipeLengthRecognizing(true);

        let pdfPathOrFile = file;
        if (window.__lastOpenedPdfFile__ instanceof File || window.__lastOpenedPdfFile__ instanceof Blob) {
          pdfPathOrFile = window.__lastOpenedPdfFile__;
        }

        const isValidPath = typeof file === 'string' &&
          file.length > 0 &&
          !file.startsWith('blob:');

        if (!isValidPath && !(pdfPathOrFile instanceof File || pdfPathOrFile instanceof Blob)) {
          pdfPathOrFile = window.__lastOpenedPdfPath__ || window.__lastOpenedPdfFile__;
        }

        if (!pdfPathOrFile) {
          message.error('无法获取PDF文件，请重新打开PDF文件后再试');
          return;
        }

        const { default: ocrService } = await import('../services/ocrService');
        const currentWeldArea = latestAreasRef.current.weldRecognition || globalWeldRecognitionArea;
        const recognitionArea = currentWeldArea || { x: 0, y: 0, width: 1, height: 1, page: currentPage };
        const pipeLengthTemplate = {
          materialArea: null,
          scaffoldArea: {
            ...recognitionArea,
            page: recognitionArea.page || currentPage
          }
        };

        message.loading({ content: '正在识别当前页管道长度文字...', key: 'pipe-length-recognize', duration: 0 });
        const result = await ocrService.recognizeSinglePage(pdfPathOrFile, pipeLengthTemplate, currentPage);
        const detections = result?.detections || result?.scaffold || result?.scaffolds || [];

        if (typeof window !== 'undefined') {
          const debugPayload = {
            time: new Date().toISOString(),
            page: currentPage,
            area: recognitionArea,
            detectionCount: detections.length,
            texts: detections.map((item, index) => ({
              index,
              text: item?.text || item?.scaffoldInfo || item?.originalText || item?.content || '',
              score: item?.score || item?.confidence || null,
              box: item?.box || item?.bbox || null
            }))
          };
          window.__lastPipeLengthOcrResult = debugPayload;
          console.log('[管道长度识别] OCR返回结果', debugPayload);
          auditLogService.log('pipe_length_ocr', {
            pdfFileName: file?.name || pdfFilePath || '',
            page: currentPage,
            count: detections.length,
            area: recognitionArea,
            detectionCount: detections.length,
            texts: debugPayload.texts.slice(0, 120)
          });
        }

        setTextDetections(prev => ({
          ...prev,
          [currentPage]: {
            ...(prev[currentPage] || {}),
            ...(result || {}),
            detections,
            page_info: result?.pageInfo || result?.page_info || prev[currentPage]?.page_info || {},
            _pipeLengthAutoRecognized: true
          }
        }));

        message.success({
          content: `管道长度文字识别完成，识别到 ${detections.length} 个文字项`,
          key: 'pipe-length-recognize',
          duration: 2
        });
      } catch (error) {
        console.error('管道长度文字识别失败:', error);
        message.error({
          content: `管道长度识别失败: ${error.message}`,
          key: 'pipe-length-recognize',
          duration: 4
        });
        return;
      } finally {
        setPipeLengthRecognizing(false);
      }
    }

    setShowPipeLengthDebug(true);
  }, [
    currentPage,
    file,
    pageRecognitionData,
    pipeLengthRecognizing,
    recognitionCache,
    showPipeLengthDebug,
    textDetections
  ]);

  // 书签面板状态
  const [showBookmarkPanel, setShowBookmarkPanel] = useState(false);

  // 🚀 辅助函数：获取页面识别数据（优先从缓存获取，解决批量识别时内存优化导致的数据访问问题）
  const getPageRecognitionData = useCallback((pageNum) => {
    // 优先从缓存获取（批量识别模式下数据只存在缓存中）
    if (recognitionCache) {
      const cachedData = recognitionCache.getPageData(pageNum);
      if (cachedData) {
        return cachedData;
      }
    }
    // 回退到React state中的数据
    return pageRecognitionData[pageNum]?.data || null;
  }, [recognitionCache, pageRecognitionData]);

  const getDetectionText = useCallback((item) => (
    item?.text ??
    item?.value ??
    item?.content ??
    item?.label ??
    item?.scaffoldInfo ??
    item?.originalText ??
    item?.materialDescription ??
    item?.description ??
    ''
  ), []);

  const normalizeDetectionItem = useCallback((item, source) => {
    if (!item || typeof item !== 'object') return null;
    const text = String(getDetectionText(item) || '').trim();
    const box = item.box || item.bbox || item.points || item.polygon || null;
    const hasBox = Array.isArray(box) && box.length > 0;
    const hasRect = [item.x, item.y, item.width ?? item.w, item.height ?? item.h]
      .every(value => typeof value === 'number' && Number.isFinite(value));
    const hasPosition = item.position &&
      typeof item.position.x === 'number' &&
      typeof item.position.y === 'number';

    if (!text && !hasBox && !hasRect && !hasPosition) return null;

    const normalized = {
      ...item,
      text,
      _detectionSource: source
    };

    if (!normalized.box && box) {
      normalized.box = box;
    }

    if (!normalized.box && hasRect) {
      normalized.box = [
        [item.x, item.y],
        [item.x + (item.width ?? item.w), item.y],
        [item.x + (item.width ?? item.w), item.y + (item.height ?? item.h)],
        [item.x, item.y + (item.height ?? item.h)]
      ];
    }

    return normalized;
  }, [getDetectionText]);

  const getPageTextLikeDetections = useCallback((pageNum) => {
    const recognizedPageData = getPageRecognitionData(pageNum) || {};
    const textPageData = textDetections?.[pageNum] || {};
    const sources = [
      ['text', textPageData.detections],
      ['recognition', recognizedPageData.detections],
      ['scaffold', recognizedPageData.scaffold],
      ['scaffolds', recognizedPageData.scaffolds],
      ['scaffoldData', recognizedPageData.scaffoldData],
      ['materials', recognizedPageData.materials],
      ['materialData', recognizedPageData.materialData]
    ];

    const sourceLists = sources.map(([, list]) => list);
    const cached = textLikeDetectionsCacheRef.current.get(Number(pageNum));
    if (
      cached
      && cached.sourceLists.length === sourceLists.length
      && cached.sourceLists.every((list, index) => list === sourceLists[index])
    ) {
      return touchExistingMapEntry(textLikeDetectionsCacheRef.current, Number(pageNum))?.result || cached.result;
    }

    const result = [];
    const seen = new Set();

    sources.forEach(([source, list]) => {
      if (!Array.isArray(list)) return;
      list.forEach(item => {
        const normalized = normalizeDetectionItem(item, source);
        if (!normalized) return;
        const boxKey = Array.isArray(normalized.box)
          ? JSON.stringify(normalized.box).slice(0, 160)
          : `${normalized.x ?? ''},${normalized.y ?? ''},${normalized.width ?? normalized.w ?? ''},${normalized.height ?? normalized.h ?? ''}`;
        const key = `${normalized.text}|${boxKey}`;
        if (seen.has(key)) return;
        seen.add(key);
        result.push(normalized);
      });
    });

    // This is a disposable normalized copy of recognition data, not business
    // state. Keeping one copy for every visited page eventually retained a
    // large renderer heap on long drawings.
    touchBoundedMapEntry(
      textLikeDetectionsCacheRef.current,
      Number(pageNum),
      { sourceLists, result },
      12
    );
    return result;
  }, [getPageRecognitionData, normalizeDetectionItem, textDetections]);

  useEffect(() => {
    textLikeDetectionsCacheRef.current.clear();
  }, [file]);

  // 处理区域删除选择
  const handleAreaDeleteMouseDown = useCallback((e) => {
    console.log('🖱️ 区域删除 MouseDown 触发', { areaDeleteMode, button: e.button });
    if (!areaDeleteMode || e.button !== 0) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    // 获取相对于 AnnotationLayer 的坐标（与标注创建时相同的坐标系统）
    const rect = e.currentTarget.getBoundingClientRect();
    const pageX = (e.clientX - rect.left) / scale;
    const pageY = (e.clientY - rect.top) / scale;
    
    console.log('📍 开始选择区域:', { pageX, pageY, scale });
    
    setIsSelectingArea(true);
    setAreaSelection({
      startX: pageX,
      startY: pageY,
      endX: pageX,
      endY: pageY
    });
  }, [areaDeleteMode, scale]);

  const handleAreaDeleteMouseMove = useCallback((e) => {
    if (!isSelectingArea || !areaDeleteMode) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    // 使用与标注创建时相同的坐标系统
    const rect = e.currentTarget.getBoundingClientRect();
    const pageX = (e.clientX - rect.left) / scale;
    const pageY = (e.clientY - rect.top) / scale;
    
    console.log('🖱️ 区域选择移动:', { pageX, pageY });
    
    setAreaSelection(prev => ({
      ...prev,
      endX: pageX,
      endY: pageY
    }));
  }, [isSelectingArea, areaDeleteMode, scale]);

  const handleAreaDeleteMouseUp = useCallback((e) => {
    if (!isSelectingArea || !areaDeleteMode || !areaSelection) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    setIsSelectingArea(false);
    
    // 检查选区大小，避免误触（点击而非拖拽）
    const width = Math.abs(areaSelection.endX - areaSelection.startX);
    const height = Math.abs(areaSelection.endY - areaSelection.startY);
    
    console.log('📐 区域选择完成:', {
      selection: areaSelection,
      width,
      height,
      currentPage,
      scale,
      viewOffset
    });
    
    if (width < 5 && height < 5) {
      // 选区太小，认为是误触
      console.log('⚠️ 选区太小，忽略');
      setAreaSelection(null);
      return;
    }
    
    // 调用区域删除回调
    if (onAreaDelete) {
      console.log('🗑️ 调用区域删除回调');
      onAreaDelete(areaSelection, currentPage);
    }
    
    // 清空选区
    setAreaSelection(null);
  }, [isSelectingArea, areaDeleteMode, areaSelection, onAreaDelete, currentPage]);

  // 定期检查选中状态
  useEffect(() => {
    if (!showVectorDebug) {
      setHasSelection(false);
      return undefined;
    }
    const checkInterval = setInterval(() => {
      if (firstPageVisualizerRef.current && firstPageVisualizerRef.current.getSelectionInfo) {
        const info = firstPageVisualizerRef.current.getSelectionInfo();
        setHasSelection(previous => previous === info.selectedCount ? previous : info.selectedCount);
      }
    }, 500); // 每500ms检查一次
    
    return () => clearInterval(checkInterval);
  }, [showVectorDebug]);
  
  // 导出调试数据（技术数据）或标注数据（手动标注）
  const handleExportDebugData = () => {
    if (!firstPageVisualizerRef.current) {
      console.warn('没有可用的矢量数据进行导出');
      return;
    }
    
    // 检查是否有选中的内容
    const info = firstPageVisualizerRef.current.getSelectionInfo ? 
      firstPageVisualizerRef.current.getSelectionInfo() : { selectedCount: 0 };
    
    if (info.selectedCount > 0) {
      // 有选中内容 -> 导出标注数据
      if (firstPageVisualizerRef.current.exportManualAnnotations) {
        firstPageVisualizerRef.current.exportManualAnnotations();
      }
    } else {
      // 无选中内容 -> 导出技术调试数据
      if (firstPageVisualizerRef.current.exportDebugData) {
        firstPageVisualizerRef.current.exportDebugData();
      }
    }
  };
  
  // 导出焊点数据（用户数据）
  const handleExportWelds = () => {
    if (firstPageVisualizerRef.current && firstPageVisualizerRef.current.exportSelectedWelds) {
      firstPageVisualizerRef.current.exportSelectedWelds();
    } else {
      console.warn('没有可用的焊点数据进行导出');
    }
  };

  // 文字识别（全页OCR，不需要模板）
  const handleTextDetection = async () => {
    if (textDetecting) {
      console.log('⚠️ 文字识别正在进行中');
      return;
    }

    try {
      setTextDetecting(true);
      
      // 清除页面尺寸警告标志，允许新一轮检测时重新显示警告
      delete window.__weldTextSizeWarningShown__;
      
      // 🌐 支持Web端：优先使用路径，没有路径时使用文件对象
      let pdfPathOrFile = file;
      if (window.__lastOpenedPdfFile__ instanceof File || window.__lastOpenedPdfFile__ instanceof Blob) {
        pdfPathOrFile = window.__lastOpenedPdfFile__;
      }
      
      // 检查是否为有效路径
      const isValidPath = typeof file === 'string' && 
                         file.length > 0 && 
                         !file.startsWith('blob:');
      
      if (!isValidPath && !(pdfPathOrFile instanceof File || pdfPathOrFile instanceof Blob)) {
        // 尝试使用全局保存的路径
        pdfPathOrFile = window.__lastOpenedPdfPath__;
        
        // 如果路径也不可用，尝试使用文件对象
        if (!pdfPathOrFile && window.__lastOpenedPdfFile__) {
          pdfPathOrFile = window.__lastOpenedPdfFile__;
          console.log('🌐 [Web] 文字识别使用文件对象');
        }
      }
      
      if (!pdfPathOrFile) {
        message.error('无法获取PDF文件。请重新打开PDF文件后再试。');
        setTextDetecting(false);
        return;
      }

      const currentWeldArea = latestAreasRef.current.weldRecognition || globalWeldRecognitionArea;
      if (currentWeldArea) {
        try {
          let extractedVectorsForCurrentPage = false;
          if (!pageVectors[currentPage] || pageVectors[currentPage].length === 0) {
            const page = pageObjectsRef?.current?.get?.(currentPage);
            if (page) {
              const { VectorExtractionUtils } = await import('../utils/vectorExtractionUtils');
              const vectors = await VectorExtractionUtils.extractVectors(page);
              setPageVectors(prev => ({
                ...prev,
                [currentPage]: vectors
              }));
              extractedVectorsForCurrentPage = true;
            }
          }
          if (showWeldDebug && !extractedVectorsForCurrentPage) {
            setRulesVersion(prev => prev + 1);
          }
        } catch (error) {
          console.warn('文字识别前焊点区域识别准备失败，继续执行文字识别:', error);
        }
      }

      const isFileObject = pdfPathOrFile instanceof File || pdfPathOrFile instanceof Blob;
      console.log('📝 开始文字识别:', { 
        isFileObject,
        pdfPath: isFileObject ? '(文件对象)' : pdfPathOrFile, 
        currentPage 
      });
      
      // 动态导入OCR服务
      const { default: ocrService } = await import('../services/ocrService');
      
      const currentPipelineArea = latestAreasRef.current.pipeline || globalPipelineArea;
      const currentPipeClassArea = latestAreasRef.current.pipeClass || globalPipeClassArea;
      const textDetectionTemplate = (currentPipelineArea || currentPipeClassArea) ? {
        ...(currentPipelineArea ? { pipelineArea: {
          ...currentPipelineArea,
          page: currentPipelineArea.page || currentPage
        } } : {}),
        ...(currentPipeClassArea ? { pipeClassArea: {
          ...currentPipeClassArea,
          page: currentPipeClassArea.page || currentPage
        } } : {})
      } : null;

      const result = await ocrService.detectTextOnly(pdfPathOrFile, currentPage, textDetectionTemplate);
      
      console.log('✅ 文字识别完成:', {
        detections: result.detections.length,
        page: currentPage,
        page_info: result.page_info
      });
      
      // 🔧 如果 page_info 不完整，使用 PDF 页面的原始尺寸补全
      // 注意：pageSize 是渲染后的尺寸（乘以 scale=2.0），需要除以 scale 得到原始尺寸
      const hasValidPageInfo = result.page_info && 
        (result.page_info.page_width > 0 || result.page_info.width > 0) && 
        (result.page_info.page_height > 0 || result.page_info.height > 0);
      
      if (!hasValidPageInfo && pageSize && pageSize.width > 0 && pageSize.height > 0) {
        // PDF 渲染使用的 scale 是 2.0，需要还原为原始尺寸
        const PDF_RENDER_SCALE = 2.0;
        const originalWidth = Math.round(pageSize.width / PDF_RENDER_SCALE);
        const originalHeight = Math.round(pageSize.height / PDF_RENDER_SCALE);
        
        console.log('🔧 使用 PDF 原始页面尺寸补全 page_info:', {
          渲染尺寸: `${pageSize.width} x ${pageSize.height}`,
          原始尺寸: `${originalWidth} x ${originalHeight}`,
          scale: PDF_RENDER_SCALE
        });
        
        result.page_info = {
          page_width: originalWidth,
          page_height: originalHeight,
          page_index: currentPage,
          _fromPdfPage: true
        };
      }
      
      const finalResult = enrichTextDetectionResult(result, currentPage, result.page_info);
      console.log('🧾 管线号提取结果:', {
        page: currentPage,
        pipelineStatus: finalResult.pipelineStatus,
        pipelineNumber: finalResult.pipelineNumber,
        pipelineConfidence: finalResult.pipelineConfidence,
        pipelineEngine: finalResult.pipelineEngine,
        pipelineFallbackUsed: finalResult.pipelineFallbackUsed,
        pipelineSource: finalResult.pipelineSource,
        topCandidates: (finalResult.pipelineCandidates || []).slice(0, 3).map(candidate => ({
          text: candidate.text,
          normalizedText: candidate.normalizedText,
          score: candidate.score,
          confidence: candidate.confidence
        }))
      });

      // 存储识别结果
      setTextDetections(prev => ({
        ...prev,
        [currentPage]: finalResult
      }));
      onPageTextDetectionsChange?.({ [currentPage]: finalResult });

      // 触发焊点重新识别（如果焊点识别已启用）
      
      const pipelineLabel = finalResult.pipelineStatus === 'matched'
        ? `管线号 ${finalResult.pipelineNumber}`
        : '未识别到管线号';
      const pipelineSourceLabel = finalResult.pipelineEngine === 'mineru'
        ? 'MinerU'
        : (finalResult.pipelineFallbackUsed ? 'PaddleOCR回退' : 'PaddleOCR');
      const pipeClassLabel = finalResult.pipeClass ? `，管道等级 ${finalResult.pipeClass}` : '';
      message.success(`识别到 ${finalResult.detections.length} 个文字区域，${pipelineLabel}${pipeClassLabel}，来源 ${pipelineSourceLabel}`);
      
    } catch (error) {
      console.error('❌ 文字识别失败:', error);
      message.error(`文字识别失败: ${error.message}`);
    } finally {
      setTextDetecting(false);
    }
  };

  // 导出文字识别结果
  const handleExportTextDetections = async (format = 'json') => {
    try {
      // 动态导入导出工具
      const { exportCurrentPageDetections } = await import('../utils/TextDetectionExportUtils');
      
      const currentPageDetections = textDetections[currentPage];
      if (!currentPageDetections || !currentPageDetections.detections) {
        message.warning('当前页面没有文字识别数据');
        return;
      }

      // 获取PDF文件名
      let pdfFileName = 'document';
      if (file && typeof file === 'string') {
        pdfFileName = file.split(/[/\\]/).pop().replace('.pdf', '');
      }

      // 导出
      exportCurrentPageDetections(
        currentPageDetections,
        currentPage,
        format,
        pdfFileName
      );
      
    } catch (error) {
      console.error('❌ 导出文字识别结果失败:', error);
      message.error(`导出失败: ${error.message}`);
    }
  };

  // 调试：监控 pageVectors 变化
  useEffect(() => {
    const pages = Object.keys(pageVectors);
    if (pages.length > 0) {
      console.log('📄 pageVectors 已更新:', {
        pageCount: pages.length,
        pages: pages.map(p => `Page ${p}: ${pageVectors[p]?.length || 0} vectors`)
      });
    }
  }, [pageVectors]);

  // 将 setPageVectors 暴露给全局，供 PDFDocumentManager 使用
  useEffect(() => {
    window.setPageVectors = setPageVectors;
    window.currentRenderMode = renderMode;
    return () => {
      delete window.setPageVectors;
      delete window.currentRenderMode;
    };
  }, [renderMode]);

  // 控制矢量调试的启用状态，并在启用时触发矢量提取
  useEffect(() => {
    window.enableVectorDebug = showVectorDebug;
    
    // 当启用矢量调试时，手动触发当前页的矢量提取
    if ((showVectorDebug || showFittingDebug || showPipeLengthDebug) && renderMode === 'svg') {
      // 🚀 性能优化：使用防抖避免快速翻页时重复提取
      const debounceTimer = setTimeout(async () => {
        try {
          // 获取当前页的 page 对象
          if (pageObjectsRef && pageObjectsRef.current && pageObjectsRef.current.has(currentPage)) {
            // 检查是否已经提取过
            if (pageVectors[currentPage] && pageVectors[currentPage].length > 0) {
              console.log(`✅ [矢量调试] 第 ${currentPage} 页矢量已缓存，跳过重复提取`);
              return;
            }
            
            const page = pageObjectsRef.current.get(currentPage);
            const { VectorExtractionUtils } = await import('../utils/vectorExtractionUtils');
            
            console.log(`🔄 [矢量调试] 开始提取第 ${currentPage} 页矢量...`);
            const vectors = await VectorExtractionUtils.extractVectors(page);
            console.log(`✅ [矢量调试] 第 ${currentPage} 页提取到 ${vectors.length} 个矢量路径`);
            
            setPageVectors(prev => ({
              ...prev,
              [currentPage]: vectors
            }));
          } else {
            console.log(`⏳ [矢量调试] 等待第 ${currentPage} 页加载...`);
          }
        } catch (err) {
          console.warn(`❌ [矢量调试] 第 ${currentPage} 页矢量提取失败:`, err);
        }
      }, 300); // 300ms 防抖延迟
      
      return () => clearTimeout(debounceTimer);
    }
    
    return () => {
      delete window.enableVectorDebug;
    };
  }, [showVectorDebug, showFittingDebug, showPipeLengthDebug, renderMode, currentPage, pageObjectsRef, pageVectors]);

  // 暴露数据到全局，供焊点文字检查工具使用
  useEffect(() => {
    window.__firstPageVisualizerRef__ = firstPageVisualizerRef;
    window.__currentTextDetections__ = textDetections[currentPage];
    // 🆕 暴露 PDF 页面尺寸，供文字过滤使用
    window.__pdfPageSize__ = pageSize;
    window.dispatchEvent(new CustomEvent('vectorTestUpdate'));
    
    return () => {
      delete window.__firstPageVisualizerRef__;
      delete window.__currentTextDetections__;
      delete window.__pdfPageSize__;
    };
  }, [textDetections, currentPage, pageSize]);

  // 暴露recognizer到window（当焊点识别启用时）
  useEffect(() => {
    if (showWeldDebug && firstPageVisualizerRef.current) {
      // 等待一小段时间确保 VectorVisualizer 已完全初始化
      const timer = setTimeout(() => {
        if (firstPageVisualizerRef.current) {
          // 尝试获取 recognizer
          let recognizer = null;
          
          if (firstPageVisualizerRef.current.getRecognizer) {
            recognizer = firstPageVisualizerRef.current.getRecognizer();
          }
          
          if (!recognizer && firstPageVisualizerRef.current.getRuleManager) {
            const ruleManager = firstPageVisualizerRef.current.getRuleManager();
            if (ruleManager && ruleManager.__recognizer__) {
              recognizer = ruleManager.__recognizer__;
            }
          }
          
          if (recognizer) {
            window.__weldRecognizer__ = recognizer;
            console.log('✅ Recognizer 已暴露到 window.__weldRecognizer__');
          }
        }
      }, 500);
      
      // The persisted region is not touched here. Refresh only the viewport
      // geometry when scrolling/resizing so the visual overlay cannot use a
      // stale client rectangle after the PDF layout moves.
      let frameId = null;
      const refreshDisplayGeometry = () => {
        if (frameId !== null) cancelAnimationFrame(frameId);
        frameId = requestAnimationFrame(() => {
          frameId = null;
          setCanvasGeometry(ocrUtils.getCanvasGeometry());
          setOcrRenderKey(prev => prev + 1);
        });
      };
      window.addEventListener('resize', refreshDisplayGeometry, { passive: true });
      window.addEventListener('scroll', refreshDisplayGeometry, true);
      return () => {
        clearTimeout(timer);
        if (frameId !== null) cancelAnimationFrame(frameId);
        window.removeEventListener('resize', refreshDisplayGeometry);
        window.removeEventListener('scroll', refreshDisplayGeometry, true);
      };
    } else {
      delete window.__weldRecognizer__;
    }
  }, [showWeldDebug]);

  // 初始化全局检查工具（仅一次）
  useEffect(() => {
    initGlobalWeldTextCheck();
    initGlobalPipelineCheck();
    console.log('✅ 调试工具已初始化，可在控制台使用:');
    console.log('   【焊点工具】');
    console.log('   window.checkWeldText()         // 分析焊点与文字关系');
    console.log('   window.getPureWelds()          // 获取纯净焊点');
    console.log('   window.getContaminatedWelds()  // 获取在文字区域内的焊点');
    console.log('   【管道工具】');
    console.log('   window.checkPipelines()        // 检测管道');
    console.log('   window.analyzePaths()          // 分析 Path 统计');
    console.log('   window.highlightPipelines()    // 高亮管道');
  }, []);

  // Each VectorVisualizer publishes only its own page. Page-scoped signatures and
  // storage prevent one mounted page from replacing another page's weld results.
  const handleDisplayedWeldsChange = useCallback(({ pageNumber, welds: sourceWelds, pipelineNumber }) => {
    const normalizedPage = Number(pageNumber);
    if (!showWeldDebugRef.current || !Number.isFinite(normalizedPage)) return;
    // Fast scrolling can mount a detector outside the active batch. Keep that
    // page display-only so it cannot refresh or replace the current sequence.
    if (!isPageInsideMultiPagePreview(normalizedPage)) {
      const pending = displayedWeldPendingRef.current.get(normalizedPage);
      if (pending?.timer) clearTimeout(pending.timer);
      displayedWeldPendingRef.current.delete(normalizedPage);
      return;
    }

    const welds = Array.isArray(sourceWelds) ? sourceWelds : [];
    const currentVectors = pageVectorsRef.current[normalizedPage] || [];
    if (welds.length > 0 && currentVectors.length > 0) {
      try {
        associateWeldsWithSingleSegmentVectors(welds, currentVectors, 15);
      } catch (error) {
        console.warn('焊点-单线段关联失败:', error);
      }
    }

    const signature = `${normalizedPage}:${pipelineNumber || ''}:` + welds.map((weld) => {
      const center = weld?.center || {};
      return [
        getWeldSelectionKey(weld),
        Number(center.x || 0).toFixed(2),
        Number(center.y || 0).toFixed(2),
        weld?.relatedSegmentId || weld?.relatedSegment?.pathId || ''
      ].join('@');
    }).join('|');
    const normalizedWelds = welds.map(weld => ({
      ...weld,
      page: normalizedPage,
      pageNum: normalizedPage,
      pipelineNumber: weld?.pipelineNumber || pipelineNumber || ''
    }));
    const previousPending = displayedWeldPendingRef.current.get(normalizedPage);
    if (previousPending?.timer) clearTimeout(previousPending.timer);
    const updateToken = `${Date.now()}-${Math.random()}`;
    const timer = setTimeout(() => {
      const latestPending = displayedWeldPendingRef.current.get(normalizedPage);
      if (!latestPending || latestPending.token !== updateToken) return;
      displayedWeldPendingRef.current.delete(normalizedPage);
      if (!showWeldDebugRef.current) return;
      if (!isPageInsideMultiPagePreview(normalizedPage)) return;
      if (signature === displayedWeldSignaturesRef.current.get(normalizedPage)) return;

      const existingWelds = multiPageBatchService.getPageWelds(normalizedPage);
      // Mounted page layers can briefly publish an empty/intermediate result while
      // pages are changing. Never let that transient frame erase a numbered page.
      if (
        multiPageNumberPreviewRef.current &&
        normalizedWelds.length === 0 &&
        existingWelds.length > 0
      ) {
        return;
      }

      displayedWeldSignaturesRef.current.set(normalizedPage, signature);
      multiPageBatchService.setPageWelds(normalizedPage, normalizedWelds);
      pendingWeldRefreshPagesRef.current.add(normalizedPage);
      setPageWeldsVersion(version => version + 1);
      if (normalizedPage === Number(currentPageRef.current)) {
        setDisplayedWelds(normalizedWelds);
      }
    }, 300);
    displayedWeldPendingRef.current.set(normalizedPage, {
      token: updateToken,
      timer,
      signature
    });
  }, [isPageInsideMultiPagePreview]);

  useEffect(() => {
    if (!showWeldDebug) return;
    setDisplayedWelds([...multiPageBatchService.getPageWelds(currentPage)]);
  }, [currentPage, pageWeldsVersion, showWeldDebug]);

  useEffect(() => {
    if (showWeldDebug) return;
    displayedWeldPendingRef.current.forEach(pending => clearTimeout(pending?.timer));
    displayedWeldPendingRef.current.clear();
    displayedWeldSignaturesRef.current.clear();
    pendingWeldRefreshPagesRef.current.clear();
    setDisplayedWelds([]);
    setShowWeldNumbers(false);
  }, [showWeldDebug]);

  useEffect(() => () => {
    displayedWeldPendingRef.current.forEach(pending => clearTimeout(pending?.timer));
    displayedWeldPendingRef.current.clear();
  }, []);

  const normalizeWeldPathId = useCallback((value) => {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : null;
  }, []);

  const clearSinglePageNumberingSelection = useCallback(() => {
    setSelectedStartWeldId(null);
    setSelectedStartWeld(null);
    setNumberingSegments([]);
    setNumberlessNumberingSegmentKeys([]);
    setOrderedNumberingWelds([]);
  }, []);

  const exitSinglePageNumberingMode = useCallback(() => {
    setShowWeldNumbers(false);
    setIsWeldStartPickMode(false);
    clearSinglePageNumberingSelection();
  }, [clearSinglePageNumberingSelection]);

  const handleToggleSinglePageWeldNumbering = useCallback(() => {
    if (showWeldNumbers) {
      exitSinglePageNumberingMode();
      return;
    }

    setShowWeldNumbers(true);
    setIsWeldStartPickMode(true);
    clearSinglePageNumberingSelection();
  }, [showWeldNumbers, exitSinglePageNumberingMode, clearSinglePageNumberingSelection]);

  const buildPathIdRangeSequence = useCallback((welds, startPathId, endPathId) => {
    const normalizedStart = normalizeWeldPathId(startPathId);
    const normalizedEnd = normalizeWeldPathId(endPathId);
    if (normalizedStart === null || normalizedEnd === null) {
      return [];
    }

    const sorted = [...(welds || [])]
      .map((weld, index) => ({
        weld,
        index,
        pathId: normalizeWeldPathId(weld?.pathId)
      }))
      .filter(item => item.pathId !== null)
      .sort((a, b) => (a.pathId === b.pathId ? a.index - b.index : a.pathId - b.pathId));

    const startIndex = sorted.findIndex(item => item.pathId === normalizedStart);
    const endIndex = sorted.findIndex(item => item.pathId === normalizedEnd);
    if (startIndex === -1 || endIndex === -1) {
      return [];
    }

    if (startIndex === endIndex) {
      return [sorted[startIndex].weld];
    }

    const rangeItems = startIndex <= endIndex
      ? sorted.slice(startIndex, endIndex + 1)
      : sorted.slice(endIndex, startIndex + 1).reverse();

    return rangeItems.map(item => item.weld);
  }, [normalizeWeldPathId]);

  const getNumberingOrderedItems = useCallback((welds) => (
    [...(welds || [])]
      .map((weld, index) => ({
        weld,
        index,
        pathId: normalizeWeldPathId(weld?.pathId)
      }))
      .filter(item => item.pathId !== null)
      .sort((a, b) => (a.pathId === b.pathId ? a.index - b.index : a.pathId - b.pathId))
  ), [normalizeWeldPathId]);

  const getPageAwareWeldSelectionKey = useCallback((weld, pageNum) => {
    const baseKey = getWeldSelectionKey(weld);
    if (!baseKey) return '';
    const resolvedPage = pageNum ?? weld?.page ?? currentPage;
    return `${resolvedPage || ''}__${baseKey}`;
  }, [currentPage]);

  const getWeldNumberingOrderIndex = useCallback((welds, targetWeld) => {
    const targetKey = getWeldSelectionKey(targetWeld);
    if (!targetKey) return -1;
    return getNumberingOrderedItems(welds).findIndex(item => getWeldSelectionKey(item.weld) === targetKey);
  }, [getNumberingOrderedItems]);

  const buildNumberingSegmentRangeSequence = useCallback((welds, segment, options = {}) => {
    const orderedItems = getNumberingOrderedItems(welds);
    const startOrderIndex = Number(segment?.startOrderIndex);
    const endOrderIndex = Number(segment?.endOrderIndex);

    if (
      Number.isInteger(startOrderIndex) &&
      Number.isInteger(endOrderIndex) &&
      startOrderIndex >= 0 &&
      endOrderIndex >= 0 &&
      startOrderIndex < orderedItems.length &&
      endOrderIndex < orderedItems.length
    ) {
      if (startOrderIndex === endOrderIndex) {
        return [orderedItems[startOrderIndex].weld];
      }
      const rangeItems = startOrderIndex <= endOrderIndex
        ? orderedItems.slice(startOrderIndex, endOrderIndex + 1)
        : orderedItems.slice(endOrderIndex, startOrderIndex + 1).reverse();
      return rangeItems.map(item => item.weld);
    }

    if (options.requireOrderRange) {
      return [];
    }

    return buildPathIdRangeSequence(welds, segment?.startPathId, segment?.endPathId);
  }, [buildPathIdRangeSequence, getNumberingOrderedItems]);

  const rebuildNumberingWeldsFromSegments = useCallback((segments, welds) => {
    const seen = new Set();
    const ordered = [];

    (segments || []).forEach(segment => {
      const range = buildNumberingSegmentRangeSequence(welds, segment);
      range.forEach(weld => {
        const key = getWeldSelectionKey(weld);
        if (!key || seen.has(key)) return;
        seen.add(key);
        ordered.push(weld);
      });
    });

    return ordered;
  }, [buildNumberingSegmentRangeSequence]);

  const getNumberingSegmentKey = useCallback((segment) => (
    `${segment?.page || ''}__${segment?.pipelineNumber || ''}__${segment?.startOrderIndex ?? ''}__${segment?.endOrderIndex ?? ''}__${segment?.startKey || ''}__${segment?.endKey || ''}`
  ), []);

  const getNumberingSegmentPatternKey = useCallback(
    getPageScopedNumberingSegmentPatternKey,
    []
  );

  const isNumberingSegmentHidden = useCallback((segment) => {
    const hiddenKeys = new Set(numberlessNumberingSegmentKeys);
    if (hiddenKeys.has(getNumberingSegmentKey(segment))) return true;
    const patternKey = getNumberingSegmentPatternKey(segment);
    return (numberingSegments || []).some(sourceSegment => (
      hiddenKeys.has(getNumberingSegmentKey(sourceSegment)) &&
      getNumberingSegmentPatternKey(sourceSegment) === patternKey
    ));
  }, [
    getNumberingSegmentKey,
    getNumberingSegmentPatternKey,
    numberingSegments,
    numberlessNumberingSegmentKeys
  ]);

  const getNumberlessWeldKeys = useCallback((segments, welds) => {
    const hiddenWeldKeys = new Set();

    (segments || []).forEach(segment => {
      if (!isNumberingSegmentHidden(segment)) return;
      const range = buildNumberingSegmentRangeSequence(welds, segment);
      range.forEach(weld => {
        const key = getWeldSelectionKey(weld);
        if (key) hiddenWeldKeys.add(key);
      });
    });

    return hiddenWeldKeys;
  }, [
    buildNumberingSegmentRangeSequence,
    isNumberingSegmentHidden
  ]);

  const getNumberlessWeldKeysForPage = useCallback((segments, pageWelds) => {
    const hiddenWeldKeys = new Set();

    (segments || []).forEach(segment => {
      if (!isNumberingSegmentHidden(segment)) return;
      const range = buildNumberingSegmentRangeSequence(pageWelds, segment);
      range.forEach(weld => {
        const key = getWeldSelectionKey(weld);
        if (key) hiddenWeldKeys.add(key);
      });
    });

    return hiddenWeldKeys;
  }, [
    buildNumberingSegmentRangeSequence,
    isNumberingSegmentHidden
  ]);

  const normalizeNumberingPipeline = useCallback((value) => (
    String(value || '').trim().replace(/\s+/g, '').toUpperCase()
  ), []);

  const getResolvedPagePipelineNumber = useCallback((pageNum) => {
    const normalizeSource = (value) => normalizeNumberingPipeline(
      String(value || '')
        .replace(/LINE\s*NO\.?\s*[:：]?/ig, '')
        .replace(/管线号\s*[:：]?/g, '')
    );

    const textPageData = textDetections?.[pageNum];
    const recognizedPageData = getPageRecognitionData(pageNum);
    const statePageData = pageRecognitionData?.[pageNum]?.data || pageRecognitionData?.[pageNum];
    const materialRowsForPage = (materialRows || []).filter(row => (
      Number(row?.sourcePage || row?.page || pageNum) === Number(pageNum)
    ));

    const sanitizePipelineSource = (value) => normalizeNumberingPipeline(
      String(value || '')
        .replace(/LINE\s*NO\.?\s*[:：]?\s*/ig, '')
        .replace(/管线号\s*[:：]?\s*/g, '')
    );

    return sanitizePipelineSource(
      textPageData?.pipelineNumber ||
      textPageData?.pipeline?.text ||
      textPageData?.pipeline ||
      recognizedPageData?.pipelineNumber ||
      recognizedPageData?.pipeline?.text ||
      recognizedPageData?.pipeline ||
      recognizedPageData?.materials?.find(item => item?.pipelineNumber)?.pipelineNumber ||
      statePageData?.pipelineNumber ||
      statePageData?.pipeline?.text ||
      statePageData?.pipeline ||
      statePageData?.materials?.find(item => item?.pipelineNumber)?.pipelineNumber ||
      materialRowsForPage.find(row => row?.pipelineNumber)?.pipelineNumber ||
      ''
    );
  }, [
    getPageRecognitionData,
    materialRows,
    normalizeNumberingPipeline,
    pageRecognitionData,
    textDetections
  ]);

  const getNumberingPagePipelineNumber = useCallback((pageNum, fallbackWelds = []) => {
    const serviceTextData = multiPageBatchService.pageTextDetections?.[pageNum] || {};
    const serviceWelds = fallbackWelds.length > 0 ? fallbackWelds : multiPageBatchService.getPageWelds(pageNum);
    return normalizeNumberingPipeline(
      getResolvedPagePipelineNumber(pageNum) ||
      serviceTextData.pipelineNumber ||
      serviceTextData.pipeline?.text ||
      serviceTextData.pipeline ||
      serviceWelds.find(weld => weld?.pipelineNumber)?.pipelineNumber ||
      ''
    );
  }, [getResolvedPagePipelineNumber, normalizeNumberingPipeline]);

  const syncPipelineNumberToAnnotations = useCallback((context) => {
    if (context?.status !== 'resolved' || !context?.pipelineNumber || !onBatchAnnotationUpdates) return;
    const pages = Array.from(new Set([
      Number(context.page),
      ...(Array.isArray(context.matchedPages) ? context.matchedPages.map(Number) : [])
    ].filter(Number.isFinite)));
    const updatesById = buildAnnotationPipelineUpdates({
      annotations,
      pages,
      pipelineNumber: context.pipelineNumber,
      pipelineNumberSource: context.source === 'manual-confirmation'
        ? 'user_confirmed'
        : /pipeline-area|page-number-area/.test(String(context.source || ''))
          ? 'inferred'
          : 'business_data'
    });
    const updateCount = Object.keys(updatesById).length;
    if (updateCount > 0) {
      onBatchAnnotationUpdates(
        updatesById,
        `写入管线号 ${context.pipelineNumber} (${updateCount}个标注)`
      );
    }
  }, [annotations, onBatchAnnotationUpdates]);

  const commitManualInsertPipelineContext = useCallback((context) => {
    setManualInsertPipelineContext(context);
    syncPipelineNumberToAnnotations(context);
    return context;
  }, [syncPipelineNumberToAnnotations]);

  const resolveManualInsertPipelineContext = useCallback(async (pageNum, sourceWelds = multiPageNumberWelds, isCurrent = () => true) => {
    const publishContext = context => isCurrent() ? commitManualInsertPipelineContext(context) : context;
    const resolvedPage = Number(pageNum || currentPage || 1);
    const pageWelds = (sourceWelds || []).filter(
      weld => Number(weld?.page || weld?.pageNum) === resolvedPage
    );
    const weldPipeline = normalizeNumberingPipeline(
      pageWelds.find(weld => weld?.pipelineNumber)?.pipelineNumber || ''
    );
    const adjacentPages = [resolvedPage - 1, resolvedPage + 1]
      .filter(candidate => candidate >= 1 && candidate <= Number(numPages || candidate));

    const buildContext = (recognizedByPage = {}) => {
      const readPipeline = candidatePage => normalizeNumberingPipeline(
        recognizedByPage?.[candidatePage]?.pipelineNumber ||
        getNumberingPagePipelineNumber(candidatePage) ||
        ''
      );
      const currentPipeline = weldPipeline || readPipeline(resolvedPage);
      const annotationContext = resolvePipelineFromWeldAnnotations({
        welds: sourceWelds,
        currentPage: resolvedPage,
        currentPipelineNumber: currentPipeline
      });
      if (annotationContext.status === 'resolved') {
        return {
          ...annotationContext,
          matchedPages: Array.from(new Set([
            ...(annotationContext.matchedPages || []),
            ...adjacentPages.filter(candidatePage => readPipeline(candidatePage) === annotationContext.pipelineNumber)
          ])),
          page: resolvedPage,
          currentPipelineNumber: currentPipeline
        };
      }
      const adjacent = adjacentPages.map(candidatePage => ({
        page: candidatePage,
        pipelineNumber: readPipeline(candidatePage)
      })).filter(item => item.pipelineNumber);
      const candidates = Array.from(new Set([
        ...(annotationContext.candidates || []),
        currentPipeline,
        ...adjacent.map(item => item.pipelineNumber)
      ].filter(Boolean)));

      const matchedAdjacent = currentPipeline
        ? adjacent.find(item => item.pipelineNumber === currentPipeline)
        : null;
      const sharedAdjacentPipeline = !currentPipeline && adjacent.length === 2 &&
        adjacent[0].pipelineNumber === adjacent[1].pipelineNumber
        ? adjacent[0].pipelineNumber
        : '';
      const resolvedPipeline = matchedAdjacent ? currentPipeline : sharedAdjacentPipeline;
      return {
        page: resolvedPage,
        status: resolvedPipeline ? 'resolved' : 'unresolved',
        pipelineNumber: resolvedPipeline,
        candidates,
        matchedPage: matchedAdjacent?.page || (sharedAdjacentPipeline ? `${adjacent[0].page}、${adjacent[1].page}` : null),
        matchedPages: matchedAdjacent
          ? [matchedAdjacent.page]
          : (sharedAdjacentPipeline ? adjacent.map(item => item.page) : []),
        currentPipelineNumber: currentPipeline,
        source: resolvedPipeline ? 'pipeline-area-adjacent-match' : 'needs-confirmation'
      };
    };

    const cachedContext = buildContext();
    const pipelineArea = latestAreasRef.current.pipeline || globalPipelineArea;
    const pageNumberArea = latestAreasRef.current.pageNumber || globalPageNumberArea;

    const resolveFromSheetPageGroup = async pipelineNumber => {
      const normalizedPipeline = normalizeNumberingPipeline(pipelineNumber);
      if (!normalizedPipeline || !pageNumberArea || !pdfDocumentRef?.getPage) return null;
      const currentResult = await multiPageBatchService.extractPdfTextFromAreaPages(
        pdfDocumentRef,
        resolvedPage,
        resolvedPage,
        pageNumberArea
      );
      const currentReference = parseSheetPageReference(
        currentResult?.[resolvedPage]?.detections || []
      );
      const range = inferSheetPdfPageRange({
        pdfPage: resolvedPage,
        reference: currentReference,
        pdfPageCount: Number(numPages || pdfDocumentRef.numPages || 0)
      });
      if (!range) return null;

      const [firstPageResult, lastPageResult] = await Promise.all([
        range.startPage === resolvedPage
          ? Promise.resolve(currentResult)
          : multiPageBatchService.extractPdfTextFromAreaPages(
            pdfDocumentRef,
            range.startPage,
            range.startPage,
            pageNumberArea
          ),
        range.endPage === resolvedPage
          ? Promise.resolve(currentResult)
          : multiPageBatchService.extractPdfTextFromAreaPages(
            pdfDocumentRef,
            range.endPage,
            range.endPage,
            pageNumberArea
          )
      ]);
      const firstReference = parseSheetPageReference(
        firstPageResult?.[range.startPage]?.detections || []
      );
      const lastReference = parseSheetPageReference(
        lastPageResult?.[range.endPage]?.detections || []
      );
      if (!validateSheetPdfPageRange({ range, firstReference, lastReference })) return null;

      return {
        page: resolvedPage,
        status: 'resolved',
        pipelineNumber: normalizedPipeline,
        candidates: [normalizedPipeline],
        matchedPage: `${range.startPage}-${range.endPage}`,
        matchedPages: range.pages,
        currentPipelineNumber: normalizedPipeline,
        sheetPageReference: currentReference,
        sheetPageRange: range,
        source: 'page-number-area-group'
      };
    };

    try {
      const cachedSheetContext = await resolveFromSheetPageGroup(
        cachedContext.currentPipelineNumber || cachedContext.pipelineNumber
      );
      if (cachedSheetContext) {
        return publishContext(cachedSheetContext);
      }
    } catch (error) {
      console.warn('焊点调整页码区域快速归组失败，回退到管线号识别:', error);
    }

    // A known pipeline is not enough to return yet: its trailing pages may
    // have no recognized pipeline metadata. Give the validated "1 OF N" sheet
    // range a chance to bind those pages before falling back to the partial
    // annotation result.
    if (cachedContext.status === 'resolved') {
      return publishContext(cachedContext);
    }
    if (!pipelineArea) {
      if (isCurrent()) setManualInsertPipelineContext(cachedContext);
      return cachedContext;
    }

    let pdfSource = file;
    if (
      (typeof File !== 'undefined' && window.__lastOpenedPdfFile__ instanceof File) ||
      (typeof Blob !== 'undefined' && window.__lastOpenedPdfFile__ instanceof Blob)
    ) {
      pdfSource = window.__lastOpenedPdfFile__;
    }
    const validFilePath = typeof file === 'string' && file.length > 0 && !file.startsWith('blob:');
    const isBlobSource = typeof Blob !== 'undefined' && pdfSource instanceof Blob;
    if (!validFilePath && !isBlobSource) {
      pdfSource = window.__lastOpenedPdfPath__ || window.__lastOpenedPdfFile__;
    }
    if (!pdfSource) {
      if (isCurrent()) setManualInsertPipelineContext(cachedContext);
      return cachedContext;
    }

    if (!isCurrent()) return cachedContext;
    setManualInsertPipelineContext({
      ...cachedContext,
      page: resolvedPage,
      status: 'resolving'
    });
    try {
      const currentRecognized = await multiPageBatchService.detectTextFromPages(
        pdfSource,
        resolvedPage,
        resolvedPage,
        { pipelineArea, ...(pageNumberArea ? { pageNumberArea } : {}) }
      );
      const currentPipeline = normalizeNumberingPipeline(
        currentRecognized?.[resolvedPage]?.pipelineNumber || ''
      );
      if (!isCurrent()) return cachedContext;
      try {
        const recognizedSheetContext = await resolveFromSheetPageGroup(currentPipeline);
        if (!isCurrent()) return cachedContext;
        if (recognizedSheetContext) {
          setTextDetections(prev => ({
            ...prev,
            [resolvedPage]: currentRecognized?.[resolvedPage]
          }));
          onPageTextDetectionsChange?.({
            [resolvedPage]: currentRecognized?.[resolvedPage]
          });
          return publishContext(recognizedSheetContext);
        }
      } catch (error) {
        console.warn('焊点调整识别管线号后的页码快速归组失败，回退到相邻页识别:', error);
      }

      // The current page has already been sent to the remote recognizer above.
      // Recognize only its neighbours here; the previous range call included
      // the current page again and nearly doubled the slow fallback path.
      const neighbourResults = await Promise.all(adjacentPages.map(candidatePage => (
        multiPageBatchService.detectTextFromPages(
          pdfSource,
          candidatePage,
          candidatePage,
          { pipelineArea }
        )
      )));
      const recognized = neighbourResults.reduce(
        (merged, result) => ({ ...merged, ...(result || {}) }),
        { ...currentRecognized }
      );
      const relevantResults = {};
      if (!isCurrent()) return cachedContext;
      for (const candidatePage of [resolvedPage, ...adjacentPages]) {
        if (recognized?.[candidatePage]) relevantResults[candidatePage] = recognized[candidatePage];
      }
      setTextDetections(prev => ({ ...prev, ...relevantResults }));
      onPageTextDetectionsChange?.(relevantResults);
      const nextContext = buildContext(relevantResults);
      return publishContext(nextContext);
    } catch (error) {
      console.error('补点前后页管线号区域识别失败:', error);
      const failedContext = { ...cachedContext, status: 'unresolved', error: error.message };
      if (isCurrent()) setManualInsertPipelineContext(failedContext);
      return failedContext;
    }
  }, [
    currentPage,
    commitManualInsertPipelineContext,
    file,
    getNumberingPagePipelineNumber,
    multiPageNumberWelds,
    normalizeNumberingPipeline,
    numPages,
    onPageTextDetectionsChange,
    pdfDocumentRef
  ]);

  const getNumberingWeldsForPage = useCallback((pageNum) => {
    if (multiPageNumberPreview) {
      if (!isPageInsideMultiPagePreview(pageNum)) return [];
      const previewWelds = (multiPageNumberWelds || []).filter(
        weld => Number(weld.page || weld.pageNum) === Number(pageNum)
      );
      // 预览序列是删除/补点后的唯一数据源。即使当前页已删至零个，
      // 也不能退回识别缓存，否则刚删除的焊点会再次显示并可被重复操作。
      return previewWelds;
    }
    if (Number(pageNum) === Number(currentPage)) {
      return displayedWelds || [];
    }
    const serviceWelds = multiPageBatchService.getPageWelds(pageNum);
    if (serviceWelds && serviceWelds.length > 0) {
      return serviceWelds;
    }
    return (multiPageNumberWelds || []).filter(weld => Number(weld.page || weld.pageNum) === Number(pageNum));
  }, [currentPage, displayedWelds, isPageInsideMultiPagePreview, multiPageNumberPreview, multiPageNumberWelds]);

  const getNumberingSegmentRangeForPage = useCallback((segment, pageNum, pageWelds) => {
    const isSourcePage = Number(pageNum) === Number(segment?.page || currentPage);
    if (isSourcePage && Array.isArray(segment?.sourceRangeWelds) && segment.sourceRangeWelds.length > 0) {
      return segment.sourceRangeWelds.map(weld => ({
        ...weld,
        page: pageNum,
        pipelineNumber: normalizeNumberingPipeline(segment.pipelineNumber) || weld?.pipelineNumber
      }));
    }
    if (!isSourcePage) {
      return [];
    }
    return buildNumberingSegmentRangeSequence(pageWelds, segment, {
      requireOrderRange: true
    }).map(weld => ({
      ...weld,
      page: pageNum,
      pipelineNumber: normalizeNumberingPipeline(segment.pipelineNumber) || weld?.pipelineNumber
    }));
  }, [
    buildNumberingSegmentRangeSequence,
    currentPage,
    normalizeNumberingPipeline
  ]);

  const applyNumberingSegmentsToPageOrder = useCallback((automaticPageOrder, pageSegments, pageNum) => {
    let correctedPageOrder = [...(automaticPageOrder || [])];
    (pageSegments || []).forEach(segment => {
      const segmentRange = getNumberingSegmentRangeForPage(
        segment,
        pageNum,
        automaticPageOrder
      );
      correctedPageOrder = moveWeldRangeInSequence({
        welds: correctedPageOrder,
        rangeWelds: segmentRange,
        getKey: weld => getPageAwareWeldSelectionKey(weld, pageNum)
      });
    });
    return correctedPageOrder;
  }, [getNumberingSegmentRangeForPage, getPageAwareWeldSelectionKey]);

  const getSegmentTargetStartNumber = useCallback((segment) => {
    const value = Number(segment?.targetStartNumber ?? segment?.moveTargetNumber);
    return Number.isFinite(value) && value >= 1 ? value : null;
  }, []);

  const buildCorrectedMultiPageNumbering = useCallback((
    sourceWelds,
    segments,
    fallbackStartNumber = 1,
    increment = 1,
    options = {}
  ) => {
    const retainNumberless = !!options.retainNumberless;
    const source = Array.isArray(sourceWelds) ? sourceWelds : [];
    const pages = Array.from(new Set(
      source.map(weld => Number(weld?.page || weld?.pageNum)).filter(Boolean)
    )).sort((a, b) => a - b);
    const flattened = [];
    const hiddenPageAwareKeys = new Set();
    const forcedStarts = [];
    const forcedStartByBaseKey = new Map();
    const editedNumberingBaseKeys = new Set();
    const numberingKeyOccurrences = new Map();
    const startByScope = new Map();
    const explicitPipelineByPage = new Map(
      pages.map(pageNum => {
        const pageWelds = source.filter(
          weld => Number(weld?.page || weld?.pageNum) === Number(pageNum)
        );
        const pageSegments = (segments || []).filter(
          segment => Number(segment?.page || pageNum) === Number(pageNum)
        );
        return [
          pageNum,
          normalizeNumberingPipeline(
            pageSegments.find(segment => segment?.pipelineNumber)?.pipelineNumber ||
            getNumberingPagePipelineNumber(pageNum, pageWelds)
          )
        ];
      })
    );
    const crossPageScopes = buildCrossPageNumberingScopes({
      welds: source,
      explicitPipelineByPage,
      increment
    });

    pages.forEach((pageNum) => {
      const automaticPageOrder = source.filter(
        weld => Number(weld?.page || weld?.pageNum) === Number(pageNum)
      );
      const pageSegments = (segments || []).filter(
        segment => Number(segment?.page || pageNum) === Number(pageNum)
      );
      const correctedPageOrder = applyNumberingSegmentsToPageOrder(
        automaticPageOrder,
        pageSegments,
        pageNum
      );
      const hiddenKeys = getNumberlessWeldKeysForPage(pageSegments, automaticPageOrder);
      const pageScope = crossPageScopes.get(pageNum) || {};
      const pagePipelineNumber = pageScope.pipelineNumber || '';
      const scopeKey = pageScope.scopeKey || pagePipelineNumber || `__PAGE_${pageNum}`;
      const originalNumbers = automaticPageOrder
        .map(weld => Number(weld?.weldNumber ?? weld?.number))
        .filter(Number.isFinite);
      const pageStart = originalNumbers.length > 0
        ? Math.min(...originalNumbers)
        : Number(fallbackStartNumber);
      if (!startByScope.has(scopeKey)) {
        startByScope.set(
          scopeKey,
          pageScope.resetToStartNumber
            ? (Number.isFinite(Number(fallbackStartNumber)) ? Number(fallbackStartNumber) : 1)
            : (Number.isFinite(pageStart) ? pageStart : 1)
        );
      }

      pageSegments.forEach((segment) => {
        if (isNumberingSegmentHidden(segment)) return;
        const targetStartNumber = getSegmentTargetStartNumber(segment);
        if (targetStartNumber === null) return;
        const numberedSegmentWelds = getNumberingSegmentRangeForPage(
          segment,
          pageNum,
          automaticPageOrder
        ).filter(weld => !hiddenKeys.has(getWeldSelectionKey(weld)));
        const firstNumberedWeld = numberedSegmentWelds[0];
        const firstKey = getPageAwareWeldSelectionKey(firstNumberedWeld, pageNum);
        if (firstKey) {
          forcedStartByBaseKey.set(firstKey, targetStartNumber);
        }
        numberedSegmentWelds.forEach(weld => {
          const editedKey = getPageAwareWeldSelectionKey(weld, pageNum);
          if (editedKey) editedNumberingBaseKeys.add(editedKey);
        });
      });

      correctedPageOrder.forEach((weld) => {
        const pageAwareKey = getPageAwareWeldSelectionKey(weld, pageNum);
        if (!pageAwareKey) return;
        const occurrence = numberingKeyOccurrences.get(pageAwareKey) || 0;
        numberingKeyOccurrences.set(pageAwareKey, occurrence + 1);
        const uniqueNumberingKey = `${pageAwareKey}__OCCURRENCE_${occurrence}`;
        if (hiddenKeys.has(getWeldSelectionKey(weld))) {
          hiddenPageAwareKeys.add(uniqueNumberingKey);
        }
        if (occurrence === 0 && forcedStartByBaseKey.has(pageAwareKey)) {
          forcedStarts.push({
            key: uniqueNumberingKey,
            startNumber: forcedStartByBaseKey.get(pageAwareKey)
          });
        }
        flattened.push({
          ...weld,
          page: pageNum,
          pageNum,
          pipelineNumber: pagePipelineNumber || weld?.pipelineNumber || '',
          numberingScopeKey: scopeKey,
          __numberingKey: uniqueNumberingKey,
          __numberingBaseKey: pageAwareKey,
          __numberingScope: scopeKey,
          __numberingEdited: editedNumberingBaseKeys.has(pageAwareKey)
        });
      });
    });

    const assigned = assignCompactWeldNumbers({
      welds: flattened,
      hiddenKeys: hiddenPageAwareKeys,
      forcedStarts,
      startNumber: fallbackStartNumber,
      increment,
      getKey: weld => weld.__numberingKey,
      getScopeKey: weld => weld.__numberingScope,
      getScopeStartNumber: scopeKey => startByScope.get(scopeKey)
    }).welds;

    const conflictResolved = resolvePipelineNumberConflicts({
      welds: assigned,
      increment,
      getKey: weld => weld.__numberingKey,
      getScopeKey: weld => weld.__numberingScope,
      isEdited: weld => weld.__numberingEdited === true
    });

    const assignedByKey = new Map(
      conflictResolved.map(weld => [weld.__numberingKey, weld])
    );
    const result = retainNumberless
      ? flattened.map((sourceWeld) => {
          const assignedWeld = assignedByKey.get(sourceWeld.__numberingKey);
          if (assignedWeld) return assignedWeld;
          return {
            ...sourceWeld,
            weldNumber: null,
            number: '',
            displayNumber: '',
            isNumberless: true
          };
        })
      // Both the blue numbering preview and the final annotation snapshot must
      // consume the conflict-resolved sequence. Returning `assigned` here made
      // final generation silently fall back to pre-resolution/duplicate values.
      : conflictResolved;

    return result.map(({
      __numberingKey,
      __numberingBaseKey,
      __numberingScope,
      __numberingEdited,
      ...weld
    }) => weld);
  }, [
    applyNumberingSegmentsToPageOrder,
    getNumberingPagePipelineNumber,
    getNumberingSegmentRangeForPage,
    getPageAwareWeldSelectionKey,
    getSegmentTargetStartNumber,
    getNumberlessWeldKeysForPage,
    isNumberingSegmentHidden,
    normalizeNumberingPipeline
  ]);

  const rebuildStableMultiPageSequence = useCallback((retainNumberless = true, originalSourceOverride = null) => {
    // A reopened editable PDF already contains the user's final numbering,
    // including intentional gaps such as 1-30 and 52-58. Do not compact that
    // sequence again; manual insertion has already shifted the affected scope.
    if (reopenedPdfSupplementMode && numberingSegments.length === 0 && !originalSourceOverride) {
      return (multiPageNumberWelds || []).filter(weld => retainNumberless || !weld?.isNumberless);
    }
    const originalSource = Array.isArray(originalSourceOverride)
      ? originalSourceOverride
      : multiPageOriginalNumberWelds.length > 0
      ? multiPageOriginalNumberWelds
      : multiPageNumberWelds.filter(weld => !weld?.isManualInserted && !weld?.isNumberless);
    const manualOperations = multiPageNumberWelds
      .filter(weld => weld?.isManualInserted)
      .sort((a, b) => Number(a?.manualInsertedAt || 0) - Number(b?.manualInsertedAt || 0));
    const pendingRule = multiPageBatchService.getPendingBatchAnnotationRule() || activeAnnotationRule;
    const fallbackStartNumber = Number(pendingRule?.startNumber ?? pendingRule?.currentNumber ?? 1);
    const numberingIncrement = Number(pendingRule?.increment ?? 1);
    let effectiveWelds = buildCorrectedMultiPageNumbering(
      originalSource,
      numberingSegments,
      Number.isFinite(fallbackStartNumber) ? fallbackStartNumber : 1,
      Number.isFinite(numberingIncrement) ? numberingIncrement : 1,
      { retainNumberless }
    );

    manualOperations.forEach((manualWeld) => {
      const requestedNumber = Number(
        manualWeld?.manualRequestedNumber ??
        manualWeld?.weldNumber ??
        manualWeld?.number
      );
      if (!Number.isFinite(requestedNumber)) return;
      const manualPage = Number(manualWeld?.page || manualWeld?.pageNum);
      const pageScopeWeld = effectiveWelds.find(
        weld => Number(weld?.page || weld?.pageNum) === manualPage
      );
      effectiveWelds = insertManualWeldIntoSequence({
        welds: effectiveWelds,
        pageNum: manualPage,
        pipelineNumber: manualWeld?.pipelineNumber || pageScopeWeld?.pipelineNumber || '',
        numberingScopeKey: manualWeld?.numberingScopeKey || pageScopeWeld?.numberingScopeKey || '',
        insertNumber: requestedNumber,
        manualWeld
      }).welds;
    });

    return effectiveWelds;
  }, [
    activeAnnotationRule,
    buildCorrectedMultiPageNumbering,
    multiPageNumberWelds,
    multiPageOriginalNumberWelds,
    numberingSegments,
    reopenedPdfSupplementMode
  ]);

  // Refresh pages already participating in the multi-page sequence without
  // discarding manual inserts, numberless segments, or target-number rules.
  useEffect(() => {
    if (!pageWeldsVersion || !multiPageNumberPreview || reopenedPdfSupplementMode) return;
    const refreshedPages = new Set(pendingWeldRefreshPagesRef.current);
    pendingWeldRefreshPagesRef.current.clear();
    if (refreshedPages.size === 0 || multiPageOriginalNumberWelds.length === 0) return;

    const participatingPages = new Set(
      multiPageOriginalNumberWelds.map(weld => Number(weld?.page || weld?.pageNum))
    );
    const pagesToReplace = [...refreshedPages].filter(page => participatingPages.has(page));
    if (pagesToReplace.length === 0) return;

    let nextOriginals = multiPageOriginalNumberWelds.filter(
      weld => !pagesToReplace.includes(Number(weld?.page || weld?.pageNum))
    );
    pagesToReplace.forEach(page => {
      nextOriginals.push(...multiPageBatchService.getPageWelds(page));
    });
    nextOriginals.sort((a, b) =>
      Number(a?.page || a?.pageNum) - Number(b?.page || b?.pageNum)
    );

    setMultiPageOriginalNumberWelds(nextOriginals);
    setMultiPageNumberWelds(rebuildStableMultiPageSequence(true, nextOriginals));
  }, [
    multiPageNumberPreview,
    multiPageOriginalNumberWelds,
    pageWeldsVersion,
    reopenedPdfSupplementMode,
    rebuildStableMultiPageSequence
  ]);

  const extractAnnotationNumber = useCallback((annotation) => {
    const match = String(annotation?.text || '').match(/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }, []);

  const resolvePipelineScopedStartNumber = useCallback((rule, pipelineNumber) => {
    if (!rule) {
      return 1;
    }

    const fallbackStart = rule.currentNumber !== undefined && rule.currentNumber !== null
      ? rule.currentNumber
      : (rule.startNumber || 1);
    const pipelineKey = normalizeNumberingPipeline(pipelineNumber);
    if (!pipelineKey) {
      return fallbackStart;
    }

    const increment = rule.increment !== undefined ? rule.increment : 1;
    const samePipelineNumbers = (annotations || [])
      .filter(annotation => {
        if (annotation?.ruleId !== rule.id) return false;
        const annotationPipeline = normalizeNumberingPipeline(annotation?.pipelineNumber) ||
          getResolvedPagePipelineNumber(annotation?.page);
        return annotationPipeline === pipelineKey;
      })
      .map(extractAnnotationNumber)
      .filter(number => Number.isFinite(number));

    if (samePipelineNumbers.length === 0) {
      return rule.startNumber || 1;
    }

    return Math.max(...samePipelineNumbers) + increment;
  }, [
    annotations,
    extractAnnotationNumber,
    getResolvedPagePipelineNumber,
    normalizeNumberingPipeline
  ]);

  const handleSelectNumberingWeld = useCallback((weld) => {
    if (!isPageInsideMultiPagePreview(currentPage)) {
      message.warning('当前页不在本次多页处理范围内，不会加入调整结果');
      return;
    }
    const selectionWelds = getNumberingWeldsForPage(currentPage);
    const pathId = normalizeWeldPathId(weld?.pathId);
    if (pathId === null) {
      message.warning('该焊点没有可用的 Path ID，无法用于起止编号');
      return;
    }

    if (!selectedStartWeld) {
      setSelectedStartWeldId(pathId);
      setSelectedStartWeld(weld);
      message.info(`已选择起点 Path ID: ${pathId}，请继续选择终点`);
      return;
    }

    const startPathId = normalizeWeldPathId(selectedStartWeld.pathId);
    if (startPathId === null) {
      setSelectedStartWeldId(pathId);
      setSelectedStartWeld(weld);
      message.info(`已重新选择起点 Path ID: ${pathId}，请继续选择终点`);
      return;
    }

    const segmentPipelineNumber = getNumberingPagePipelineNumber(currentPage, selectionWelds);
    const sourceRangeWelds = buildNumberingSegmentRangeSequence(selectionWelds, {
      startOrderIndex: getWeldNumberingOrderIndex(selectionWelds, selectedStartWeld),
      endOrderIndex: getWeldNumberingOrderIndex(selectionWelds, weld),
      startPathId,
      endPathId: pathId
    }, {
      requireOrderRange: true
    }).map(rangeWeld => ({
      ...rangeWeld,
      page: currentPage,
      pipelineNumber: segmentPipelineNumber || rangeWeld?.pipelineNumber
    }));

    const nextSegment = {
      page: currentPage,
      pipelineNumber: segmentPipelineNumber,
      startPathId,
      endPathId: pathId,
      startOrderIndex: getWeldNumberingOrderIndex(selectionWelds, selectedStartWeld),
      endOrderIndex: getWeldNumberingOrderIndex(selectionWelds, weld),
      startKey: getWeldSelectionKey(selectedStartWeld),
      endKey: getWeldSelectionKey(weld),
      sourceRangeWelds
    };

    const appendSegment = (segments) => {
      const next = [...segments, nextSegment];
      setOrderedNumberingWelds(rebuildNumberingWeldsFromSegments(next, selectionWelds));
      message.success(`已添加编号段: ${startPathId} → ${pathId}`);
      return next;
    };
    const alreadyExists = numberingSegments.some(segment =>
        Number(segment.page || currentPage) === Number(nextSegment.page) &&
        normalizeNumberingPipeline(segment.pipelineNumber) === normalizeNumberingPipeline(nextSegment.pipelineNumber) &&
        Number(segment.startOrderIndex) === Number(nextSegment.startOrderIndex) &&
        Number(segment.endOrderIndex) === Number(nextSegment.endOrderIndex)
    );
    if (alreadyExists) {
      message.info(`该起点和终点已经添加过: ${startPathId} → ${pathId}`);
    } else {
      const overlappingIndexes = getOverlappingSegmentIndexes({
        segments: numberingSegments,
        rangeWelds: sourceRangeWelds,
        pageNum: currentPage,
        getKey: getWeldSelectionKey
      });
      if (overlappingIndexes.length > 0) {
        Modal.confirm({
          title: '修正段存在重叠',
          content: `新范围与 ${overlappingIndexes.length} 个已有修正段共用焊点。为避免添加先后影响结果，是否用新范围替换这些旧段？`,
          okText: '替换旧段',
          cancelText: '取消添加',
          onOk: () => {
            setNumberingSegments(prev => {
              const currentOverlaps = new Set(getOverlappingSegmentIndexes({
                segments: prev,
                rangeWelds: sourceRangeWelds,
                pageNum: currentPage,
                getKey: getWeldSelectionKey
              }));
              return appendSegment(prev.filter((_, index) => !currentOverlaps.has(index)));
            });
          }
        });
      } else {
        setNumberingSegments(prev => appendSegment(prev));
      }
    }

    setSelectedStartWeldId(null);
    setSelectedStartWeld(null);
  }, [
    normalizeWeldPathId,
    isPageInsideMultiPagePreview,
    selectedStartWeld,
    currentPage,
    getNumberingWeldsForPage,
    getNumberingPagePipelineNumber,
    getWeldNumberingOrderIndex,
    normalizeNumberingPipeline,
    rebuildNumberingWeldsFromSegments,
    numberingSegments
  ]);

  const handleClearNumberingSegments = useCallback(() => {
    setSelectedStartWeldId(null);
    setSelectedStartWeld(null);
    setNumberingSegments([]);
    setNumberlessNumberingSegmentKeys([]);
    setOrderedNumberingWelds([]);
  }, []);

  const handleRemoveNumberingSegment = useCallback((segmentIndex) => {
    setNumberingSegments(prev => {
      const removedSegment = prev[segmentIndex];
      const next = prev.filter((_, index) => index !== segmentIndex);
      if (removedSegment) {
        const removedKey = getNumberingSegmentKey(removedSegment);
        setNumberlessNumberingSegmentKeys(keys => keys.filter(key => key !== removedKey));
      }
      setOrderedNumberingWelds(rebuildNumberingWeldsFromSegments(next, displayedWelds));
      return next;
    });
  }, [displayedWelds, getNumberingSegmentKey, rebuildNumberingWeldsFromSegments]);

  const handleReverseNumberingSegment = useCallback((segmentIndex) => {
    setNumberingSegments(prev => {
      const next = prev.map((segment, index) => {
        if (index !== segmentIndex) return segment;
        return {
          ...segment,
          startPathId: segment.endPathId,
          endPathId: segment.startPathId,
          startOrderIndex: segment.endOrderIndex,
          endOrderIndex: segment.startOrderIndex,
          startKey: segment.endKey,
          endKey: segment.startKey,
          sourceRangeWelds: [...(segment.sourceRangeWelds || [])].reverse()
        };
      });
      setOrderedNumberingWelds(
        rebuildNumberingWeldsFromSegments(next, getNumberingWeldsForPage(currentPage))
      );
      return next;
    });
  }, [currentPage, getNumberingWeldsForPage, rebuildNumberingWeldsFromSegments]);

  const handleUpdateNumberingSegmentMove = useCallback((segmentIndex, updates) => {
    setNumberingSegments(prev => prev.map((segment, index) => (
      index === segmentIndex ? { ...segment, ...updates } : segment
    )));
  }, []);

  const handleToggleNumberlessSegment = useCallback((segment) => {
    const segmentKey = getNumberingSegmentKey(segment);
    setNumberlessNumberingSegmentKeys(prev => (
      prev.includes(segmentKey)
        ? prev.filter(key => key !== segmentKey)
        : [...prev, segmentKey]
    ));
  }, [getNumberingSegmentKey]);

  useEffect(() => {
    if (!showWeldNumbers) {
      setIsWeldStartPickMode(false);
      clearSinglePageNumberingSelection();
      return;
    }

    setIsWeldStartPickMode(true);

    const selectionWelds = getNumberingWeldsForPage(currentPage);
    if (!selectionWelds || selectionWelds.length === 0) {
      // 空白页仍属于当前多页批次时，不能把它误判为“退出编号”。
      // 只取消尚未完成的起点选择，已确定的编号段、补点和去编号状态必须保留。
      setSelectedStartWeldId(null);
      setSelectedStartWeld(null);
      return;
    }

    if (selectedStartWeldId !== null) {
      const matchedStartWeld = selectionWelds.find(weld =>
        normalizeWeldPathId(weld?.pathId) === normalizeWeldPathId(selectedStartWeldId)
      );

      if (!matchedStartWeld) {
        setSelectedStartWeldId(null);
        setSelectedStartWeld(null);
      } else {
        setSelectedStartWeld(matchedStartWeld);
      }
    }

    setOrderedNumberingWelds(rebuildNumberingWeldsFromSegments(numberingSegments, selectionWelds));
  }, [
    showWeldNumbers,
    displayedWelds,
    currentPage,
    getNumberingWeldsForPage,
    selectedStartWeldId,
    numberingSegments,
    normalizeWeldPathId,
    clearSinglePageNumberingSelection,
    rebuildNumberingWeldsFromSegments
  ]);

  // 使用材料输入功能Hook
  const {
    // 状态
    materialInputVisible,
    materialNumber1,
    materialNumber2,
    pendingAnnotation,
    materialInputTimer,
    isAutoFocusing,
    
    // 状态设置器
    setMaterialInputVisible,
    setMaterialNumber1,
    setMaterialNumber2,
    setPendingAnnotation,
    setMaterialInputTimer,
    setIsAutoFocusing,
    
    // 方法
    closeMaterialInput,
    savePendingAnnotation,
    showMaterialInput,
    
    // 事件处理器
    handleMaterialNumber1Change,
    handleMaterialNumber2Change,
    handleInputFocus,
    handleInput2Focus,
    handleInputBlur
  } = useMaterialInput({
    // 回调函数
    onAnnotationAdd,
    onAnnotationUpdate
  });

  // OCR状态现在由OCRContext管理
  const {
    globalOcrRegion,
    globalOcrResults,
    ocrAreaTarget,
    ocrState,
    setOcrAreaTarget,
    setOcrState,
    setGlobalOcrRegion,
    setGlobalOcrResults
  } = useOCRContext();

  // 保留一些PDFViewer专用状态
  const [globalSplitLines, setGlobalSplitLines] = useState([]);
  const [draggingSplitLine, setDraggingSplitLine] = useState(null); // { id, startClientX, startRelativeX }
  const [hoveredSplitLineId, setHoveredSplitLineId] = useState(null);
  const isDraggingSplitLineRef = useRef(false); // 用 ref 跨事件系统传递拖拽状态
  const [globalPipelineArea, setGlobalPipelineArea] = useState(null);
  const [globalPipeClassArea, setGlobalPipeClassArea] = useState(null);
  const [globalDrawingNumberArea, setGlobalDrawingNumberArea] = useState(null);
  const [globalPageNumberArea, setGlobalPageNumberArea] = useState(null);
  const [globalScaffoldArea, setGlobalScaffoldArea] = useState(null);
  const [globalWeldRecognitionArea, setGlobalWeldRecognitionArea] = useState(null);
  
  // 使用useRef来保存最新的区域状态，避免异步更新问题
  const latestAreasRef = useRef({
    material: null,
    pipeline: null,
    pipeClass: null,
    drawingNumber: null,
    pageNumber: null,
    scaffold: null,
    weldRecognition: null
  });
  const [pipelineBackfillProgress, setPipelineBackfillProgress] = useState({
    visible: false,
    running: false,
    current: 0,
    total: 0,
    updated: 0,
    failedPages: [],
    currentPage: null
  });

  const handleBackfillAnnotationPipelines = useCallback(async () => {
    if (pipelineBackfillProgress.running) return;
    const pipelineArea = latestAreasRef.current.pipeline || globalPipelineArea;
    const pageNumberArea = latestAreasRef.current.pageNumber || globalPageNumberArea;
    if (!pipelineArea) {
      message.warning('请先划定管线号区域');
      return;
    }

    const missingWeldAnnotations = (annotations || []).filter(annotation => (
      isRecoverableWeldAnnotation(annotation) &&
      !sanitizeRecognizedPipelineNumber(annotation?.pipelineNumber || annotation?.weldData?.pipelineNumber)
    ));
    const targetPages = Array.from(new Set(
      missingWeldAnnotations.map(annotation => Number(annotation.page || 1)).filter(Number.isFinite)
    )).sort((left, right) => left - right);

    if (targetPages.length === 0) {
      message.info('现有焊口标注均已包含管线号');
      return;
    }

    let pdfSource = file;
    if (
      (typeof File !== 'undefined' && window.__lastOpenedPdfFile__ instanceof File) ||
      (typeof Blob !== 'undefined' && window.__lastOpenedPdfFile__ instanceof Blob)
    ) {
      pdfSource = window.__lastOpenedPdfFile__;
    }
    const validFilePath = typeof file === 'string' && file.length > 0 && !file.startsWith('blob:');
    const isBlobSource = typeof Blob !== 'undefined' && pdfSource instanceof Blob;
    if (!validFilePath && !isBlobSource) {
      pdfSource = window.__lastOpenedPdfPath__ || window.__lastOpenedPdfFile__;
    }
    if (!pdfSource) {
      message.error('无法取得当前PDF文件，请重新打开后再试');
      return;
    }

    setPipelineBackfillProgress({
      visible: true,
      running: true,
      current: 0,
      total: targetPages.length,
      updated: 0,
      failedPages: [],
      currentPage: targetPages[0]
    });

    const updatesById = {};
    const recognizedResults = {};
    const failedPages = [];
    let updatedCount = 0;

    try {
      for (let index = 0; index < targetPages.length; index += 1) {
        const page = targetPages[index];
        setPipelineBackfillProgress(previous => ({
          ...previous,
          current: index,
          currentPage: page
        }));

        const existingPageAnnotation = (annotations || []).find(annotation => (
          Number(annotation?.page || 1) === page &&
          isRecoverableWeldAnnotation(annotation) &&
          sanitizeRecognizedPipelineNumber(annotation?.pipelineNumber || annotation?.weldData?.pipelineNumber)
        ));
        const existingPagePipeline = sanitizeRecognizedPipelineNumber(
          existingPageAnnotation?.pipelineNumber || existingPageAnnotation?.weldData?.pipelineNumber || ''
        );
        let pipelineNumber = existingPagePipeline || sanitizeRecognizedPipelineNumber(
          getNumberingPagePipelineNumber(page) || ''
        );
        let source = pipelineNumber ? 'business_data' : 'inferred';

        if (!pipelineNumber) {
          const detected = await multiPageBatchService.detectTextFromPages(
            pdfSource,
            page,
            page,
            { pipelineArea, ...(pageNumberArea ? { pageNumberArea } : {}) }
          );
          const pageResult = detected?.[page];
          if (pageResult) recognizedResults[page] = pageResult;
          pipelineNumber = sanitizeRecognizedPipelineNumber(pageResult?.pipelineNumber || '');
          source = 'inferred';
        }

        if (pipelineNumber) {
          const pageMissingAnnotations = missingWeldAnnotations.filter(
            annotation => Number(annotation.page || 1) === page
          );
          const pageUpdates = buildAnnotationPipelineUpdates({
            annotations: pageMissingAnnotations,
            pages: [page],
            pipelineNumber,
            pipelineNumberSource: source
          });
          Object.assign(updatesById, pageUpdates);
          updatedCount += Object.keys(pageUpdates).length;
        } else {
          failedPages.push(page);
        }

        setPipelineBackfillProgress(previous => ({
          ...previous,
          current: index + 1,
          updated: updatedCount,
          failedPages: [...failedPages]
        }));
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      if (Object.keys(recognizedResults).length > 0) {
        setTextDetections(previous => ({ ...previous, ...recognizedResults }));
        onPageTextDetectionsChange?.(recognizedResults);
      }
      if (Object.keys(updatesById).length > 0 && onBatchAnnotationUpdates) {
        onBatchAnnotationUpdates(updatesById, `补全管线号（${updatedCount}个焊口标注）`);
      }

      if (failedPages.length > 0) {
        message.warning(`已补全${updatedCount}个焊口标注；第${failedPages.join('、')}页未识别到管线号`);
      } else {
        message.success(`已补全${updatedCount}个焊口标注的管线号`);
      }
    } catch (error) {
      console.error('批量补全标注管线号失败:', error);
      message.error(`补全管线号失败：${error?.message || '未知错误'}`);
    } finally {
      setPipelineBackfillProgress(previous => ({
        ...previous,
        running: false,
        currentPage: null
      }));
    }
  }, [
    annotations,
    file,
    getNumberingPagePipelineNumber,
    globalPageNumberArea,
    globalPipelineArea,
    onBatchAnnotationUpdates,
    onPageTextDetectionsChange,
    pipelineBackfillProgress.running
  ]);

  const publishCurrentTemplate = useCallback((overrides = {}) => {
    const currentPageNumber = currentPage || 1;
    const withPage = (area) => area ? { ...area, page: area.page || currentPageNumber } : null;
    const splitLines = overrides.splitLines !== undefined ? overrides.splitLines : globalSplitLines;
    const materialArea = overrides.material !== undefined ? overrides.material : (latestAreasRef.current.material || globalOcrRegion);
    const pipelineArea = overrides.pipeline !== undefined ? overrides.pipeline : (latestAreasRef.current.pipeline || globalPipelineArea);
    const pipeClassArea = overrides.pipeClass !== undefined ? overrides.pipeClass : (latestAreasRef.current.pipeClass || globalPipeClassArea);
    const drawingNumberArea = overrides.drawingNumber !== undefined ? overrides.drawingNumber : (latestAreasRef.current.drawingNumber || globalDrawingNumberArea);
    const pageNumberArea = overrides.pageNumber !== undefined ? overrides.pageNumber : (latestAreasRef.current.pageNumber || globalPageNumberArea);
    const scaffoldArea = overrides.scaffold !== undefined ? overrides.scaffold : (latestAreasRef.current.scaffold || globalScaffoldArea);
    const weldRecognitionArea = overrides.weldRecognition !== undefined ? overrides.weldRecognition : (latestAreasRef.current.weldRecognition || globalWeldRecognitionArea);

    const template = {
      materialArea: withPage(materialArea),
      pipelineArea: withPage(pipelineArea),
      pipeClassArea: withPage(pipeClassArea),
      pageNumberArea: withPage(pageNumberArea),
      drawingNumberArea: withPage(drawingNumberArea),
      scaffoldArea: withPage(scaffoldArea),
      weldRecognitionArea: withPage(weldRecognitionArea),
      columns: splitLines.map((line) => ({
        x: line.x,
        page: currentPageNumber
      }))
    };

    const hasAnyArea = template.materialArea || template.pipelineArea || template.pipeClassArea || template.pageNumberArea || template.drawingNumberArea || template.scaffoldArea || template.weldRecognitionArea;
    if (hasAnyArea) {
      setTemplateUploaded(true);
      window.dispatchEvent(new CustomEvent('template-updated', { detail: template }));
    }
  }, [
    currentPage,
    globalOcrRegion,
    globalPipelineArea,
    globalPipeClassArea,
    globalDrawingNumberArea,
    globalPageNumberArea,
    globalScaffoldArea,
    globalWeldRecognitionArea,
    globalSplitLines
  ]);
  
  // 鼠标位置状态（用于实时拖拽显示）
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  
  // OCR画布几何状态
  const [canvasGeometry, setCanvasGeometry] = useState(null);
  const [multiSelectedAnnotationIds, setMultiSelectedAnnotationIds] = useState(new Set());
  const [multiAnnotationStartPositions, setMultiAnnotationStartPositions] = useState(null);
  const suppressNextAnnotationClickIdsRef = useRef(new Set());
  const externalSelectedAnnotationIdSet = useMemo(
    () => new Set((selectedAnnotationIds || []).filter(Boolean)),
    [selectedAnnotationIds]
  );

  const clearMultiSelection = useCallback(() => {
    setMultiSelectedAnnotationIds(prev => prev.size ? new Set() : prev);
    setMultiAnnotationStartPositions(null);
    onAnnotationSelectionChange?.([]);
  }, [onAnnotationSelectionChange]);

  useEffect(() => {
    setMultiSelectedAnnotationIds(prev => {
      const nextIds = selectedAnnotationIds || [];
      if (prev.size === nextIds.length && nextIds.every(id => prev.has(id))) {
        return prev;
      }
      return new Set(nextIds);
    });
  }, [selectedAnnotationIds]);

  useEffect(() => {
    const handleClearMultiSelection = (event) => {
      if (event.key !== 'Escape') return;
      clearMultiSelection();
    };

    document.addEventListener('keydown', handleClearMultiSelection);
    return () => document.removeEventListener('keydown', handleClearMultiSelection);
  }, [clearMultiSelection]);

  // OCR工具类实例
  const ocrUtilsInstance = useMemo(() => 
    new OCRUtils(pageRefsRef, currentPage, scale, pageObjectsRef), 
    [pageRefsRef, currentPage, scale, pageObjectsRef]
  );

  // 扩展OCR工具对象（兼容旧代码调用方式）
  const ocrUtils = useMemo(() => ({
    // 代理方法
    getCanvasGeometry: () => ocrUtilsInstance.getViewportGeometry(),
    getViewportGeometry: () => ocrUtilsInstance.getViewportGeometry(),
    clientToCanvas: (x, y) => ocrUtilsInstance.clientToCanvas(x, y),
    canvasToClient: (x, y) => ocrUtilsInstance.canvasToClient(x, y),
    isPointInRegion: (p, r) => ocrUtilsInstance.isPointInRegion(p, r),
    getResizeHandles: (r) => ocrUtilsInstance.getResizeHandles(r),
    getClickedHandle: (p, r) => ocrUtilsInstance.getClickedHandle(p, r),
    generateId: OCRUtils.generateId,
    
    // 补充缺失的辅助方法
    calculateRect: (startPoint, endPoint) => {
      const x = Math.min(startPoint.x, endPoint.x);
      const y = Math.min(startPoint.y, endPoint.y);
      const width = Math.abs(endPoint.x - startPoint.x);
      const height = Math.abs(endPoint.y - startPoint.y);
      return { x, y, width, height };
    }
  }), [ocrUtilsInstance]);

  // 使用PDF工具函数Hook
  const {
    // 工具函数
    isElectron,
    callLocalPaddleOCR,
    callWebPaddleOCR,
    callBackupOCR,
    callMaterialOCR,
    callPaddleOCR,
    postProcessOCRText,
    determineMaterialType,
    parseMaterialTableStructured,
    exportToExcel,
    generateMaterialColumns
  } = usePDFUtils({
    // 状态数据
    file,
    currentPage,
    globalPipelineArea,
    globalPipeClassArea,
    globalPageNumberArea,
    globalDrawingNumberArea,
    globalScaffoldArea,
    pageObjectsRef, // Pass page objects for OCR in SVG mode
    pageRefsRef,    // Pass page refs for OCRUtils
    scale,          // Pass scale for OCRUtils
    renderMode
  });

  // 使用PDF注释功能Hook
  const {
    // 状态
    isDrawing,
    currentAnnotation,
    draggingAnnotation: hookDraggingAnnotation,
    annotationDragStart: hookAnnotationDragStart,
    annotationStartPos: hookAnnotationStartPos,
    dragType: hookDragType,
    
    // 状态设置器
    setDraggingAnnotation,
    setAnnotationDragStart,
    setAnnotationStartPos,
    setDragType,
    setCurrentAnnotation,
    
    // 事件处理函数
    handleAnnotationStart,
    handleAnnotationMove,
    handleAnnotationEnd,
    handlePipeSegmentClick,
    
    // 工具函数
    processAnnotationText: hookProcessAnnotationText,
    calculateAnnotationSize: hookCalculateAnnotationSize,
    calculateConnectionPoint: hookCalculateConnectionPoint,
    generateRulePreview: hookGenerateRulePreview,
    annotationStyles: hookAnnotationStyles
  } = usePDFAnnotations({
    // 基础状态
    annotationMode,
    pipeSegmentMode,
    scale,
    
    // 注释配置
     annotationColor,
     annotationFontSize,
     annotationTopFontSize,
     annotationBottomFontSize,
     annotationFrameSize,
     annotationBorderShape,
     annotationPipeTagRotation,
     annotationPipeTagZeroPadCount,
    activeAnnotationRule,
    pipeSegmentCounter,
    pipeSegmentFontSize,
    pipeSegmentZeroPadWidth,
    annotations,
    pageSize,
    getPageSize: getAnnotationPageSize,
    
    // 材料输入相关
    materialInputVisible,
    showMaterialInput,
    savePendingAnnotation,
    closeMaterialInput,
    
    // 回调函数
    onAnnotationAdd,
    onAnnotationUpdate,
    onAnnotationClick,
    onPipeSegmentCounterUpdate,
    generatePipeSegmentLetter,
    
    // DOM引用
    containerRef
  });

  useEffect(() => {
    if (!hookDraggingAnnotation) {
      setMultiAnnotationStartPositions(null);
    }
  }, [hookDraggingAnnotation]);

  // 使用PDF事件处理器Hook
  const {
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleContextMenu,
    handleWheel,
    handleScroll
  } = usePDFEventHandlers({
    // 基础状态
    containerRef,
    currentPage,
    numPages,
    scale,
    viewMode,
    pipeSegmentMode,

    // 拖拽状态
    isDragging,
    setIsDragging,
    dragStart,
    setDragStart,
    viewOffset,
    setViewOffset,
    dragStartOffset,
    setDragStartOffset,
    
    // 注释拖拽状态
    draggingAnnotation: hookDraggingAnnotation,
    setDraggingAnnotation,
    annotationDragStart: hookAnnotationDragStart,
    setAnnotationDragStart,
    annotationStartPos: hookAnnotationStartPos,
    setAnnotationStartPos,
    dragType: hookDragType,
    setDragType,
    
    // 可见范围状态
    visiblePageRange,
    setVisiblePageRange,
    pageSize,
    
    // 回调函数
    onPageChange,
    onScaleChange,
    onAnnotationUpdate,
    onAnnotationMoveCommit,
    onAnnotationDragPreview: handleAnnotationDragPreview,
    annotationsById: annotationPageIndex?.byId,
    documentKey: file,
    annotationDragEnabled: !annotationMode && !pipeSegmentMode && !areaDeleteMode,
    annotations,
    multiSelectedAnnotationIds: Array.from(multiSelectedAnnotationIds),
    multiAnnotationStartPositions,
    
    // OCR相关
    ocrState,
    canvasGeometry,
    setCanvasGeometry,
    ocrUtils // Pass the initialized ocrUtils
  });
  
  // 模板状态管理
  const [templateUploaded, setTemplateUploaded] = useState(false);

  // 监控globalSplitLines状态变化
  useEffect(() => {
    // 状态变化监控已移除调试输出
  }, [globalSplitLines]);

  // 分割线拖拽的全局事件处理
  useEffect(() => {
    if (!draggingSplitLine) return;

    const { id, startClientX, startRelativeX, actualWidth, scaleX } = draggingSplitLine;

    const onMouseMove = (e) => {
      const deltaClient = e.clientX - startClientX;
      const deltaRelative = (deltaClient / scaleX) / actualWidth;
      let newX = startRelativeX + deltaRelative;

      if (globalOcrRegion) {
        newX = Math.max(globalOcrRegion.x, Math.min(globalOcrRegion.x + globalOcrRegion.width, newX));
      }
      setGlobalSplitLines(prev => prev.map(line =>
        line.id === id ? { ...line, x: newX } : line
      ));
    };

    const onMouseUp = () => {
      setDraggingSplitLine(null);
      setHoveredSplitLineId(null);
      document.body.style.cursor = '';
      // 延迟重置，防止 mouseup 触发额外的点击事件
      setTimeout(() => {
        isDraggingSplitLineRef.current = false;
      }, 50);
    };

    document.body.style.cursor = 'ew-resize';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
    };
  }, [draggingSplitLine, globalOcrRegion, setGlobalSplitLines]);

  // 注释工具函数已移动到 PDFAnnotations Hook 中
  // 使用Hook中的函数：hookProcessAnnotationText, hookCalculateAnnotationSize 等

  
  // PDF文档管理相关函数已移动到 PDFDocumentManager Hook 中

  // 滚动监听函数已移动到 PDFEventHandlers Hook 中


  
  // 键盘事件处理已移动到 PDFEventHandlers Hook 中
  
  // 所有事件处理逻辑已移动到 PDFEventHandlers Hook 中

  // 关闭材料编号输入对话框

  // 处理标注绘制开始
  // 注释事件处理函数已移动到 PDFAnnotations Hook 中



  // App owns the shared page index. Keep a local fallback so PDFViewer stays
  // usable in isolated tests and legacy embeddings.
  const fallbackPageAnnotationsIndexRef = useRef(null);
  const effectiveAnnotationPageIndex = useMemo(() => {
    if (annotationPageIndex) return annotationPageIndex;
    const nextIndex = createPageAnnotationIndex(
      annotations,
      fallbackPageAnnotationsIndexRef.current
    );
    fallbackPageAnnotationsIndexRef.current = nextIndex;
    return nextIndex;
  }, [annotationPageIndex, annotations]);

  const pageAnnotationsMap = useMemo(() => {
    if (!pendingNumberingAnnotations?.length) return effectiveAnnotationPageIndex.byPage;

    // The confirmation preview must use the exact same renderer as committed
    // annotations.  The lightweight AnnotationItem renderer intentionally only
    // supports a subset of shapes (and did not render split-circle at all),
    // which made the preview appear empty for the ShenYuan rule.
    // Merge the frozen preview snapshot into the normal page map instead.  On
    // confirmation this same snapshot is submitted unchanged, so preview and
    // committed output cannot drift apart visually.
    const previewResult = prepareWeldAdjustmentPreview(annotations, pendingNumberingAnnotations || []);
    return buildPreviewPageAnnotationMap(effectiveAnnotationPageIndex, previewResult);
  }, [annotations, effectiveAnnotationPageIndex, pendingNumberingAnnotations]);

  // 从映射中获取页面标注（引用更稳定，减少重渲染）
  const getPageAnnotations = useCallback((pageNumber) => {
    return pageAnnotationsMap.get(Number(pageNumber || 1)) || [];
  }, [pageAnnotationsMap]);

  const annotationRenderLiveStateRef = useRef(null);
  annotationRenderLiveStateRef.current = {
    annotationsById: effectiveAnnotationPageIndex.byId,
    selectedAnnotation,
    selectedAnnotationIds,
    multiSelectedAnnotationIds,
    externalSelectedAnnotationIdSet,
    onAnnotationClick,
    onAnnotationSelectionChange,
    onAnnotationEdit,
    clearMultiSelection
  };

  // Pending numbering annotations are already included in pageAnnotationsMap
  // and rendered by renderAnnotations. Keep this call site as a no-op so all
  // viewer layouts retain the same structure without drawing a second copy.
  const renderPendingNumberingAnnotations = useCallback(() => null, []);

  // 渲染标注时添加高亮效果 - 优化版
  const renderAnnotations = useCallback((pageNumber, dragPreviewAnnotations = null, indexedPageAnnotations = null) => {
    const renderStartTime = performance.now();
    const pageAnnotations = dragPreviewAnnotations || indexedPageAnnotations || [];
    const {
      selectedAnnotation,
      multiSelectedAnnotationIds,
      externalSelectedAnnotationIdSet
    } = annotationRenderLiveStateRef.current;
    
    // 🔍 性能监控：只在标注数量多时输出警告（可选，生产环境可注释掉）
    if (!dragPreviewAnnotations && pageAnnotations.length > 100) {
      console.warn(`⚠️ [性能提示] 第${pageNumber}页有 ${pageAnnotations.length} 个标注，建议减少标注数量`);
    }
    
    const result = pageAnnotations.map((annotation) => {
      // 检查坐标有效性
      const isValidCoordinate = (x, y) => {
        return typeof x === 'number' && typeof y === 'number' && 
               !isNaN(x) && !isNaN(y) && 
               x >= 0 && y >= 0 && 
               x < 10000 && y < 10000; // 合理的坐标范围
      };
      
      if (!isValidCoordinate(annotation.endX, annotation.endY)) {
        console.warn(`⚠️ 标注坐标无效:`, annotation.text, `坐标: (${annotation.endX}, ${annotation.endY})`);
        return null; // 跳过无效坐标的标注
      }
      
      // 添加标注交互处理函数
      const handleAnnotationMouseDown = (e) => {
        e.preventDefault();
        // Right-button mouseup may be followed by contextmenu. It must not
        // start a second gesture after the committed drag has already ended.
        if (e.type === 'contextmenu') return;
        
        // 在管段号模式下，禁用拖拽功能，直接返回
        if (pipeSegmentMode) {
          return;
        }
        
        // 在其他模式下，不阻止事件冒泡
        e.stopPropagation();
        const liveState = annotationRenderLiveStateRef.current;

        if ((e.ctrlKey || e.metaKey) && e.button === 0) {
          const next = new Set(
            liveState.multiSelectedAnnotationIds.size > 0
              ? liveState.multiSelectedAnnotationIds
              : (liveState.selectedAnnotation ? [liveState.selectedAnnotation] : [])
          );
          if (next.has(annotation.id)) {
            next.delete(annotation.id);
          } else {
            next.add(annotation.id);
          }
          const nextSelection = Array.from(next);
          setMultiSelectedAnnotationIds(next);
          liveState.onAnnotationSelectionChange?.(nextSelection);
          setMultiAnnotationStartPositions(null);
          return;
        }
        
        // 如果不在标注模式，只处理拖拽逻辑
        if (e.button === 0) {
          liveState.onAnnotationClick?.(annotation);
          liveState.onAnnotationSelectionChange?.([annotation.id]);
          if (annotationMode) {
            setMultiAnnotationStartPositions(null);
            return;
          }
        }

        if (!annotationMode) {
          const selectedIdSet = liveState.multiSelectedAnnotationIds;
          if (selectedIdSet.size > 0 && !selectedIdSet.has(annotation.id)) {
            liveState.clearMultiSelection();
          }

          // 处理拖拽逻辑
          const containerRect = containerRef.current.getBoundingClientRect();
          
          let detectedDragType;
          
          // 根据鼠标按键类型决定拖拽模式
          if (e.button === 0) { // 左键
            if (annotation.hasLeaderLine) {
              detectedDragType = 'leader'; // 整体移动
            } else {
              detectedDragType = 'whole';
            }
          } else if (e.button === 2) { // 右键
            if (annotation.hasLeaderLine) {
              detectedDragType = 'annotation'; // 标注框移动，引导线固定
            } else {
              detectedDragType = 'whole';
            }
          } else {
            return; // 其他按键不处理
          }
          
          setDraggingAnnotation(annotation.id);
          setDragType(detectedDragType);
          if (selectedIdSet.size > 1 && selectedIdSet.has(annotation.id)) {
            const startPositions = {};
            selectedIdSet.forEach(id => {
              const item = liveState.annotationsById.get(id);
              if (item) {
                startPositions[item.id] = {
                  startX: item.startX,
                  startY: item.startY,
                  endX: item.endX,
                  endY: item.endY
                };
              }
            });
            setMultiAnnotationStartPositions(startPositions);
          } else {
            setMultiAnnotationStartPositions(null);
          }
          setAnnotationDragStart({ 
            x: e.clientX - containerRect.left, 
            y: e.clientY - containerRect.top 
          });
          setAnnotationStartPos({
            startX: annotation.startX,
            startY: annotation.startY,
            endX: annotation.endX,
            endY: annotation.endY
          });
        }
      };

      // 添加双击事件处理函数
      const handleAnnotationSelectClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const liveState = annotationRenderLiveStateRef.current;

        if (suppressNextAnnotationClickIdsRef.current.has(annotation.id)) {
          suppressNextAnnotationClickIdsRef.current.delete(annotation.id);
          return;
        }

        if (e.detail >= 2 && e.button === 0) {
          if (liveState.onAnnotationEdit) {
            liveState.onAnnotationEdit(annotation);
          } else {
            liveState.onAnnotationClick?.(annotation);
          }
          return;
        }

        if ((e.ctrlKey || e.metaKey) && e.button === 0) {
          return;
        }

        if (e.button === 0) {
          setMultiSelectedAnnotationIds(new Set([annotation.id]));
          liveState.onAnnotationClick?.(annotation);
          liveState.onAnnotationSelectionChange?.([annotation.id]);
          setMultiAnnotationStartPositions(null);
        }
      };

      const handleAnnotationSafeMouseDown = (e) => {
        if ((e.ctrlKey || e.metaKey) && e.button === 0) {
          e.preventDefault();
          e.stopPropagation();
          const liveState = annotationRenderLiveStateRef.current;
          const next = new Set([
            ...Array.from(liveState.multiSelectedAnnotationIds || []),
            ...(liveState.selectedAnnotationIds || []),
            ...(liveState.selectedAnnotation ? [liveState.selectedAnnotation] : [])
          ]);
          if (next.has(annotation.id)) {
            next.delete(annotation.id);
          } else {
            next.add(annotation.id);
          }
          const nextSelection = Array.from(next);
          setMultiSelectedAnnotationIds(new Set(nextSelection));
          liveState.onAnnotationSelectionChange?.(nextSelection);
          setMultiAnnotationStartPositions(null);
          suppressNextAnnotationClickIdsRef.current.add(annotation.id);
          return;
        }

        if (annotationMode) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        handleAnnotationMouseDown(e);
      };

      const handleAnnotationDoubleClick = (e) => {
        e.preventDefault();
        const liveState = annotationRenderLiveStateRef.current;
        
        // 在管段号模式下，不阻止事件冒泡，让AnnotationLayer能够处理点击事件
        if (!pipeSegmentMode) {
          e.stopPropagation();
        }
        
        // 双击直接编辑标注（不通过selectedAnnotation机制）
        console.log('🎯 PDF上的标注被双击:', annotation.text);
        if (liveState.onAnnotationEdit) {
          liveState.onAnnotationEdit(annotation);
        } else if (liveState.onAnnotationClick) {
          // 兼容旧的逻辑
          liveState.onAnnotationClick(annotation);
        }
      };

      // 计算标注的边界框 - 根据实际标注大小动态计算
      const getBoundingBox = (annotation) => {
        const { displayText, fontSize } = hookProcessAnnotationText(annotation);
        const { circleRadius, diamondRadius, rectangleHalfSide, textRectangleWidth, textRectangleHeight, diagonalLength } = hookCalculateAnnotationSize(displayText, fontSize, annotation);
        

        
        // 根据不同形状计算实际尺寸
        let shapeSize;
        switch (annotation.borderShape) {
          case 'circle':
          case 'split-circle':
          case 'shop-weld':
            shapeSize = circleRadius;
            break;
          case 'diamond':
          case 'field-weld':
            shapeSize = diamondRadius;
            break;
          case 'rectangle':
            shapeSize = rectangleHalfSide;
            break;
          case 'text-rectangle':
            shapeSize = Math.max(textRectangleWidth / 2, textRectangleHeight / 2);
            break;
          case 'pipe-tag':
            shapeSize = ((diagonalLength || 56.7) / 10) * 11.5;
            break;
          default:
            shapeSize = Math.max(displayText.length * fontSize * 0.6, fontSize) / 2 + 10;
        }
        
        // 考虑焊缝的平行线扩展
        let weldLineExtension = 0;
        if (annotation.borderShape === 'field-weld') {
          // 现场焊缝：菱形与平行线一体化，无额外扩展
          weldLineExtension = 0;
        } else if (annotation.borderShape === 'shop-weld') {
          // 车间焊缝：平行线可能超出圆形边界
          const weldLineOffset = diagonalLength * 0.12;
          const intersectionDistance = Math.sqrt(circleRadius * circleRadius - weldLineOffset * weldLineOffset);
          weldLineExtension = Math.max(0, intersectionDistance - circleRadius);
        }
        
        const actualSize = Math.max(shapeSize, weldLineExtension);
        const clickPadding = 10; // 额外的点击边距
        const totalPadding = actualSize + clickPadding;
        
        let minX, minY, maxX, maxY;
        
        if (annotation.hasLeaderLine) {
          // 有引导线时，要包含引导线的起点
          const allX = [annotation.startX, annotation.endX - totalPadding, annotation.endX + totalPadding];
          const allY = [annotation.startY, annotation.endY - totalPadding, annotation.endY + totalPadding];
          minX = Math.min(...allX);
          minY = Math.min(...allY);
          maxX = Math.max(...allX);
          maxY = Math.max(...allY);
        } else {
          // 没有引导线时，只考虑标注框本身
          minX = annotation.endX - totalPadding;
          minY = annotation.endY - totalPadding;
          maxX = annotation.endX + totalPadding;
          maxY = annotation.endY + totalPadding;
        }
        
        return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
      };

      const boundingBox = getBoundingBox(annotation);
      const isMultiSelected = multiSelectedAnnotationIds.has(annotation.id) || externalSelectedAnnotationIdSet.has(annotation.id);
      const isAnnotationHighlighted = selectedAnnotation === annotation.id || isMultiSelected;

      // 🚀 性能优化：使用 MemoizedAnnotationWrapper 包装每个标注
      // 这样只有该标注自身变化时才会重新渲染，而不是所有标注都重新渲染
      return (
        <MemoizedAnnotationWrapper 
          key={annotation.id} 
          annotation={annotation}
          scale={scale}
          selectedAnnotation={selectedAnnotation}
          isMultiSelected={isMultiSelected}
          interactionDisabled={annotationMode}
          renderContext={renderAnnotations}
        >
          <svg
            data-pdf-annotation-id={dragPreviewAnnotations ? undefined : annotation.id}
            style={{
              position: 'absolute',
              top: `${boundingBox.minY * scale}px`,
              left: `${boundingBox.minX * scale}px`,
              width: `${boundingBox.width * scale}px`,
              height: `${boundingBox.height * scale}px`,
              pointerEvents: 'none',
              zIndex: 1001,
              overflow: 'visible'
            }}
            viewBox={`${boundingBox.minX} ${boundingBox.minY} ${boundingBox.width} ${boundingBox.height}`}
            onMouseDown={handleAnnotationSafeMouseDown}
            onClick={handleAnnotationSelectClick}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onDoubleClick={handleAnnotationDoubleClick}
          >
            <rect
              x={boundingBox.minX}
              y={boundingBox.minY}
              width={boundingBox.width}
              height={boundingBox.height}
              fill="transparent"
              style={{ pointerEvents: 'none', cursor: annotationMode ? 'pointer' : 'move' }}
              onMouseDown={handleAnnotationSafeMouseDown}
              onClick={handleAnnotationSelectClick}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDoubleClick={handleAnnotationDoubleClick}
            />
          {/* 标注框和内容 */}


          {annotation.borderShape === 'circle' && (() => {
            const { displayText, fontSize } = hookProcessAnnotationText(annotation);
            const { circleRadius } = hookCalculateAnnotationSize(displayText, fontSize, annotation);
            
            return (
              <g
                style={{ pointerEvents: annotationMode ? 'none' : 'auto', cursor: annotationMode ? 'default' : 'move' }}
                onMouseDown={handleAnnotationSafeMouseDown}
                onClick={handleAnnotationSelectClick}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleAnnotationMouseDown(e); }}
                onDoubleClick={handleAnnotationDoubleClick}
              >
                {/* 引导线（如果有） - 连接到圆形边缘 */}
                {annotation.hasLeaderLine && (() => {
                  // 计算引导线方向
                  const dx = annotation.endX - annotation.startX;
                  const dy = annotation.endY - annotation.startY;
                  const length = Math.sqrt(dx * dx + dy * dy);
                  const unitX = dx / length;
                  const unitY = dy / length;
                  
                  // 计算引导线与圆形边缘的交点
                  const intersectionX = annotation.endX - unitX * circleRadius;
                  const intersectionY = annotation.endY - unitY * circleRadius;
                  
                  return (
                    <g>
                      <line
                        x1={annotation.startX}
                        y1={annotation.startY}
                        x2={intersectionX}
                        y2={intersectionY}
                        stroke={annotation.color}
                        strokeWidth={hookAnnotationStyles.strokeWidth}
                      />
                      {/* 引导线起点 - 小圆点 */}
                      <circle
                        cx={annotation.startX}
                        cy={annotation.startY}
                        r="1"
                        fill={annotation.color}
                      />
                      {/* 引导线起点 - 可拖拽区域（透明） */}
                      <g className="leader-drag-area">
                        <circle
                          cx={annotation.startX}
                          cy={annotation.startY}
                          r="15"
                          fill="transparent"
                          stroke="transparent"
                          style={{
                            cursor: !annotationMode ? 'crosshair' : 'default',
                            // 标注模式下必须彻底让出命中区域，否则会挡住新标注的落点
                            pointerEvents: annotationMode ? 'none' : 'auto'
                          }}
                        />
                        {/* 悬停指示器 */}
                        <circle
                          cx={annotation.startX}
                          cy={annotation.startY}
                          r="12"
                          fill="transparent"
                          stroke="rgba(255, 0, 0, 0.6)"
                          strokeWidth={hookAnnotationStyles.strokeWidth}
                          strokeDasharray="2,2"
                          opacity="0"
                          style={{
                            cursor: !annotationMode ? 'crosshair' : 'default',
                            pointerEvents: 'none',
                            transition: 'opacity 0.2s'
                          }}
                          className="leader-hover-indicator"
                        />
                      </g>

                    </g>
                   );
                })()}
                
                {/* 圆形框 */}
                <circle
                  cx={annotation.endX}
                  cy={annotation.endY}
                  r={circleRadius}
                  fill="transparent"
                  stroke={annotation.color}
                  strokeWidth={hookAnnotationStyles.strokeWidth}
                />
                {/* 文字 - 确保正向显示并完美居中 */}
                <text
                  x={annotation.endX}
                  y={annotation.endY}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={hookProcessAnnotationText(annotation).fontSize}
                  fill={annotation.color}
                  fontWeight={hookAnnotationStyles.textFontWeight}
                  transform={`rotate(0, ${annotation.endX}, ${annotation.endY})`}
                  style={hookAnnotationStyles.textStyle}
                >
                  {hookProcessAnnotationText(annotation).displayText}
                </text>
              </g>
            );
          })()}

          {annotation.borderShape === 'split-circle' && (() => {
            const { displayText, fontSize } = hookProcessAnnotationText(annotation);
            const { circleRadius } = hookCalculateAnnotationSize(displayText, fontSize, annotation);
            const topText = formatSplitCircleTopText(annotation.topText, annotation.jointTypeText);
            const defaultSplitFontSize = Math.max(fontSize * 0.72, 10);
            const topFontSize = annotation.topFontSize || 16;
            const bottomFontSize = annotation.bottomFontSize || defaultSplitFontSize;
            const textOffset = circleRadius * 0.42;

            return (
              <g
                style={{ pointerEvents: annotationMode ? 'none' : 'auto', cursor: annotationMode ? 'default' : 'move' }}
                onMouseDown={handleAnnotationSafeMouseDown}
                onClick={handleAnnotationSelectClick}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleAnnotationMouseDown(e); }}
                onDoubleClick={handleAnnotationDoubleClick}
              >
                {annotation.hasLeaderLine && (() => {
                  const dx = annotation.endX - annotation.startX;
                  const dy = annotation.endY - annotation.startY;
                  const length = Math.sqrt(dx * dx + dy * dy) || 1;
                  const unitX = dx / length;
                  const unitY = dy / length;
                  const intersectionX = annotation.endX - unitX * circleRadius;
                  const intersectionY = annotation.endY - unitY * circleRadius;

                  return (
                    <g>
                      <line
                        x1={annotation.startX}
                        y1={annotation.startY}
                        x2={intersectionX}
                        y2={intersectionY}
                        stroke={annotation.color}
                        strokeWidth={hookAnnotationStyles.strokeWidth}
                      />
                      <circle cx={annotation.startX} cy={annotation.startY} r="1" fill={annotation.color} />
                    </g>
                  );
                })()}
                <circle
                  cx={annotation.endX}
                  cy={annotation.endY}
                  r={circleRadius}
                  fill="transparent"
                  stroke={annotation.color}
                  strokeWidth={hookAnnotationStyles.strokeWidth}
                />
                <line
                  x1={annotation.endX - circleRadius * 0.86}
                  y1={annotation.endY}
                  x2={annotation.endX + circleRadius * 0.86}
                  y2={annotation.endY}
                  stroke={annotation.color}
                  strokeWidth={hookAnnotationStyles.strokeWidth}
                />
                <text
                  x={annotation.endX}
                  y={annotation.endY - textOffset}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={topFontSize}
                  fill={annotation.color}
                  fontWeight={hookAnnotationStyles.textFontWeight}
                  style={hookAnnotationStyles.textStyle}
                >
                  {topText}
                </text>
                <text
                  x={annotation.endX}
                  y={annotation.endY + textOffset}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={bottomFontSize}
                  fill={annotation.color}
                  fontWeight={hookAnnotationStyles.textFontWeight}
                  style={hookAnnotationStyles.textStyle}
                >
                  {displayText}
                </text>
              </g>
            );
          })()}

          {annotation.borderShape === 'field-weld' && (() => {
            const { displayText, fontSize } = hookProcessAnnotationText(annotation);
            const { diamondRadius, diagonalLength } = hookCalculateAnnotationSize(displayText, fontSize, annotation);
            const weldLineOffset = diagonalLength * 0.12;
            const diamondWidthAtOffset = diamondRadius - Math.abs(weldLineOffset);
            const weldLineLength = diamondWidthAtOffset * 2;
            const { endX, endY } = annotation;

            // 构建一体化路径
            const pathData = `
              M ${endX},${endY - diamondRadius} 
              L ${endX + diamondRadius},${endY} 
              L ${endX},${endY + diamondRadius} 
              L ${endX - diamondRadius},${endY} 
              Z 
              M ${endX - weldLineLength / 2},${endY - weldLineOffset} 
              L ${endX + weldLineLength / 2},${endY - weldLineOffset} 
              M ${endX - weldLineLength / 2},${endY + weldLineOffset} 
              L ${endX + weldLineLength / 2},${endY + weldLineOffset}
            `;
            
            return (
              <g
                style={{ pointerEvents: annotationMode ? 'none' : 'auto', cursor: annotationMode ? 'default' : 'move' }}
                onMouseDown={handleAnnotationSafeMouseDown}
                onClick={handleAnnotationSelectClick}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleAnnotationMouseDown(e); }}
                onDoubleClick={handleAnnotationDoubleClick}
              >
                {/* 引导线（如果有） */}
                {annotation.hasLeaderLine && (() => {
                  const connection = hookCalculateConnectionPoint(annotation, 'diamond', diamondRadius);
                  return (
                    <g>
                      <line
                        x1={annotation.startX}
                        y1={annotation.startY}
                        x2={connection.connectionX}
                        y2={connection.connectionY}
                        stroke={annotation.color}
                        strokeWidth={hookAnnotationStyles.strokeWidth}
                        markerEnd="url(#arrow)"
                      />
                      <circle
                        cx={annotation.startX}
                        cy={annotation.startY}
                        r="1.5"
                        fill={annotation.color}
                      />
                    </g>
                  );
                })()}

                {/* 使用单一路径绘制整个符号 */}
                <path
                  d={pathData}
                  fill="transparent"
                  stroke={annotation.color}
                  strokeWidth={hookAnnotationStyles.strokeWidth}
                />

                {/* 文字 */}
                <text
                  x={annotation.endX}
                  y={annotation.endY - weldLineOffset * 0.6 - 13}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={hookProcessAnnotationText(annotation).fontSize}
                  fill={annotation.color}
                  fontWeight={hookAnnotationStyles.textFontWeight}
                  transform={`rotate(0, ${annotation.endX}, ${annotation.endY})`}
                  style={hookAnnotationStyles.textStyle}
                >
                  {hookProcessAnnotationText(annotation).displayText}
                </text>
              </g>
            );
          })()}

          {annotation.borderShape === 'diamond' && (() => {
            const { displayText, fontSize } = hookProcessAnnotationText(annotation);
            const { diamondRadius } = hookCalculateAnnotationSize(displayText, fontSize, annotation);
            
            return (
              <g
                style={{ pointerEvents: annotationMode ? 'none' : 'auto', cursor: annotationMode ? 'default' : 'move' }}
                onMouseDown={handleAnnotationSafeMouseDown}
                onClick={handleAnnotationSelectClick}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleAnnotationMouseDown(e); }}
                onDoubleClick={handleAnnotationDoubleClick}
              >
                {/* 引导线（如果有） - 连接到菱形边缘 */}
                {annotation.hasLeaderLine && (() => {
                  const connection = hookCalculateConnectionPoint(annotation, 'diamond', diamondRadius);
                  
                  return (
                    <g>
                      <line
                        x1={annotation.startX}
                        y1={annotation.startY}
                        x2={connection.connectionX}
                        y2={connection.connectionY}
                        stroke={annotation.color}
                        strokeWidth={hookAnnotationStyles.strokeWidth}
                      />
                      <circle
                        cx={annotation.startX}
                        cy={annotation.startY}
                        r="1"
                        fill={annotation.color}
                      />
                    </g>
                  );
                })()}
                
                {/* 菱形 - 不旋转，保持正向 */}
                <polygon
                  points={`${annotation.endX},${annotation.endY - diamondRadius} ${annotation.endX + diamondRadius},${annotation.endY} ${annotation.endX},${annotation.endY + diamondRadius} ${annotation.endX - diamondRadius},${annotation.endY}`}
                  fill="transparent"
                  stroke={annotation.color}
                  strokeWidth={hookAnnotationStyles.strokeWidth}
                />
                {/* 文字 - 确保正向显示并完美居中 */}
                <text
                  x={annotation.endX}
                  y={annotation.endY}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={hookProcessAnnotationText(annotation).fontSize}
                  fill={annotation.color}
                  fontWeight={hookAnnotationStyles.textFontWeight}
                  transform={`rotate(0, ${annotation.endX}, ${annotation.endY})`}
                  style={hookAnnotationStyles.textStyle}
                >
                  {hookProcessAnnotationText(annotation).displayText}
                </text>
              </g>
            );
          })()}

          {annotation.borderShape === 'rectangle' && (() => {
            const { displayText, fontSize } = hookProcessAnnotationText(annotation);
            const { rectangleHalfSide } = hookCalculateAnnotationSize(displayText, fontSize, annotation);
            
            return (
              <g
                style={{ pointerEvents: annotationMode ? 'none' : 'auto', cursor: annotationMode ? 'default' : 'move' }}
                onMouseDown={handleAnnotationSafeMouseDown}
                onClick={handleAnnotationSelectClick}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleAnnotationMouseDown(e); }}
                onDoubleClick={handleAnnotationDoubleClick}
              >
                {/* 引导线（如果有） - 连接到矩形角点 */}
                {annotation.hasLeaderLine && (() => {
                  const connection = hookCalculateConnectionPoint(annotation, 'rectangle', rectangleHalfSide);
                  
                  return (
                    <g>
                      <line
                        x1={annotation.startX}
                        y1={annotation.startY}
                        x2={connection.connectionX}
                        y2={connection.connectionY}
                        stroke={annotation.color}
                        strokeWidth={hookAnnotationStyles.strokeWidth}
                      />
                      <circle
                        cx={annotation.startX}
                        cy={annotation.startY}
                        r="1"
                        fill={annotation.color}
                      />
                    </g>
                  );
                })()}
                
                {/* 矩形 */}
                <rect
                  x={annotation.endX - rectangleHalfSide}
                  y={annotation.endY - rectangleHalfSide}
                  width={rectangleHalfSide * 2}
                  height={rectangleHalfSide * 2}
                  fill="transparent"
                  stroke={annotation.color}
                  strokeWidth={hookAnnotationStyles.strokeWidth}
                />
                {/* 文字 - 确保正向显示并完美居中 */}
                <text
                  x={annotation.endX}
                  y={annotation.endY}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={hookProcessAnnotationText(annotation).fontSize}
                  fill={annotation.color}
                  fontWeight={hookAnnotationStyles.textFontWeight}
                  transform={`rotate(0, ${annotation.endX}, ${annotation.endY})`}
                  style={hookAnnotationStyles.textStyle}
                >
                  {hookProcessAnnotationText(annotation).displayText}
                </text>
              </g>
            );
          })()}

          {annotation.borderShape === 'text-rectangle' && (() => {
            const { displayText, fontSize } = hookProcessAnnotationText(annotation);
            const { textRectangleWidth: width, textRectangleHeight: height } = hookCalculateAnnotationSize(displayText, fontSize, annotation);
            return (
              <g
                style={{ pointerEvents: annotationMode ? 'none' : 'auto', cursor: annotationMode ? 'default' : 'move' }}
                onMouseDown={handleAnnotationSafeMouseDown}
                onClick={handleAnnotationSelectClick}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleAnnotationMouseDown(e); }}
                onDoubleClick={handleAnnotationDoubleClick}
              >
                {annotation.hasLeaderLine && (() => {
                  const connection = hookCalculateConnectionPoint(annotation, 'text-rectangle', { width, height });
                  return (
                    <g>
                      <line x1={annotation.startX} y1={annotation.startY} x2={connection.connectionX} y2={connection.connectionY} stroke={annotation.color} strokeWidth={hookAnnotationStyles.strokeWidth} />
                      <circle cx={annotation.startX} cy={annotation.startY} r="1" fill={annotation.color} />
                    </g>
                  );
                })()}
                <rect
                  x={annotation.endX - width / 2}
                  y={annotation.endY - height / 2}
                  width={width}
                  height={height}
                  fill="transparent"
                  stroke={annotation.color}
                  strokeWidth={hookAnnotationStyles.strokeWidth}
                />
                <text
                  x={annotation.endX}
                  y={annotation.endY}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={fontSize}
                  fill={annotation.color}
                  fontWeight={hookAnnotationStyles.textFontWeight}
                  style={hookAnnotationStyles.textStyle}
                >{displayText}</text>
              </g>
            );
          })()}

          {annotation.borderShape === 'pipe-tag' && (() => {
            const { displayText, fontSize } = hookProcessAnnotationText(annotation);
            const { diagonalLength } = hookCalculateAnnotationSize(displayText, fontSize, annotation);
            const unitPerMm = (diagonalLength || 56.7) / 10;
            const tag = {
              width: 23 * unitPerMm,
              height: 4 * unitPerMm,
              inset: Math.max(1.4, 0.45 * unitPerMm)
            };
            const x = annotation.endX - tag.width / 2;
            const y = annotation.endY - tag.height / 2;
            const rotation = Number(annotation.rotation) || 0;
            
            return (
              <g
                style={{ pointerEvents: annotationMode ? 'none' : 'auto', cursor: annotationMode ? 'default' : 'move' }}
                onMouseDown={handleAnnotationSafeMouseDown}
                onClick={handleAnnotationSelectClick}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleAnnotationMouseDown(e); }}
                onDoubleClick={handleAnnotationDoubleClick}
              >
                {annotation.hasLeaderLine && (() => {
                  const connection = hookCalculateConnectionPoint(annotation, 'pipe-tag', tag);
                  return (
                    <g>
                      <line
                        x1={annotation.startX}
                        y1={annotation.startY}
                        x2={connection.connectionX}
                        y2={connection.connectionY}
                        stroke={annotation.color}
                        strokeWidth={hookAnnotationStyles.strokeWidth}
                      />
                      <circle
                        cx={annotation.startX}
                        cy={annotation.startY}
                        r="1"
                        fill={annotation.color}
                      />
                    </g>
                  );
                })()}
                <g transform={`rotate(${rotation}, ${annotation.endX}, ${annotation.endY})`}>
                  <rect
                    x={x}
                    y={y}
                    width={tag.width}
                    height={tag.height}
                    fill="transparent"
                    stroke={annotation.color}
                    strokeWidth={Math.max(1, hookAnnotationStyles.strokeWidth * 0.75)}
                  />
                  <rect
                    x={x + tag.inset}
                    y={y + tag.inset}
                    width={tag.width - tag.inset * 2}
                    height={tag.height - tag.inset * 2}
                    fill="transparent"
                    stroke={annotation.color}
                    strokeWidth={Math.max(0.75, hookAnnotationStyles.strokeWidth * 0.45)}
                  />
                  <text
                    x={annotation.endX}
                    y={annotation.endY}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={fontSize}
                    fill={annotation.color}
                    fontWeight={hookAnnotationStyles.textFontWeight}
                    style={hookAnnotationStyles.textStyle}
                  >
                    {displayText}
                  </text>
                </g>
              </g>
            );
          })()}

          {annotation.borderShape === 'shop-weld' && (() => {
            const { displayText, fontSize } = hookProcessAnnotationText(annotation);
            const { circleRadius, diagonalLength } = hookCalculateAnnotationSize(displayText, fontSize, annotation);
            const weldLineOffset = diagonalLength * 0.12;
            const intersectionDistance = Math.sqrt(circleRadius * circleRadius - weldLineOffset * weldLineOffset);
            const weldLineLength = intersectionDistance * 2;
            const { endX, endY } = annotation;

            // 构建一体化路径
            const pathData = `
              M ${endX - circleRadius}, ${endY}
              A ${circleRadius},${circleRadius} 0 1,0 ${endX + circleRadius},${endY}
              A ${circleRadius},${circleRadius} 0 1,0 ${endX - circleRadius},${endY}
              M ${endX - weldLineLength / 2},${endY - weldLineOffset}
              L ${endX + weldLineLength / 2},${endY - weldLineOffset}
              M ${endX - weldLineLength / 2},${endY + weldLineOffset}
              L ${endX + weldLineLength / 2},${endY + weldLineOffset}
            `;
            
            return (
              <g
                style={{ pointerEvents: annotationMode ? 'none' : 'auto', cursor: annotationMode ? 'default' : 'move' }}
                onMouseDown={handleAnnotationSafeMouseDown}
                onClick={handleAnnotationSelectClick}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleAnnotationMouseDown(e); }}
                onDoubleClick={handleAnnotationDoubleClick}
              >
                {/* 引导线（如果有） */}
                {annotation.hasLeaderLine && (() => {
                  const connection = hookCalculateConnectionPoint(annotation, 'circle', circleRadius);
                  return (
                    <g>
                      <line
                        x1={annotation.startX}
                        y1={annotation.startY}
                        x2={connection.connectionX}
                        y2={connection.connectionY}
                        stroke={annotation.color}
                        strokeWidth={hookAnnotationStyles.strokeWidth}
                        markerEnd="url(#arrow)"
                      />
                      <circle
                        cx={annotation.startX}
                        cy={annotation.startY}
                        r="1.5"
                        fill={annotation.color}
                      />
                    </g>
                  );
                })()}

                {/* 使用单一路径绘制整个符号 */}
                <path
                  d={pathData}
                  fill="transparent"
                  stroke={annotation.color}
                  strokeWidth={hookAnnotationStyles.strokeWidth}
                />

                {/* 文字 */}
                <text
                  x={annotation.endX}
                  y={annotation.endY - weldLineOffset * 0.6 - 13}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={hookProcessAnnotationText(annotation).fontSize}
                  fill={annotation.color}
                  fontWeight={hookAnnotationStyles.textFontWeight}
                  transform={`rotate(0, ${annotation.endX}, ${annotation.endY})`}
                  style={hookAnnotationStyles.textStyle}
                >
                  {hookProcessAnnotationText(annotation).displayText}
                </text>
              </g>
            );
          })()}

          {annotation.borderShape === 'none' && (
            <g
              style={{ pointerEvents: annotationMode ? 'none' : 'auto', cursor: annotationMode ? 'default' : 'move' }}
              onMouseDown={handleAnnotationSafeMouseDown}
              onClick={handleAnnotationSelectClick}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleAnnotationMouseDown(e); }}
              onDoubleClick={handleAnnotationDoubleClick}
            >
              {/* 引导线（如果有） - 直接连接到文字位置 */}
              {annotation.hasLeaderLine && (
                <g>
                  <line
                    x1={annotation.startX}
                    y1={annotation.startY}
                    x2={annotation.endX}
                    y2={annotation.endY}
                    stroke={annotation.color}
                    strokeWidth={hookAnnotationStyles.strokeWidth}
                  />
                  <circle
                    cx={annotation.startX}
                    cy={annotation.startY}
                    r="1"
                    fill={annotation.color}
                  />
                </g>
              )}
              
              {/* 无边框文字 - 确保正向显示并完美居中 */}
              <text
                x={annotation.endX}
                y={annotation.endY}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={hookProcessAnnotationText(annotation).fontSize}
                fill={annotation.color}
                fontWeight={hookAnnotationStyles.textFontWeight}
                transform={`rotate(0, ${annotation.endX}, ${annotation.endY})`}
                style={hookAnnotationStyles.textStyle}
              >
                {hookProcessAnnotationText(annotation).displayText}
              </text>
            </g>
          )}

          {/* 选中状态的高亮效果 - 优雅的高亮设计 */}
          {isAnnotationHighlighted && (
            <g>
              {/* 外层光晕效果 */}
              <rect
                x={boundingBox.minX - 8}
                y={boundingBox.minY - 8}
                width={boundingBox.width + 16}
                height={boundingBox.height + 16}
                fill="none"
                stroke="rgba(255, 215, 0, 0.6)"
                strokeWidth={hookAnnotationStyles.strokeWidth}
                rx="8"
                ry="8"
                opacity="0.8"
                style={{
                  filter: "drop-shadow(0 0 12px rgba(255, 215, 0, 0.4))"
                }}
              >
                <animate
                  attributeName="opacity"
                  values="0.4;0.8;0.4"
                  dur="2s"
                  repeatCount="indefinite"
                />
              </rect>
              
              {/* 内层精致边框 */}
              <rect
                x={boundingBox.minX - 2}
                y={boundingBox.minY - 2}
                width={boundingBox.width + 4}
                height={boundingBox.height + 4}
                fill="rgba(255, 215, 0, 0.08)"
                stroke="rgba(255, 165, 0, 0.9)"
                strokeWidth="1.5"
                rx="6"
                ry="6"
                opacity="0.9"
              />
              
              {/* 引导线高亮（如果有引导线） */}
              {annotation.hasLeaderLine && (
                <>
                  {/* 引导线外层光晕 */}
                  <line
                    x1={annotation.startX}
                    y1={annotation.startY}
                    x2={annotation.endX}
                    y2={annotation.endY}
                    stroke="rgba(255, 215, 0, 0.4)"
                    strokeWidth="8"
                    opacity="0.6"
                    strokeLinecap="round"
                    style={{
                      filter: "blur(2px)"
                    }}
                  />
                  {/* 引导线内层高亮 */}
                  <line
                    x1={annotation.startX}
                    y1={annotation.startY}
                    x2={annotation.endX}
                    y2={annotation.endY}
                    stroke="rgba(255, 165, 0, 0.8)"
                    strokeWidth="3"
                    opacity="0.9"
                    strokeLinecap="round"
                  />
                </>
              )}
              
              {/* 标注框精致高亮 */}
              {annotation.borderShape === 'circle' && (
                <>
                  {/* 外层光晕圆圈 */}
                  <circle
                    cx={annotation.endX}
                    cy={annotation.endY}
                    r={Math.max(boundingBox.width, boundingBox.height) / 4 + 6}
                    fill="none"
                    stroke="rgba(255, 215, 0, 0.5)"
                    strokeWidth="3"
                    opacity="0.7"
                    style={{
                      filter: "blur(1px)"
                    }}
                  >
                    <animate
                      attributeName="r"
                      values={`${Math.max(boundingBox.width, boundingBox.height) / 4 + 4};${Math.max(boundingBox.width, boundingBox.height) / 4 + 8};${Math.max(boundingBox.width, boundingBox.height) / 4 + 4}`}
                      dur="2s"
                      repeatCount="indefinite"
                    />
                  </circle>
                  {/* 内层精致圆圈 */}
                  <circle
                    cx={annotation.endX}
                    cy={annotation.endY}
                    r={Math.max(boundingBox.width, boundingBox.height) / 4 + 2}
                    fill="none"
                    stroke="rgba(255, 165, 0, 0.9)"
                    strokeWidth={hookAnnotationStyles.strokeWidth}
                    opacity="0.8"
                  />
                </>
              )}
            </g>
          )}
        </svg>
        </MemoizedAnnotationWrapper>
      );
    }).filter(Boolean); // 过滤掉null值
    
    // 性能监控（可选，生产环境可注释掉）
    const renderEndTime = performance.now();
    const renderDuration = renderEndTime - renderStartTime;
    if (renderDuration > 50) {
      console.warn(`⚠️ [性能] 第${pageNumber}页渲染耗时 ${renderDuration.toFixed(2)}ms (${pageAnnotations.length}个标注)`);
    }
    
    return result;
  }, [scale, hookCalculateConnectionPoint, hookProcessAnnotationText, hookCalculateAnnotationSize, annotationMode, pipeSegmentMode, setDraggingAnnotation, setDragType, setAnnotationDragStart, setAnnotationStartPos, hookAnnotationStyles]);

  // During creation only the temporary annotation changes. Cache the existing
  // annotation JSX per page so pointer movement does not rebuild a dense layer.
  const renderedAnnotationsCacheRef = useRef(new Map());
  const renderAnnotationsCached = useCallback((pageNumber) => {
    const page = Number(pageNumber || 1);
    const pageAnnotations = getPageAnnotations(page);
    const pageRevision = getPageAnnotationRevision(effectiveAnnotationPageIndex, page);
    const liveState = annotationRenderLiveStateRef.current;
    const selectionKey = createPageSelectionKey(pageAnnotations, {
      selectedAnnotation: liveState.selectedAnnotation,
      selectedAnnotationIds: liveState.selectedAnnotationIds,
      multiSelectedAnnotationIds: liveState.multiSelectedAnnotationIds,
      externalSelectedAnnotationIds: liveState.externalSelectedAnnotationIdSet
    });
    const cacheState = {
      pageAnnotations,
      pageRevision,
      visualKey: `${scale}|${annotationMode ? 1 : 0}|${pipeSegmentMode ? 1 : 0}`,
      selectionKey,
      renderer: renderAnnotations
    };
    const cached = renderedAnnotationsCacheRef.current.get(page);
    if (isAnnotationRenderCacheHit(cached, cacheState)) {
      return touchExistingMapEntry(renderedAnnotationsCacheRef.current, page)?.content || cached.content;
    }
    const content = renderAnnotations(page, null, pageAnnotations);
    touchBoundedMapEntry(
      renderedAnnotationsCacheRef.current,
      page,
      createAnnotationRenderCacheEntry({ ...cacheState, content }),
      6
    );
    return content;
  }, [annotationMode, effectiveAnnotationPageIndex, getPageAnnotations, pipeSegmentMode, renderAnnotations, scale]);

  useEffect(() => {
    const handleAnnotationMemoryCheckpoint = () => {
      const current = Number(singlePageCurrentRef.current) || 1;
      trimSinglePageSnapshotsToCurrent();
      renderedAnnotationsCacheRef.current.clear();
      textLikeDetectionsCacheRef.current.clear();
      multiPageBatchService.releaseTransientRecognitionCaches();
      VectorExtractionUtils.releasePdfLibSourceDocument();
      pageObjectsRef.current?.forEach?.((page, pageNumber) => {
        if (Number(pageNumber) === current) return;
        try { page?.cleanup?.(); } catch (error) { /* already released */ }
        pageObjectsRef.current.delete(pageNumber);
      });
      window.__luotuLastAnnotationMemoryCheckpoint = {
        completedAt: Date.now(),
        currentPage: current,
        retainedSnapshots: singlePageSnapshotCacheRef.current.size,
        retainedPdfPages: Number(pageObjectsRef.current?.size || 0)
      };
    };
    window.addEventListener('luotu-annotation-memory-checkpoint', handleAnnotationMemoryCheckpoint);
    return () => window.removeEventListener('luotu-annotation-memory-checkpoint', handleAnnotationMemoryCheckpoint);
  }, [pageObjectsRef, trimSinglePageSnapshotsToCurrent]);

  const renderAnnotationDragPreview = pageNumber => (
    <AnnotationDragPreview
      pageNumber={pageNumber}
      scale={scale}
      renderAnnotations={renderAnnotations}
      ref={preview => {
        if (preview) annotationDragPreviewRefs.current.set(pageNumber, preview);
        else annotationDragPreviewRefs.current.delete(pageNumber);
      }}
    />
  );

  // 渲染当前绘制中的标注
  const renderCurrentAnnotation = (pageNumber) => {
    if (!currentAnnotation || currentAnnotation.page !== pageNumber) return null;
    
    // 定义点击处理函数
    const handleAnnotationClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('🎯 当前标注被点击:', currentAnnotation.text);
      if (onAnnotationClick) {
        onAnnotationClick(currentAnnotation);
      }
    };
    
    // 定义双击处理函数
    const handleCurrentAnnotationDoubleClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 双击功能已移除
    };
    
    // 计算当前标注的边界框 - 根据实际标注大小动态计算
    const getBoundingBox = (annotation) => {
      const { displayText, fontSize } = hookProcessAnnotationText(annotation);
      const { circleRadius, diamondRadius, rectangleHalfSide, textRectangleWidth, textRectangleHeight, diagonalLength } = hookCalculateAnnotationSize(displayText, fontSize, annotation);
      
      // 根据不同形状计算实际尺寸
      let shapeSize;
      switch (annotation.borderShape) {
        case 'circle':
        case 'split-circle':
        case 'shop-weld':
          shapeSize = circleRadius;
          break;
        case 'diamond':
        case 'field-weld':
          shapeSize = diamondRadius;
          break;
        case 'rectangle':
          shapeSize = rectangleHalfSide;
          break;
        case 'text-rectangle':
          shapeSize = Math.max(textRectangleWidth / 2, textRectangleHeight / 2);
          break;
        case 'pipe-tag':
          shapeSize = ((diagonalLength || 56.7) / 10) * 11.5;
          break;
        default:
          shapeSize = Math.max(displayText.length * fontSize * 0.6, fontSize) / 2 + 10;
      }
      
      // 考虑焊缝的平行线扩展
      let weldLineExtension = 0;
      if (annotation.borderShape === 'field-weld') {
        // 现场焊缝：菱形与平行线一体化，无额外扩展
        weldLineExtension = 0;
      } else if (annotation.borderShape === 'shop-weld') {
        // 车间焊缝：平行线可能超出圆形边界
        const weldLineOffset = diagonalLength * 0.12;
        const intersectionDistance = Math.sqrt(circleRadius * circleRadius - weldLineOffset * weldLineOffset);
        weldLineExtension = Math.max(0, intersectionDistance - circleRadius);
      }
      
      const actualSize = Math.max(shapeSize, weldLineExtension);
      const clickPadding = 10; // 额外的点击边距
      const totalPadding = actualSize + clickPadding;
      
      let minX, minY, maxX, maxY;
      
      if (annotation.hasLeaderLine) {
        // 有引导线时，要包含引导线的起点
        const allX = [annotation.startX, annotation.endX - totalPadding, annotation.endX + totalPadding];
        const allY = [annotation.startY, annotation.endY - totalPadding, annotation.endY + totalPadding];
        minX = Math.min(...allX);
        minY = Math.min(...allY);
        maxX = Math.max(...allX);
        maxY = Math.max(...allY);
      } else {
        // 没有引导线时，只考虑标注框本身
        minX = annotation.endX - totalPadding;
        minY = annotation.endY - totalPadding;
        maxX = annotation.endX + totalPadding;
        maxY = annotation.endY + totalPadding;
      }
      
      return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
    };

    const boundingBox = getBoundingBox(currentAnnotation);

    // 统一的SVG标注渲染（包含引导线和标注框）
    return (
      <svg
        style={{
          position: 'absolute',
          top: `${boundingBox.minY * scale}px`,
          left: `${boundingBox.minX * scale}px`,
          width: `${boundingBox.width * scale}px`,
          height: `${boundingBox.height * scale}px`,
          pointerEvents: 'none',
          zIndex: 1001,
          cursor: 'default'
        }}
        onClick={handleAnnotationClick}
        onDoubleClick={handleCurrentAnnotationDoubleClick}
        viewBox={`${boundingBox.minX} ${boundingBox.minY} ${boundingBox.width} ${boundingBox.height}`}
      >
        {/* 标注框和内容 */}


        {currentAnnotation.borderShape === 'circle' && (
          <g>
            {/* 引导线（如果有） - 连接到圆形边缘 */}
            {currentAnnotation.hasLeaderLine && (() => {
              const { displayText, fontSize } = hookProcessAnnotationText(currentAnnotation);
              const { circleRadius } = hookCalculateAnnotationSize(displayText, fontSize, currentAnnotation);
              const connection = hookCalculateConnectionPoint(currentAnnotation, 'circle', circleRadius);
              
              return (
                <g>
                  <line
                    x1={currentAnnotation.startX}
                    y1={currentAnnotation.startY}
                    x2={connection.connectionX}
                    y2={connection.connectionY}
                    stroke={currentAnnotation.color}
                    strokeWidth={hookAnnotationStyles.strokeWidth}
                  />
                  <circle
                    cx={currentAnnotation.startX}
                    cy={currentAnnotation.startY}
                    r="1"
                    fill={currentAnnotation.color}
                  />
                </g>
              );
            })()}
            
            {/* 圆形框 */}
            {(() => {
              const { displayText, fontSize } = hookProcessAnnotationText(currentAnnotation);
              const { circleRadius } = hookCalculateAnnotationSize(displayText, fontSize, currentAnnotation);
              
              return (
                <circle
                  cx={currentAnnotation.endX}
                  cy={currentAnnotation.endY}
                  r={circleRadius}
                  fill="transparent"
                  stroke={currentAnnotation.color}
                  strokeWidth={hookAnnotationStyles.strokeWidth}
                />
              );
            })()}
            {/* 文字 - 确保正向显示并完美居中 */}
            <text
              x={currentAnnotation.endX}
              y={currentAnnotation.endY}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={hookProcessAnnotationText(currentAnnotation).fontSize}
              fill={currentAnnotation.color}
              fontWeight={hookAnnotationStyles.textFontWeight}
              transform={`rotate(0, ${currentAnnotation.endX}, ${currentAnnotation.endY})`}
              style={hookAnnotationStyles.textStyle}
            >
              {hookProcessAnnotationText(currentAnnotation).displayText}
            </text>
          </g>
        )}

        {currentAnnotation.borderShape === 'split-circle' && (() => {
          const { displayText, fontSize } = hookProcessAnnotationText(currentAnnotation);
          const { circleRadius } = hookCalculateAnnotationSize(displayText, fontSize, currentAnnotation);
          const topText = formatSplitCircleTopText(currentAnnotation.topText, currentAnnotation.jointTypeText);
          const defaultSplitFontSize = Math.max(fontSize * 0.72, 10);
          const topFontSize = currentAnnotation.topFontSize || 16;
          const bottomFontSize = currentAnnotation.bottomFontSize || defaultSplitFontSize;
          const textOffset = circleRadius * 0.42;

          return (
            <g>
              {currentAnnotation.hasLeaderLine && (() => {
                const dx = currentAnnotation.endX - currentAnnotation.startX;
                const dy = currentAnnotation.endY - currentAnnotation.startY;
                const length = Math.sqrt(dx * dx + dy * dy) || 1;
                const unitX = dx / length;
                const unitY = dy / length;
                const connectionX = currentAnnotation.endX - unitX * circleRadius;
                const connectionY = currentAnnotation.endY - unitY * circleRadius;

                return (
                  <g>
                    <line
                      x1={currentAnnotation.startX}
                      y1={currentAnnotation.startY}
                      x2={connectionX}
                      y2={connectionY}
                      stroke={currentAnnotation.color}
                      strokeWidth={hookAnnotationStyles.strokeWidth}
                    />
                    <circle cx={currentAnnotation.startX} cy={currentAnnotation.startY} r="1" fill={currentAnnotation.color} />
                  </g>
                );
              })()}
              <circle
                cx={currentAnnotation.endX}
                cy={currentAnnotation.endY}
                r={circleRadius}
                fill="transparent"
                stroke={currentAnnotation.color}
                strokeWidth={hookAnnotationStyles.strokeWidth}
              />
              <line
                x1={currentAnnotation.endX - circleRadius * 0.86}
                y1={currentAnnotation.endY}
                x2={currentAnnotation.endX + circleRadius * 0.86}
                y2={currentAnnotation.endY}
                stroke={currentAnnotation.color}
                strokeWidth={hookAnnotationStyles.strokeWidth}
              />
              <text
                x={currentAnnotation.endX}
                y={currentAnnotation.endY - textOffset}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={topFontSize}
                fill={currentAnnotation.color}
                fontWeight={hookAnnotationStyles.textFontWeight}
                style={hookAnnotationStyles.textStyle}
              >
                {topText}
              </text>
              <text
                x={currentAnnotation.endX}
                y={currentAnnotation.endY + textOffset}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={bottomFontSize}
                fill={currentAnnotation.color}
                fontWeight={hookAnnotationStyles.textFontWeight}
                style={hookAnnotationStyles.textStyle}
              >
                {displayText}
              </text>
            </g>
          );
        })()}

        {currentAnnotation.borderShape === 'field-weld' && (() => {
          const { displayText, fontSize } = hookProcessAnnotationText(currentAnnotation);
          const { diamondRadius, diagonalLength } = hookCalculateAnnotationSize(displayText, fontSize, currentAnnotation);
          const weldLineOffset = diagonalLength * 0.12;
          // 计算平行线与菱形的交点，确保一体化设计
          const diamondWidthAtOffset = diamondRadius - Math.abs(weldLineOffset);
          const weldLineLength = diamondWidthAtOffset * 2;
          
          return (
            <g>
              {/* 引导线（如果有） - 连接到菱形边缘 */}
              {currentAnnotation.hasLeaderLine && (() => {
                const connection = hookCalculateConnectionPoint(currentAnnotation, 'diamond', diamondRadius);
                
                return (
                  <g>
                    <line
                      x1={currentAnnotation.startX}
                      y1={currentAnnotation.startY}
                      x2={connection.connectionX}
                      y2={connection.connectionY}
                      stroke={currentAnnotation.color}
                      strokeWidth={hookAnnotationStyles.strokeWidth}
                    />
                    <circle
                      cx={currentAnnotation.startX}
                      cy={currentAnnotation.startY}
                      r="1"
                      fill={currentAnnotation.color}
                    />
                  </g>
                );
              })()}
              
              {/* 菱形边框 */}
              <polygon
                points={`${currentAnnotation.endX},${currentAnnotation.endY - diamondRadius} ${currentAnnotation.endX + diamondRadius},${currentAnnotation.endY} ${currentAnnotation.endX},${currentAnnotation.endY + diamondRadius} ${currentAnnotation.endX - diamondRadius},${currentAnnotation.endY}`}
                fill="transparent"
                stroke={currentAnnotation.color}
                strokeWidth={hookAnnotationStyles.strokeWidth}
              />
              {/* 一体化的平行线 */}
              <line
                x1={currentAnnotation.endX - weldLineLength / 2}
                y1={currentAnnotation.endY - weldLineOffset}
                x2={currentAnnotation.endX + weldLineLength / 2}
                y2={currentAnnotation.endY - weldLineOffset}
                stroke={currentAnnotation.color}
                strokeWidth={hookAnnotationStyles.strokeWidth}
              />
              <line
                x1={currentAnnotation.endX - weldLineLength / 2}
                y1={currentAnnotation.endY + weldLineOffset}
                x2={currentAnnotation.endX + weldLineLength / 2}
                y2={currentAnnotation.endY + weldLineOffset}
                stroke={currentAnnotation.color}
                strokeWidth={hookAnnotationStyles.strokeWidth}
              />
              {/* 文字 - 确保正向显示 */}
              <text
                x={currentAnnotation.endX}
                y={currentAnnotation.endY - weldLineOffset * 0.6 - 13}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={hookProcessAnnotationText(currentAnnotation).fontSize}
                fill={currentAnnotation.color}
                fontWeight={hookAnnotationStyles.textFontWeight}
                transform={`rotate(0, ${currentAnnotation.endX}, ${currentAnnotation.endY})`}
                style={hookAnnotationStyles.textStyle}
              >
                {hookProcessAnnotationText(currentAnnotation).displayText}
              </text>
            </g>
          );
        })()}

        {currentAnnotation.borderShape === 'diamond' && (
          <g>
            {/* 引导线（如果有） - 连接到菱形边缘 */}
            {currentAnnotation.hasLeaderLine && (() => {
              const { displayText, fontSize } = hookProcessAnnotationText(currentAnnotation);
              const { diamondRadius } = hookCalculateAnnotationSize(displayText, fontSize, currentAnnotation);
              const connection = hookCalculateConnectionPoint(currentAnnotation, 'diamond', diamondRadius);
              
              return (
                <g>
                  <line
                    x1={currentAnnotation.startX}
                    y1={currentAnnotation.startY}
                    x2={connection.connectionX}
                    y2={connection.connectionY}
                    stroke={currentAnnotation.color}
                    strokeWidth={hookAnnotationStyles.strokeWidth}
                  />
                  <circle
                    cx={currentAnnotation.startX}
                    cy={currentAnnotation.startY}
                    r="1"
                    fill={currentAnnotation.color}
                  />
                </g>
              );
            })()}
            
            {/* 菱形 */}
            {(() => {
              const { displayText, fontSize } = hookProcessAnnotationText(currentAnnotation);
              const { diamondRadius } = hookCalculateAnnotationSize(displayText, fontSize, currentAnnotation);
              
              return (
                <polygon
                  points={`${currentAnnotation.endX},${currentAnnotation.endY - diamondRadius} ${currentAnnotation.endX + diamondRadius},${currentAnnotation.endY} ${currentAnnotation.endX},${currentAnnotation.endY + diamondRadius} ${currentAnnotation.endX - diamondRadius},${currentAnnotation.endY}`}
                  fill="transparent"
                  stroke={currentAnnotation.color}
                  strokeWidth={hookAnnotationStyles.strokeWidth}
                />
              );
            })()}
            {/* 文字 - 确保正向显示 */}
            <text
              x={currentAnnotation.endX}
              y={currentAnnotation.endY}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={hookProcessAnnotationText(currentAnnotation).fontSize}
              fill={currentAnnotation.color}
              fontWeight={hookAnnotationStyles.textFontWeight}
              transform={`rotate(0, ${currentAnnotation.endX}, ${currentAnnotation.endY})`}
              style={hookAnnotationStyles.textStyle}
            >
              {hookProcessAnnotationText(currentAnnotation).displayText}
            </text>
          </g>
        )}

        {currentAnnotation.borderShape === 'rectangle' && (() => {
          const { displayText, fontSize } = hookProcessAnnotationText(currentAnnotation);
          const { rectangleHalfSide } = hookCalculateAnnotationSize(displayText, fontSize, currentAnnotation);
          
          return (
            <g>
              {/* 引导线（如果有） - 连接到矩形角点 */}
              {currentAnnotation.hasLeaderLine && (() => {
                const connection = hookCalculateConnectionPoint(currentAnnotation, 'rectangle', rectangleHalfSide);
                
                return (
                  <g>
                    <line
                      x1={currentAnnotation.startX}
                      y1={currentAnnotation.startY}
                      x2={connection.connectionX}
                      y2={connection.connectionY}
                      stroke={currentAnnotation.color}
                      strokeWidth={hookAnnotationStyles.strokeWidth}
                    />
                    <circle
                      cx={currentAnnotation.startX}
                      cy={currentAnnotation.startY}
                      r="1"
                      fill={currentAnnotation.color}
                    />
                  </g>
                );
              })()}
              
              {/* 矩形 */}
              <rect
                x={currentAnnotation.endX - rectangleHalfSide}
                y={currentAnnotation.endY - rectangleHalfSide}
                width={rectangleHalfSide * 2}
                height={rectangleHalfSide * 2}
                fill="transparent"
                stroke={currentAnnotation.color}
                strokeWidth={hookAnnotationStyles.strokeWidth}
              />
              {/* 文字 - 确保正向显示 */}
              <text
                x={currentAnnotation.endX}
                y={currentAnnotation.endY}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={hookProcessAnnotationText(currentAnnotation).fontSize}
                fill={currentAnnotation.color}
                fontWeight={hookAnnotationStyles.textFontWeight}
                transform={`rotate(0, ${currentAnnotation.endX}, ${currentAnnotation.endY})`}
                style={hookAnnotationStyles.textStyle}
              >
                {hookProcessAnnotationText(currentAnnotation).displayText}
              </text>
            </g>
          );
        })()}

        {currentAnnotation.borderShape === 'text-rectangle' && (() => {
          const { displayText, fontSize } = hookProcessAnnotationText(currentAnnotation);
          const { textRectangleWidth: width, textRectangleHeight: height } = hookCalculateAnnotationSize(displayText, fontSize, currentAnnotation);
          return (
            <g>
              {currentAnnotation.hasLeaderLine && (() => {
                const connection = hookCalculateConnectionPoint(currentAnnotation, 'text-rectangle', { width, height });
                return (
                  <g>
                    <line x1={currentAnnotation.startX} y1={currentAnnotation.startY} x2={connection.connectionX} y2={connection.connectionY} stroke={currentAnnotation.color} strokeWidth={hookAnnotationStyles.strokeWidth} />
                    <circle cx={currentAnnotation.startX} cy={currentAnnotation.startY} r="1" fill={currentAnnotation.color} />
                  </g>
                );
              })()}
              <rect
                x={currentAnnotation.endX - width / 2}
                y={currentAnnotation.endY - height / 2}
                width={width}
                height={height}
                fill="transparent"
                stroke={currentAnnotation.color}
                strokeWidth={hookAnnotationStyles.strokeWidth}
              />
              <text
                x={currentAnnotation.endX}
                y={currentAnnotation.endY}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={fontSize}
                fill={currentAnnotation.color}
                fontWeight={hookAnnotationStyles.textFontWeight}
                style={hookAnnotationStyles.textStyle}
              >{displayText}</text>
            </g>
          );
        })()}

        {currentAnnotation.borderShape === 'pipe-tag' && (() => {
          const { displayText, fontSize } = hookProcessAnnotationText(currentAnnotation);
          const { diagonalLength } = hookCalculateAnnotationSize(displayText, fontSize, currentAnnotation);
          const unitPerMm = (diagonalLength || 56.7) / 10;
          const tag = {
            width: 23 * unitPerMm,
            height: 4 * unitPerMm,
            inset: Math.max(1.4, 0.45 * unitPerMm)
          };
          const x = currentAnnotation.endX - tag.width / 2;
          const y = currentAnnotation.endY - tag.height / 2;
          const rotation = Number(currentAnnotation.rotation) || 0;
          
          return (
            <g>
              {currentAnnotation.hasLeaderLine && (() => {
                const connection = hookCalculateConnectionPoint(currentAnnotation, 'pipe-tag', tag);
                
                return (
                  <g>
                    <line
                      x1={currentAnnotation.startX}
                      y1={currentAnnotation.startY}
                      x2={connection.connectionX}
                      y2={connection.connectionY}
                      stroke={currentAnnotation.color}
                      strokeWidth={hookAnnotationStyles.strokeWidth}
                    />
                    <circle
                      cx={currentAnnotation.startX}
                      cy={currentAnnotation.startY}
                      r="1"
                      fill={currentAnnotation.color}
                    />
                  </g>
                );
              })()}
              <g transform={`rotate(${rotation}, ${currentAnnotation.endX}, ${currentAnnotation.endY})`}>
                <rect
                  x={x}
                  y={y}
                  width={tag.width}
                  height={tag.height}
                  fill="transparent"
                  stroke={currentAnnotation.color}
                  strokeWidth={Math.max(1, hookAnnotationStyles.strokeWidth * 0.75)}
                />
                <rect
                  x={x + tag.inset}
                  y={y + tag.inset}
                  width={tag.width - tag.inset * 2}
                  height={tag.height - tag.inset * 2}
                  fill="transparent"
                  stroke={currentAnnotation.color}
                  strokeWidth={Math.max(0.75, hookAnnotationStyles.strokeWidth * 0.45)}
                />
                <text
                  x={currentAnnotation.endX}
                  y={currentAnnotation.endY}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={fontSize}
                  fill={currentAnnotation.color}
                  fontWeight={hookAnnotationStyles.textFontWeight}
                  style={hookAnnotationStyles.textStyle}
                >
                  {displayText}
                </text>
              </g>
            </g>
          );
        })()}

        {currentAnnotation.borderShape === 'shop-weld' && (() => {
          const { displayText, fontSize } = hookProcessAnnotationText(currentAnnotation);
          const { circleRadius, diagonalLength } = hookCalculateAnnotationSize(displayText, fontSize, currentAnnotation);
          const weldLineOffset = diagonalLength * 0.12;
          const intersectionDistance = Math.sqrt(circleRadius * circleRadius - weldLineOffset * weldLineOffset);
          const weldLineLength = intersectionDistance * 2;
          
          return (
            <g>
              {/* 引导线（如果有） - 连接到圆形边缘 */}
              {currentAnnotation.hasLeaderLine && (() => {
                const connection = hookCalculateConnectionPoint(currentAnnotation, 'circle', circleRadius);
                
                return (
                  <g>
                    <line
                      x1={currentAnnotation.startX}
                      y1={currentAnnotation.startY}
                      x2={connection.connectionX}
                      y2={connection.connectionY}
                      stroke={currentAnnotation.color}
                      strokeWidth={hookAnnotationStyles.strokeWidth}
                    />
                    <circle
                      cx={currentAnnotation.startX}
                      cy={currentAnnotation.startY}
                      r="1"
                      fill={currentAnnotation.color}
                    />
                  </g>
                );
              })()}
              
              {/* 圆形边框 */}
              <circle
                cx={currentAnnotation.endX}
                cy={currentAnnotation.endY}
                r={circleRadius}
                fill="transparent"
                stroke={currentAnnotation.color}
                strokeWidth={hookAnnotationStyles.strokeWidth}
              />
              {/* 一体化的平行线 - 与圆形边框相接 */}
              <line
                x1={currentAnnotation.endX - weldLineLength / 2}
                y1={currentAnnotation.endY - weldLineOffset}
                x2={currentAnnotation.endX + weldLineLength / 2}
                y2={currentAnnotation.endY - weldLineOffset}
                stroke={currentAnnotation.color}
                strokeWidth={hookAnnotationStyles.strokeWidth}
              />
              <line
                x1={currentAnnotation.endX - weldLineLength / 2}
                y1={currentAnnotation.endY + weldLineOffset}
                x2={currentAnnotation.endX + weldLineLength / 2}
                y2={currentAnnotation.endY + weldLineOffset}
                stroke={currentAnnotation.color}
                strokeWidth={hookAnnotationStyles.strokeWidth}
              />
              {/* 文字 - 确保正向显示 */}
              <text
                x={currentAnnotation.endX}
                y={currentAnnotation.endY - weldLineOffset * 0.6 - 13}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={hookProcessAnnotationText(currentAnnotation).fontSize}
                fill={currentAnnotation.color}
                fontWeight={hookAnnotationStyles.textFontWeight}
                transform={`rotate(0, ${currentAnnotation.endX}, ${currentAnnotation.endY})`}
                style={hookAnnotationStyles.textStyle}
              >
                {hookProcessAnnotationText(currentAnnotation).displayText}
              </text>
            </g>
          );
        })()}

        {currentAnnotation.borderShape === 'none' && (() => {
          const { displayText, fontSize } = hookProcessAnnotationText(currentAnnotation);
          
          // 计算文本宽度（粗略估算）
          const getTextWidth = (text, fontSize) => {
            let width = 0;
            for (let i = 0; i < text.length; i++) {
              const char = text[i];
              if (/[\u4e00-\u9fa5]/.test(char)) {
                width += fontSize;
              } else {
                width += fontSize * 0.6;
              }
            }
            return width;
          };
          
          const textWidth = getTextWidth(displayText, fontSize);
          const maxWidth = 300; // 最大单行宽度，增加到300像素
          
          // 如果文本过长，考虑换行
          if (textWidth > maxWidth) {
            // 智能拆分：优先在标点符号、空格处拆分
            const splitPoints = [' ', '-', '、', '，', '。', '；', '：'];
            const chars = displayText.split('');
            const lines = [];
            let currentLine = '';
            let currentWidth = 0;
            
            for (let i = 0; i < chars.length; i++) {
              const char = chars[i];
              const charWidth = /[\u4e00-\u9fa5]/.test(char) ? fontSize : fontSize * 0.6;
              
              // 检查添加当前字符后是否超出宽度
              if (currentWidth + charWidth > maxWidth && currentLine.length > 0) {
                // 超出宽度，需要换行
                // 尝试在最近的分隔符处断行
                let breakPoint = -1;
                for (let j = currentLine.length - 1; j >= Math.max(0, currentLine.length - 10); j--) {
                  if (splitPoints.includes(currentLine[j])) {
                    breakPoint = j + 1;
                    break;
                  }
                }
                
                if (breakPoint > 0 && breakPoint < currentLine.length) {
                  // 在分隔符处断行
                  lines.push(currentLine.substring(0, breakPoint));
                  currentLine = currentLine.substring(breakPoint) + char;
                  currentWidth = getTextWidth(currentLine, fontSize);
                } else {
                  // 没有合适的分隔符，直接在当前位置断行
                  lines.push(currentLine);
                  currentLine = char;
                  currentWidth = charWidth;
                }
              } else {
                currentLine += char;
                currentWidth += charWidth;
              }
            }
            if (currentLine) {
              lines.push(currentLine);
            }
            
            const lineHeight = fontSize * 1.3;
            const totalHeight = lines.length * lineHeight;
            
            return (
              <g>
                {/* 引导线（如果有） */}
                {currentAnnotation.hasLeaderLine && (
                  <g>
                    <line
                      x1={currentAnnotation.startX}
                      y1={currentAnnotation.startY}
                      x2={currentAnnotation.endX}
                      y2={currentAnnotation.endY - totalHeight / 2 + lineHeight / 2}
                      stroke={currentAnnotation.color}
                      strokeWidth={hookAnnotationStyles.strokeWidth}
                    />
                    <circle
                      cx={currentAnnotation.startX}
                      cy={currentAnnotation.startY}
                      r="1"
                      fill={currentAnnotation.color}
                    />
                  </g>
                )}
                
                {/* 多行文字 */}
                {lines.map((line, index) => (
                  <text
                    key={index}
                    x={currentAnnotation.endX}
                    y={currentAnnotation.endY - totalHeight / 2 + (index + 0.5) * lineHeight}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={fontSize}
                    fill={currentAnnotation.color}
                    fontWeight={hookAnnotationStyles.textFontWeight}
                    transform={`rotate(0, ${currentAnnotation.endX}, ${currentAnnotation.endY - totalHeight / 2 + (index + 0.5) * lineHeight})`}
                    style={hookAnnotationStyles.textStyle}
                  >
                    {line}
                  </text>
                ))}
              </g>
            );
          }
          
          // 文本不长，正常单行显示
          return (
            <g>
              {/* 引导线（如果有） - 直接连接到文字位置 */}
              {currentAnnotation.hasLeaderLine && (
                <g>
                  <line
                    x1={currentAnnotation.startX}
                    y1={currentAnnotation.startY}
                    x2={currentAnnotation.endX}
                    y2={currentAnnotation.endY}
                    stroke={currentAnnotation.color}
                    strokeWidth={hookAnnotationStyles.strokeWidth}
                  />
                  <circle
                    cx={currentAnnotation.startX}
                    cy={currentAnnotation.startY}
                    r="1"
                    fill={currentAnnotation.color}
                  />
                </g>
              )}
              
              {/* 无边框文字 - 确保正向显示 */}
              <text
                x={currentAnnotation.endX}
                y={currentAnnotation.endY}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={fontSize}
                fill={currentAnnotation.color}
                fontWeight={hookAnnotationStyles.textFontWeight}
                transform={`rotate(0, ${currentAnnotation.endX}, ${currentAnnotation.endY})`}
                style={hookAnnotationStyles.textStyle}
              >
                {displayText}
              </text>
            </g>
          );
        })()}

        {/* 选中状态的高亮效果 - 覆盖整个标注 */}
        {selectedAnnotation === currentAnnotation.id && (
          <g>
            {/* 高亮背景 - 覆盖整个边界框 */}
            <rect
              x={boundingBox.minX}
              y={boundingBox.minY}
              width={boundingBox.width}
              height={boundingBox.height}
              fill="rgba(24, 144, 255, 0.1)"
              stroke="#1890ff"
              strokeWidth="3"
              strokeDasharray="8,4"
              rx="4"
              ry="4"
              opacity="0.9"
              style={{
                filter: "drop-shadow(0 0 8px rgba(24, 144, 255, 0.5))"
              }}
            />
            {/* 引导线高亮（如果有引导线） */}
            {currentAnnotation.hasLeaderLine && (
              <line
                x1={currentAnnotation.startX}
                y1={currentAnnotation.startY}
                x2={currentAnnotation.endX}
                y2={currentAnnotation.endY}
                stroke="#1890ff"
                strokeWidth="6"
                opacity="0.3"
                strokeLinecap="round"
              />
            )}
            {/* 标注框高亮 */}
            <circle
              cx={currentAnnotation.endX}
              cy={currentAnnotation.endY}
              r={Math.max(boundingBox.width, boundingBox.height) / 4}
              fill="none"
              stroke="#1890ff"
              strokeWidth="4"
              opacity="0.6"
              strokeDasharray="6,3"
            />
          </g>
        )}
      </svg>
    );
  };

  // 滚动到指定页面
  const scrollToPage = useCallback((pageNumber) => {
    const pageRef = pageRefsRef.current[pageNumber];
    if (pageRef && containerRef.current) {
      pageRef.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    }
  }, []);

  useEffect(() => {
    if (currentPage && pageRefsRef.current[currentPage]) {
      scrollToPage(currentPage);
    }
  }, [currentPage, scrollToPage]);

  useEffect(() => {

    if (file) {
      setLoading(true);
      setError(null);
      // 重置视图状态
      setViewOffset({ x: 0, y: 0 });
    }
  }, [file]);

  // 获取缓存的页面信息
  const getCachedPageInfo = useCallback((pageNumber) => {
    return pageCache.get(pageNumber);
  }, [pageCache]);
  
  // 页面变化时只恢复已缓存的尺寸并清理旧的元数据缓存。
  // 旧“预加载”仅创建隐藏 div，并未加载 PDF 页面，却会产生多轮状态
  // 更新和未清理的定时任务，因此不再在翻页路径中调用。
  useEffect(() => {
    // setViewOffset({ x: 0, y: 0 }); // 注释掉此行以保留上一页的位置
    
    // 优先使用缓存的页面尺寸信息
    if (currentPage) {
      const cachedInfo = getCachedPageInfo(currentPage);
      if (cachedInfo && cachedInfo.size) {
        setPageSize(previous => {
          const next = cachedInfo.size;
          return previous.width === next.width &&
            previous.height === next.height &&
            previous.widthMM === next.widthMM &&
            previous.heightMM === next.heightMM
            ? previous
            : next;
        });

      }
    }

    if (currentPage && numPages) {
      cleanupCache(currentPage);
    }
  }, [currentPage, numPages, cleanupCache, getCachedPageInfo, setPageSize]);
  
  // 移除缩放优化相关useEffect
  
  // 组件卸载时清理节流定时器
  useEffect(() => {
    return () => {
      if (wheelThrottleRef.current) {
        clearTimeout(wheelThrottleRef.current);
      }
    };
  }, []);

  // 全局鼠标事件监听已移动到 PDFEventHandlers Hook 中

  // OCR事件处理函数
  const handleOcrMouseDown = useCallback((e) => {
    console.log('🖱️ OCR鼠标按下事件', { isActive: ocrState.isActive, mode: ocrState.mode, button: e.button });
    if (!ocrState.isActive) {
      console.log('🖱️ OCR未激活，忽略事件');
      return;
    }
    
    // 只处理鼠标左键事件
    if (e.button !== 0) {
      console.log('🖱️ 非左键点击，忽略事件');
      return;
    }
    
    const canvasPoint = ocrUtils.clientToCanvas(e.clientX, e.clientY);
    console.log('🖱️ Canvas坐标:', canvasPoint);
    if (!canvasPoint) return;
    
    e.preventDefault();
    console.log('🖱️ 开始处理OCR鼠标事件');
    
    // 如果正在拖拽分割线，或者点击的目标是分割线本身，忽略此处的点击事件，防止在原位置添加新线
    if (isDraggingSplitLineRef.current || (e.target && e.target.closest('[data-split-line="true"]'))) {
      console.log('🖱️ 正在拖拽或点击了分割线，忽略全图点击');
      return;
    }

    // 分割线模式
    if (ocrState.mode === 'splitLine') {
      ocrActions.addSplitLine(canvasPoint.x);
      return;
    }
    
    // 检查是否点击了调整手柄
    if (globalOcrRegion) {
      const clickedHandle = ocrUtils.getClickedHandle(canvasPoint, globalOcrRegion);
      if (clickedHandle) {
        ocrActions.startResize(clickedHandle, canvasPoint, globalOcrRegion);
        return;
      }
      
      // 检查是否点击了区域内部（移动）
      if (ocrUtils.isPointInRegion(canvasPoint, globalOcrRegion)) {
        // TODO: 实现区域移动功能
        return;
      }
    }
    
    // 区域选择模式
    if (ocrState.mode === 'selecting') {
      ocrActions.startDrag(canvasPoint);
    }
  }, [ocrState.isActive, ocrState.mode, ocrState.region]);

  const handleOcrMouseMove = useCallback((e) => {
    if (!ocrState.isActive) return;
    
    // 在拖拽时更新鼠标位置（用于实时显示拖拽框）
    if (ocrState.dragState.isDragging) {
      const canvasPoint = ocrUtils.clientToCanvas(e.clientX, e.clientY);
      if (canvasPoint) {
        setMousePosition(canvasPoint);
      }
      return;
    }
    
    // 只在调整区域大小时才需要坐标转换
    if (!ocrState.resizeState.isResizing) {
      return;
    }
    
    const canvasPoint = ocrUtils.clientToCanvas(e.clientX, e.clientY);
    if (!canvasPoint) return;
    
    // 调整区域大小
    if (ocrState.resizeState.isResizing) {
      ocrActions.updateResize(canvasPoint);
    }
  }, [ocrState.isActive, ocrState.dragState.isDragging, ocrState.resizeState.isResizing]);

  const handleOcrMouseUp = useCallback((e) => {
    console.log('🖱️ OCR鼠标松开事件', { 
      isActive: ocrState.isActive, 
      isDragging: ocrState.dragState.isDragging,
      mode: ocrState.mode,
      button: e.button,
      clientX: e.clientX,
      clientY: e.clientY
    });
    if (!ocrState.isActive) {
      console.log('🖱️ OCR未激活，忽略松开事件');
      return;
    }
    
    // 结束拖拽
    if (ocrState.dragState.isDragging) {
      console.log('🖱️ 结束拖拽，开始计算结束位置');
      // 计算结束位置
      const endPoint = ocrUtils.clientToCanvas(e.clientX, e.clientY);
      console.log('🖱️ 拖拽结束位置:', endPoint);
      if (endPoint) {
        console.log('🖱️ 调用endDrag');
        ocrActions.endDrag(endPoint);
      } else {
        console.error('🖱️ 无法计算结束位置');
      }
    } else {
      console.log('🖱️ 当前不在拖拽状态');
    }
    
    // 结束调整大小
    if (ocrState.resizeState.isResizing) {
      console.log('🖱️ 结束调整大小');
      ocrActions.endResize();
    }
  }, [ocrState.isActive, ocrState.dragState.isDragging, ocrState.resizeState.isResizing, ocrState.mode]);

  const handleOcrKeyDown = useCallback((e) => {
    if (!ocrState.isActive) return;
    
    switch (e.key) {
      case 'Escape':
        if (ocrState.mode === 'selecting') {
          setOcrState(prev => ({ ...prev, mode: 'idle' }));
          message.info('已取消区域选择');
        } else if (ocrState.mode === 'splitLine') {
          setOcrState(prev => ({ ...prev, mode: 'idle' }));
          message.info('已退出分割线模式');
        }
        e.preventDefault();
        break;
        
      case 'Delete':
        if (globalOcrRegion) {
          ocrActions.clearAll();
        }
        e.preventDefault();
        break;
        
      case 'Enter':
        if (globalOcrRegion) {
          // TODO: 执行OCR识别
          message.info('OCR识别功能待实现');
        }
        e.preventDefault();
        break;
    }
  }, [ocrState.isActive, ocrState.mode, ocrState.region]);

  // OCR事件监听器
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !ocrState.isActive) return;

    // 添加鼠标和键盘事件监听器
    container.addEventListener('mousedown', handleOcrMouseDown);
    container.addEventListener('mousemove', handleOcrMouseMove);
    container.addEventListener('mouseup', handleOcrMouseUp);
    document.addEventListener('keydown', handleOcrKeyDown);

    return () => {
      container.removeEventListener('mousedown', handleOcrMouseDown);
      container.removeEventListener('mousemove', handleOcrMouseMove);
      container.removeEventListener('mouseup', handleOcrMouseUp);
      document.removeEventListener('keydown', handleOcrKeyDown);
    };
  }, [ocrState.isActive, handleOcrMouseDown, handleOcrMouseMove, handleOcrMouseUp, handleOcrKeyDown]);

  // 监听来自Toolbar的OCR操作
  useEffect(() => {
    const handleOcrAction = (event) => {
      console.log('🎯 收到OCR事件:', event.detail);
      const { action, engine } = event.detail;
      console.log('🎯 执行OCR操作:', action);
      console.log('🎯 当前globalOcrRegion状态:', globalOcrRegion);
      switch (action) {
        case 'startRegion':
          console.log('🎯 开始区域选择');
          setOcrAreaTarget('material');
          ocrActions.startRegionSelection();
          break;
        case 'splitLine':
          ocrActions.enterSplitLineMode();
          break;
        case 'setPipelineArea':
          message.info('请框选"管线号"区域');
          setOcrAreaTarget('pipeline');
          ocrActions.startRegionSelection();
          break;
        case 'setPipeClassArea':
          message.info('请框选"管道等级"区域');
          setOcrAreaTarget('pipeClass');
          ocrActions.startRegionSelection();
          break;
        case 'setDrawingNumberArea':
          message.info('请框选"图号"区域');
          setOcrAreaTarget('drawingNumber');
          ocrActions.startRegionSelection();
          break;
        case 'setPageNumberArea':
          message.info('请框选"页码"区域');
          setOcrAreaTarget('pageNumber');
          ocrActions.startRegionSelection();
          break;
        case 'setScaffoldArea':
          message.info('请框选"支架"区域');
          setOcrAreaTarget('scaffold');
          ocrActions.startRegionSelection();
          break;
        case 'setWeldRecognitionArea':
          message.info('请框选"焊点识别"区域');
          setOcrAreaTarget('weldRecognition');
          ocrActions.startRegionSelection();
          break;
        case 'saveTemplate':
          ocrActions.saveTemplate();
          break;
        case 'checkStatus':
          // 检查所有区域状态
          console.log('🔍 当前所有区域状态:');
          console.log('材料表区域:', globalOcrRegion);
          console.log('管线号区域:', globalPipelineArea);
          console.log('管道等级区域:', globalPipeClassArea);
          console.log('图号区域:', globalDrawingNumberArea);
          console.log('页码区域:', globalPageNumberArea);
          console.log('支架区域:', globalScaffoldArea);
          console.log('焊点识别区域:', globalWeldRecognitionArea);
          console.log('分割线:', globalSplitLines);
          
          const areas = [
            { name: '材料表区域', value: globalOcrRegion },
            { name: '管线号区域', value: globalPipelineArea },
            { name: '管道等级区域', value: globalPipeClassArea },
            { name: '图号区域', value: globalDrawingNumberArea },
            { name: '页码区域', value: globalPageNumberArea },
            { name: '支架区域', value: globalScaffoldArea },
            { name: '焊点识别区域', value: globalWeldRecognitionArea }
          ];
          
          const setAreas = areas.filter(area => area.value !== null);
          const unsetAreas = areas.filter(area => area.value === null);
          
          message.info(
            `已设置: ${setAreas.map(a => a.name).join('、') || '无'}\n` +
            `未设置: ${unsetAreas.map(a => a.name).join('、') || '无'}\n` +
            `分割线: ${globalSplitLines.length}条`,
            5
          );
          break;
        case 'clear':
          ocrActions.clearAll();
          break;
        case 'importTemplate':
          console.log('🎯 导入模板', event.detail.template);
          try {
            const template = event.detail.template;
            // 验证模板格式 - 检查是否至少有一个区域
            const hasAnyArea = template.materialArea || 
                              template.pipelineArea || 
                              template.pipeClassArea ||
                              template.drawingNumberArea || 
                              template.pageNumberArea || 
                              template.scaffoldArea ||
                              template.weldRecognitionArea;
            
            if (!hasAnyArea) {
              message.error('模板格式错误：模板中没有任何区域数据');
              return;
            }
            
            // 导入材料表区域（如果存在）
            if (template.materialArea) {
              setGlobalOcrRegion(template.materialArea);
              latestAreasRef.current.material = template.materialArea;
            } else {
              // 如果没有材料表区域，清空相关状态
              setGlobalOcrRegion(null);
              latestAreasRef.current.material = null;
            }
            
            // 导入其他区域（如果存在）
            if (template.pipelineArea) {
              setGlobalPipelineArea(template.pipelineArea);
              latestAreasRef.current.pipeline = template.pipelineArea;
            } else {
              setGlobalPipelineArea(null);
              latestAreasRef.current.pipeline = null;
            }
            if (template.pipeClassArea) {
              setGlobalPipeClassArea(template.pipeClassArea);
              latestAreasRef.current.pipeClass = template.pipeClassArea;
            } else {
              setGlobalPipeClassArea(null);
              latestAreasRef.current.pipeClass = null;
            }
            if (template.drawingNumberArea) {
              setGlobalDrawingNumberArea(template.drawingNumberArea);
              latestAreasRef.current.drawingNumber = template.drawingNumberArea;
            } else {
              setGlobalDrawingNumberArea(null);
              latestAreasRef.current.drawingNumber = null;
            }
            if (template.pageNumberArea) {
              setGlobalPageNumberArea(template.pageNumberArea);
              latestAreasRef.current.pageNumber = template.pageNumberArea;
            } else {
              setGlobalPageNumberArea(null);
              latestAreasRef.current.pageNumber = null;
            }
            if (template.scaffoldArea) {
              setGlobalScaffoldArea(template.scaffoldArea);
              latestAreasRef.current.scaffold = template.scaffoldArea;
            } else {
              setGlobalScaffoldArea(null);
              latestAreasRef.current.scaffold = null;
            }
            if (template.weldRecognitionArea) {
              setGlobalWeldRecognitionArea(template.weldRecognitionArea);
              latestAreasRef.current.weldRecognition = template.weldRecognitionArea;
            } else {
              setGlobalWeldRecognitionArea(null);
              latestAreasRef.current.weldRecognition = null;
            }
            
            // 导入分割线
            if (template.columns && Array.isArray(template.columns)) {
              const splitLines = template.columns.map((col, index) => ({
                x: col.x,
                id: `imported-${index}-${Date.now()}`
              }));
              setGlobalSplitLines(splitLines);
            }
            
            // 导入模板后不激活OCR状态，避免在PDF中显示区域信息
            // 模板数据已保存到全局状态，可用于OCR识别但不显示可视化区域
            
            // 更新模板状态
            setOcrState(prev => ({
              ...prev,
              isActive: true,
              mode: 'idle',
              dragState: {
                isDragging: false,
                startPoint: null
              },
              resizeState: {
                isResizing: false,
                handle: null,
                originalRegion: null,
                startPoint: null
              }
            }));
            setTemplateUploaded(true);
            
            // 触发模板导入事件，通知App.js
            window.dispatchEvent(new CustomEvent('template-imported', { detail: template }));
            
            console.log('🎯 模板导入完成');
            // 移除重复提示，由App.js统一处理
          } catch (error) {
            console.error('🎯 模板导入失败:', error);
            message.error('模板导入失败');
          }
          break;
        case 'startOCR':
          if (!file) {
            message.warning('请先加载PDF文件');
            return;
          }
          
          // 检查是否已导入模板（通过检查材料表区域是否存在）
          if (!globalOcrRegion) {
            message.warning('请先导入模板配置后再进行批量识别');
            return;
          }
          
          // 触发批量OCR识别事件，模板数据由App.js统一管理
          window.dispatchEvent(new CustomEvent('start-batch-ocr', { 
            detail: { engine: engine || 'paddleocr', pages: event.detail?.pages || null }
          }));
          break;
      }
    };

    window.addEventListener('ocr-action', handleOcrAction);
    return () => window.removeEventListener('ocr-action', handleOcrAction);
  }, [
    globalOcrRegion,
    globalSplitLines,
    globalPipelineArea,
    globalPipeClassArea,
    globalDrawingNumberArea,
    globalPageNumberArea,
    globalScaffoldArea,
    globalWeldRecognitionArea
  ]);

  // 组件卸载时保存材料编号
  useEffect(() => {
    return () => {
      // 在cleanup时从DOM直接读取最新值，避免依赖状态导致频繁更新
      if (document.getElementById('material-input-1') && document.getElementById('material-input-2')) {
        const input1 = document.getElementById('material-input-1');
        const input2 = document.getElementById('material-input-2');
        const currentValue1 = input1?.value || '';
        const currentValue2 = input2?.value || '';
        
        if ((currentValue1 || currentValue2) && pendingAnnotation && onAnnotationUpdate) {
          const materialNumber = currentValue1 && currentValue2 ? `${currentValue1}-${currentValue2}` : 
                                currentValue1 || currentValue2;
          onAnnotationUpdate(pendingAnnotation.id, { materialNumber });
        }
      }
    };
  }, []); // 移除所有依赖，只在组件卸载时执行



  // 添加一个状态来强制OCR区域重新渲染
  const [ocrRenderKey, setOcrRenderKey] = useState(0);
  
  // 当scale、viewOffset变化时强制OCR区域重新渲染
  useEffect(() => {
    if (ocrState.isActive) {
      setOcrRenderKey(prev => prev + 1);
      // 延迟获取Canvas几何信息，确保Canvas已经渲染完成
      const timer = setTimeout(() => {
        const geometry = ocrUtils.getCanvasGeometry();
        setCanvasGeometry(geometry);
      }, 50); // 减少延迟时间以提高响应速度
      return () => clearTimeout(timer);
    } else {
      setCanvasGeometry(null);
    }
  }, [scale, ocrState.isActive, currentPage, viewOffset]); // 添加viewOffset监听

  // OCR核心功能函数
  // 已移动到上方初始化 (ocrUtils)
  
  // OCR操作函数
  const ocrActions = {
    // 开始区域选择
    startRegionSelection: () => {
      setOcrState(prev => ({
        ...prev,
        isActive: true,
        mode: 'selecting'
      }));
      message.info('请在PDF上拖拽框选材料表区域');
    },

    // 进入分割线模式
    enterSplitLineMode: (regionOverride = null) => {
      const currentRegion = regionOverride || globalOcrRegion;
      console.log('🎯 进入分割线模式，当前globalOcrRegion:', globalOcrRegion, '传入区域:', regionOverride, '使用区域:', currentRegion);
      if (!currentRegion) {
        message.warning('请先绘制材料表区域');
        console.log('🎯 没有可用区域，无法进入分割线模式');
        return;
      }
      
      // 如果传入了区域覆盖参数，强制更新全局区域状态
      if (regionOverride) {
        console.log('🎯 强制更新globalOcrRegion为传入区域:', regionOverride);
        setGlobalOcrRegion(regionOverride);
      }
      
      setOcrState(prev => ({
        ...prev,
        isActive: true,
        mode: 'splitLine'
      }));
      message.info('单击添加分割线 | 拖拽移动 | 右键删除');
    },

    // 清空所有OCR数据
    clearAll: () => {
      console.log('🧹 clearAll被调用，清空所有绘制区域');
      console.log('🧹 清空前的globalSplitLines:', globalSplitLines);
      setGlobalOcrRegion(null);
      setGlobalSplitLines([]);
      setGlobalOcrResults([]);
      // 清空所有区域，回到初始空白状态
      setGlobalPipelineArea(null);
      setGlobalPipeClassArea(null);
      setGlobalDrawingNumberArea(null);
      setGlobalPageNumberArea(null);
      setGlobalScaffoldArea(null);
      setGlobalWeldRecognitionArea(null);
      // 同时清空ref
      latestAreasRef.current = {
        material: null,
        pipeline: null,
        pipeClass: null,
        drawingNumber: null,
        pageNumber: null,
        scaffold: null,
        weldRecognition: null
      };
      setOcrAreaTarget('material');
      
      // 清空模板状态，恢复到初始状态
      setTemplateUploaded(false);

      // 触发模板清除事件，通知App.js
      window.dispatchEvent(new CustomEvent('template-cleared'));
      
      setOcrState(prev => ({
        ...prev,
        isActive: false,
        mode: 'idle',
        dragState: {
          isDragging: false,
          startPoint: { x: 0, y: 0 },
          currentPoint: { x: 0, y: 0 }
        },
        resizeState: {
          isResizing: false,
          handle: null,
          startPoint: { x: 0, y: 0 },
          originalRegion: null
        },
        results: {
          visible: false,
          materials: []
        }
      }));
      message.success('已清空所有绘制区域');
    },

    // 保存模板
    saveTemplate: () => {
      console.log('🎯 saveTemplate被调用');
      console.log('🎯 当前globalOcrRegion:', globalOcrRegion);
      console.log('🎯 当前globalSplitLines:', globalSplitLines);
      console.log('🎯 globalSplitLines长度:', globalSplitLines.length);
      console.log('🎯 当前globalPipelineArea:', globalPipelineArea);
      console.log('🎯 当前globalPipeClassArea:', globalPipeClassArea);
      console.log('🎯 当前globalPageNumberArea:', globalPageNumberArea);
      console.log('🎯 当前globalDrawingNumberArea:', globalDrawingNumberArea);

      // 构建模板数据 - 使用ref中的最新值，避免状态异步更新问题
      const currentPageNumber = currentPage || 1;
      const withPage = (area) => {
        console.log('🎯 withPage处理区域:', area);
        return area ? { ...area, page: currentPageNumber } : null;
      };
      
      // 使用最新的区域数据（优先使用ref，回退到状态）
      const currentPipelineArea = latestAreasRef.current.pipeline || globalPipelineArea;
      const currentPipeClassArea = latestAreasRef.current.pipeClass || globalPipeClassArea;
      const currentDrawingNumberArea = latestAreasRef.current.drawingNumber || globalDrawingNumberArea;
      const currentPageNumberArea = latestAreasRef.current.pageNumber || globalPageNumberArea;
      const currentScaffoldArea = latestAreasRef.current.scaffold || globalScaffoldArea;
      const currentWeldRecognitionArea = latestAreasRef.current.weldRecognition || globalWeldRecognitionArea;
      
      // 检查是否至少有一个区域被设置
      const hasAnyArea = globalOcrRegion || 
                        currentPipelineArea || 
                        currentPipeClassArea ||
                        currentDrawingNumberArea || 
                        currentPageNumberArea || 
                        currentScaffoldArea ||
                        currentWeldRecognitionArea;
      
      if (!hasAnyArea) {
        message.warning('请至少绘制一个区域（材料表、管线号、图号、页码、支架或焊点区域）');
        return;
      }
      
      console.log('🎯 【使用最新区域数据】');
      console.log('🎯 currentPipelineArea:', currentPipelineArea);
      console.log('🎯 currentDrawingNumberArea:', currentDrawingNumberArea);
      console.log('🎯 currentPageNumberArea:', currentPageNumberArea);
      
      const template = {
        materialArea: globalOcrRegion ? withPage({
          x: globalOcrRegion.x,
          y: globalOcrRegion.y,
          width: globalOcrRegion.width,
          height: globalOcrRegion.height
        }) : null,
        pipelineArea: withPage(currentPipelineArea),
        pipeClassArea: withPage(currentPipeClassArea),
        pageNumberArea: withPage(currentPageNumberArea),
        drawingNumberArea: withPage(currentDrawingNumberArea),
        scaffoldArea: withPage(currentScaffoldArea),
        weldRecognitionArea: withPage(currentWeldRecognitionArea),
        columns: globalSplitLines.map((line, index) => ({
          x: line.x,
          page: currentPageNumber
        }))
      };
      
      console.log('🎯 构建的模板数据:', template);

      // 额外检查：如果有区域为null，给出警告
      const missingAreas = [];
      if (!template.pipelineArea) missingAreas.push('管线号区域');
      if (!template.pageNumberArea) missingAreas.push('页码区域');
      if (!template.drawingNumberArea) missingAreas.push('图号区域');
      
      if (missingAreas.length > 0) {
        console.warn('🚨 以下区域未设置:', missingAreas.join('、'));
        message.warning(`以下区域未设置：${missingAreas.join('、')}。如果需要，请先绘制相应区域。`);
      }

      // 生成文件名
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `template_${timestamp}.json`;

      // 创建下载链接
      const dataStr = JSON.stringify(template, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(dataBlob);
      
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      message.success(`模板已保存为 ${filename}`);
      console.log('🎯 保存的模板数据:', template);
    },

    // 添加分割线
    addSplitLine: (canvasX) => {

      
      if (!globalOcrRegion) {

        return;
      }
      
      // 将Canvas像素坐标转换为相对坐标
      const canvasGeometry = ocrUtils.getCanvasGeometry();
      if (!canvasGeometry) {

        return;
      }
      
      // 获取实际宽度（使用统一的内部尺寸属性）
      const actualWidth = canvasGeometry.internalWidth || canvasGeometry.rect.width;
      const relativeX = canvasX / actualWidth;
      
      // 检查X坐标是否在区域内（使用相对坐标）
      if (relativeX >= globalOcrRegion.x && relativeX <= globalOcrRegion.x + globalOcrRegion.width) {
        const newLine = {
          x: relativeX,
          id: ocrUtils.generateId()
        };

        setGlobalSplitLines(prev => {
          const updated = [...prev, newLine];
          publishCurrentTemplate({ splitLines: updated });
          return updated;
        });
        

        
        message.success('已添加分割线');
      } else {

        message.warning('请在材料表区域内添加分割线');
      }
    },

    // 删除分割线
    removeSplitLine: (lineId) => {
      setGlobalSplitLines(prev => {
        const updated = prev.filter(line => line.id !== lineId);
        publishCurrentTemplate({ splitLines: updated });
        return updated;
      });
    },

    // 更新分割线位置
    updateSplitLineX: (lineId, newRelativeX) => {
      setGlobalSplitLines(prev => {
        const updated = prev.map(line =>
          line.id === lineId ? { ...line, x: newRelativeX } : line
        );
        publishCurrentTemplate({ splitLines: updated });
        return updated;
      });
    },

    // 更新区域
    updateRegion: (newRegion) => {
      setGlobalOcrRegion(newRegion);
      latestAreasRef.current.material = newRegion;
      publishCurrentTemplate({ material: newRegion });
    },

    // 开始拖拽
    startDrag: (point) => {
      console.log('🖱️ 开始拖拽，起始点:', point);
      setOcrState(prev => {
        const newState = {
          ...prev,
          dragState: {
            isDragging: true,
            startPoint: point,
            currentPoint: point
          }
        };
        console.log('🖱️ 拖拽状态已更新:', newState.dragState);
        return newState;
      });
    },

    // 更新拖拽
    updateDrag: (point) => {
      console.log('🖱️ 更新拖拽位置:', point);
      setOcrState(prev => {
        const newState = {
          ...prev,
          dragState: {
            ...prev.dragState,
            currentPoint: point
          }
        };
        console.log('🖱️ 拖拽状态更新:', newState.dragState);
        return newState;
      });
    },

    // 结束拖拽
    endDrag: (endPoint) => {
      console.log('🖱️ endDrag被调用，结束点:', endPoint);
      console.log('🖱️ 当前OCR状态:', { mode: ocrState.mode, isDragging: ocrState.dragState.isDragging });
      if (ocrState.mode === 'selecting' && ocrState.dragState.isDragging) {
        const newRegion = ocrUtils.calculateRect(
          ocrState.dragState.startPoint,
          endPoint || ocrState.dragState.currentPoint
        );
        console.log('🖱️ 计算的新区域:', newRegion);
        
        // 只有当区域足够大时才创建
        // 对"管线号/图号/页码"等小字段区域放宽阈值；材料表保持更高阈值
        const isSmallFieldTarget = (ocrAreaTarget === 'pipeline' || ocrAreaTarget === 'pipeClass' || ocrAreaTarget === 'drawingNumber' || ocrAreaTarget === 'pageNumber' || ocrAreaTarget === 'weldRecognition');
        const minSizePx = isSmallFieldTarget ? 1 : 6;
        if (newRegion.width > minSizePx && newRegion.height > minSizePx) {
          console.log('🖱️ 区域足够大，创建OCR区域');
          
          // 将Canvas像素坐标转换为相对坐标（0-1之间的比例）
          const canvasGeometry = ocrUtils.getCanvasGeometry();
          if (canvasGeometry) {
            // 获取实际宽高（使用统一的内部尺寸属性，避免 SVG 模式下的问题）
            const actualWidth = canvasGeometry.internalWidth || canvasGeometry.rect.width;
            const actualHeight = canvasGeometry.internalHeight || canvasGeometry.rect.height;
            
            const relativeRegion = {
              x: newRegion.x / actualWidth,
              y: newRegion.y / actualHeight,
              width: newRegion.width / actualWidth,
              height: newRegion.height / actualHeight
            };
            console.log('🖱️ 相对坐标区域:', relativeRegion);
            
            // 根据目标类型保存到对应区域
            if (ocrAreaTarget === 'pipeline') {
              console.log('🎯 设置管线号区域:', relativeRegion);
              setGlobalPipelineArea(relativeRegion);
              publishCurrentTemplate({ pipeline: relativeRegion });
              latestAreasRef.current.pipeline = relativeRegion; // 同时更新ref
              message.success('已设置管线号区域');
            } else if (ocrAreaTarget === 'pipeClass') {
              console.log('🎯 设置管道等级区域:', relativeRegion);
              setGlobalPipeClassArea(relativeRegion);
              publishCurrentTemplate({ pipeClass: relativeRegion });
              latestAreasRef.current.pipeClass = relativeRegion;
              message.success('已设置管道等级区域');
            } else if (ocrAreaTarget === 'drawingNumber') {
              console.log('🎯 设置图号区域:', relativeRegion);
              setGlobalDrawingNumberArea(relativeRegion);
              publishCurrentTemplate({ drawingNumber: relativeRegion });
              latestAreasRef.current.drawingNumber = relativeRegion; // 同时更新ref
              message.success('已设置图号区域');
            } else if (ocrAreaTarget === 'pageNumber') {
              console.log('🎯 设置页码区域:', relativeRegion);
              setGlobalPageNumberArea(relativeRegion);
              publishCurrentTemplate({ pageNumber: relativeRegion });
              latestAreasRef.current.pageNumber = relativeRegion; // 同时更新ref
              message.success('已设置页码区域');
            } else if (ocrAreaTarget === 'scaffold') {
              console.log('🎯 设置支架区域:', relativeRegion);
              setGlobalScaffoldArea(relativeRegion);
              publishCurrentTemplate({ scaffold: relativeRegion });
              latestAreasRef.current.scaffold = relativeRegion; // 同时更新ref
              message.success('已设置支架区域');
            } else if (ocrAreaTarget === 'weldRecognition') {
              console.log('🎯 设置焊点识别区域:', relativeRegion);
              setGlobalWeldRecognitionArea(relativeRegion);
              latestAreasRef.current.weldRecognition = relativeRegion;
              message.success('已设置焊点识别区域');
            } else {
              // 默认材料表区域
              console.log('🖱️ 设置globalOcrRegion:', relativeRegion);
              setGlobalOcrRegion(relativeRegion);
              latestAreasRef.current.material = relativeRegion;
              publishCurrentTemplate({ material: relativeRegion });
              message.success('已设置材料表区域');
              // 使用更长的延迟确保状态更新完成，然后进入分割线模式
              setTimeout(() => {
                ocrActions.enterSplitLineMode(relativeRegion);
              }, 200);
            }
            
            setOcrState(prev => ({
              ...prev,
              isActive: true, // 确保保持激活状态以显示区域
              mode: 'idle',
              dragState: {
                isDragging: false,
                startPoint: { x: 0, y: 0 },
                currentPoint: { x: 0, y: 0 }
              }
            }));
            
            
          }
        } else {
          console.log('🖱️ 区域太小，不创建OCR区域');
          message.warning(isSmallFieldTarget ? '所选区域太小或为零，请重新框选' : '材料表区域太小，请适当放大再选择');
          setOcrState(prev => ({
            ...prev,
            mode: 'idle',
            dragState: {
              isDragging: false,
              startPoint: { x: 0, y: 0 },
              currentPoint: { x: 0, y: 0 }
            }
          }));
        }
      }
    },

    // 开始调整大小
    startResize: (handle, point, region) => {
      setOcrState(prev => ({
        ...prev,
        mode: 'resizing',
        resizeState: {
          isResizing: true,
          handle,
          startPoint: point,
          originalRegion: { ...region }
        }
      }));
    },

    // 更新调整大小
    updateResize: (currentPoint) => {
      if (!ocrState.resizeState.isResizing || !ocrState.resizeState.originalRegion) return;
      
      const { handle, startPoint, originalRegion } = ocrState.resizeState;
      
      // 获取Canvas几何信息进行坐标转换
      const canvasGeometry = ocrUtils.getCanvasGeometry();
      if (!canvasGeometry) return;
      
      // 获取实际宽高（使用统一的内部尺寸属性）
      const actualWidth = canvasGeometry.internalWidth || canvasGeometry.rect.width;
      const actualHeight = canvasGeometry.internalHeight || canvasGeometry.rect.height;
      
      // 将Canvas像素差值转换为相对差值
      const deltaX = (currentPoint.x - startPoint.x) / actualWidth;
      const deltaY = (currentPoint.y - startPoint.y) / actualHeight;
      
      let newRegion = { ...originalRegion };
      
      // 根据手柄类型调整区域（使用相对坐标）
      switch (handle) {
        case 'nw':
          newRegion.x += deltaX;
          newRegion.y += deltaY;
          newRegion.width -= deltaX;
          newRegion.height -= deltaY;
          break;
        case 'ne':
          newRegion.y += deltaY;
          newRegion.width += deltaX;
          newRegion.height -= deltaY;
          break;
        case 'sw':
          newRegion.x += deltaX;
          newRegion.width -= deltaX;
          newRegion.height += deltaY;
          break;
        case 'se':
          newRegion.width += deltaX;
          newRegion.height += deltaY;
          break;
        case 'n':
          newRegion.y += deltaY;
          newRegion.height -= deltaY;
          break;
        case 's':
          newRegion.height += deltaY;
          break;
        case 'w':
          newRegion.x += deltaX;
          newRegion.width -= deltaX;
          break;
        case 'e':
          newRegion.width += deltaX;
          break;
      }
      
      // 确保最小尺寸
      if (newRegion.width < 20) {
        if (handle.includes('w')) {
          newRegion.x = originalRegion.x + originalRegion.width - 20;
        }
        newRegion.width = 20;
      }
      if (newRegion.height < 20) {
        if (handle.includes('n')) {
          newRegion.y = originalRegion.y + originalRegion.height - 20;
        }
        newRegion.height = 20;
      }
      
      setGlobalOcrRegion(newRegion);
    },

    // 结束调整大小
    endResize: () => {
      setOcrState(prev => ({
        ...prev,
        mode: 'idle',
        resizeState: {
          isResizing: false,
          handle: null,
          startPoint: { x: 0, y: 0 },
          originalRegion: null
        }
      }));
    },


  };





  // 解析材料表（结构化）



  // 工具函数现在由 usePDFUtils Hook 提供

  // 修正区域OCR：使用新的材料表OCR服务
  // 修正区域OCR：使用新的材料表OCR服务
  const performRegionOCR = useCallback(async (region) => {
    if (!region) {
      message.warning('请先框选材料表区域');
      if (onMaterialRowsChange) {
        onMaterialRowsChange([], [], currentPage);
      }
      return;
    }
    setOcrState(prev => ({ ...prev, isProcessing: true }));
    try {
      const geo = ocrUtils.getCanvasGeometry();
      if (!geo) {
        console.error('无法获取Canvas几何信息');
        return;
      }
      const canvas = geo.element; // Use element (canvas or svg or container)
      
      // 获取分割线信息
      const splitLines = globalSplitLines || [];
      
      // 使用新的材料表OCR服务
      const ocrResult = await callPaddleOCR(canvas, {
        type: 'material',
        isMaterialTable: true,
        region: region,
        splitLines: splitLines
      });
      
      // 处理OCR结果 - 适配新的后端数据格式
      let materials = [];
      let rawLogicalRows = [];
      const cellText = (cell) => {
        if (cell && typeof cell === 'object') return cell.text || '';
        return cell || '';
      };
      const rowToMaterial = (row, index) => {
        if (Array.isArray(row)) {
          return {
            key: index + 1,
            搴忓彿: row[0] || index + 1,
            鏉愭枡鎻忚堪: row[1] || '',
            瑙勬牸: row[2] || '',
            鏉愭枡浠ｇ爜: row[3] || '',
            鏁伴噺: row[4] || '',
            鍗曚綅: row[5] || '',
            绫诲瀷: row[6] || ''
          };
        }
        return {
          key: index + 1,
          搴忓彿: cellText(row?.column1) || index + 1,
          鏉愭枡鎻忚堪: cellText(row?.column2),
          瑙勬牸: cellText(row?.column3),
          鏉愭枡浠ｇ爜: cellText(row?.column4),
          鏁伴噺: cellText(row?.column5),
          鍗曚綅: cellText(row?.column6),
          绫诲瀷: cellText(row?.column7)
        };
      };
      
      if (ocrResult && Array.isArray(ocrResult.logical_rows) && ocrResult.logical_rows.length > 0) {
        const logicalRows = ocrResult.logical_rows;
        if (Array.isArray(logicalRows[0])) {
          rawLogicalRows = logicalRows;
        } else {
          const pageObj = logicalRows[0] || {};
          rawLogicalRows = Array.isArray(pageObj.material)
            ? pageObj.material.map((rowObj, index) => [
                cellText(rowObj?.column1) || index + 1,
                cellText(rowObj?.column2),
                cellText(rowObj?.column3),
                cellText(rowObj?.column4),
                cellText(rowObj?.column5),
                cellText(rowObj?.column6),
                cellText(rowObj?.column7)
              ])
            : [];
        }
        materials = rawLogicalRows.map(rowToMaterial);
      } else if (ocrResult && ocrResult.material && ocrResult.material.length > 0) {
        // 使用新的结构化材料数据格式
        materials = ocrResult.material.map((materialRow, index) => {
          const result = {
            key: index + 1,
            序号: index + 1
          };

          // 处理动态列数据
          Object.keys(materialRow).forEach((columnKey, colIndex) => {
            if (columnKey.startsWith('column')) {
              const columnData = materialRow[columnKey];
              const text = columnData.text || '';

              // 根据列索引映射到固定字段名
              switch (colIndex) {
                case 0:
                  result.序号 = text || index + 1;
                  break;
                case 1:
                  result.材料描述 = text;
                  break;
                case 2:
                  result.规格 = text;
                  break;
                case 3:
                  result.材料代码 = text;
                  break;
                case 4:
                  result.数量 = text;
                  break;
                case 5:
                  result.单位 = text;
                  break;
                case 6:
                  result.类型 = text;
                  break;
                default:
                  // 处理额外的列
                  result[`列${colIndex + 1}`] = text;
                  break;
              }
            }
          });

          return result;
        });

        // 转换为logical_rows格式（向后兼容）
        rawLogicalRows = materials.map((item, index) => [
          item.序号 || index + 1,
          item.材料描述 || '',
          item.规格 || '',
          item.材料代码 || '',
          item.数量 || '',
          item.单位 || '',
          item.类型 || ''
        ]);
      } else if (ocrResult && ocrResult.text) {
        // 如果没有结构化数据，使用文本解析
        materials = parseMaterialTableStructured(ocrResult.text);
        // 转换为logical_rows格式
        rawLogicalRows = materials.map((item, index) => [
          item.序号 || index + 1,
          item.材料描述 || (typeof item.text === 'string' ? item.text : (item.text?.text || '')) || '',
          item.规格 || '',
          item.材料代码 || '',
          item.数量 || '',
          item.单位 || '',
          item.类型 || ''
        ]);
      } else {
        // OCR结果为空或无效
        console.warn('OCR结果为空或无效:', ocrResult);
        if (onMaterialRowsChange) {
          onMaterialRowsChange([], [], currentPage);
        }
        message.warning('OCR识别结果为空，请检查选择区域是否包含有效内容');
        return;
      }
      
      setOcrState(prev => ({ 
        ...prev, 
        results: { visible: true, materials, rawLogicalRows }
      }));

      if (onMaterialRowsChange) {
        onMaterialRowsChange(materials, rawLogicalRows, currentPage);
      }
      
      // 自动导出Excel（使用原始logical_rows数据）
      auditLogService.log('material_table_recognize', {
        pdfFileName: file?.name || '',
        page: currentPage,
        count: 1,
        pages: [currentPage],
        recognizedRows: materials.length,
        recognitionResults: [{
          page: currentPage,
          materials,
          rawLogicalRows
        }]
      });

      if (rawLogicalRows.length > 0) {
        exportToExcel(rawLogicalRows);
      }
      
      message.success(`识别完成！共处理 ${materials.length} 行数据，Excel文件已自动导出`);
    } catch (error) {
      console.error('OCR处理失败:', error);
      message.error('OCR处理失败: ' + error.message);
    } finally {
      setOcrState(prev => ({ ...prev, isProcessing: false }));
    }
  }, [ocrUtils, callPaddleOCR, parseMaterialTableStructured, globalSplitLines, onMaterialRowsChange, currentPage, file]);






  // 🆕 处理全局高亮标注
  const handleGlobalHighlightedAnnotations = useCallback(() => {
    console.log('🖱️ [PDFViewer] handleGlobalHighlightedAnnotations 被调用');
    // 使用 selectedDetectionIndices (通过 props 或 context 获取)
    // 这里我们从 ocrState 中获取，因为上下文已经在组件中解构
    const currentSelectedIndices = ocrState.selectedDetectionIndices;

    console.log('🔍 状态检查:', {
      hasOnBatchAdd: !!onBatchAddScaffoldAnnotations,
      hasSelectedIndices: !!currentSelectedIndices,
      indicesContent: currentSelectedIndices
    });

    if (!onBatchAddScaffoldAnnotations || !currentSelectedIndices) {
      console.warn('⚠️ [PDFViewer] 全局标注中止：缺少必要条件');
      return;
    }
    
    const allSelectedIndices = currentSelectedIndices;
    let globalAnnotations = [];
    let globalCount = 0;
    
    // 遍历所有页面的选中项
    Object.entries(allSelectedIndices).forEach(([page, indices]) => {
      const pageNum = parseInt(page, 10);
      if (indices.size === 0) return;
      
      // 获取该页面的检测数据（优先从缓存获取）
      const pageData = getPageRecognitionData(pageNum);
      if (!pageData || !pageData.detections) return;
      
      // 获取选中项
      const selectedDetections = pageData.detections.filter((_, index) => indices.has(index));
      
      // 对该页面的选中项排序（从上到下，从左到右）
      selectedDetections.sort((a, b) => {
        const yA = a.box[0][1];
        const yB = b.box[0][1];
        if (Math.abs(yA - yB) < 0.005) {
          return a.box[0][0] - b.box[0][0];
        }
        return yA - yB;
      });
      
      // 生成标注数据
      const pageAnnotations = selectedDetections.map((detection) => {
        globalCount++;
        // 计算中心点
        const centerX = detection.box[0][0] + (detection.box[1][0] - detection.box[0][0]) / 2;
        const centerY = detection.box[0][1] + (detection.box[2][1] - detection.box[0][1]) / 2;
        
        // 生成连续编号 V1, V2...
        const seqText = `V${globalCount}`;
        
        return {
          page: pageNum,
          info: {
            text: seqText,
            originalText: detection.text,
            x: centerX,
            y: centerY,
            detection: detection,
            isValve: true,
            isManualSelection: true
          }
        };
      });
      
      globalAnnotations = [...globalAnnotations, ...pageAnnotations];
    });
    
    if (globalAnnotations.length > 0) {
      console.log(`🌍 [PDFViewer] 执行全局高亮标注，共 ${globalAnnotations.length} 项`);
      onBatchAddScaffoldAnnotations(globalAnnotations, 'global'); // 传递特殊标记 'global'
      
      // 清除所有选中状态
      setOcrState(prev => ({
        ...prev,
        selectedDetectionIndices: {}
      }));
      
      message.success(`已为所有页面添加 ${globalAnnotations.length} 个标注`);
    } else {
      message.info('没有选中的高亮框');
    }
  }, [onBatchAddScaffoldAnnotations, ocrState.selectedDetectionIndices, pageRecognitionData, setOcrState]);

  // 监听来自Toolbar的全局标注事件
  useEffect(() => {
    const handleGlobalAnnotationEvent = (event) => {
      console.log('👂 [PDFViewer] 收到 ocr-global-annotation 事件:', event.detail);
      if (event.detail?.action === 'annotateHighlighted') {
        handleGlobalHighlightedAnnotations();
      }
    };
    
    window.addEventListener('ocr-global-annotation', handleGlobalAnnotationEvent);
    
    return () => {
      window.removeEventListener('ocr-global-annotation', handleGlobalAnnotationEvent);
    };
  }, [handleGlobalHighlightedAnnotations]);

  // 从 textDetections 派生指定页的文字区域（PDF 原始坐标），供碰撞算法使用
  const getPageTextRegions = (pageNum, detections) => {
    const data = detections[pageNum];
    if (!data?.detections?.length || !data?.page_info) return null;
    const pi = data.page_info;
    const pw = pi.page_width || pi.width || 0;
    const ph = pi.page_height || pi.height || 0;
    if (!pw || !ph) return null;
    return ObjectRecognizer.convertOCRDetectionsToTextRegions(
      data.detections, { width: pw, height: ph }
    );
  };

  // 转换焊点编号为标注
  const handleConvertWeldsToAnnotations = useCallback(() => {
    const hasBatchWelds = multiPageNumberPreview && multiPageNumberWelds.length > 0;
    if ((!displayedWelds || displayedWelds.length === 0) && !hasBatchWelds) {
      message.warning('当前没有识别到焊点，无法生成编号');
      return;
    }

    const hasManualWeldInsertions = (multiPageNumberWelds || []).some(weld => weld?.isManualInserted);
    if (!reopenedPdfSupplementMode && !numberingSegments.length && !hasManualWeldInsertions) {
      message.warning('请先按“起点→终点”的顺序至少添加一段编号范围');
      return;
    }

    console.log('📝 使用多段起止 Path ID 编号顺序生成标注');
    console.log(`   编号段数: ${numberingSegments.length}`);
    console.log(`   焊点总数: ${orderedNumberingWelds.length}`);

    if (multiPageNumberPreview && multiPageNumberWelds.length > 0) {
      const pendingBatchRule = multiPageBatchService.getPendingBatchAnnotationRule() || activeAnnotationRule;
      const correctedWelds = rebuildStableMultiPageSequence(false);
      const adjustmentDelta = reopenedPdfSupplementMode
        ? buildWeldAdjustmentDelta({
          originalWelds: reopenedOriginalWeldsRef.current,
          currentWelds: correctedWelds
        })
        : { welds: correctedWelds };
      const weldsToGenerate = adjustmentDelta.welds;

      if (!weldsToGenerate.length) {
        message.info('编号和焊点没有变化，无需生成标注');
        return;
      }

      // 冻结蓝圈阶段最终确认的编号快照。红色预览和最终写入均只使用这份快照，
      // 后续翻页、识别刷新或父状态回显不得再次改变编号。
      setMultiPageNumberWelds(correctedWelds);
      multiPageBatchService.setCorrectedNumberedWelds(weldsToGenerate);
      const correctedAnnotations = multiPageBatchService.convertWeldsToAnnotations(
        scale,
        pendingBatchRule,
        'KEEP_ORDER',
        null,
        {
          weldRecognitionArea: latestAreasRef.current.weldRecognition || globalWeldRecognitionArea,
          pageVectors,
          pageTextDetections: textDetections
        }
      );
      // Keep the complete all-page sequence in memory for subsequent inserts;
      // only the generated preview/commit payload is differential.
      multiPageBatchService.setCorrectedNumberedWelds(correctedWelds);

      if (!correctedAnnotations.length) {
        message.warning('多段修正后未能生成标注，请检查所选区段');
        return;
      }
      numberingPreviewReturnModeRef.current = manualWeldInsertMode
        ? 'insert'
        : manualWeldDeleteMode ? 'delete' : 'idle';
      setPendingNumberingAnnotations(correctedAnnotations);
      setManualWeldInsertMode(false);
      setManualWeldDeleteMode(false);
      setIsWeldStartPickMode(false);
      message.success(`已生成 ${correctedAnnotations.length} 个标注预览，请确认后再正式生成`);
      return;
    }

    {
      const normalizePipelineForNumbering = (value) => normalizeNumberingPipeline(value);
      const getPagePipelineForNumbering = getNumberingPagePipelineNumber;
      const currentPipelineNumber = getPagePipelineForNumbering(currentPage, displayedWelds);
      const scopedNumberingSegments = numberingSegments.map(segment => ({
        ...segment,
        pipelineNumber: normalizePipelineForNumbering(segment.pipelineNumber) ||
          getPagePipelineForNumbering(segment.page || currentPage)
      }));
      const scopedPipelineNumbers = Array.from(new Set(
        scopedNumberingSegments
          .map(segment => normalizePipelineForNumbering(segment.pipelineNumber))
          .filter(Boolean)
      ));
      const startNum = activeAnnotationRule
        ? resolvePipelineScopedStartNumber(activeAnnotationRule, currentPipelineNumber)
        : 1;
      const increment = activeAnnotationRule ? (activeAnnotationRule.increment !== undefined ? activeAnnotationRule.increment : 1) : 1;
      const servicePageWelds = multiPageBatchService.pageWelds || {};
      const servicePageTexts = multiPageBatchService.pageTextDetections || {};
      const sourcePages = scopedNumberingSegments
        .map(segment => Number(segment.page || currentPage))
        .filter(Boolean);
      const candidatePages = Array.from(new Set([
        ...sourcePages,
        ...Object.keys(servicePageWelds).map(Number).filter(Boolean),
        ...Object.keys(servicePageTexts).map(Number).filter(Boolean),
        ...Object.keys(pageVectors || {}).map(Number).filter(Boolean),
        ...multiPageNumberWelds.map(weld => Number(weld.page || weld.pageNum)).filter(Boolean)
      ])).sort((a, b) => a - b);
      const targetPages = candidatePages.filter(pageNum => {
        return sourcePages.includes(Number(pageNum));
      });

      let nextNumber = startNum;
      const newAnnotations = [];

      targetPages.forEach((pageNum) => {
        const pageWelds = getNumberingWeldsForPage(pageNum);
        const pageSegments = scopedNumberingSegments.filter(segment => (
          Number(pageNum) === Number(segment.page || currentPage)
        ));
        const hasSegmentStoredWelds = pageSegments.some(segment => (
          Array.isArray(segment?.sourceRangeWelds) && segment.sourceRangeWelds.length > 0
        ));
        if ((!pageWelds || pageWelds.length === 0) && !hasSegmentStoredWelds) return;

        const pagePipelineNumber = getPagePipelineForNumbering(pageNum, pageWelds) || currentPipelineNumber;

        const seenWeldKeys = new Set();
        const orderedWeldsForPage = [];
        pageSegments.forEach(segment => {
          const range = getNumberingSegmentRangeForPage(segment, pageNum, pageWelds);
          range.forEach(weld => {
            const key = getPageAwareWeldSelectionKey(weld, pageNum);
            if (!key || seenWeldKeys.has(key)) return;
            seenWeldKeys.add(key);
            orderedWeldsForPage.push(weld);
          });
        });
        if (!orderedWeldsForPage || orderedWeldsForPage.length === 0) {
          console.warn(`第 ${pageNum} 页未能生成焊点编号，已跳过`);
          return;
        }

        const numberlessWeldKeys = getNumberlessWeldKeysForPage(pageSegments, pageWelds);
        const forcedStartByKey = new Map();
        pageSegments.forEach((segment) => {
          if (isNumberingSegmentHidden(segment)) return;
          const targetStartNumber = getSegmentTargetStartNumber(segment);
          if (targetStartNumber === null) return;
          const firstNumberedWeld = getNumberingSegmentRangeForPage(
            segment,
            pageNum,
            pageWelds
          ).find(weld => !numberlessWeldKeys.has(getWeldSelectionKey(weld)));
          const firstKey = getWeldSelectionKey(firstNumberedWeld);
          if (firstKey) forcedStartByKey.set(firstKey, targetStartNumber);
        });
        const numberedWeldsForPage = orderedWeldsForPage.filter(
          weld => !numberlessWeldKeys.has(getWeldSelectionKey(weld))
        );
        if (numberedWeldsForPage.length === 0) return;

        const pageLayoutData = calculateWeldLayout(
          numberedWeldsForPage,
          PDF_LAYOUT_BASE_SCALE,
          'KEEP_ORDER',
          undefined,
          undefined,
          getPageTextRegions(pageNum, textDetections),
          {
            normalizedPlacementArea: latestAreasRef.current.weldRecognition || globalWeldRecognitionArea,
            graphicVectors: pageVectors[pageNum] || [],
            circleDiameter: annotationFrameSize || 56.7,
            allowLeaderThroughGraphics: true,
            allowLeaderCrossing: false
          }
        );

        pageLayoutData.forEach((item, index) => {
          const forcedStart = forcedStartByKey.get(getWeldSelectionKey(item));
          if (Number.isFinite(forcedStart)) {
            nextNumber = forcedStart;
          }
          let text = String(nextNumber);
          if (activeAnnotationRule) {
            const prefix = activeAnnotationRule.prefix || '';
            const suffix = activeAnnotationRule.suffix || '';
            text = `${prefix}${nextNumber}${suffix}`;
          }
          const scaledFontSize = scaleAnnotationValue(annotationFontSize || 34, pageSize, 34);
          const scaledTopFontSize = scaleAnnotationValue(annotationTopFontSize || annotationFontSize || 34, pageSize, scaledFontSize);
          const scaledBottomFontSize = scaleAnnotationValue(annotationBottomFontSize || annotationFontSize || 34, pageSize, scaledFontSize);
          const scaledFrameSize = annotationFrameSize || 56.7;

          newAnnotations.push({
            id: Date.now() + Math.random().toString(36).substr(2, 9) + `${pageNum}-${index}`,
            page: pageNum,
            type: 'text',
            startX: item.startX,
            startY: item.startY,
            endX: item.endX,
            endY: item.endY,
            text,
            color: '#ff0000',
            fontSize: scaledFontSize,
            topFontSize: scaledTopFontSize,
            bottomFontSize: scaledBottomFontSize,
            frameSize: scaledFrameSize,
            borderShape: 'circle',
            hasLeaderLine: true,
            remark: activeAnnotationRule?.remark || '批量自动生成',
            ruleId: activeAnnotationRule?.id,
            pipelineNumber: pagePipelineNumber,
            isUploaded: false
          });

          nextNumber += increment;
        });
      });

      if (newAnnotations.length === 0) {
        message.warning('未能生成标注，请确认同管线页已完成焊点识别，且起止 Path ID 在对应页存在');
        return;
      }

      const updatedRule = activeAnnotationRule ? {
        ...activeAnnotationRule,
        currentNumber: nextNumber,
        updatedAt: new Date().toISOString()
      } : null;

      if (onBatchAddAnnotations) {
        onBatchAddAnnotations(newAnnotations, updatedRule);
        if (targetPages.length > 1) {
          message.success(`已按管线号 ${currentPipelineNumber} 生成 ${targetPages.length} 页、${newAnnotations.length} 个标注`);
        }
        exitSinglePageNumberingMode();
        setShowWeldDebug(false);
        setShowPipelineDebug(false);
        setShowVectorDebug(false);
      }
      return;
    }

    const layoutData = calculateWeldLayout(
      orderedNumberingWelds,
      PDF_LAYOUT_BASE_SCALE,
      'KEEP_ORDER',
      undefined,
      undefined,
      getPageTextRegions(currentPage, textDetections),
      {
        normalizedPlacementArea: latestAreasRef.current.weldRecognition || globalWeldRecognitionArea,
        graphicVectors: pageVectors[currentPage] || [],
        circleDiameter: annotationFrameSize || 56.7,
        allowLeaderThroughGraphics: true,
        allowLeaderCrossing: false
      }
    );
    
    // 2. 转换为标注对象
    const currentPipelineNumber = getResolvedPagePipelineNumber(currentPage);
    const startNum = activeAnnotationRule
      ? resolvePipelineScopedStartNumber(activeAnnotationRule, currentPipelineNumber)
      : 1;
    const increment = activeAnnotationRule ? (activeAnnotationRule.increment !== undefined ? activeAnnotationRule.increment : 1) : 1;
    const numberlessWeldKeys = getNumberlessWeldKeys(numberingSegments, displayedWelds);

    const newAnnotations = layoutData.map((item, index) => {
      let text;
      text = item.number.toString();
      if (activeAnnotationRule) {
        const num = startNum + (index * increment);
        const prefix = activeAnnotationRule.prefix || '';
        const suffix = activeAnnotationRule.suffix || '';
        text = `${prefix}${num}${suffix}`;
      }
      if (numberlessWeldKeys.has(getWeldSelectionKey(item))) {
        text = '';
      }

      const scaledFontSize = scaleAnnotationValue(annotationFontSize || 34, pageSize, 34);
      const scaledTopFontSize = scaleAnnotationValue(annotationTopFontSize || annotationFontSize || 34, pageSize, scaledFontSize);
      const scaledBottomFontSize = scaleAnnotationValue(annotationBottomFontSize || annotationFontSize || 34, pageSize, scaledFontSize);
      const scaledFrameSize = annotationFrameSize || 56.7;

      return {
        id: Date.now() + Math.random().toString(36).substr(2, 9) + index,
        page: currentPage,
        type: 'text',
        
        // 3. layoutData 现在直接输出 PDF 基准坐标（PDF原始点 * 2.0）
        // AnnotationLayer 渲染时会再乘当前 zoom scale，因此这里直接存储即可
        startX: item.startX,
        startY: item.startY,
        endX: item.endX,
        endY: item.endY,
        
        text: text,
        color: '#ff0000',      // 纯红色
        fontSize: scaledFontSize,
        topFontSize: scaledTopFontSize,
        bottomFontSize: scaledBottomFontSize,
        frameSize: scaledFrameSize,
        borderShape: 'circle', // 圆形
        hasLeaderLine: true,   // 开启引导线
        remark: activeAnnotationRule?.remark || '批量自动生成', // 自动添加备注
        ruleId: activeAnnotationRule?.id,
        pipelineNumber: currentPipelineNumber,
        isUploaded: false
      };
    });
    
    // 3. 准备更新后的规则对象（如果使用了规则）
    let updatedRule = null;
    if (activeAnnotationRule) {
      const nextNumber = startNum + (layoutData.length * increment);

      updatedRule = {
        ...activeAnnotationRule,
        currentNumber: nextNumber,
        updatedAt: new Date().toISOString()
      };
    }

    // 4. 提交给父组件，父组件更新 annotations 状态
    if (onBatchAddAnnotations) {
      onBatchAddAnnotations(newAnnotations, updatedRule);
      
      // 5. 生成后关闭焊点编号显示，避免重叠
      exitSinglePageNumberingMode();
      // 同时关闭焊点识别、管道识别和矢量调试，确保没有任何覆盖层干扰
      setShowWeldDebug(false);
      setShowPipelineDebug(false);
      setShowVectorDebug(false);
    }
  }, [
    displayedWelds,
    numberingSegments,
    orderedNumberingWelds,
    multiPageNumberPreview,
    multiPageNumberWelds,
    multiPageOriginalNumberWelds,
    manualWeldInsertMode,
    manualWeldDeleteMode,
    reopenedPdfSupplementMode,
    scale,
    currentPage,
    textDetections,
    onBatchAddAnnotations,
    activeAnnotationRule,
    annotationFontSize,
    annotationTopFontSize,
    annotationBottomFontSize,
    annotationFrameSize,
    pageSize,
    pageVectors,
    globalWeldRecognitionArea,
    buildNumberingSegmentRangeSequence,
    getWeldSelectionKey,
    getPageAwareWeldSelectionKey,
    rebuildNumberingWeldsFromSegments,
    getNumberlessWeldKeysForPage,
    getNumberlessWeldKeys,
    getNumberingPagePipelineNumber,
    getNumberingSegmentRangeForPage,
    applyNumberingSegmentsToPageOrder,
    buildCorrectedMultiPageNumbering,
    rebuildStableMultiPageSequence,
    getSegmentTargetStartNumber,
    isNumberingSegmentHidden,
    getNumberingWeldsForPage,
    normalizeNumberingPipeline,
    getResolvedPagePipelineNumber,
    resolvePipelineScopedStartNumber,
    exitSinglePageNumberingMode
  ]);

  const handleConfirmNumberingAnnotations = useCallback(() => {
    if (!pendingNumberingAnnotations.length) return;
    if (reopenedPdfSupplementMode) {
      onApplyWeldAdjustment?.(pendingNumberingAnnotations);
    } else {
      onBatchAddAnnotations?.(pendingNumberingAnnotations, null);
    }
    window.dispatchEvent(new CustomEvent('multi-page-segment-correction-applied', {
      detail: {
        segmentCount: numberingSegments.length,
        weldCount: pendingNumberingAnnotations.length
      }
    }));
    setPendingNumberingAnnotations([]);
    setMultiPageNumberPreview(false);
    setManualWeldInsertMode(false);
    setManualWeldDeleteMode(false);
    exitSinglePageNumberingMode();
    setShowWeldDebug(false);
    setShowPipelineDebug(false);
    setShowVectorDebug(false);
    numberingPreviewReturnModeRef.current = 'idle';
    message.success(`已确认生成 ${pendingNumberingAnnotations.length} 个多页标注`);
  }, [
    exitSinglePageNumberingMode,
    numberingSegments.length,
    onApplyWeldAdjustment,
    onBatchAddAnnotations,
    pendingNumberingAnnotations,
    reopenedPdfSupplementMode
  ]);

  const handleReturnToNumberingAdjustment = useCallback(() => {
    const returnMode = numberingPreviewReturnModeRef.current;
    setPendingNumberingAnnotations([]);
    setShowWeldDebug(true);
    setShowWeldNumbers(true);
    setManualWeldInsertMode(returnMode === 'insert');
    setManualWeldDeleteMode(returnMode === 'delete');
    setIsWeldStartPickMode(returnMode === 'idle');
    setMultiPageNumberPreview(true);
    message.info(
      returnMode === 'insert'
        ? '已返回补点调整，原编号段和补点均已保留'
        : returnMode === 'delete'
          ? '已返回删除调整，原编号段和删除记录均已保留'
          : '已返回蓝圈编号调整，原编号段和补点均已保留'
    );
  }, []);

  // 处理多页批量处理 - 矢量提取完成
  const handleVectorsExtracted = useCallback((vectors) => {
    const pageEntries = Object.entries(vectors || {});
    console.log('📐 多页矢量提取完成:', {
      pages: pageEntries.length,
      totalVectors: pageEntries.reduce((sum, [, pageItems]) => sum + (pageItems?.length || 0), 0)
    });
    // 可以选择性地更新到 pageVectors 状态
    setPageVectors(prev => ({ ...prev, ...vectors }));
  }, []);

  // 处理多页批量处理 - 文字识别完成
  const handleTextsDetected = useCallback((texts) => {
    console.log('📝 多页文字识别完成:', texts);
    // 可以选择性地更新到 textDetections 状态
    setTextDetections(prev => ({ ...prev, ...texts }));
    onPageTextDetectionsChange?.(texts);
  }, [onPageTextDetectionsChange]);

  // 处理多页批量处理 - 焊点识别完成
  const handleWeldsDetected = useCallback((welds) => {
    console.log('🔥 多页焊点识别完成:', welds);
  }, []);

  // 处理多页批量处理 - 显示编号预览
  const handleShowNumberPreview = useCallback((show, welds = [], pageRange = null) => {
    console.log('🎬 多页编号预览:', show, welds.length);

    if (!show) {
      clearSinglePageNumberingSelection();
      setPendingNumberingAnnotations([]);
      setManualWeldInsertMode(false);
      setManualWeldDeleteMode(false);
      setIsWeldStartPickMode(false);
    }
    
    // 转换多页数据格式，使其与单页格式一致
    // 多页数据: { pageNum, weldNumber, ... }
    // 单页数据: { page, number, ... }
    const normalizedWelds = welds.map(weld => ({
      ...weld,
      page: weld.pageNum || weld.page,  // 统一使用 page 字段
      number: weld.weldNumber || weld.number  // 统一使用 number 字段
    }));
    
    const weldPages = normalizedWelds.map(weld => Number(weld.page)).filter(Number.isFinite);
    const requestedStart = Number(pageRange?.startPage ?? pageRange?.start);
    const requestedEnd = Number(pageRange?.endPage ?? pageRange?.end);
    const nextRange = Number.isFinite(requestedStart) && Number.isFinite(requestedEnd)
      ? { startPage: Math.min(requestedStart, requestedEnd), endPage: Math.max(requestedStart, requestedEnd) }
      : weldPages.length > 0
        ? { startPage: Math.min(...weldPages), endPage: Math.max(...weldPages) }
        : null;
    multiPagePreviewPageRangeRef.current = nextRange;
    setMultiPagePreviewPageRange(nextRange);

    console.log('📝 转换后的焊点数据:', normalizedWelds.slice(0, 3));
    
    setMultiPageNumberPreview(show);
    if (show) setReopenedPdfSupplementMode(false);
    setMultiPageNumberWelds(normalizedWelds);
    setMultiPageOriginalNumberWelds(normalizedWelds);
    manualWeldDeleteHistoryRef.current = [];
    
    // 如果显示预览，自动切换到第一个有焊点的页面
    if (show && normalizedWelds.length > 0) {
      const firstWeldPage = normalizedWelds[0].page;
      if (firstWeldPage && firstWeldPage !== currentPage) {
        if (onPageChange) {
          onPageChange(firstWeldPage);
        }
        message.info(`已切换到第 ${firstWeldPage} 页查看编号预览`);
      }
    }
  }, [clearSinglePageNumberingSelection, currentPage]);

  const handleStartMultiPageSegmentCorrection = useCallback((welds = []) => {
    const sourceWelds = welds.length > 0 ? welds : multiPageNumberWelds;
    clearSinglePageNumberingSelection();
    setManualWeldInsertMode(false);
    setManualWeldDeleteMode(false);
    setShowWeldDebug(true);
    setShowWeldNumbers(true);
    setIsWeldStartPickMode(true);
    setMultiPageNumberPreview(true);

    const firstPage = Number(sourceWelds[0]?.page || sourceWelds[0]?.pageNum);
    if (firstPage && firstPage !== currentPage && onPageChange) {
      onPageChange(firstPage);
    }
    message.info('已进入多段起止修正：只需选择顺序异常区段的起点和终点');
  }, [
    clearSinglePageNumberingSelection,
    currentPage,
    multiPageNumberWelds,
    onPageChange
  ]);

  const handleRestoreMultiPageAutoOrder = useCallback(() => {
    clearSinglePageNumberingSelection();
    setManualWeldInsertMode(false);
    setManualWeldDeleteMode(false);
    setMultiPageNumberWelds(multiPageOriginalNumberWelds);
    manualWeldDeleteHistoryRef.current = [];
    setShowWeldNumbers(false);
    setIsWeldStartPickMode(false);
    setMultiPageNumberPreview(true);
    message.info('已清除多段修正，恢复多页自动编号顺序');
  }, [clearSinglePageNumberingSelection, multiPageOriginalNumberWelds]);

  const handleReopenMultiPageAdjustment = useCallback((initialMode = 'idle') => {
    if (!multiPageNumberWelds.length) {
      message.warning('没有可继续调整的多页焊点数据');
      return;
    }
    clearSinglePageNumberingSelection();
    setManualWeldInsertMode(initialMode === 'insert');
    setManualWeldDeleteMode(initialMode === 'delete');
    setShowWeldDebug(true);
    setShowWeldNumbers(true);
    setIsWeldStartPickMode(true);
    setMultiPageNumberPreview(true);
    message.info('已重新打开补点与顺序调整；修改后请点击“生成可编辑标注”覆盖本次批量结果');
  }, [clearSinglePageNumberingSelection, multiPageNumberWelds]);

  const hasReopenedWeldSequenceCandidate = useMemo(() => (
    annotations.some(isRecoverableWeldAnnotation)
  ), [annotations]);

  const handleStartReopenedPdfSupplement = useCallback((initialMode = 'idle') => {
    const rebuilt = buildReopenedWeldSequence(annotations, currentPage);
    if (!rebuilt.welds.length) {
      message.warning('当前 PDF 中没有可恢复的自动焊口元数据，无法安全补点');
      return;
    }
    const restoredBatchRunId = rebuilt.batchRunId || `reopened-weld-batch-${Date.now()}`;
    const restoredWelds = rebuilt.welds.map(weld => ({
      ...weld,
      batchRunId: weld.batchRunId || restoredBatchRunId
    }));
    const restoredRuleSource = buildReopenedAnnotationRule(restoredWelds, currentPage);
    const restoredRule = restoredRuleSource
      ? {
        ...restoredRuleSource,
        // The right-side circle setting is the single source of truth for
        // supplemental points, rather than varying historical page styles.
        frameSize: Number(annotationFrameSize) || 56.7
      }
      : null;
    const restoredPageRange = Number(numPages) > 0
      ? { startPage: 1, endPage: Number(numPages) }
      : rebuilt.pageRange;

    clearSinglePageNumberingSelection();
    setNumberingSegments([]);
    setNumberlessNumberingSegmentKeys([]);
    reopenedOriginalWeldsRef.current = restoredWelds;
    setMultiPageOriginalNumberWelds(restoredWelds);
    setMultiPageNumberWelds(restoredWelds);
    setMultiPagePreviewPageRange(restoredPageRange);
    multiPagePreviewPageRangeRef.current = restoredPageRange;
    setReopenedPdfSupplementMode(true);
    setPendingNumberingAnnotations([]);
    setManualWeldInsertMode(initialMode === 'insert');
    setManualWeldDeleteMode(initialMode === 'delete');
    manualWeldDeleteHistoryRef.current = [];
    setIsWeldStartPickMode(false);
    setShowWeldDebug(true);
    setShowWeldNumbers(true);
    setMultiPageNumberPreview(true);
    if (restoredRule) multiPageBatchService.setPendingBatchAnnotationRule(restoredRule);
    multiPageBatchService.setCorrectedNumberedWelds(restoredWelds);

    const currentNumbers = restoredWelds
      .filter(weld => Number(weld.page || weld.pageNum) === Number(currentPage))
      .map(weld => Number(weld.weldNumber ?? weld.number))
      .filter(Number.isFinite);
    updateManualWeldInsertPosition(currentNumbers.length > 0 ? Math.max(...currentNumbers) + 1 : 1);

    message.success(`已从 PDF 全部标注信息恢复 ${restoredWelds.length} 个焊口，原编号保持不变`);
  }, [
    annotationFrameSize,
    annotations,
    clearSinglePageNumberingSelection,
    currentPage,
    numPages,
    updateManualWeldInsertPosition
  ]);

  const currentPageManualWeldCount = useMemo(() => (
    (multiPageNumberWelds || []).filter(weld => (
      Number(weld?.page || weld?.pageNum) === Number(currentPage) &&
      weld?.isManualInserted
    )).length
  ), [currentPage, multiPageNumberWelds]);

  const currentPageNumberedWeldCount = useMemo(() => (
    (multiPageNumberWelds || []).filter(
      weld => Number(weld?.page || weld?.pageNum) === Number(currentPage)
    ).length
  ), [currentPage, multiPageNumberWelds]);

  const currentPageWeldNumberRange = useMemo(() => {
    const numbers = (multiPageNumberWelds || [])
      .filter(weld => Number(weld?.page || weld?.pageNum) === Number(currentPage))
      .map(weld => Number(weld?.weldNumber ?? weld?.number))
      .filter(Number.isFinite);
    if (numbers.length === 0) {
      return { min: 1, max: 0 };
    }
    return {
      min: Math.min(...numbers),
      max: Math.max(...numbers)
    };
  }, [currentPage, multiPageNumberWelds]);

  const currentPageHasNumberedWelds = currentPageWeldNumberRange.max >= currentPageWeldNumberRange.min;
  const selectedManualInsertPipelineNumber = (
    Number(manualInsertPipelineContext.page) === Number(currentPage) &&
    manualInsertPipelineContext.status === 'resolved'
  )
    ? manualInsertPipelineContext.pipelineNumber
    : getNumberingPagePipelineNumber(currentPage);
  const currentManualInsertContext = useMemo(() => {
    const pendingRule = multiPageBatchService.getPendingBatchAnnotationRule() || activeAnnotationRule;
    return resolveManualInsertContext({
      welds: multiPageNumberWelds,
      pageNum: currentPage,
      pipelineNumber: selectedManualInsertPipelineNumber,
      fallbackStartNumber: pendingRule?.startNumber ?? pendingRule?.currentNumber ?? 1,
      increment: pendingRule?.increment ?? 1
    });
  }, [activeAnnotationRule, currentPage, multiPageNumberWelds, selectedManualInsertPipelineNumber]);
  // 插入序号可以早于或晚于当前页已有范围（例如当前页为 56-62 时补 47）。
  // 真正的顺延范围由 insertManualWeldIntoSequence 按同管线号处理。
  const manualInsertMinimum = 1;
  const manualInsertMaximum = undefined;

  const bindManualInsertPipelineScope = useCallback((welds, pipelineNumber, context = manualInsertPipelineContext) => (
    bindPipelineToMatchingPages({
      welds,
      pipelineNumber,
      pipelineNumberSource: context?.source === 'manual-confirmation'
        ? 'user_confirmed'
        : /pipeline-area|page-number-area/.test(String(context?.source || ''))
          ? 'inferred'
          : 'business_data',
      anchorPage: currentPage,
      matchedPages: context?.matchedPages || [],
      getPagePipeline: (page, pageWelds) => getNumberingPagePipelineNumber(page, pageWelds)
    })
  ), [currentPage, getNumberingPagePipelineNumber, manualInsertPipelineContext]);

  const handleManualInsertPipelineChange = useCallback((values) => {
    const selectedValues = Array.isArray(values) ? values : [values];
    const pipelineNumber = normalizeNumberingPipeline(selectedValues[selectedValues.length - 1] || '');
    if (!pipelineNumber) {
      setManualInsertPipelineContext(prev => ({
        ...prev,
        page: Number(currentPage),
        status: 'unresolved',
        pipelineNumber: '',
        source: 'manual-cleared'
      }));
      return;
    }

    const confirmedContext = {
      page: Number(currentPage),
      status: 'resolved',
      pipelineNumber,
      matchedPages: [],
      matchedPage: null,
      source: 'manual-confirmation'
    };
    setManualInsertPipelineContext(prev => ({
      ...prev,
      ...confirmedContext,
      candidates: Array.from(new Set([...(prev.candidates || []), pipelineNumber])),
    }));
    syncPipelineNumberToAnnotations(confirmedContext);
    const scopedWelds = bindManualInsertPipelineScope(multiPageNumberWelds, pipelineNumber, confirmedContext);
    if (scopedWelds !== multiPageNumberWelds) setMultiPageNumberWelds(scopedWelds);
    const pendingRule = multiPageBatchService.getPendingBatchAnnotationRule() || activeAnnotationRule;
    const nextContext = resolveManualInsertContext({
      welds: scopedWelds,
      pageNum: currentPage,
      pipelineNumber,
      fallbackStartNumber: pendingRule?.startNumber ?? pendingRule?.currentNumber ?? 1,
      increment: pendingRule?.increment ?? 1
    });
    updateManualWeldInsertPosition(nextContext.suggestedNumber);
  }, [
    activeAnnotationRule,
    bindManualInsertPipelineScope,
    currentPage,
    multiPageNumberWelds,
    normalizeNumberingPipeline,
    syncPipelineNumberToAnnotations,
    updateManualWeldInsertPosition
  ]);

  useWeldAdjustmentPipelineSync({
    page: currentPage,
    mode: manualWeldInsertMode ? 'insert' : manualWeldDeleteMode ? 'delete' : null,
    documentKey: file,
    context: manualInsertPipelineContext,
    welds: multiPageNumberWelds,
    resolve: resolveManualInsertPipelineContext,
    apply: pipelineContext => {
      if (pipelineContext?.status !== 'resolved' || !pipelineContext.pipelineNumber) return;
      setMultiPageNumberWelds(prev => bindManualInsertPipelineScope(
        prev, pipelineContext.pipelineNumber, pipelineContext
      ));
      if (manualWeldInsertMode && Number(manualWeldInsertPageRef.current) !== Number(currentPage)) {
        manualWeldInsertPageRef.current = currentPage;
        const scopedWelds = bindManualInsertPipelineScope(
          multiPageNumberWelds, pipelineContext.pipelineNumber, pipelineContext
        );
        const pendingRule = multiPageBatchService.getPendingBatchAnnotationRule() || activeAnnotationRule;
        const pageNumbers = scopedWelds
          .filter(weld => Number(weld?.page || weld?.pageNum) === Number(currentPage))
          .map(weld => Number(weld?.weldNumber ?? weld?.number)).filter(Number.isFinite);
        const insertContext = resolveManualInsertContext({
          welds: scopedWelds, pageNum: currentPage, pipelineNumber: pipelineContext.pipelineNumber,
          fallbackStartNumber: pendingRule?.startNumber ?? pendingRule?.currentNumber ?? 1,
          increment: pendingRule?.increment ?? 1
        });
        updateManualWeldInsertPosition(pageNumbers.length
          ? Math.max(...pageNumbers) + 1 : insertContext.suggestedNumber);
      }
    }
  });

  const handleToggleManualWeldInsert = useCallback(async () => {
    const next = !manualWeldInsertMode;
    if (next) {
      if (false) {
        message.warning('当前页不在本次多页处理范围内，请返回已处理页后再补点');
        return;
      }
      setSelectedStartWeldId(null);
      setSelectedStartWeld(null);
      setIsWeldStartPickMode(false);
      setManualWeldDeleteMode(false);

      const calculatedWelds = rebuildStableMultiPageSequence(true);
      const pipelineContext = await resolveManualInsertPipelineContext(currentPage, calculatedWelds);
      if (!isPageInManualInsertPipelineScope(currentPage, pipelineContext)) {
        message.warning('当前页不属于已确认的同管线号范围，无法补点；请先确认补点管线号');
        return;
      }
      const scopedWelds = pipelineContext.status === 'resolved'
        ? bindManualInsertPipelineScope(calculatedWelds, pipelineContext.pipelineNumber, pipelineContext)
        : calculatedWelds;
      setMultiPageNumberWelds(scopedWelds);

      const pageNumbers = scopedWelds
        .filter(weld => Number(weld?.page || weld?.pageNum) === Number(currentPage))
        .map(weld => Number(weld?.weldNumber ?? weld?.number))
        .filter(Number.isFinite);
      const pendingRule = multiPageBatchService.getPendingBatchAnnotationRule() || activeAnnotationRule;
      const emptyPageContext = resolveManualInsertContext({
        welds: scopedWelds,
        pageNum: currentPage,
        pipelineNumber: pipelineContext.status === 'resolved' ? pipelineContext.pipelineNumber : '',
        fallbackStartNumber: pendingRule?.startNumber ?? pendingRule?.currentNumber ?? 1,
        increment: pendingRule?.increment ?? 1
      });
      const maxNumber = pageNumbers.length > 0 ? Math.max(...pageNumbers) : null;
      updateManualWeldInsertPosition(number => {
        const value = Number(number);
        return Number.isFinite(value) && value >= 1
          ? value
          : maxNumber === null ? emptyPageContext.suggestedNumber : maxNumber + 1;
      });
      if (pipelineContext.status !== 'resolved') {
        message.warning('未能确认管线号，暂不能补点；请在“补点管线号”中选择或填写后再操作');
      } else {
        message.info('补焊点模式：已按同管线预览确定序号；补点后同管线后续序号将强制顺延');
      }
    } else {
      setIsWeldStartPickMode(true);
    }
    setManualWeldInsertMode(next);
  }, [
    currentPage,
    activeAnnotationRule,
    bindManualInsertPipelineScope,
    isPageInManualInsertPipelineScope,
    manualWeldInsertMode,
    rebuildStableMultiPageSequence,
    resolveManualInsertPipelineContext,
    updateManualWeldInsertPosition
  ]);

  const handleManualWeldPointClick = useCallback((point) => {
    if (!manualWeldInsertMode || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
    if (!isPageInManualInsertPipelineScope(currentPage, manualInsertPipelineContext)) {
      message.warning('当前页不属于已确认的同管线号范围，无法补点');
      return;
    }
    if (
      Number(manualInsertPipelineContext.page) !== Number(currentPage) ||
      manualInsertPipelineContext.status !== 'resolved' ||
      !manualInsertPipelineContext.pipelineNumber
    ) {
      message.warning(
        manualInsertPipelineContext.status === 'resolving'
          ? '正在比对当前页管线号，请稍候再补点'
          : '必须先确认管线号，补点才能同步顺延该管线号下的全部焊点'
      );
      return;
    }

    const {
      insertNumber,
      nextCursorValue
    } = reserveManualInsertNumber({
      cursorValue: manualWeldInsertPositionRef.current,
      // 目标号可以早于当前页范围，例如当前页 56-62 时补入 47。
      // 同管线号的后续顺延由 insertManualWeldIntoSequence 负责。
      minNumber: 1,
      fallbackNumber: currentPageHasNumberedWelds
        ? currentPageWeldNumberRange.max + 1
        : currentManualInsertContext.suggestedNumber
    });
    // 先同步预留下一序号，再提交较慢的布局状态，连续点击不会重复读取同一序号。
    updateManualWeldInsertPosition(nextCursorValue);

    setMultiPageNumberWelds(prev => {
      const rawSource = Array.isArray(prev) ? [...prev] : [];
      const source = bindManualInsertPipelineScope(
        rawSource,
        selectedManualInsertPipelineNumber,
        manualInsertPipelineContext
      );
      const currentPageWelds = source.filter(
        weld => Number(weld?.page || weld?.pageNum) === Number(currentPage)
      );
      const pendingRule = multiPageBatchService.getPendingBatchAnnotationRule() || activeAnnotationRule;
      const insertContext = resolveManualInsertContext({
        welds: source,
        pageNum: currentPage,
        pipelineNumber: selectedManualInsertPipelineNumber || getNumberingPagePipelineNumber(
          currentPage,
          currentPageWelds
        ),
        fallbackStartNumber: pendingRule?.startNumber ?? pendingRule?.currentNumber ?? 1,
        increment: pendingRule?.increment ?? 1
      });
      const pipelineNumber = insertContext.pipelineNumber;
      const numberingScopeKey = insertContext.numberingScopeKey;
      const reopenedTemplate = reopenedPdfSupplementMode
        ? findReopenedWeldTemplate(source, currentPage, pipelineNumber, insertNumber, point)
        : null;
      const manualId = `manual-weld-${currentPage}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const manualWeld = {
        id: manualId,
        pathId: null,
        center: { x: point.x, y: point.y },
        boundingBox: {
          minX: point.x - 3,
          minY: point.y - 3,
          width: 6,
          height: 6
        },
        page: Number(currentPage),
        pageNum: Number(currentPage),
        pipelineNumber,
        pipelineNumberRaw: pipelineNumber,
        pipelineNumberSource: manualInsertPipelineContext.source === 'manual-confirmation'
          ? 'user_confirmed'
          : /pipeline-area|page-number-area/.test(String(manualInsertPipelineContext.source || ''))
            ? 'inferred'
            : 'business_data',
        numberingScopeKey,
        numberingAffixKey: getWeldDisplayAffixKey(reopenedTemplate),
        displayNumber: reopenedTemplate?.displayNumber,
        isManualInserted: true,
        manualInsertId: manualId,
        manualRequestedNumber: insertNumber,
        isNumberingEdited: true,
        manualInsertedAt: Date.now(),
        batchRunId: reopenedTemplate?.batchRunId,
        annotationTopText: reopenedTemplate?.annotationTopText,
        annotationJointTypeText: reopenedTemplate?.annotationJointTypeText,
        annotationBorderShape: reopenedTemplate?.annotationBorderShape,
        annotationFontSize: reopenedTemplate?.annotationFontSize,
        annotationTopFontSize: reopenedTemplate?.annotationTopFontSize,
        annotationBottomFontSize: reopenedTemplate?.annotationBottomFontSize,
        // Match the nearest weld on the current page so a supplemental point
        // does not stand out from the annotations already printed there.
        // The right-side standard remains the fallback for an empty page.
        annotationFrameSize: Number(reopenedTemplate?.annotationFrameSize) ||
          Number(annotationFrameSize) || Number(pendingRule?.frameSize) || 56.7,
        annotationColor: reopenedTemplate?.annotationColor,
        annotationRuleId: reopenedTemplate?.annotationRuleId,
        annotationRuleName: reopenedTemplate?.annotationRuleName
      };
      const result = insertManualWeldIntoSequence({
        welds: source,
        pageNum: currentPage,
        pipelineNumber,
        numberingScopeKey,
        insertNumber,
        manualWeld
      });
      return result.welds;
    });

    message.success({
      key: 'manual-weld-insert-success',
      content: `已补入焊口序号 ${insertNumber}`,
      duration: 0.8
    });
  }, [
    currentPage,
    activeAnnotationRule,
    annotationFrameSize,
    bindManualInsertPipelineScope,
    currentPageHasNumberedWelds,
    currentPageWeldNumberRange,
    currentManualInsertContext.suggestedNumber,
    getNumberingPagePipelineNumber,
    isPageInManualInsertPipelineScope,
    manualInsertPipelineContext,
    manualWeldInsertMode,
    reopenedPdfSupplementMode,
    selectedManualInsertPipelineNumber,
    updateManualWeldInsertPosition,
  ]);

  const handleUndoLastManualWeld = useCallback(() => {
    setMultiPageNumberWelds(prev => {
      const source = Array.isArray(prev) ? [...prev] : [];
      let removeIndex = -1;
      let latestTime = -1;
      source.forEach((weld, index) => {
        if (
          weld?.isManualInserted &&
          Number(weld?.page || weld?.pageNum) === Number(currentPage) &&
          Number(weld?.manualInsertedAt || 0) >= latestTime
        ) {
          latestTime = Number(weld?.manualInsertedAt || 0);
          removeIndex = index;
        }
      });
      if (removeIndex < 0) {
        message.info('当前页没有可撤销的补焊点');
        return prev;
      }
      const result = removeManualWeldFromSequence({
        welds: source,
        manualInsertId: source[removeIndex].manualInsertId
      });
      updateManualWeldInsertPosition(Number.isFinite(result.removedNumber) ? result.removedNumber : 1);
      message.success('已撤销上一个补焊点');
      return result.welds;
    });
  }, [currentPage, updateManualWeldInsertPosition]);

  const handleToggleManualWeldDelete = useCallback(async () => {
    const next = !manualWeldDeleteMode;
    if (next) {
      if (!isPageInsideMultiPagePreview(currentPage)) {
        message.warning('当前页不在本次多页处理范围内，请返回已处理页后再删除焊点');
        return;
      }
      if ((multiPageNumberWelds || []).length <= 1) {
        message.warning('至少需要保留一个焊点；若要清空，请使用普通标注删除');
        return;
      }
      setManualWeldInsertMode(false);
      setPendingManualWeldDelete([]);
      setSelectedStartWeldId(null);
      setSelectedStartWeld(null);
      setIsWeldStartPickMode(false);
      const pipelineContext = await resolveManualInsertPipelineContext(currentPage, multiPageNumberWelds);
      const scopedWelds = pipelineContext.status === 'resolved'
        ? bindManualInsertPipelineScope(multiPageNumberWelds, pipelineContext.pipelineNumber, pipelineContext)
        : multiPageNumberWelds;
      if (scopedWelds !== multiPageNumberWelds) setMultiPageNumberWelds(scopedWelds);
      if (pipelineContext.status !== 'resolved' || !pipelineContext.pipelineNumber) {
        message.warning('未能确认管线号，暂不能删除；请先选择或填写管线号');
      } else {
        message.info('批量删除焊点模式：可连续选择或取消多个焊点，再统一确认删除');
      }
    } else {
      setPendingManualWeldDelete([]);
      setIsWeldStartPickMode(true);
    }
    setManualWeldDeleteMode(next);
  }, [
    bindManualInsertPipelineScope,
    currentPage,
    isPageInsideMultiPagePreview,
    manualWeldDeleteMode,
    multiPageNumberWelds,
    resolveManualInsertPipelineContext
  ]);

  const handleDeleteNumberingWeld = useCallback((weld) => {
    if (!manualWeldDeleteMode) return;
    if (!isPageInsideMultiPagePreview(currentPage)) return;
    if (
      manualInsertPipelineContext.status !== 'resolved' ||
      !manualInsertPipelineContext.pipelineNumber
    ) {
      message.warning('必须先确认管线号，删除才能同步影响该管线号下的全部焊点');
      return;
    }
    if (weld?.isWeldedSupport === true) {
      message.warning('支架焊点不参与普通焊口删除和顺延');
      return;
    }
    if ((multiPageNumberWelds || []).length <= 1) {
      message.warning('至少需要保留一个焊点；若要清空，请使用普通标注删除');
      return;
    }
    const weldKey = getWeldSelectionKey(weld);
    if (!weldKey) {
      message.warning('未找到对应焊点，无法选择删除');
      return;
    }
    const weldNumber = Number(weld?.weldNumber ?? weld?.number);
    const pipelineNumber = String(
      weld?.pipelineNumber || manualInsertPipelineContext.pipelineNumber || ''
    ).trim();
    const selectedFromOtherPipeline = pendingManualWeldDelete.some(item => (
      item.pipelineNumber && pipelineNumber && item.pipelineNumber !== pipelineNumber
    ));
    if (selectedFromOtherPipeline) {
      message.warning('一次批量删除只能选择同一管线号的焊点');
      return;
    }
    const selectedIndex = pendingManualWeldDelete.findIndex(item => item.weldKey === weldKey);
    if (selectedIndex >= 0) {
      const nextSelection = pendingManualWeldDelete.filter(item => item.weldKey !== weldKey);
      setPendingManualWeldDelete(nextSelection);
      message.info({
        key: 'manual-weld-delete-selected',
        content: `已取消焊口 ${Number.isFinite(weldNumber) ? weldNumber : ''}，当前选中 ${nextSelection.length} 个`,
        duration: 1.2
      });
      return;
    }
    const nextSelection = [...pendingManualWeldDelete, {
      weldKey,
      weldNumber: Number.isFinite(weldNumber) ? weldNumber : '',
      displayNumber: weld?.displayNumber,
      pipelineNumber,
      page: Number(weld?.page || weld?.pageNum || currentPage)
    }];
    setPendingManualWeldDelete(nextSelection);
    message.info({
      key: 'manual-weld-delete-selected',
      content: `已选择焊口 ${weld?.displayNumber || (Number.isFinite(weldNumber) ? weldNumber : '')}，当前共 ${nextSelection.length} 个`,
      duration: 1.2
    });
  }, [
    currentPage,
    isPageInsideMultiPagePreview,
    manualInsertPipelineContext,
    manualWeldDeleteMode,
    multiPageNumberWelds,
    pendingManualWeldDelete
  ]);

  const handleConfirmManualWeldDelete = useCallback(() => {
    if (!manualWeldDeleteMode || pendingManualWeldDelete.length === 0) return;
    const source = Array.isArray(multiPageNumberWelds) ? multiPageNumberWelds : [];
    if (source.length <= 1) {
      message.warning('至少需要保留一个焊点；若要清空，请使用普通标注删除');
      return;
    }
    const result = removeWeldsFromSequence({
      welds: source,
      weldKeys: pendingManualWeldDeleteKeys,
      getWeldKey: getWeldSelectionKey
    });
    if (result.removedWelds.length === 0) {
      message.warning('未找到对应焊点，未执行批量删除');
      return;
    }
    const regularWeldCount = source.filter(weld => weld?.isWeldedSupport !== true).length;
    if (result.removedWelds.length >= regularWeldCount) {
      message.warning('至少需要保留一个普通焊点；若要清空，请使用普通标注删除');
      return;
    }

    const deletedSourceIds = result.removedWelds
      .map(weld => weld?.sourceAnnotationId)
      .filter(Boolean);
    const compactSource = compactReplacementSourceIds(source);
    manualWeldDeleteHistoryRef.current.push({
      welds: compactSource,
      page: currentPage,
      removedNumbers: result.removedNumbers,
      removedCount: result.removedWelds.length
    });
    if (manualWeldDeleteHistoryRef.current.length > 10) {
      manualWeldDeleteHistoryRef.current.shift();
    }
    const nextWelds = compactReplacementSourceIds(result.welds, deletedSourceIds);
    setMultiPageNumberWelds(nextWelds);
    setPendingManualWeldDelete([]);
    message.success(`已批量删除 ${result.removedWelds.length} 个焊点，同管线对应前后缀的后续编号已前移；请预览确认`);
  }, [
    currentPage,
    manualWeldDeleteMode,
    multiPageNumberWelds,
    pendingManualWeldDelete,
    pendingManualWeldDeleteKeys
  ]);

  const handleCancelManualWeldDelete = useCallback(() => {
    setPendingManualWeldDelete([]);
  }, []);

  const handleUndoLastWeldDelete = useCallback(() => {
    const previous = manualWeldDeleteHistoryRef.current.pop();
    if (!previous) {
      message.info('没有可撤销的删除操作');
      return;
    }
    setMultiPageNumberWelds(previous.welds);
    setPendingManualWeldDelete([]);
    message.success(`已恢复上一次删除的 ${previous.removedCount || 1} 个焊点`);
  }, []);

  const handleWeldAdjustmentAction = useCallback(({ key }) => {
    if (
      !multiPageNumberPreview &&
      (key === 'insert' || key === 'delete') &&
      hasReopenedWeldSequenceCandidate
    ) {
      // A newly opened editable PDF must be rebuilt from its embedded
      // annotation information. A stale multi-page draft can contain only the
      // last edited page and would truncate downstream shift/rollback.
      handleStartReopenedPdfSupplement(key);
      return;
    }
    if (
      !multiPageNumberPreview &&
      (key === 'insert' || key === 'delete') &&
      multiPageNumberWelds.length > 0
    ) {
      handleReopenMultiPageAdjustment(key);
      return;
    }
    if (key === 'insert') {
      if (!manualWeldInsertMode) handleToggleManualWeldInsert();
      return;
    }
    if (key === 'delete') {
      if (!manualWeldDeleteMode) handleToggleManualWeldDelete();
      return;
    }
    if (key === 'exit') {
      setManualWeldInsertMode(false);
      setManualWeldDeleteMode(false);
      setPendingManualWeldDelete([]);
      setPendingNumberingAnnotations([]);
      setMultiPageNumberPreview(false);
      setReopenedPdfSupplementMode(false);
      setMultiPageNumberWelds([]);
      setMultiPageOriginalNumberWelds([]);
      manualWeldDeleteHistoryRef.current = [];
      numberingPreviewReturnModeRef.current = 'idle';
      exitSinglePageNumberingMode();
      setShowWeldDebug(false);
      setShowPipelineDebug(false);
      setShowVectorDebug(false);
      message.info('已退出焊点调整和多段起止编号，未生成新焊口');
    }
  }, [
    exitSinglePageNumberingMode,
    handleToggleManualWeldDelete,
    handleToggleManualWeldInsert,
    handleStartReopenedPdfSupplement,
    handleReopenMultiPageAdjustment,
    manualWeldDeleteMode,
    manualWeldInsertMode,
    multiPageNumberPreview,
    multiPageNumberWelds.length,
    hasReopenedWeldSequenceCandidate
  ]);

  useEffect(() => {
    onWeldAdjustmentStateChange?.({
      available: (
        multiPageNumberPreview &&
        pendingNumberingAnnotations.length === 0 &&
        multiPageNumberWelds.length > 0
      ) || (
        !multiPageNumberPreview &&
        (multiPageNumberWelds.length > 0 || hasReopenedWeldSequenceCandidate)
      ),
      mode: manualWeldInsertMode
        ? 'insert'
        : manualWeldDeleteMode ? 'delete' : 'idle',
      handleAction: handleWeldAdjustmentAction
    });
  }, [
    handleWeldAdjustmentAction,
    manualWeldDeleteMode,
    manualWeldInsertMode,
    multiPageNumberPreview,
    multiPageNumberWelds.length,
    onWeldAdjustmentStateChange,
    pendingNumberingAnnotations.length,
    hasReopenedWeldSequenceCandidate
  ]);

  const handleNumberingWeldInteraction = useCallback((weld) => {
    if (manualWeldDeleteMode) {
      handleDeleteNumberingWeld(weld);
      return;
    }
    handleSelectNumberingWeld(weld);
  }, [handleDeleteNumberingWeld, handleSelectNumberingWeld, manualWeldDeleteMode]);

  const handlePipelineComparisonReady = useCallback((comparisonResult) => {
    const nextAlerts = comparisonResult?.alertsByPage || {};
    setPagePipelineAlerts(nextAlerts);
    setPipelineComparisonSummary(comparisonResult?.summary || null);
  }, []);

  const syncPipelineAlertsFromService = useCallback(() => {
    const comparison = multiPageBatchService.getPipelineComparison();
    setPagePipelineAlerts(comparison?.alertsByPage || {});
    setPipelineComparisonSummary(comparison?.summary || null);
  }, []);

  const multiPageAbnormalCount = pipelineComparisonSummary?.abnormalCount || 0;
  const multiPageAbnormalCountText = multiPageAbnormalCount > 99 ? '99+' : String(multiPageAbnormalCount);
  const renderMultiPageButtonContent = useCallback(() => (
    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%' }}>
      <span>多页处理</span>
      {multiPageAbnormalCount > 0 && (
        <span
          style={{
            minWidth: 20,
            height: 20,
            padding: '0 6px',
            borderRadius: 999,
            background: '#ff4d4f',
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            lineHeight: '20px',
            textAlign: 'center',
            boxShadow: '0 2px 8px rgba(255, 77, 79, 0.28)'
          }}
        >
          {multiPageAbnormalCountText}
        </span>
      )}
    </span>
  ), [multiPageAbnormalCount, multiPageAbnormalCountText]);

  const renderPipelineComparisonOverlay = useCallback((pageNumber) => {
    const alerts = pagePipelineAlerts[pageNumber] || [];
    if (alerts.length === 0) {
      return null;
    }

    return (
      <>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            border: '3px solid rgba(255, 77, 79, 0.9)',
            boxShadow: 'inset 0 0 0 1px rgba(255, 77, 79, 0.2)',
            pointerEvents: 'none',
            zIndex: 1500
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            maxWidth: 320,
            padding: '10px 12px',
            background: 'rgba(255, 255, 255, 0.97)',
            border: '1px solid #ff4d4f',
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.14)',
            pointerEvents: 'none',
            zIndex: 1501
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, color: '#ff4d4f', marginBottom: 8 }}>
            管线对账异常
          </div>
          {alerts.map((alert, index) => {
            const actualText = alert.actualWeldCount === null || alert.actualWeldCount === undefined ? '—' : alert.actualWeldCount;
            const deltaText = alert.delta === null || alert.delta === undefined
              ? '—'
              : (alert.delta > 0 ? `+${alert.delta}` : `${alert.delta}`);

            return (
              <div
                key={alert.key || `${alert.pipelineNumber || 'unresolved'}-${index}`}
                style={{
                  paddingTop: index === 0 ? 0 : 8,
                  marginTop: index === 0 ? 0 : 8,
                  borderTop: index === 0 ? 'none' : '1px solid #fff1f0'
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: '#262626', marginBottom: 4 }}>
                  {alert.pipelineNumber || '未识别管线'}
                </div>
                <div style={{ fontSize: 12, color: '#595959', marginBottom: 4 }}>
                  已识别焊点数量: {actualText} | 差值: {deltaText}
                </div>
                <div style={{ fontSize: 12, color: '#ff4d4f', lineHeight: 1.5 }}>
                  {alert.message}
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  }, [pagePipelineAlerts]);

  // 处理多页批量处理 - 标注生成完成
  const handleAnnotationsGenerated = useCallback((annotations) => {
    console.log('🔢 多页标注生成完成:', annotations);
    
    // 隐藏预览
    setMultiPageNumberPreview(false);
    setMultiPageNumberWelds([]);
    setMultiPageOriginalNumberWelds([]);
    
    if (annotations && annotations.length > 0) {
      // 批量添加标注
      if (onBatchAddAnnotations) {
        onBatchAddAnnotations(annotations, null);
        message.success(`已添加 ${annotations.length} 个焊点标注`);
      }
      
      // 关闭相关调试面板
      setShowWeldNumbers(false);
      setShowWeldDebug(false);
      setShowVectorDebug(false);
    }
  }, [onBatchAddAnnotations]);

  const getAnnotationWeldPoint = useCallback((annotation) => {
    const x = Number.isFinite(annotation?.startX) ? annotation.startX : annotation?.endX;
    const y = Number.isFinite(annotation?.startY) ? annotation.startY : annotation?.endY;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }, []);

  const getWeldCenterPoint = useCallback((weld) => {
    if (weld?.center && Number.isFinite(weld.center.x) && Number.isFinite(weld.center.y)) {
      return weld.center;
    }
    if (weld?.boundingBox) {
      const { minX = 0, minY = 0, maxX, maxY, width = 0, height = 0 } = weld.boundingBox;
      const resolvedWidth = Number.isFinite(maxX) ? maxX - minX : width;
      const resolvedHeight = Number.isFinite(maxY) ? maxY - minY : height;
      return { x: minX + resolvedWidth / 2, y: minY + resolvedHeight / 2 };
    }
    return null;
  }, []);

  const extractEditableAnnotationsFromPdfBuffer = useCallback(async (arrayBuffer) => {
    if (!window.PDFLib?.PDFDocument) {
      throw new Error('PDFLib 未加载，无法读取可编辑标注');
    }
    const { PDFDocument, PDFName } = window.PDFLib;
    const pdfDoc = await PDFDocument.load(arrayBuffer.slice(0), { ignoreEncryption: true });
    let annotationData = null;

    const decodePdfValueText = (value) => {
      if (!value) return '';
      if (typeof value.decodeText === 'function') {
        try {
          return value.decodeText();
        } catch (error) {
          // fall through to raw decoding
        }
      }

      const raw = value.toString?.() || '';
      if (raw.startsWith('<feff') && raw.endsWith('>')) {
        const hex = raw.slice(5, -1);
        let text = '';
        for (let i = 0; i + 3 < hex.length; i += 4) {
          const code = parseInt(hex.slice(i, i + 4), 16);
          if (Number.isFinite(code)) text += String.fromCharCode(code);
        }
        return text;
      }
      if (raw.startsWith('(') && raw.endsWith(')')) {
        return raw.slice(1, -1);
      }
      return raw;
    };

    const extractRectNumbers = (rect) => {
      const values = rect?.asArray?.() || [];
      if (values.length >= 4) {
        return values.slice(0, 4).map(item => Number(item?.asNumber?.() ?? item));
      }
      const matches = (rect?.toString?.() || '').match(/-?\d+(?:\.\d+)?/g) || [];
      return matches.slice(0, 4).map(Number);
    };

    const normalizeNativeWeldText = (value) => {
      const text = String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
      if (!text) return '';
      const upper = text.toUpperCase();
      if (/^(?:E|N|S|EL|DN|ND|PT|NO|REV|DATE|PAGE|SHEET|SP)\b/.test(upper)) return '';
      if (/[+\-/.]/.test(upper)) return '';
      const tokens = upper.split(/\s+/).filter(Boolean);
      if (tokens.length !== 1) return '';
      const token = tokens[0];
      if (/^(?:DN|ND|EL|SP|PT|NO)\d/i.test(token)) return '';
      return /^[A-Z]{1,3}\d{1,4}$/.test(token) ? token : '';
    };

    const extractNativePdfSquareAnnotations = () => {
      const nativeAnnotations = [];
      for (let pageIndex = 0; pageIndex < pdfDoc.getPageCount(); pageIndex += 1) {
        const page = pdfDoc.getPage(pageIndex);
        const pageHeight = page.getHeight();
        const annots = page.node?.Annots?.();
        const annotRefs = annots?.asArray?.() || [];

        annotRefs.forEach((annotRef, annotIndex) => {
          const annot = pdfDoc.context.lookup(annotRef);
          const subtype = annot?.get?.(PDFName.of('Subtype'))?.toString?.();
          if (!['/Square', '/Circle', '/FreeText', '/Text'].includes(subtype)) return;

          const text = normalizeNativeWeldText(decodePdfValueText(annot.get(PDFName.of('Contents'))));
          if (!text) return;

          const rectNumbers = extractRectNumbers(annot.get(PDFName.of('Rect')));
          if (rectNumbers.length < 4 || rectNumbers.some(value => !Number.isFinite(value))) return;
          const [x1, y1, x2, y2] = rectNumbers;
          const minX = Math.min(x1, x2);
          const maxX = Math.max(x1, x2);
          const minY = Math.min(y1, y2);
          const maxY = Math.max(y1, y2);
          const width = maxX - minX;
          const height = maxY - minY;
          if (width < 3 || width > 80 || height < 3 || height > 80) return;

          const centerX = (minX + maxX) / 2;
          const centerY = pageHeight - ((minY + maxY) / 2);
          const sourceBox = {
            minX,
            minY: pageHeight - maxY,
            maxX,
            maxY: pageHeight - minY,
            width,
            height
          };
          nativeAnnotations.push({
            id: `native-square-${pageIndex + 1}-${annotIndex}-${text}`,
            type: 'text',
            page: pageIndex + 1,
            text,
            startX: centerX,
            startY: centerY,
            endX: centerX,
            endY: centerY,
            sourceBox,
            color: '#FF0000',
            fontSize: 34,
            frameSize: 56.7,
            borderShape: 'circle',
            hasLeaderLine: true,
            remark: 'Ep3d PDF原生标注',
            nativePdfAnnotation: true
          });
        });
      }
      return nativeAnnotations;
    };

    try {
      const keywords = pdfDoc.getKeywords();
      const keywordString = Array.isArray(keywords) ? keywords.join(' ') : (keywords || '');
      if (keywordString.includes('ANNOTATION_DATA:')) {
        const annotationMatch = keywordString.match(/ANNOTATION_DATA:([^:]+):([^:]+):(.+)/);
        if (annotationMatch && annotationMatch[3] && annotationMatch[3] !== 'ATTACHMENT') {
          annotationData = JSON.parse(annotationMatch[3]);
        }
      }
    } catch (error) {
      console.warn('[对照落图] 从 Keywords 读取标注失败:', error);
    }

    if (!annotationData) {
      const readStreamBytes = (stream) => {
        if (!stream) return null;
        if (typeof stream.decode === 'function') {
          try { return stream.decode(); } catch (error) { /* fallback */ }
        }
        const raw = stream.contents || (typeof stream.getContents === 'function' ? stream.getContents() : null);
        if (!raw) return null;
        const filter = stream.dict?.get?.(PDFName.of('Filter'))?.toString?.() || '';
        if (filter.includes('FlateDecode') && window.pako?.inflate) {
          try { return window.pako.inflate(raw); } catch (error) { return raw; }
        }
        return raw;
      };

      try {
        const indirectObjects = pdfDoc.context.enumerateIndirectObjects();
        for (const [, obj] of indirectObjects) {
          const dict = obj?.dict;
          if (!dict) continue;
          const typeObj = dict.get(PDFName.of('Type'));
          if (typeObj?.toString() !== '/Filespec') continue;
          const fName = dict.get(PDFName.of('F')) || dict.get(PDFName.of('UF'));
          const fileName = fName?.toString().replace(/[()]/g, '');
          if (fileName !== 'annotations.json') continue;

          const efDict = dict.get(PDFName.of('EF'));
          const embeddedFileRef = efDict?.get?.(PDFName.of('F'));
          const embeddedFileStream = embeddedFileRef ? pdfDoc.context.lookup(embeddedFileRef) : null;
          const attachmentBytes = readStreamBytes(embeddedFileStream);
          if (!attachmentBytes) continue;

          const jsonString = new TextDecoder().decode(attachmentBytes);
          if (jsonString.trim().startsWith('{')) {
            annotationData = JSON.parse(jsonString);
            break;
          }
        }
      } catch (error) {
        console.warn('[对照落图] 从附件读取 annotations.json 失败:', error);
      }
    }

    const annotations = Array.isArray(annotationData?.annotations) ? annotationData.annotations : [];
    if (annotations.length > 0) {
      return { annotations, pageCount: pdfDoc.getPageCount(), sourceType: 'editable' };
    }

    const nativeAnnotations = extractNativePdfSquareAnnotations();
    return { annotations: nativeAnnotations, pageCount: pdfDoc.getPageCount(), sourceType: 'native-square' };
  }, []);

  const detectWeldsFromVectorsForCompare = useCallback((vectors, pageNum, applyWeldArea = false) => {
    if (!Array.isArray(vectors) || vectors.length === 0) return [];
    const spatialIndex = new VectorSpatialIndex(vectors, 10000, 10000, 50);
    const recognizer = new ObjectRecognizer(vectors, spatialIndex);
    recognizer.detectWelds(null);
    let welds = recognizer.getDetectedWelds() || [];
    const pageInfo = multiPageBatchService.getPageInfo(pageNum, vectors);
    if (applyWeldArea && globalWeldRecognitionArea && pageInfo) {
      welds = welds.filter(weld => multiPageBatchService.isWeldInRecognitionArea(weld, globalWeldRecognitionArea, pageInfo));
    }
    try {
      associateWeldsWithSingleSegmentVectors(welds, vectors, 15);
    } catch (error) {
      console.warn('[对照落图] 焊点单线段关联失败:', error);
    }
    return welds.map((weld, index) => ({ ...weld, pageNum, pageIndex: index }));
  }, [globalWeldRecognitionArea]);

  const buildSourceAnnotationLeaderHints = useCallback((sourceAnnotations, vectors, sourceWelds) => {
    if (!Array.isArray(sourceAnnotations) || !Array.isArray(vectors) || !Array.isArray(sourceWelds)) {
      return new Map();
    }

    const toSegment = (vector) => {
      const x1 = Number(vector?.[1]);
      const y1 = Number(vector?.[2]);
      const x2 = Number(vector?.[3]);
      const y2 = Number(vector?.[4]);
      if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
      const length = Math.hypot(x2 - x1, y2 - y1);
      if (length <= 0) return null;
      return {
        vector,
        x1,
        y1,
        x2,
        y2,
        length,
        pathId: vector?.[7] ?? vector?.pathId ?? vector?.path_id ?? 'unknown',
        bbox: {
          minX: Math.min(x1, x2),
          minY: Math.min(y1, y2),
          maxX: Math.max(x1, x2),
          maxY: Math.max(y1, y2)
        }
      };
    };

    const expandBox = (box, pad) => ({
      minX: box.minX - pad,
      minY: box.minY - pad,
      maxX: box.maxX + pad,
      maxY: box.maxY + pad
    });
    const intersects = (a, b) => !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
    const pointInBox = (point, box, pad = 0) => (
      point.x >= box.minX - pad &&
      point.x <= box.maxX + pad &&
      point.y >= box.minY - pad &&
      point.y <= box.maxY + pad
    );
    const boxCenter = (box) => ({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 });
    const pointToBoxEdgeDistance = (point, box) => {
      if (point.x >= box.minX && point.x <= box.maxX) {
        return Math.min(Math.abs(point.y - box.minY), Math.abs(point.y - box.maxY));
      }
      if (point.y >= box.minY && point.y <= box.maxY) {
        return Math.min(Math.abs(point.x - box.minX), Math.abs(point.x - box.maxX));
      }
      return Math.min(
        Math.hypot(point.x - box.minX, point.y - box.minY),
        Math.hypot(point.x - box.maxX, point.y - box.minY),
        Math.hypot(point.x - box.maxX, point.y - box.maxY),
        Math.hypot(point.x - box.minX, point.y - box.maxY)
      );
    };

    const segments = vectors.map(toSegment).filter(Boolean);
    const groupsByPath = new Map();
    segments.forEach(segment => {
      const key = String(segment.pathId);
      if (!groupsByPath.has(key)) groupsByPath.set(key, []);
      groupsByPath.get(key).push(segment);
    });

    const pathGroups = Array.from(groupsByPath.entries()).map(([pathId, items]) => {
      const minX = Math.min(...items.map(item => item.bbox.minX));
      const minY = Math.min(...items.map(item => item.bbox.minY));
      const maxX = Math.max(...items.map(item => item.bbox.maxX));
      const maxY = Math.max(...items.map(item => item.bbox.maxY));
      return {
        pathId,
        items,
        bbox: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
      };
    });

    const sourceWeldCenters = sourceWelds
      .map(weld => ({ weld, center: getWeldCenterPoint(weld) }))
      .filter(item => item.center);

    const result = new Map();
    sourceAnnotations.forEach(annotation => {
      const annotationPoint = getAnnotationWeldPoint(annotation);
      if (!annotationPoint) return;
      const sourceBox = annotation.sourceBox || {
        minX: annotationPoint.x - 8,
        minY: annotationPoint.y - 8,
        maxX: annotationPoint.x + 8,
        maxY: annotationPoint.y + 8,
        width: 16,
        height: 16
      };
      const searchBox = expandBox(sourceBox, 14);
      const wrapper = pathGroups
        .filter(group => {
          const { width, height } = group.bbox;
          if (width < 8 || height < 8 || width > 46 || height > 46) return false;
          if (group.items.length < 3) return false;
          return intersects(group.bbox, searchBox);
        })
        .sort((a, b) => {
          const ca = boxCenter(a.bbox);
          const cb = boxCenter(b.bbox);
          return Math.hypot(ca.x - annotationPoint.x, ca.y - annotationPoint.y) -
            Math.hypot(cb.x - annotationPoint.x, cb.y - annotationPoint.y);
        })[0];
      if (!wrapper) return;

      const leaderCandidates = segments
        .filter(segment => {
          if (String(segment.pathId) === String(wrapper.pathId)) return false;
          if (segment.length < 8 || segment.length > 180) return false;
          const p1 = { x: segment.x1, y: segment.y1 };
          const p2 = { x: segment.x2, y: segment.y2 };
          const p1Touches = pointToBoxEdgeDistance(p1, wrapper.bbox) <= 4;
          const p2Touches = pointToBoxEdgeDistance(p2, wrapper.bbox) <= 4;
          if (p1Touches === p2Touches) return false;
          const remotePoint = p1Touches ? p2 : p1;
          if (pointInBox(remotePoint, wrapper.bbox, 2)) return false;
          if (segment.length < 13 && intersects(segment.bbox, sourceBox)) return false;
          return true;
        })
        .map(segment => {
          const p1 = { x: segment.x1, y: segment.y1 };
          const p2 = { x: segment.x2, y: segment.y2 };
          const p1Touches = pointToBoxEdgeDistance(p1, wrapper.bbox) <= 4;
          const remotePoint = p1Touches ? p2 : p1;
          let nearestWeld = null;
          let nearestWeldDistance = Infinity;
          sourceWeldCenters.forEach(item => {
            const d = Math.hypot(item.center.x - remotePoint.x, item.center.y - remotePoint.y);
            if (d < nearestWeldDistance) {
              nearestWeldDistance = d;
              nearestWeld = item.weld;
            }
          });
          const textPenalty = intersects(segment.bbox, sourceBox) ? 30 : 0;
          const lengthScore = Math.min(segment.length, 70) * 0.45;
          const weldScore = Number.isFinite(nearestWeldDistance) ? Math.max(0, 55 - nearestWeldDistance) : 0;
          return {
            segment,
            remotePoint,
            nearestWeld,
            nearestWeldDistance,
            score: lengthScore + weldScore - textPenalty
          };
        })
        .sort((a, b) => b.score - a.score);

      if (leaderCandidates.length === 0) return;
      const best = leaderCandidates[0];
      if (best.score < 8) return;
      const key = annotation.id || `${annotation.page}-${annotation.text}-${annotation.startX}-${annotation.startY}`;
      result.set(key, {
        wrapper,
        leader: best.segment,
        leaderRemotePoint: best.remotePoint,
        sourceWeld: best.nearestWeld,
        sourcePoint: best.remotePoint,
        confidence: leaderCandidates.length === 1 || best.score - (leaderCandidates[1]?.score ?? -Infinity) >= 12 ? 'high' : 'medium',
        score: best.score
      });
    });

    return result;
  }, [getAnnotationWeldPoint, getWeldCenterPoint]);

  const ensureTargetPageWeldsForCompare = useCallback(async (pageNum) => {
    let vectors = pageVectors[pageNum];
    if (!vectors || vectors.length === 0) {
      const page = pageObjectsRef?.current?.get?.(pageNum) || (pdfDocumentRef ? await pdfDocumentRef.getPage(pageNum) : null);
      if (!page) {
        throw new Error(`目标 PDF 第 ${pageNum} 页尚未加载`);
      }
      vectors = await VectorExtractionUtils.extractVectors(page);
      setPageVectors(prev => ({ ...prev, [pageNum]: vectors }));
    }
    return detectWeldsFromVectorsForCompare(vectors, pageNum, true);
  }, [detectWeldsFromVectorsForCompare, pageObjectsRef, pageVectors, pdfDocumentRef]);

  const detectSourcePageVectorsForCompare = useCallback(async (sourcePdfDocument, pageNum, sourceFile = null) => {
    const previousPdfFile = window.__currentPdfFile__;
    const previousPdfPath = window.__currentPdfPath__;
    if (sourceFile) {
      window.__currentPdfFile__ = sourceFile;
      window.__currentPdfPath__ = '';
    }
    try {
      const page = await sourcePdfDocument.getPage(pageNum);
      return await VectorExtractionUtils.extractVectors(page);
    } finally {
      window.__currentPdfFile__ = previousPdfFile;
      window.__currentPdfPath__ = previousPdfPath;
    }
  }, []);

  const detectSourcePageWeldsForCompare = useCallback(async (sourcePdfDocument, pageNum, sourceFile = null) => {
    const vectors = await detectSourcePageVectorsForCompare(sourcePdfDocument, pageNum, sourceFile);
    return detectWeldsFromVectorsForCompare(vectors, pageNum, false);
  }, [detectSourcePageVectorsForCompare, detectWeldsFromVectorsForCompare]);

  const normalizePointInBounds = useCallback((point, bounds) => ({
    x: bounds.width > 1e-6 ? (point.x - bounds.minX) / bounds.width : 0.5,
    y: bounds.height > 1e-6 ? (point.y - bounds.minY) / bounds.height : 0.5
  }), []);

  const buildPointBounds = useCallback((points) => {
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return { minX, minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
  }, []);

  const buildCompareOrderProfile = useCallback((items, pointKey, weldKey) => {
    const entries = (items || [])
      .map((item, index) => ({ item, index, point: item?.[pointKey], weld: item?.[weldKey] }))
      .filter(entry => entry.point && Number.isFinite(entry.point.x) && Number.isFinite(entry.point.y));
    const profile = new Map();
    if (entries.length === 0) return profile;

    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const endpointA = entries
      .map(entry => ({
        entry,
        spread: entries.reduce((sum, other) => sum + distance(entry.point, other.point), 0)
      }))
      .sort((a, b) => b.spread - a.spread)[0].entry;
    const endpointB = entries
      .map(entry => ({ entry, distance: distance(endpointA.point, entry.point) }))
      .sort((a, b) => b.distance - a.distance)[0].entry;
    const start = (endpointA.point.x + endpointA.point.y) <= (endpointB.point.x + endpointB.point.y) ? endpointA : endpointB;

    const remaining = new Set(entries.map(entry => entry.index));
    const ordered = [];
    let current = start;
    while (current && remaining.size > 0) {
      ordered.push(current);
      remaining.delete(current.index);
      const next = Array.from(remaining)
        .map(index => entries.find(entry => entry.index === index))
        .filter(Boolean)
        .map(entry => ({ entry, distance: distance(current.point, entry.point) }))
        .sort((a, b) => a.distance - b.distance)[0];
      current = next ? next.entry : null;
    }

    const denom = Math.max(ordered.length - 1, 1);
    ordered.forEach((entry, orderIndex) => {
      const seg = entry.item?.leaderHint?.leader || entry.weld?.relatedSegment || entry.weld?.relatedPipeline || null;
      const dx = Number(seg?.x2) - Number(seg?.x1);
      const dy = Number(seg?.y2) - Number(seg?.y1);
      profile.set(entry.item, {
        orderRatio: orderIndex / denom,
        angle: Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) > 0 ? Math.atan2(dy, dx) : null
      });
    });
    return profile;
  }, []);

  const buildCompareMatches = useCallback((sourceAnnotations, sourceWelds, targetWelds, sourceLeaderHints = new Map()) => {
    const sourceItems = sourceAnnotations
      .map((annotation, index) => {
        const annotationPoint = getAnnotationWeldPoint(annotation);
        if (!annotationPoint) return null;
        const hintKey = annotation.id || `${annotation.page}-${annotation.text}-${annotation.startX}-${annotation.startY}`;
        const leaderHint = sourceLeaderHints.get(hintKey);
        let nearestSourceWeld = null;
        let nearestDistance = Infinity;
        sourceWelds.forEach(weld => {
          const center = getWeldCenterPoint(weld);
          if (!center) return;
          const distance = Math.hypot(center.x - annotationPoint.x, center.y - annotationPoint.y);
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestSourceWeld = weld;
          }
        });
        const sourcePoint = leaderHint?.sourcePoint || (nearestSourceWeld ? getWeldCenterPoint(nearestSourceWeld) : annotationPoint);
        return {
          annotation,
          sourceWeld: leaderHint?.sourceWeld || nearestSourceWeld,
          sourcePoint,
          sourceIndex: index,
          leaderHint
        };
      })
      .filter(Boolean);

    const targetItems = targetWelds
      .map((weld, index) => ({ weld, targetPoint: getWeldCenterPoint(weld), targetIndex: index }))
      .filter(item => item.targetPoint);

    if (sourceItems.length === 0 || targetItems.length === 0) return [];

    const sourceBounds = buildPointBounds(sourceItems.map(item => item.sourcePoint));
    const targetBounds = buildPointBounds(targetItems.map(item => item.targetPoint));
    const sourceProfile = buildCompareOrderProfile(sourceItems, 'sourcePoint', 'sourceWeld');
    const targetProfile = buildCompareOrderProfile(targetItems, 'targetPoint', 'weld');
    const usedTargetIndexes = new Set();
    const angleDelta = (a, b) => {
      if (!Number.isFinite(a) || !Number.isFinite(b)) return 0.5;
      let diff = Math.abs(a - b) % Math.PI;
      if (diff > Math.PI / 2) diff = Math.PI - diff;
      return diff / (Math.PI / 2);
    };

    return sourceItems.map(sourceItem => {
      const sourceNormalized = normalizePointInBounds(sourceItem.sourcePoint, sourceBounds);
      const sourceTopo = sourceProfile.get(sourceItem);
      let best = null;
      targetItems.forEach(targetItem => {
        if (usedTargetIndexes.has(targetItem.targetIndex)) return;
        const targetNormalized = normalizePointInBounds(targetItem.targetPoint, targetBounds);
        const positionDistance = Math.hypot(
          sourceNormalized.x - targetNormalized.x,
          sourceNormalized.y - targetNormalized.y
        );
        const targetTopo = targetProfile.get(targetItem);
        const orderDistance = sourceTopo && targetTopo ? Math.abs(sourceTopo.orderRatio - targetTopo.orderRatio) : 0.5;
        const directionDistance = sourceTopo && targetTopo ? angleDelta(sourceTopo.angle, targetTopo.angle) : 0.5;
        const normalizedDistance = positionDistance * 0.38 + orderDistance * 0.48 + directionDistance * 0.14;
        if (!best || normalizedDistance < best.normalizedDistance) {
          best = { ...targetItem, normalizedDistance, positionDistance, orderDistance, directionDistance };
        }
      });

      const matched = best && best.normalizedDistance <= 0.26;
      if (matched) usedTargetIndexes.add(best.targetIndex);
      return {
        key: `${sourceItem.annotation.id || sourceItem.sourceIndex}-${sourceItem.sourceIndex}`,
        ...sourceItem,
        targetWeld: matched ? best.weld : null,
        targetPoint: matched ? best.targetPoint : null,
        targetIndex: matched ? best.targetIndex : null,
        normalizedDistance: best?.normalizedDistance ?? null,
        positionDistance: best?.positionDistance ?? null,
        orderDistance: best?.orderDistance ?? null,
        directionDistance: best?.directionDistance ?? null,
        status: matched ? 'matched' : 'unmatched'
      };
    });
  }, [buildCompareOrderProfile, buildPointBounds, getAnnotationWeldPoint, getWeldCenterPoint, normalizePointInBounds]);

  const handleCompareSourceFileChange = useCallback(async (event) => {
    const sourceFile = event.target.files?.[0];
    event.target.value = '';
    if (!sourceFile) return;
    try {
      setCompareProcessing(true);
      setCompareMatches([]);
      setCompareSummary(null);
      const arrayBuffer = await sourceFile.arrayBuffer();
      const { annotations: loadedAnnotations, pageCount, sourceType } = await extractEditableAnnotationsFromPdfBuffer(arrayBuffer);
      setCompareSourceFile({ file: sourceFile, arrayBuffer });
      setCompareSourceAnnotations(loadedAnnotations);
      setCompareSourcePageCount(pageCount || 0);
      setCompareSourcePage(1);
      if (sourceType === 'native-square' && loadedAnnotations.length > 0) {
        message.success(`已从 Ep3d PDF 原生注释读取 ${loadedAnnotations.length} 个焊口标注`);
        return;
      }
      if (loadedAnnotations.length === 0) {
        message.warning('未从 Ep3d PDF 读取到可编辑标注。请确认它是本软件导出的可编辑版 PDF。');
      } else {
        message.success(`已读取 Ep3d 可编辑标注 ${loadedAnnotations.length} 个`);
      }
    } catch (error) {
      console.error('[对照落图] 读取源 PDF 失败:', error);
      message.error(`读取 Ep3d PDF 失败：${error.message}`);
    } finally {
      setCompareProcessing(false);
    }
  }, [extractEditableAnnotationsFromPdfBuffer]);

  const handleRunCompareLayout = useCallback(async () => {
    if (!compareSourceFile?.arrayBuffer) {
      message.warning('请先选择 Ep3d 可编辑 PDF');
      return;
    }
    const sourcePage = Math.max(1, Number(compareSourcePage) || 1);
    const targetPage = Math.max(1, Number(compareTargetPage) || currentPage || 1);
    const sourcePageAnnotations = compareSourceAnnotations.filter(annotation => Number(annotation.page || 1) === sourcePage);
    if (sourcePageAnnotations.length === 0) {
      message.warning(`Ep3d PDF 第 ${sourcePage} 页没有可编辑标注`);
      return;
    }

    try {
      setCompareProcessing(true);
      const sourcePdf = await pdfjs.getDocument({ data: compareSourceFile.arrayBuffer.slice(0) }).promise;
      const [sourceVectors, detectedTargetWelds] = await Promise.all([
        detectSourcePageVectorsForCompare(sourcePdf, sourcePage, compareSourceFile.file),
        ensureTargetPageWeldsForCompare(targetPage)
      ]);
      const sourceWelds = detectWeldsFromVectorsForCompare(sourceVectors, sourcePage, false);
      const sourceLeaderHints = buildSourceAnnotationLeaderHints(sourcePageAnnotations, sourceVectors, sourceWelds);
      const visibleTargetWelds = Number(targetPage) === Number(currentPage) && Array.isArray(displayedWelds) && displayedWelds.length > 0
        ? displayedWelds.map((weld, index) => ({ ...weld, pageNum: targetPage, pageIndex: index }))
        : [];
      const targetWelds = visibleTargetWelds.length > 0 ? visibleTargetWelds : detectedTargetWelds;

      const matches = buildCompareMatches(sourcePageAnnotations, sourceWelds, targetWelds, sourceLeaderHints);
      setCompareMatches(matches);
      setCompareSummary({
        sourcePage,
        targetPage,
        sourceAnnotationCount: sourcePageAnnotations.length,
        sourceWeldCount: sourceWelds.length,
        targetWeldCount: targetWelds.length,
        matchedCount: matches.filter(item => item.status === 'matched').length,
        sourceLeaderCount: sourceLeaderHints.size
      });
      message.success(`对照完成：匹配 ${matches.filter(item => item.status === 'matched').length}/${sourcePageAnnotations.length} 个标注`);
    } catch (error) {
      console.error('[对照落图] 对照识别失败:', error);
      message.error(`对照识别失败：${error.message}`);
    } finally {
      setCompareProcessing(false);
    }
  }, [
    buildCompareMatches,
    buildSourceAnnotationLeaderHints,
    compareSourceAnnotations,
    compareSourceFile,
    compareSourcePage,
    compareTargetPage,
    currentPage,
    detectSourcePageVectorsForCompare,
    detectWeldsFromVectorsForCompare,
    displayedWelds,
    ensureTargetPageWeldsForCompare
  ]);

  const handleApplyCompareLayout = useCallback(() => {
    const matched = compareMatches.filter(item => item.status === 'matched' && item.targetWeld && item.annotation);
    if (matched.length === 0) {
      message.warning('没有可生成的匹配标注');
      return;
    }
    const targetPage = compareSummary?.targetPage || compareTargetPage || currentPage;
    const layoutInput = matched.map(item => ({
      ...item.targetWeld,
      number: item.annotation.text,
      weldNumber: item.annotation.text
    }));
    const layoutData = calculateWeldLayout(
      layoutInput,
      PDF_LAYOUT_BASE_SCALE,
      'KEEP_ORDER',
      undefined,
      undefined,
      getPageTextRegions(targetPage, textDetections),
      {
        normalizedPlacementArea: latestAreasRef.current.weldRecognition || globalWeldRecognitionArea,
        graphicVectors: pageVectors[targetPage] || [],
        circleDiameter: annotationFrameSize || 56.7,
        allowLeaderThroughGraphics: true,
        allowLeaderCrossing: false
      }
    );
    const nextAnnotations = layoutData.map((item, index) => {
      const sourceAnnotation = matched[index].annotation;
      const editableSourceAnnotation = { ...(sourceAnnotation || {}) };
      delete editableSourceAnnotation.nativePdfAnnotation;
      delete editableSourceAnnotation.sourceBox;
      delete editableSourceAnnotation.compareSource;
      return {
        ...editableSourceAnnotation,
        id: `compare-layout-${targetPage}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'text',
        page: targetPage,
        startX: item.startX,
        startY: item.startY,
        endX: item.endX,
        endY: item.endY,
        hasLeaderLine: sourceAnnotation.hasLeaderLine !== false,
        nativePdfAnnotation: false,
        isUploaded: false,
        compareSource: {
          sourceFileName: compareSourceFile?.file?.name || '',
          sourcePage: compareSummary?.sourcePage || compareSourcePage,
          targetPage,
          matchDistance: matched[index].normalizedDistance
        }
      };
    });
    onBatchAddAnnotations?.(nextAnnotations, null);
    message.success(`已生成 ${nextAnnotations.length} 个对照标注`);
  }, [
    compareMatches,
    compareSourceFile,
    compareSourcePage,
    compareSummary,
    compareTargetPage,
    currentPage,
    onBatchAddAnnotations,
    textDetections
  ]);

  const getMaterialKey = useCallback((material) => {
    const sourceDocument = String(
      material?.sourceDocument ||
      material?.documentKey ||
      material?.pdfFileName ||
      material?.fileName ||
      ''
    ).trim();
    const identity = [
      material?.pipelineNumber,
      material?.materialCode || material?.itemCode,
      material?.description,
      material?.specification,
      material?.diameter
    ].map(value => String(value || '').trim().normalize('NFKC').toUpperCase()).join('|');
    return [sourceDocument, identity].filter(Boolean).join('::');
  }, []);

  const getFittingMaterialSignature = useCallback((material) => {
    const normalize = (value) => String(value ?? '')
      .normalize('NFKC')
      .trim()
      .replace(/[×＊*]/g, 'X')
      .replace(/\s+/g, ' ')
      .toUpperCase();
    const normalizeSignaturePart = (value) => normalize(value)
      .replace(/[|,;:：，；。.'"`~!@#$%^&()_+=[\]{}<>?/\\\-\s]+/g, '');
    const description = normalize(
      material?.description ||
      material?.rawMaterial?.DESCRIPTION ||
      material?.rawMaterial?.['材料描述'] ||
      material?.type ||
      ''
    );
    const specification = normalize(
      material?.specification ||
      material?.diameter ||
      material?.ND ||
      material?.DN ||
      material?.['\u89c4\u683c'] ||
      material?.['\u7ba1\u5f84'] ||
      material?.rawMaterial?.specification ||
      material?.rawMaterial?.['\u89c4\u683c'] ||
      material?.rawMaterial?.['\u7ba1\u5f84'] ||
      material?.rawMaterial?.ND ||
      material?.rawMaterial?.DN ||
      ''
    );
    const materialCode = normalize(
      material?.materialCode ||
      material?.itemCode ||
      material?.rawMaterial?.ITEM_CODE ||
      material?.rawMaterial?.itemCode ||
      material?.rawMaterial?.['材料代码'] ||
      material?.rawMaterial?.['材料编码'] ||
      ''
    );
    return `${normalizeSignaturePart(description)}|${normalizeSignaturePart(specification)}|${normalizeSignaturePart(materialCode)}`;
  }, []);

  const getMaterialDnTokens = useCallback((material) => {
    const sources = [
      material?.diameter,
      material?.ND,
      material?.DN,
      material?.specification,
      material?.rawMaterial?.diameter,
      material?.rawMaterial?.ND,
      material?.rawMaterial?.DN,
      material?.rawMaterial?.specification
    ].map(value => String(value || '').normalize('NFKC').toUpperCase()).filter(Boolean);

    const tokens = new Set();
    sources.forEach(source => {
      const normalized = source.replace(/[×＊*]/g, 'X');
      const matches = normalized.match(/\d+(?:\.\d+)?/g) || [];
      matches.forEach(match => tokens.add(match.replace(/\.0+$/, '')));
    });
    return Array.from(tokens);
  }, []);

  const isPipeMaterial = useCallback((material) => {
    const text = [
      material?.description,
      material?.type,
      material?.category,
      material?.jointType,
      material?.rawMaterial?.DESCRIPTION,
      material?.rawMaterial?.['材料描述']
    ].map(value => String(value || '').normalize('NFKC').toUpperCase()).join(' ');

    if (/三通|\bTEE\b|弯头|弯管|\bELBOW\b|法兰|\bFLANGE\b|垫片|\bGASKET\b|阀|\bVALVE\b|螺栓|\bBOLT\b|支架|\bSUPPORT\b/.test(text)) {
      return false;
    }
    return /管子|管材|钢管|无缝钢管|焊管|\bPIPE\b|\bSMLS\b|\bERW\b/.test(text);
  }, []);

  const findMatchingPipeMaterial = useCallback((diameter, fittingMaterial) => {
    const target = String(diameter || '').replace(/\.0+$/, '');
    if (!target) return null;
    const fittingPipeline = String(fittingMaterial?.pipelineNumber || fittingMaterial?.rawMaterial?.pipelineNumber || '').trim();
    return (materialRows || []).find(row => {
      if (!isPipeMaterial(row)) return false;
      const rowPipeline = String(row?.pipelineNumber || row?.rawMaterial?.pipelineNumber || '').trim();
      if (fittingPipeline && rowPipeline && fittingPipeline !== rowPipeline) return false;
      return getMaterialDnTokens(row).includes(target);
    }) || null;
  }, [getMaterialDnTokens, isPipeMaterial, materialRows]);

  const buildAnnotationMaterialUpdates = useCallback((annotation, material) => {
    const materialKey = getMaterialKey(material);
    if (!materialKey) return null;

    const existingBindings = Array.isArray(annotation.materialBindings)
      ? annotation.materialBindings.filter(Boolean)
      : (annotation.materialBinding ? [annotation.materialBinding] : []);
    const existingKeys = new Set(existingBindings.map(getMaterialKey).filter(Boolean));
    if (existingKeys.has(materialKey)) return null;
    if (existingBindings.length >= 2) return null;

    const nextBindings = [...existingBindings, { ...material }];
    const materialNumbers = nextBindings.map(item => item.materialId).filter(Boolean);
    return {
      materialBinding: nextBindings[0] || null,
      materialBindings: nextBindings,
      materialNumber: materialNumbers.join(', '),
      materialBindingPage: nextBindings[0]?.sourcePage || annotation.materialBindingPage || ''
    };
  }, [getMaterialKey]);

  const parseFittingDiameterRoles = useCallback((material) => {
    const raw = String(
      material?.specification ||
      material?.diameter ||
      material?.ND ||
      material?.DN ||
      material?.rawMaterial?.specification ||
      material?.rawMaterial?.ND ||
      material?.rawMaterial?.DN ||
      ''
    ).normalize('NFKC').toUpperCase();
    const numbers = Array.from(raw.matchAll(/\d+(?:\.\d+)?/g))
      .map(match => Number(match[0]))
      .filter(value => Number.isFinite(value) && value > 0);
    const unique = Array.from(new Set(numbers)).sort((a, b) => b - a);
    if (unique.length >= 2) {
      return {
        main: String(unique[0]),
        branch: String(unique[unique.length - 1]),
        isReducing: unique[0] !== unique[unique.length - 1]
      };
    }
    const same = unique.length === 1 ? String(unique[0]) : '';
    return { main: same, branch: same, isReducing: false };
  }, []);

  const createFittingRoleMaterial = useCallback((material, role, diameter) => ({
    ...material,
    diameter: diameter || material?.diameter || material?.specification || '',
    fittingConnectionRole: role,
    fittingOriginalDiameter: material?.diameter || '',
    fittingOriginalSpecification: material?.specification || ''
  }), []);

  const distancePointToSegment = useCallback((point, start, end) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len2 = dx * dx + dy * dy;
    if (!len2) {
      return Math.sqrt((point.x - start.x) ** 2 + (point.y - start.y) ** 2);
    }
    const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / len2));
    const projection = {
      x: start.x + t * dx,
      y: start.y + t * dy
    };
    return Math.sqrt((point.x - projection.x) ** 2 + (point.y - projection.y) ** 2);
  }, []);

  const findNearestWeldForTeeArm = useCallback((arm, weldAnnotations, usedAnnotationIds) => {
    const segment = arm?.segment;
    if (!segment?.start || !segment?.end) return null;
    const start = {
      x: segment.start.x * PDF_LAYOUT_BASE_SCALE,
      y: segment.start.y * PDF_LAYOUT_BASE_SCALE
    };
    const end = {
      x: segment.end.x * PDF_LAYOUT_BASE_SCALE,
      y: segment.end.y * PDF_LAYOUT_BASE_SCALE
    };

    return weldAnnotations
      .filter(annotation => !usedAnnotationIds.has(annotation.id))
      .map(annotation => {
        const point = getAnnotationWeldPoint(annotation);
        if (!point) return null;
        return {
          annotation,
          distance: distancePointToSegment(point, start, end)
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance)[0] || null;
  }, [distancePointToSegment, getAnnotationWeldPoint]);

  const handleAutoBindFittingMaterials = useCallback((fittings = [], targetPage = currentPage) => {
    if (!Array.isArray(fittings) || fittings.length === 0) {
      message.warning('当前页没有可用的管件候选');
      return;
    }
    if (!onBatchAnnotationUpdates) {
      message.warning('当前版本缺少批量更新能力，无法自动绑定');
      return;
    }

    const boundFittings = fittings
      .map(fitting => ({
        ...fitting,
        material: Array.isArray(fitting.materialBindings) ? fitting.materialBindings[0] : null
      }))
      .filter(fitting => fitting.material && getMaterialKey(fitting.material));

    if (boundFittings.length === 0) {
      message.warning('请先给弯头或三通绑定材料');
      return;
    }

    const getFittingType = (fitting) => {
      if (fitting?.type === 'tee-fitting') return 'tee-fitting';
      if (fitting?.type === 'valve-fitting') return 'valve-fitting';
      return 'elbow';
    };
    const getFittingMaterialGroup = (fitting) => {
      if (fitting?.branchOutlet) return 'branch-outlet';
      const type = getFittingType(fitting);
      if (type !== 'elbow') return type;
      const nominalAngle = Number(fitting?.nominalAngle || fitting?.elbowAngle);
      return Number.isFinite(nominalAngle) ? `elbow-${nominalAngle}` : type;
    };

    const typeMaterialKeys = new Map();
    boundFittings.forEach(fitting => {
      const group = getFittingMaterialGroup(fitting);
      if (!typeMaterialKeys.has(group)) typeMaterialKeys.set(group, new Set());
      typeMaterialKeys.get(group).add(getFittingMaterialSignature(fitting.material));
    });

    const blockedTypes = new Set(
      Array.from(typeMaterialKeys.entries())
        .filter(([, keys]) => keys.size > 1)
        .map(([type]) => type)
    );

    const weldAnnotations = (annotations || []).filter(annotation => (
      annotation?.page === targetPage &&
      annotation?.type === 'text' &&
      !annotation?.isScaffoldAnnotation &&
      !annotation?.isValveAnnotation
    ));

    if (weldAnnotations.length === 0) {
      message.warning('当前页没有可绑定的焊口标注');
      return;
    }

    const pageWidth = pageSize?.width || 1200;
    const pageHeight = pageSize?.height || 900;
    const pageDiagonal = Math.sqrt(pageWidth * pageWidth + pageHeight * pageHeight);
    const maxDistance = Math.max(40, Math.min(70, pageDiagonal * 0.035));
    const updatesById = {};
    let distanceSkipped = 0;
    let fullSkipped = 0;
    let typeSkipped = 0;

    boundFittings.forEach(fitting => {
      const fittingType = getFittingType(fitting);
      if (blockedTypes.has(getFittingMaterialGroup(fitting))) {
        typeSkipped += 1;
        return;
      }

      if (fitting.branchOutlet) {
        const diameterRoles = parseFittingDiameterRoles(fitting.material);
        const branchDiameter = diameterRoles.branch || diameterRoles.main;
        const outletMaterial = createFittingRoleMaterial(fitting.material, 'branch', branchDiameter);
        const branchPipeMaterial = findMatchingPipeMaterial(branchDiameter, fitting.material);
        const toLayoutPoint = (point) => point ? ({
          x: Number(point.x) * PDF_LAYOUT_BASE_SCALE,
          y: Number(point.y) * PDF_LAYOUT_BASE_SCALE
        }) : null;
        const mainPoint = toLayoutPoint(fitting.mainConnectionPoint);
        const branchPoint = toLayoutPoint(fitting.branchConnectionPoint);
        const fittingCenter = toLayoutPoint(fitting.center);
        const nearestToPoint = (point, excludedIds = new Set()) => {
          if (!point) return null;
          return weldAnnotations
            .filter(annotation => !excludedIds.has(annotation.id))
            .map(annotation => {
              const weldPoint = getAnnotationWeldPoint(annotation);
              if (!weldPoint) return null;
              return {
                annotation,
                distance: Math.sqrt((weldPoint.x - point.x) ** 2 + (weldPoint.y - point.y) ** 2)
              };
            })
            .filter(Boolean)
            .sort((a, b) => a.distance - b.distance)[0] || null;
        };

        const mainMatch = nearestToPoint(mainPoint || fittingCenter);
        const usedIds = new Set(mainMatch ? [mainMatch.annotation.id] : []);
        const branchMatch = nearestToPoint(branchPoint || fittingCenter, usedIds);
        if (!mainMatch || mainMatch.distance > maxDistance || (branchMatch && branchMatch.distance > maxDistance)) {
          distanceSkipped += 1;
          return;
        }

        const mainBase = updatesById[mainMatch.annotation.id]
          ? { ...mainMatch.annotation, ...updatesById[mainMatch.annotation.id] }
          : mainMatch.annotation;
        const mainUpdates = buildAnnotationMaterialUpdates(mainBase, outletMaterial) || {};
        updatesById[mainMatch.annotation.id] = {
          ...mainUpdates,
          jointTypeText: 'OL'
        };

        if (branchMatch) {
          const branchBase = updatesById[branchMatch.annotation.id]
            ? { ...branchMatch.annotation, ...updatesById[branchMatch.annotation.id] }
            : branchMatch.annotation;
          const outletUpdates = buildAnnotationMaterialUpdates(branchBase, outletMaterial) || {};
          const pipeUpdates = branchPipeMaterial
            ? buildAnnotationMaterialUpdates({ ...branchBase, ...outletUpdates }, branchPipeMaterial)
            : null;
          updatesById[branchMatch.annotation.id] = pipeUpdates || outletUpdates;
        }
        return;
      }

      if (fittingType === 'tee-fitting' && fitting.teeTopology?.branchArm && Array.isArray(fitting.teeTopology?.mainArms)) {
        const diameterRoles = parseFittingDiameterRoles(fitting.material);
        const mainPipeMaterial = findMatchingPipeMaterial(diameterRoles.main, fitting.material);
        const branchPipeMaterial = findMatchingPipeMaterial(diameterRoles.branch, fitting.material);
        const armTargets = [
          ...fitting.teeTopology.mainArms.map(arm => ({
            arm,
            role: 'main',
            material: createFittingRoleMaterial(fitting.material, 'main', diameterRoles.main),
            pipeMaterial: mainPipeMaterial
          })),
          {
            arm: fitting.teeTopology.branchArm,
            role: 'branch',
            material: createFittingRoleMaterial(fitting.material, 'branch', diameterRoles.branch),
            pipeMaterial: branchPipeMaterial
          }
        ];
        const usedAnnotationIds = new Set();
        let failed = false;

        armTargets.forEach(({ arm, material, pipeMaterial }) => {
          if (failed) return;
          const nearest = findNearestWeldForTeeArm(arm, weldAnnotations, usedAnnotationIds);
          if (!nearest || nearest.distance > maxDistance) {
            failed = true;
            return;
          }
          usedAnnotationIds.add(nearest.annotation.id);
          const baseAnnotation = updatesById[nearest.annotation.id]
            ? { ...nearest.annotation, ...updatesById[nearest.annotation.id] }
            : nearest.annotation;
          const updates = buildAnnotationMaterialUpdates(baseAnnotation, material);
          if (!updates) {
            fullSkipped += 1;
            return;
          }
          if (pipeMaterial) {
            const pipeUpdates = buildAnnotationMaterialUpdates(
              { ...baseAnnotation, ...updates },
              pipeMaterial
            );
            updatesById[nearest.annotation.id] = pipeUpdates || updates;
          } else {
            updatesById[nearest.annotation.id] = updates;
          }
        });

        if (failed) {
          distanceSkipped += 1;
        }
        return;
      }

      const requiredWeldCount = fittingType === 'tee-fitting' ? 3 : 2;
      const diameterRoles = fittingType === 'elbow' ? parseFittingDiameterRoles(fitting.material) : null;
      const elbowPipeMaterial = (
        fittingType === 'elbow'
        && diameterRoles
        && diameterRoles.main
        && diameterRoles.main === diameterRoles.branch
      )
        ? findMatchingPipeMaterial(diameterRoles.main, fitting.material)
        : null;
      const target = {
        x: (fitting.center?.x || 0) * PDF_LAYOUT_BASE_SCALE,
        y: (fitting.center?.y || 0) * PDF_LAYOUT_BASE_SCALE
      };

      const nearest = weldAnnotations
        .map(annotation => {
          const point = getAnnotationWeldPoint(annotation);
          if (!point) return null;
          const distance = Math.sqrt((point.x - target.x) ** 2 + (point.y - target.y) ** 2);
          return { annotation, distance };
        })
        .filter(Boolean)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, requiredWeldCount);

      if (nearest.length < requiredWeldCount || nearest.some(item => item.distance > maxDistance)) {
        distanceSkipped += 1;
        return;
      }

      nearest.forEach(({ annotation }) => {
        const baseAnnotation = updatesById[annotation.id]
          ? { ...annotation, ...updatesById[annotation.id] }
          : annotation;
        const updates = buildAnnotationMaterialUpdates(baseAnnotation, fitting.material);
        if (!updates) {
          fullSkipped += 1;
          return;
        }
        if (elbowPipeMaterial) {
          const pipeUpdates = buildAnnotationMaterialUpdates(
            { ...baseAnnotation, ...updates },
            elbowPipeMaterial
          );
          updatesById[annotation.id] = pipeUpdates || updates;
        } else {
          updatesById[annotation.id] = updates;
        }
      });
    });

    if (Object.keys(updatesById).length > 0) {
      onBatchAnnotationUpdates(updatesById, '自动绑定管件材料到焊口');
      message.success(`已自动绑定 ${Object.keys(updatesById).length} 个焊口`);
      return;
    }

    if (typeSkipped > 0) {
      message.warning('同一页同类管件存在多种材料，已跳过自动绑定');
    } else if (distanceSkipped > 0) {
      message.warning('最近焊口距离过大，已跳过自动绑定');
    } else if (fullSkipped > 0) {
      message.warning('焊口材料已满或已绑定相同材料，无需更新');
    } else {
      message.warning('没有可自动绑定的焊口');
    }
  }, [
    annotations,
    buildAnnotationMaterialUpdates,
    createFittingRoleMaterial,
    currentPage,
    findMatchingPipeMaterial,
    findNearestWeldForTeeArm,
    getAnnotationWeldPoint,
    getFittingMaterialSignature,
    getMaterialKey,
    onBatchAnnotationUpdates,
    pageSize,
    parseFittingDiameterRoles
  ]);

  useEffect(() => {
    setPagePipelineAlerts({});
    setPipelineComparisonSummary(null);
  }, [file, pdfFilePath]);

  useEffect(() => {
    syncPipelineAlertsFromService();
  }, [currentPage, showMultiPagePanel, syncPipelineAlertsFromService]);

  // 包装Document的onLoadSuccess，捕获pdfDocument
  const handleDocumentLoadSuccess = useCallback((pdf) => {
    console.log('📄 PDF文档加载成功，保存文档引用');
    setPdfDocumentRef(pdf);
    setPdfDocumentCacheKey(singlePageSnapshotDocumentKey);
    onPdfDocumentChange?.(pdf);
    onDocumentLoadSuccess(pdf);
  }, [onDocumentLoadSuccess, onPdfDocumentChange, singlePageSnapshotDocumentKey]);

  if (!file) {
    return (
      <EmptyContainer>
        <Empty
          description={
            <div>
              <div>请选择要查看的PDF文件</div>
              <div style={{ fontSize: '12px', color: '#666', marginTop: '8px' }}>
                使用说明：<br/>
                • 滚轮缩放图纸，自然滚动浏览<br/>
                • 右键拖拽移动图纸<br/>
                • 左键进行标注操作<br/>
                • 使用右侧滚动按钮或Page Up/Down键快速翻页<br/>
                • Ctrl+Home/End 跳转到文档开头/结尾
              </div>
            </div>
          }
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      </EmptyContainer>
    );
  }

  if (error) {
    return (
      <ViewerContainer $rulesPanelVisible={rulesPanelVisible}>
        <Alert
          message="加载错误"
          description={error}
          type="error"
          showIcon
          style={{ margin: '20px', maxWidth: '500px' }}
        />
      </ViewerContainer>
    );
  }

  const hasManualWeldInsertions = (multiPageNumberWelds || []).some(weld => weld?.isManualInserted);
  const hasPendingWeldDeletions = (multiPageNumberWelds || []).some(weld => (
    Array.isArray(weld?.replacementSourceAnnotationIds) &&
    weld.replacementSourceAnnotationIds.length > 0
  ));
  const canGenerateWeldAnnotations = numberingSegments.length > 0 || (
    multiPageNumberPreview &&
    multiPageNumberWelds.length > 0 &&
    (hasManualWeldInsertions || hasPendingWeldDeletions)
  );
  const currentNumberingPipelineNumber = getNumberingPagePipelineNumber(currentPage, displayedWelds);
  // Building the corrected cross-page sequence is substantially more
  // expensive than selecting one page from it. Keep it stable while paging;
  // rebuild only when the numbering data or correction rules actually change.
  const stableMultiPageNumberingSequenceForPreview = useMemo(() => {
    if (!multiPageNumberPreview) return [];
    // Insert/delete already commits one conflict-resolved, cross-page sequence
    // to multiPageNumberWelds. Replaying every historical manual operation on
    // every click is increasingly expensive and can briefly hide the point
    // that was just inserted. The adjustment preview must display that source
    // of truth directly; final generation still performs the full rebuild.
    if (manualWeldInsertMode || manualWeldDeleteMode) {
      return multiPageNumberWelds;
    }
    return rebuildStableMultiPageSequence(true);
  }, [
    manualWeldDeleteMode,
    manualWeldInsertMode,
    multiPageNumberPreview,
    multiPageNumberWelds,
    rebuildStableMultiPageSequence
  ]);

  const orderedNumberingWeldsForPreview = useMemo(() => {
    if (multiPageNumberPreview) {
      return stableMultiPageNumberingSequenceForPreview.filter(
        weld => Number(weld?.page || weld?.pageNum) === Number(currentPage)
      );
    }

    const previewStartNum = activeAnnotationRule
      ? resolvePipelineScopedStartNumber(activeAnnotationRule, currentNumberingPipelineNumber)
      : 1;
    const increment = activeAnnotationRule ? (activeAnnotationRule.increment !== undefined ? activeAnnotationRule.increment : 1) : 1;
    const prefix = activeAnnotationRule?.prefix || '';
    const suffix = activeAnnotationRule?.suffix || '';

    let nextNumber = previewStartNum;
    const currentPagePreview = [];
    const pages = Array.from(new Set(
      (numberingSegments || [])
        .map(segment => Number(segment.page || currentPage))
        .filter(Boolean)
    )).sort((a, b) => a - b);

    pages.forEach(pageNum => {
      const pageSegments = (numberingSegments || []).filter(segment => (
        Number(segment.page || currentPage) === Number(pageNum)
      ));
      if (pageSegments.length === 0) return;

      const pageWelds = getNumberingWeldsForPage(pageNum);
      const hiddenKeys = getNumberlessWeldKeysForPage(pageSegments, pageWelds);
      const seenKeys = new Set();

      pageSegments.forEach(segment => {
        const range = getNumberingSegmentRangeForPage(segment, pageNum, pageWelds);
        range.forEach(weld => {
          const pageAwareKey = getPageAwareWeldSelectionKey(weld, pageNum);
          if (!pageAwareKey || seenKeys.has(pageAwareKey)) return;
          seenKeys.add(pageAwareKey);

          const rawNumber = nextNumber;
          const hidden = hiddenKeys.has(getWeldSelectionKey(weld));
          const previewNumber = hidden
            ? ''
            : (activeAnnotationRule ? `${prefix}${rawNumber}${suffix}` : rawNumber);

          if (Number(pageNum) === Number(currentPage)) {
            currentPagePreview.push({
              ...weld,
              page: pageNum,
              number: previewNumber
            });
          }

          nextNumber += increment;
        });
      });
    });

    return currentPagePreview;
  }, [
    activeAnnotationRule,
    currentNumberingPipelineNumber,
    currentPage,
    getNumberingSegmentRangeForPage,
    getNumberingWeldsForPage,
    getNumberlessWeldKeysForPage,
    getPageAwareWeldSelectionKey,
    getWeldSelectionKey,
    multiPageNumberPreview,
    numberingSegments,
    stableMultiPageNumberingSequenceForPreview,
    resolvePipelineScopedStartNumber
  ]);

  const handleAnnotationLayerMouseDown = useCallback((e, pageNumber) => {
    if (!annotationMode && !pipeSegmentMode && !areaDeleteMode && !e.ctrlKey) {
      clearMultiSelection();
    }

    if (areaDeleteMode) {
      handleAreaDeleteMouseDown(e);
    } else if (pipeSegmentMode) {
      handlePipeSegmentClick(e, pageNumber);
    } else {
      handleAnnotationStart(e, pageNumber);
    }
  }, [
    annotationMode,
    pipeSegmentMode,
    areaDeleteMode,
    clearMultiSelection,
    handleAreaDeleteMouseDown,
    handlePipeSegmentClick,
    handleAnnotationStart
  ]);

  const updatePdfPointerPosition = useCallback((event) => {
    if (!onPdfPointerPositionChange) return;
    latestPdfPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    if (pdfPointerFrameRef.current !== null) return;
    pdfPointerFrameRef.current = window.requestAnimationFrame(() => {
      pdfPointerFrameRef.current = null;
      const pointer = latestPdfPointerRef.current;
      if (!pointer) return;

      // Single-page mode is the normal path. Reading only its rectangle avoids
      // repeated layout work against historical page refs during mouse moves.
      const currentElement = pageRefsRef.current?.[Number(currentPage)];
      const pageEntries = currentElement
        ? [[String(currentPage), currentElement]]
        : Object.entries(pageRefsRef.current || {});
      for (const [pageNumberText, pageElement] of pageEntries) {
        if (!pageElement) continue;
        const rect = pageElement.getBoundingClientRect();
        const isInsidePage =
          pointer.clientX >= rect.left &&
          pointer.clientX <= rect.right &&
          pointer.clientY >= rect.top &&
          pointer.clientY <= rect.bottom;
        if (!isInsidePage) continue;
        onPdfPointerPositionChange({
          page: Number(pageNumberText),
          x: (pointer.clientX - rect.left) / scale,
          y: (pointer.clientY - rect.top) / scale
        });
        return;
      }
      onPdfPointerPositionChange(null);
    });
  }, [currentPage, onPdfPointerPositionChange, pageRefsRef, scale]);

  useEffect(() => () => {
    if (pdfPointerFrameRef.current !== null) {
      window.cancelAnimationFrame(pdfPointerFrameRef.current);
      pdfPointerFrameRef.current = null;
    }
  }, []);

  const handleViewerMouseMove = useCallback((event) => {
    handleMouseMove(event);
    updatePdfPointerPosition(event);
  }, [handleMouseMove, updatePdfPointerPosition]);

  const currentPageNumberingSegments = (numberingSegments || []).filter(segment => (
    Number(segment?.page || currentPage) === Number(currentPage)
  ));
  const hiddenNumberWeldKeysForPreview = Array.from(
    getNumberlessWeldKeysForPage(
      currentPageNumberingSegments,
      getNumberingWeldsForPage(currentPage)
    )
  );

  const numberingControlPanelPortal = (
    showWeldNumbers &&
    showWeldDebug &&
    (
      displayedWelds.length > 0 ||
      multiPageNumberPreview
    ) &&
    typeof document !== 'undefined'
  ) ? createPortal((
    <div style={{
      position: 'fixed',
      top: 86,
      right: 24,
      zIndex: 2147483647,
      pointerEvents: 'auto'
    }}>
      <div style={{
        background: 'rgba(255, 255, 255, 0.98)',
        border: '1px solid #d9d9d9',
        borderRadius: 8,
        padding: 12,
        width: 760,
        maxWidth: 'calc(100vw - 48px)',
        boxShadow: '0 6px 18px rgba(0,0,0,0.18)'
      }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          {reopenedPdfSupplementMode && pendingNumberingAnnotations.length === 0 && !manualWeldInsertMode && !manualWeldDeleteMode
            ? '已打开 PDF：设置插入序号后开始补焊点'
            : pendingNumberingAnnotations.length > 0
            ? '标注结果预览：请确认是否正式生成'
            : manualWeldInsertMode
            ? '补焊点：请点击图纸中的焊点中心'
            : manualWeldDeleteMode
            ? '删除焊点：请点击需要删除的红圈焊点'
            : (selectedStartWeld ? '请选择本段终点' : '请选择本段起点')}
        </div>
        {pendingNumberingAnnotations.length === 0 && (
          <div style={{ fontSize: 13, color: '#595959', marginBottom: 8 }}>
            已添加 {numberingSegments.length} 个编号段
          </div>
        )}
        {multiPageNumberPreview && pendingNumberingAnnotations.length === 0 && (
          <div style={{
            marginBottom: 8,
            padding: 8,
            border: manualWeldDeleteMode
              ? '1px solid #ff4d4f'
              : manualWeldInsertMode ? '1px solid #fa8c16' : '1px solid #d9d9d9',
            borderRadius: 6,
            background: manualWeldDeleteMode
              ? '#fff2f0'
              : manualWeldInsertMode ? '#fff7e6' : '#fafafa'
          }}>
            <div style={{ fontSize: 12, color: '#595959', marginBottom: 6 }}>
              当前页共 {currentPageNumberedWeldCount} 个焊点，其中手动补入 {currentPageManualWeldCount} 个
            </div>
            <Select
              mode="tags"
              size="small"
              maxTagCount={1}
              value={(
                Number(manualInsertPipelineContext.page) === Number(currentPage) &&
                manualInsertPipelineContext.pipelineNumber
              ) ? [manualInsertPipelineContext.pipelineNumber] : []}
              options={(manualInsertPipelineContext.candidates || []).map(pipelineNumber => ({
                value: pipelineNumber,
                label: pipelineNumber
              }))}
              loading={manualInsertPipelineContext.status === 'resolving'}
              placeholder={manualInsertPipelineContext.status === 'resolving'
                ? '正在比对前后页管线号区域…'
                : '补点管线号（可选择或填写）'}
              onChange={handleManualInsertPipelineChange}
              disabled={
                (!manualWeldInsertMode && !manualWeldDeleteMode) ||
                manualInsertPipelineContext.status === 'resolving'
              }
              tokenSeparators={[',', '，']}
              style={{ width: '100%', marginBottom: 6 }}
            />
            {manualWeldInsertMode && manualInsertPipelineContext.status === 'resolved' && (
              <div style={{ fontSize: 12, color: '#389e0d', marginBottom: 6 }}>
                {manualInsertPipelineContext.source === 'pipeline-area-adjacent-match'
                  ? `已与第 ${manualInsertPipelineContext.matchedPage} 页管线号匹配`
                  : manualInsertPipelineContext.source === 'current-page-weld'
                  ? '已沿用当前页焊点管线号'
                  : '已人工确认补点管线号'}
              </div>
            )}
            {manualWeldInsertMode && manualInsertPipelineContext.status === 'unresolved' && (
              <div style={{ fontSize: 12, color: '#cf1322', marginBottom: 6 }}>
                前后页未找到相同管线号，请人工选择或填写后再补点
              </div>
            )}
            {manualWeldInsertMode && (
              <InputNumber
                size="small"
                min={manualInsertMinimum}
                max={manualInsertMaximum}
                value={manualWeldInsertPosition}
                onChange={value => updateManualWeldInsertPosition(
                  Math.max(manualInsertMinimum, Number(value) || manualInsertMinimum)
                )}
                addonBefore="插入序号"
                style={{ width: '100%' }}
              />
            )}
            {manualWeldDeleteMode && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 12, color: pendingManualWeldDelete.length ? '#cf1322' : '#8c8c8c', marginBottom: 6 }}>
                  {pendingManualWeldDelete.length
                    ? `已选择 ${pendingManualWeldDelete.length} 个：${pendingManualWeldDelete
                      .slice(0, 8)
                      .map(item => `第${item.page}页 ${item.displayNumber || item.weldNumber}`)
                      .join('、')}${pendingManualWeldDelete.length > 8 ? '…' : ''}`
                    : '点击图中的红圈可连续选择；再次点击可取消，也可翻页继续选择'}
                </div>
                <Space.Compact block>
                  <Button
                    size="small"
                    disabled={pendingManualWeldDelete.length === 0}
                    onClick={handleCancelManualWeldDelete}
                    style={{ flex: 1 }}
                  >
                    取消选择
                  </Button>
                  <Button
                    danger
                    type="primary"
                    size="small"
                    disabled={pendingManualWeldDelete.length === 0}
                    onClick={handleConfirmManualWeldDelete}
                    style={{ flex: 1 }}
                  >
                    确认删除（{pendingManualWeldDelete.length}）
                  </Button>
                </Space.Compact>
              </div>
            )}
            {manualWeldDeleteMode ? (
              <Button
                block
                size="small"
                disabled={manualWeldDeleteHistoryRef.current.length === 0}
                onClick={handleUndoLastWeldDelete}
                style={{ marginTop: 6 }}
              >
                撤销删除
              </Button>
            ) : (
              <Space.Compact block style={{ marginTop: 6 }}>
                <Button
                  size="small"
                  disabled={currentPageManualWeldCount === 0}
                  onClick={handleUndoLastManualWeld}
                  style={{ flex: 1 }}
                >
                  撤销补点
                </Button>
                <Button
                  size="small"
                  disabled={manualWeldDeleteHistoryRef.current.length === 0}
                  onClick={handleUndoLastWeldDelete}
                  style={{ flex: 1 }}
                >
                  撤销删除
                </Button>
              </Space.Compact>
            )}
          </div>
        )}
        {pendingNumberingAnnotations.length === 0 && <div style={{ fontSize: 13, color: canGenerateWeldAnnotations ? '#389e0d' : '#8c8c8c', marginBottom: 8 }}>
          {canGenerateWeldAnnotations
            ? `编号顺序已生成，当前页预览 ${orderedNumberingWeldsForPreview.length} 个焊点`
            : '请按起点→终点添加编号段'}
        </div>}
        {pendingNumberingAnnotations.length === 0 && numberingSegments.length > 0 && (
          <div style={{
            maxHeight: 320,
            overflowY: 'auto',
            marginBottom: 8,
            padding: 6,
            border: '1px solid #f0f0f0',
            borderRadius: 6,
            background: '#fafafa'
          }}>
            {numberingSegments.map((segment, index) => {
              const segmentWeldCount = Array.isArray(segment.sourceRangeWelds)
                ? segment.sourceRangeWelds.length
                : 0;
              const segmentStartNumber = Number(segment.targetStartNumber ?? segment.moveTargetNumber);
              const pendingRule = multiPageBatchService.getPendingBatchAnnotationRule() || activeAnnotationRule;
              const segmentIncrement = Number(pendingRule?.increment ?? 1) || 1;
              const segmentEndNumber = Number.isFinite(segmentStartNumber) && segmentWeldCount > 0
                ? segmentStartNumber + (segmentWeldCount - 1) * segmentIncrement
                : null;
              return (
                <div
                  key={`${segment.startKey}-${segment.endKey}-${index}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    marginBottom: index === numberingSegments.length - 1 ? 0 : 6
                  }}
                >
                  <span style={{ fontSize: 13, color: '#262626', flex: 1, minWidth: 180 }}>
                    {index + 1}. 第{segment.page || currentPage}页 | {segment.pipelineNumber || '未识别管线号'} | {segmentWeldCount}个焊点
                  </span>
                  <Button
                    size="small"
                    onClick={() => handleReverseNumberingSegment(index)}
                    style={{ height: 22, padding: '0 6px', fontSize: 12 }}
                  >
                    整段倒序
                  </Button>
                  <InputNumber
                    size="small"
                    min={1}
                    value={segment.targetStartNumber ?? segment.moveTargetNumber}
                    onChange={value => handleUpdateNumberingSegmentMove(index, {
                      targetStartNumber: Number(value) || undefined,
                      moveTargetNumber: undefined,
                      movePosition: undefined
                    })}
                    placeholder="本段起始号"
                    style={{ width: 126 }}
                  />
                  <span style={{ width: 108, fontSize: 13, color: '#1677ff' }}>
                    结束号：{segmentEndNumber ?? '—'}
                  </span>
                  <Button
                    size="small"
                    danger
                    onClick={() => handleRemoveNumberingSegment(index)}
                    style={{ height: 22, padding: '0 6px', fontSize: 12 }}
                  >
                    删除
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        {pendingNumberingAnnotations.length === 0 && <Button
          size="small"
          block
          disabled={!numberingSegments.length && !selectedStartWeld}
          onClick={handleClearNumberingSegments}
          style={{ marginBottom: 8 }}
        >
          清空已选段
        </Button>}
        {pendingNumberingAnnotations.length > 0 ? (
          <Space.Compact block>
            <Button block onClick={handleReturnToNumberingAdjustment}>返回调整</Button>
            <Button type="primary" block onClick={handleConfirmNumberingAnnotations}>确认生成可编辑标注</Button>
          </Space.Compact>
        ) : (
          <Button
            type="primary"
            size="small"
            block
            disabled={!canGenerateWeldAnnotations}
            onClick={handleConvertWeldsToAnnotations}
          >
            预览标注结果
          </Button>
        )}
      </div>
    </div>
  ), document.body) : null;

  const showImageFirstLoadingPage = Boolean(
    imageFirstPdfMode &&
    activeDisplayedPageSnapshot &&
    (pdfDocumentCacheKey !== singlePageSnapshotDocumentKey || !numPages)
  );
  const cacheProgressText = (() => {
    const progress = backgroundPageCacheProgress;
    if (!progress.running && progress.error) return '页面缓存失败';
    if (progress.stage === 'uploading') {
      const uploadedMb = Math.max(0, Number(progress.uploadedBytes || 0)) / (1024 * 1024);
      const sourceMb = Math.max(0, Number(progress.sourceSize || 0)) / (1024 * 1024);
      return sourceMb > 0
        ? `页面缓存：上传 ${uploadedMb.toFixed(1)}/${sourceMb.toFixed(1)} MB`
        : `页面缓存：已上传 ${uploadedMb.toFixed(1)} MB`;
    }
    if (progress.stage === 'queued') return '页面缓存：等待生成';
    if (progress.stage === 'rendering' && progress.completed === 0) return '页面缓存：正在生成第1页';
    return `页面缓存 ${progress.completed}/${progress.total}`;
  })();

  return (
    <ViewerContainer 
      ref={containerRef}
      $isDragging={isDragging}
      $annotationMode={annotationMode}
      $rulesPanelVisible={rulesPanelVisible}
      onMouseDown={handleMouseDown}
      onMouseMove={handleViewerMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={handleContextMenu}
      style={{ position: 'relative' }}
    >
      {numberingControlPanelPortal}

      {backgroundPageCacheProgress.total > 0 && (
        <div
          onMouseDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          style={{
            position: 'absolute',
            left: 12,
            bottom: 12,
            zIndex: 2147482000,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 8px',
            border: '1px solid rgba(0,0,0,0.18)',
            borderRadius: 6,
            background: 'rgba(255,255,255,0.94)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
            fontSize: 12
          }}
        >
            <span title={backgroundPageCacheProgress.error || ''}>
              {cacheProgressText}
              {backgroundPageCacheProgress.failed > 0 ? `，失败${backgroundPageCacheProgress.failed}` : ''}
              {backgroundPageCacheProgress.skipped > 0 ? `，跳过超大页${backgroundPageCacheProgress.skipped}` : ''}
            </span>
          {!serverPageCacheMode && backgroundPageCacheProgress.running &&
            backgroundPageCacheProgress.completed + backgroundPageCacheProgress.failed < backgroundPageCacheProgress.total && (
            <Button
              size="small"
              onClick={() => setBackgroundPageCachePaused(value => !value)}
              style={{ height: 24, padding: '0 8px' }}
            >
              {backgroundPageCachePaused ? '继续' : '暂停'}
            </Button>
          )}
          {!backgroundPageCacheProgress.running &&
            (backgroundPageCacheProgress.failed > 0 || backgroundPageCacheProgress.error) && (
            <Button
              size="small"
              onClick={() => {
                setBackgroundPageCacheProgress(previous => ({
                  ...previous,
                  running: true,
                  failed: 0,
                  error: ''
                }));
                setRemotePageCacheRetryNonce(value => value + 1);
              }}
              style={{ height: 24, padding: '0 8px' }}
            >
              重试缓存
            </Button>
          )}
        </div>
      )}

      {showImageFirstLoadingPage && (
        <PageViewport
          $offsetX={viewOffset.x}
          $offsetY={viewOffset.y}
          $isDragging={isDragging}
          data-pdf-image-first-loading="true"
        >
          <PageContainer data-page-number={Number(currentPage) || 1}>
            <img
              src={activeDisplayedPageSnapshot.url}
              data-pdf-page-snapshot="true"
              data-pdf-page-image-first-loading="true"
              alt={`Cached PDF page ${Number(currentPage) || 1}`}
              draggable={false}
              width={activeSinglePageSnapshotDisplaySize?.width || activeDisplayedPageSnapshot.cssWidth}
              height={activeSinglePageSnapshotDisplaySize?.height || activeDisplayedPageSnapshot.cssHeight}
              style={{ display: 'block', userSelect: 'none' }}
            />
          </PageContainer>
        </PageViewport>
      )}


      <Document
        file={file}
        suspense={false}
        onLoadSuccess={handleDocumentLoadSuccess}
        onLoadError={onDocumentLoadError}
        loading={showImageFirstLoadingPage ? null : (
          <LoadingContainer>
            <Spin size="large" />
            <div>正在加载PDF文档...</div>
          </LoadingContainer>
        )}
        error={
          <Alert
            message="加载失败"
            description="无法加载PDF文档，请检查文件格式。"
            type="error"
            showIcon
          />
        }
      >
        {numPages && (
          <>
            {/* 检查是否处于打印模式 */}
            {window.electronPrintMode ? (
              // 打印模式：显示所有页面
              <PageViewport
                $offsetX={viewOffset.x}
                $offsetY={viewOffset.y}
                $isDragging={isDragging}
              >
                {Array.from({ length: numPages }, (_, index) => {
                  const pageNumber = index + 1;
                  return (
                    <PageContainer
                      key={`print-page-${pageNumber}`}
                      ref={createPageRefCallback(pageNumber)}
                      style={{ 
                        marginBottom: pageNumber < numPages ? '20px' : '0',
                        pageBreakAfter: pageNumber < numPages ? 'always' : 'auto'
                      }}
                    >
                      <Page
                        pageNumber={pageNumber}
                        scale={scale * 2.0}
                        devicePixelRatio={getForegroundCanvasDpr(pageNumber, scale * 2.0)}
                        onLoadSuccess={onPageLoadSuccess}
                        renderTextLayer={false}
                        renderAnnotationLayer={false}
                        loading={
                          <SmoothLoader>
                            <Spin size="large" tip="页面加载中..." />
                          </SmoothLoader>
                        }
                      />
                      <AnnotationLayer
                        $annotationMode={annotationMode || pipeSegmentMode || areaDeleteMode}
                        onMouseDown={(e) => handleAnnotationLayerMouseDown(e, pageNumber)}
                        onMouseMove={(e) => {
                          if (areaDeleteMode && isSelectingArea) {
                            handleAreaDeleteMouseMove(e);
                          } else {
                            handleAnnotationMove(e, pageNumber);
                          }
                        }}
                        onMouseUp={(e) => {
                          if (areaDeleteMode && isSelectingArea) {
                            handleAreaDeleteMouseUp(e);
                          } else {
                            handleAnnotationEnd(e);
                          }
                        }}
                      >
                        {renderAnnotationsCached(pageNumber)}
                        {renderAnnotationDragPreview(pageNumber)}
                        {renderPendingNumberingAnnotations(pageNumber)}
                        {currentAnnotation && currentAnnotation.page === pageNumber && renderCurrentAnnotation(pageNumber)}
                        
                        {/* 区域选择矩形 - 只在当前页显示 */}
                        {(() => {
                          const shouldShow = isSelectingArea && areaSelection && pageNumber === currentPage;
                          return shouldShow && (
                            <SelectionRectangle
                              style={{
                                left: Math.min(areaSelection.startX, areaSelection.endX) * scale,
                                top: Math.min(areaSelection.startY, areaSelection.endY) * scale,
                                width: Math.abs(areaSelection.endX - areaSelection.startX) * scale,
                                height: Math.abs(areaSelection.endY - areaSelection.startY) * scale,
                              }}
                            />
                          );
                        })()}
                      </AnnotationLayer>
                      
                      {/* 矢量可视化调试层 */}
                      <VectorVisualizer
                        ref={(pageNumber === currentPage && pageVectors[pageNumber]?.length > 0) ? firstPageVisualizerRef : null}
                        vectors={pageVectors[pageNumber] || []}
                        scale={scale * 2.0}
                        visible={showVectorDebug}
                        showWeldDebug={showWeldDebug}
                        showFittingDebug={showFittingDebug}
                        showPipeLengthDebug={showPipeLengthDebug}
                        rulesVersion={rulesVersion}
                        ocrDetections={getPageTextLikeDetections(pageNumber)}
                        pageSize={getCachedPageInfo(pageNumber)?.size || pageSize}
                        enableOCRFilter={enableOCRFilter}
                        weldRecognitionArea={globalWeldRecognitionArea}
                        materialRows={materialRows}
                        materialScope={materialScope}
                        documentKey={pdfFilePath || file?.name || 'document'}
                        pageNumber={pageNumber}
                        pipelineNumber={textDetections[pageNumber]?.pipelineNumber || getPageRecognitionData(pageNumber)?.pipelineNumber || ''}
                        onExecuteUndoableCommand={onExecuteUndoableCommand}
                        onAutoBindFittingMaterials={handleAutoBindFittingMaterials}
                        onDisplayedWeldsChange={handleDisplayedWeldsChange}
                      />
                      
                      {/* 管道识别可视化层 */}
                      <PipelineOverlay
                        vectors={pageVectors[pageNumber] || []}
                        scale={scale}
                        visible={showPipelineDebug}
                      />
                      
                      {/* 焊点编号可视化层 */}
                      {pageNumber === currentPage && (
                        <>
                          {/* 单页编号控制面板 */}
                          {false && showWeldNumbers && showWeldDebug && displayedWelds.length > 0 && (
                             <div style={{
                               position: 'absolute',
                               top: 20,
                               right: 20,
                               zIndex: 2147483000,
                               pointerEvents: 'auto'
                             }}>
                                <div style={{
                                  background: 'rgba(255, 255, 255, 0.96)',
                                  border: '1px solid #d9d9d9',
                                  borderRadius: 8,
                                  padding: 12,
                                  minWidth: 240,
                                  boxShadow: '0 2px 8px rgba(0,0,0,0.12)'
                                }}>
                                  <div style={{ fontWeight: 600, marginBottom: 8 }}>
                                    {selectedStartWeld ? '请选择本段终点' : '请选择本段起点'}
                                  </div>
                                  <div style={{ fontSize: 12, color: '#595959', marginBottom: 8 }}>
                                    当前起点 Path ID: {selectedStartWeldId ?? '未选择'}；已添加 {numberingSegments.length} 段
                                  </div>
                                  <div style={{ fontSize: 12, color: canGenerateWeldAnnotations ? '#389e0d' : '#8c8c8c', marginBottom: 8 }}>
                                    {canGenerateWeldAnnotations
                                      ? `编号顺序已生成，共 ${orderedNumberingWelds.length} 个焊点`
                                      : '请按起点→终点添加编号段'}
                                  </div>
                                  {numberingSegments.length > 0 && (
                                    <div style={{
                                      maxHeight: 120,
                                      overflowY: 'auto',
                                      marginBottom: 8,
                                      padding: 6,
                                      border: '1px solid #f0f0f0',
                                      borderRadius: 6,
                                      background: '#fafafa'
                                    }}>
                                      {numberingSegments.map((segment, index) => (
                                        <div
                                          key={`${segment.startKey}-${segment.endKey}-${index}`}
                                          style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            gap: 8,
                                            marginBottom: index === numberingSegments.length - 1 ? 0 : 4
                                          }}
                                        >
                                          <span style={{ fontSize: 12, color: '#262626' }}>
                                            {index + 1}. {segment.startPathId} - {segment.endPathId}
                                          </span>
                                          <Button
                                            size="small"
                                            danger
                                            onClick={() => handleRemoveNumberingSegment(index)}
                                            style={{ height: 22, padding: '0 6px', fontSize: 12 }}
                                          >
                                            删除
                                          </Button>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  <Button
                                    size="small"
                                    block
                                    disabled={!numberingSegments.length && !selectedStartWeld}
                                    onClick={handleClearNumberingSegments}
                                    style={{ marginBottom: 8 }}
                                  >
                                    清空已选段
                                  </Button>
                                  <Button
                                    type="primary"
                                    size="small"
                                    block
                                    disabled={!canGenerateWeldAnnotations}
                                    onClick={handleConvertWeldsToAnnotations}
                                  >
                                    生成可编辑标注
                                  </Button>
                                </div>
                             </div>
                          )}
                          
                          {/* 单页编号预览 */}
                          <WeldNumberOverlay
                            welds={getNumberingWeldsForPage(pageNumber)}
                            vectors={pageVectors[pageNumber] || []}
                            weldRecognitionArea={latestAreasRef.current.weldRecognition || globalWeldRecognitionArea}
                            frameSize={getWeldPreviewFrameSize(pageNumber)}
                            scale={scale}
                            visible={showWeldNumbers && showWeldDebug && pendingNumberingAnnotations.length === 0}
                            animationSpeed={weldNumberAnimationSpeed}
                            selectionMode={(isWeldStartPickMode || manualWeldDeleteMode) && !manualWeldInsertMode}
                            // 多段起止/补点阶段只显示轻量蓝圈编号，不计算引线布局；
                            // 最终生成可编辑标注时才进行一次正式位置计算。
                            selectionPreviewOnly={multiPageNumberPreview && (isWeldStartPickMode || manualWeldInsertMode || manualWeldDeleteMode)}
                            onWeldClick={handleNumberingWeldInteraction}
                            manualInsertMode={manualWeldInsertMode}
                            deleteMode={manualWeldDeleteMode}
                            onManualPointClick={handleManualWeldPointClick}
                            selectedStartWeldKey={selectedStartWeld ? getWeldSelectionKey(selectedStartWeld) : null}
                            highlightedWeldKeys={[
                              ...numberingSegments.flatMap(segment => [segment.startKey, segment.endKey]),
                              ...pendingManualWeldDeleteKeys
                            ].filter(Boolean)}
                            hiddenNumberWeldKeys={hiddenNumberWeldKeysForPreview}
                            orderedWelds={orderedNumberingWeldsForPreview}
                            showPathIdHint={true}
                            ocrData={textDetections[pageNumber] || null}
                          />
                          
                          {/* 多页编号预览 */}
                          {multiPageNumberPreview && !showWeldNumbers && (
                            <WeldNumberOverlay
                              welds={multiPageNumberWelds.filter(w => w.page === pageNumber)}
                              vectors={pageVectors[pageNumber] || []}
                              weldRecognitionArea={latestAreasRef.current.weldRecognition || globalWeldRecognitionArea}
                              frameSize={getWeldPreviewFrameSize(pageNumber)}
                              scale={scale}
                              visible={true}
                              animationSpeed={weldNumberAnimationSpeed}
                              selectionMode={(isWeldStartPickMode || manualWeldDeleteMode) && !manualWeldInsertMode}
                              selectionPreviewOnly={isWeldStartPickMode || manualWeldInsertMode || manualWeldDeleteMode}
                              onWeldClick={handleNumberingWeldInteraction}
                              manualInsertMode={manualWeldInsertMode}
                              deleteMode={manualWeldDeleteMode}
                              onManualPointClick={handleManualWeldPointClick}
                              highlightedWeldKeys={pendingManualWeldDeleteKeys}
                              useGlobalSequence={false}
                              orderedWelds={orderedNumberingWeldsForPreview}
                              ocrData={textDetections[pageNumber] || null}
                            />
                          )}

                          {renderPipelineComparisonOverlay(pageNumber)}
                        </>
                      )}
                      
                      {/* 文字识别结果数据已保留用于焊点过滤，但不再显示可视化框 */}
                      
                      {/* OCR结果可视化层（材料表识别） */}
                      {(() => {
                        const pageData = getPageRecognitionData(pageNumber);
                        if (!pageData) return null;
                        // 支架模式和普通模式都使用原始 detections
                        // 🎯 材料表模式不应用支架过滤规则
                        const isScaffoldMode = pageData.isScaffoldMode === true;
                        const isMaterialMode = !isScaffoldMode; // 材料表模式
                        
                        const scaffoldDetections = [
                          ...(Array.isArray(pageData.scaffoldData) ? pageData.scaffoldData : []),
                          ...(Array.isArray(pageData.scaffolds) ? pageData.scaffolds : []),
                          ...(Array.isArray(pageData.detections) ? pageData.detections : [])
                        ];
                        const visualizationDetections = isScaffoldMode
                          ? scaffoldDetections
                          : pageData.detections;
                        const visualizationMaterialRows = [
                          ...(Array.isArray(materialRows) ? materialRows : []),
                          ...(Array.isArray(pageData.materials) ? pageData.materials : [])
                        ];

                        if (visualizationDetections && visualizationDetections.length > 0) {
                          return (
                        <OCRResultVisualization
                          detections={visualizationDetections}
                          scale={scale}
                          pageSize={pageSize}
                          currentPage={pageNumber}
                          isRawDetection={isMaterialMode}
                          normalizedArea={isMaterialMode ? globalOcrRegion : null}
                          materialRows={visualizationMaterialRows}
                          onAddScaffoldAnnotation={(scaffoldInfo) => onAddScaffoldAnnotation && onAddScaffoldAnnotation(scaffoldInfo, pageNumber)}
                          onBatchAddScaffoldAnnotations={(scaffoldInfos) => onBatchAddScaffoldAnnotations && onBatchAddScaffoldAnnotations(scaffoldInfos, pageNumber)}
                        />
                          );
                        }
                        return null;
                      })()}
                    </PageContainer>
                  );
                })}
              </PageViewport>
            ) : viewMode === 'single' ? (
              // 单页模式：只显示当前页面
              <PageViewport
                $offsetX={viewOffset.x}
                $offsetY={viewOffset.y}
                $isDragging={isDragging}
              >
                {(singlePageCacheRadius === 0
                  ? [Number(currentPage) || 1]
                  : singlePageMountedPages
                ).map((pageNumber) => {
                  const isActivePage = Number(pageNumber) === Number(currentPage);
                  return (
                <PageContainer
                  key={`single-page-${pageNumber}`}
                  ref={isActivePage ? createPageRefCallback(pageNumber) : undefined}
                  data-page-number={pageNumber}
                  aria-hidden={!isActivePage}
                  style={isActivePage ? undefined : {
                    position: 'absolute',
                    left: '-100000px',
                    top: 0,
                    visibility: 'hidden',
                    pointerEvents: 'none',
                    boxShadow: 'none',
                    margin: 0
                  }}
                >
                  {imageFirstPdfMode && (
                    remotePageCacheState.pages?.[pageNumber] ||
                    remotePageCacheState.previews?.[pageNumber]
                  ) ? (
                    isActivePage && activeDisplayedPageSnapshot ? (
                      <img
                        src={activeDisplayedPageSnapshot.url}
                        data-pdf-page-snapshot="true"
                        data-pdf-page-image-first="true"
                        alt={`Cached PDF page ${pageNumber}`}
                        draggable={false}
                        width={activeSinglePageSnapshotDisplaySize?.width || activeDisplayedPageSnapshot.cssWidth}
                        height={activeSinglePageSnapshotDisplaySize?.height || activeDisplayedPageSnapshot.cssHeight}
                        style={{ display: 'block', userSelect: 'none' }}
                      />
                    ) : remoteCanvasFallbackPage === Number(pageNumber) ? (
                      <CachedPdfCanvasPage
                        pageNumber={pageNumber}
                        renderScale={scale * 2.0}
                        devicePixelRatio={getForegroundCanvasDpr(pageNumber, scale * 2.0)}
                        onLoadSuccess={onPageLoadSuccess}
                        onRenderSuccess={handleSinglePageRenderSuccess}
                        onRenderError={handleSinglePageRenderError}
                      />
                    ) : (
                      <PageSkeleton
                        height={`${Math.max(
                          1,
                          Number(remotePageCacheState.pages?.[pageNumber]?.height || pageSize.height) *
                            ((Number(scale) || 1) / 0.625)
                        )}px`}
                      />
                    )
                  ) : serverPageCacheMode ? (
                    <>
                      <CachedPdfCanvasPage
                        pageNumber={pageNumber}
                        renderScale={scale * 2.0}
                        devicePixelRatio={getForegroundCanvasDpr(pageNumber, scale * 2.0)}
                        onLoadSuccess={onPageLoadSuccess}
                        onRenderSuccess={handleSinglePageRenderSuccess}
                        onRenderError={handleSinglePageRenderError}
                      />
                      {isActivePage && activeDisplayedPageSnapshot && singlePageLiveCanvasKey !== `${Number(pageNumber)}:${Number(scale) || 1}` && (
                        <img
                          src={activeDisplayedPageSnapshot.url}
                          data-pdf-page-snapshot="true"
                          data-pdf-page-mirror="true"
                          alt={`PDF第${pageNumber}页缓存镜像`}
                          draggable={false}
                          width={activeSinglePageSnapshotDisplaySize?.width || activeDisplayedPageSnapshot.cssWidth}
                          height={activeSinglePageSnapshotDisplaySize?.height || activeDisplayedPageSnapshot.cssHeight}
                          style={{ position: 'absolute', inset: 0, zIndex: 1, display: 'block', userSelect: 'none' }}
                        />
                      )}
                    </>
                  ) : isActivePage && activeDisplayedPageSnapshot ? (
                    <img
                      src={activeDisplayedPageSnapshot.url}
                      data-pdf-page-snapshot="true"
                      alt={`PDF第${pageNumber}页`}
                      draggable={false}
                      width={activeSinglePageSnapshotDisplaySize?.width || activeDisplayedPageSnapshot.cssWidth}
                      height={activeSinglePageSnapshotDisplaySize?.height || activeDisplayedPageSnapshot.cssHeight}
                      style={{ display: 'block', userSelect: 'none' }}
                    />
                  ) : isActivePage && activeSinglePageSnapshotKnownOnDisk ? (
                    <PageSkeleton height={`${pageSize.height * scale * 2.0}px`} />
                  ) : (
                    <CachedPdfCanvasPage
                      pageNumber={pageNumber}
                      renderScale={scale * 2.0}
                      devicePixelRatio={getForegroundCanvasDpr(pageNumber, scale * 2.0)}
                      onLoadSuccess={onPageLoadSuccess}
                      onRenderSuccess={handleSinglePageRenderSuccess}
                      onRenderError={handleSinglePageRenderError}
                    />
                  )}
                  {isActivePage && (
                    <>
                  <AnnotationLayer
                    $annotationMode={annotationMode || pipeSegmentMode || areaDeleteMode}
                    onMouseDown={(e) => handleAnnotationLayerMouseDown(e, currentPage)}
                        onMouseMove={(e) => {
                          if (areaDeleteMode && isSelectingArea) {
                            handleAreaDeleteMouseMove(e);
                          } else {
                            handleAnnotationMove(e, currentPage);
                          }
                        }}
                        onMouseUp={(e) => {
                          if (areaDeleteMode && isSelectingArea) {
                            handleAreaDeleteMouseUp(e);
                          } else {
                            handleAnnotationEnd(e);
                          }
                        }}
                  >
                    {renderAnnotationsCached(currentPage)}
                    {renderAnnotationDragPreview(currentPage)}
                    {renderPendingNumberingAnnotations(currentPage)}
                    {currentAnnotation && currentAnnotation.page === currentPage && renderCurrentAnnotation(currentPage)}
                    
                    {/* 区域选择矩形 - 只在当前页显示 */}
                    {(() => {
                      const shouldShow = isSelectingArea && areaSelection;
                      return shouldShow && (
                        <SelectionRectangle
                          style={{
                            left: Math.min(areaSelection.startX, areaSelection.endX) * scale,
                            top: Math.min(areaSelection.startY, areaSelection.endY) * scale,
                            width: Math.abs(areaSelection.endX - areaSelection.startX) * scale,
                            height: Math.abs(areaSelection.endY - areaSelection.startY) * scale,
                          }}
                        />
                      );
                    })()}
                  </AnnotationLayer>
                  
                  {/* 矢量可视化调试层 */}
                  <VectorVisualizer
                    ref={firstPageVisualizerRef}
                    vectors={pageVectors[currentPage] || []}
                    scale={scale * 2.0} // 修复：与 Page 组件的缩放比例保持一致
                    visible={showVectorDebug}
                    showWeldDebug={showWeldDebug}
                    showFittingDebug={showFittingDebug}
                    showPipeLengthDebug={showPipeLengthDebug}
                    rulesVersion={rulesVersion}
                    ocrDetections={getPageTextLikeDetections(currentPage)}
                    pageSize={getCachedPageInfo(currentPage)?.size || pageSize}
                    enableOCRFilter={enableOCRFilter}
                    weldRecognitionArea={latestAreasRef.current.weldRecognition || globalWeldRecognitionArea}
                    materialRows={materialRows}
                    materialScope={materialScope}
                    documentKey={pdfFilePath || file?.name || 'document'}
                    pageNumber={currentPage}
                    pipelineNumber={textDetections[currentPage]?.pipelineNumber || getPageRecognitionData(currentPage)?.pipelineNumber || ''}
                    onExecuteUndoableCommand={onExecuteUndoableCommand}
                    onAutoBindFittingMaterials={handleAutoBindFittingMaterials}
                    onDisplayedWeldsChange={handleDisplayedWeldsChange}
                  />
                  
                  {/* 管道识别可视化层 */}
                  <PipelineOverlay
                    vectors={pageVectors[currentPage] || []}
                    scale={scale * 2.0}
                    visible={showPipelineDebug}
                  />
                  
                  {/* 焊点编号可视化层 */}
                  {false && showWeldNumbers && showWeldDebug && displayedWelds.length > 0 && (
                     <div style={{
                       position: 'absolute',
                       top: 20,
                       right: 20,
                       zIndex: 2147483000,
                       pointerEvents: 'auto'
                     }}>
                        <div style={{
                          background: 'rgba(255, 255, 255, 0.96)',
                          border: '1px solid #d9d9d9',
                          borderRadius: 8,
                          padding: 12,
                          minWidth: 240,
                          boxShadow: '0 2px 8px rgba(0,0,0,0.12)'
                        }}>
                          <div style={{ fontWeight: 600, marginBottom: 8 }}>
                            {selectedStartWeld ? '请选择本段终点' : '请选择本段起点'}
                          </div>
                          <div style={{ fontSize: 12, color: '#595959', marginBottom: 8 }}>
                            当前起点 Path ID: {selectedStartWeldId ?? '未选择'}；已添加 {numberingSegments.length} 段
                          </div>
                          <div style={{ fontSize: 12, color: canGenerateWeldAnnotations ? '#389e0d' : '#8c8c8c', marginBottom: 8 }}>
                            {canGenerateWeldAnnotations
                              ? `编号顺序已生成，共 ${orderedNumberingWelds.length} 个焊点`
                              : '请按起点→终点添加编号段'}
                          </div>
                          {numberingSegments.length > 0 && (
                            <div style={{
                              maxHeight: 120,
                              overflowY: 'auto',
                              marginBottom: 8,
                              padding: 6,
                              border: '1px solid #f0f0f0',
                              borderRadius: 6,
                              background: '#fafafa'
                            }}>
                              {numberingSegments.map((segment, index) => (
                                <div
                                  key={`${segment.startKey}-${segment.endKey}-${index}`}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: 8,
                                    marginBottom: index === numberingSegments.length - 1 ? 0 : 4
                                  }}
                                >
                                  <span style={{ fontSize: 12, color: '#262626' }}>
                                    {index + 1}. {segment.startPathId} - {segment.endPathId}
                                  </span>
                                  <Button
                                    size="small"
                                    danger
                                    onClick={() => handleRemoveNumberingSegment(index)}
                                    style={{ height: 22, padding: '0 6px', fontSize: 12 }}
                                  >
                                    删除
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                          <Button
                            size="small"
                            block
                            disabled={!numberingSegments.length && !selectedStartWeld}
                            onClick={handleClearNumberingSegments}
                            style={{ marginBottom: 8 }}
                          >
                            清空已选段
                          </Button>
                          <Button
                            type="primary"
                            size="small"
                            block
                            disabled={!canGenerateWeldAnnotations}
                            onClick={handleConvertWeldsToAnnotations}
                          >
                            生成可编辑标注
                          </Button>
                        </div>
                     </div>
                  )}

                  {/* 单页编号预览 */}
                  <WeldNumberOverlay
                    welds={getNumberingWeldsForPage(currentPage)}
                    vectors={pageVectors[currentPage] || []}
                    weldRecognitionArea={globalWeldRecognitionArea}
                    frameSize={getWeldPreviewFrameSize(currentPage)}
                    scale={scale}
                    visible={showWeldNumbers && showWeldDebug && pendingNumberingAnnotations.length === 0}
                    animationSpeed={weldNumberAnimationSpeed}
                    selectionMode={(isWeldStartPickMode || manualWeldDeleteMode) && !manualWeldInsertMode}
                    selectionPreviewOnly={multiPageNumberPreview && (isWeldStartPickMode || manualWeldInsertMode || manualWeldDeleteMode)}
                    onWeldClick={handleNumberingWeldInteraction}
                    manualInsertMode={manualWeldInsertMode}
                    deleteMode={manualWeldDeleteMode}
                    onManualPointClick={handleManualWeldPointClick}
                    selectedStartWeldKey={selectedStartWeld ? getWeldSelectionKey(selectedStartWeld) : null}
                    highlightedWeldKeys={[
                      ...numberingSegments.flatMap(segment => [segment.startKey, segment.endKey]),
                      ...pendingManualWeldDeleteKeys
                    ].filter(Boolean)}
                    hiddenNumberWeldKeys={hiddenNumberWeldKeysForPreview}
                    orderedWelds={orderedNumberingWeldsForPreview}
                    showPathIdHint={true}
                    ocrData={textDetections[currentPage] || null}
                  />
                  
                  {/* 多页编号预览 */}
                  {multiPageNumberPreview && !showWeldNumbers && (
                    <WeldNumberOverlay
                      welds={multiPageNumberWelds.filter(w => w.page === currentPage)}
                      vectors={pageVectors[currentPage] || []}
                      weldRecognitionArea={latestAreasRef.current.weldRecognition || globalWeldRecognitionArea}
                      frameSize={getWeldPreviewFrameSize(currentPage)}
                      scale={scale}
                      visible={true}
                      animationSpeed={weldNumberAnimationSpeed}
                      selectionMode={(isWeldStartPickMode || manualWeldDeleteMode) && !manualWeldInsertMode}
                      selectionPreviewOnly={isWeldStartPickMode || manualWeldInsertMode || manualWeldDeleteMode}
                      onWeldClick={handleNumberingWeldInteraction}
                      manualInsertMode={manualWeldInsertMode}
                      deleteMode={manualWeldDeleteMode}
                      onManualPointClick={handleManualWeldPointClick}
                      highlightedWeldKeys={pendingManualWeldDeleteKeys}
                      useGlobalSequence={false}
                      orderedWelds={orderedNumberingWeldsForPreview}
                      ocrData={textDetections[currentPage] || null}
                    />
                  )}

                  {renderPipelineComparisonOverlay(currentPage)}
                  
                  {/* 文字识别结果数据已保留用于焊点过滤，但不再显示可视化框 */}
                  
                  {/* OCR结果可视化层（材料表识别） */}
                  {(() => {
                    const pageData = getPageRecognitionData(currentPage);
                    if (!pageData) return null;
                    // 支架模式和普通模式都使用原始 detections
                    // 🎯 材料表模式不应用支架过滤规则
                    const isScaffoldMode = pageData.isScaffoldMode === true;
                    const isMaterialMode = !isScaffoldMode; // 材料表模式
                    
                    // 🔍 诊断日志
                    console.log('🔍 [PDFViewer-单页模式] OCR可视化参数:', {
                      isScaffoldMode: pageData.isScaffoldMode,
                      isMaterialMode: pageData.isMaterialMode,
                      计算的isScaffoldMode: isScaffoldMode,
                      计算的isMaterialMode: isMaterialMode,
                      isRawDetection参数: isMaterialMode,
                      detectionsCount: pageData.detections?.length || 0
                    });
                    
                    const scaffoldDetections = [
                      ...(Array.isArray(pageData.scaffoldData) ? pageData.scaffoldData : []),
                      ...(Array.isArray(pageData.scaffolds) ? pageData.scaffolds : []),
                      ...(Array.isArray(pageData.detections) ? pageData.detections : [])
                    ];
                    const visualizationDetections = isScaffoldMode
                      ? scaffoldDetections
                      : pageData.detections;
                    const visualizationMaterialRows = [
                      ...(Array.isArray(materialRows) ? materialRows : []),
                      ...(Array.isArray(pageData.materials) ? pageData.materials : [])
                    ];

                    if (visualizationDetections && visualizationDetections.length > 0) {
                      return (
                        <OCRResultVisualization
                          detections={visualizationDetections}
                          scale={scale}
                          pageSize={getCachedPageInfo(pageNumber)?.size || pageSize}
                          currentPage={currentPage}
                          isRawDetection={isMaterialMode}
                          normalizedArea={isMaterialMode ? globalOcrRegion : null}
                          materialRows={visualizationMaterialRows}
                          onAddScaffoldAnnotation={(scaffoldInfo) => onAddScaffoldAnnotation && onAddScaffoldAnnotation(scaffoldInfo, currentPage)}
                          onBatchAddScaffoldAnnotations={(scaffoldInfos) => onBatchAddScaffoldAnnotations && onBatchAddScaffoldAnnotations(scaffoldInfos, currentPage)}
                        />
                      );
                    }
                    return null;
                  })()}
                    </>
                  )}
                </PageContainer>
                  );
                })}
              </PageViewport>
            ) : (
              // 连续滚动模式：显示可见范围内的页面
              Array.from({ length: numPages }, (_, index) => {
                const pageNumber = index + 1;
                const isInVisibleRange = pageNumber >= visiblePageRange.start && pageNumber <= visiblePageRange.end;
                
                return (
                  <PageContainer
                    key={`page-${pageNumber}`}
                    ref={createPageRefCallback(pageNumber)}
                    data-page-number={pageNumber}
                  >
                    {isInVisibleRange ? (
                      <FadeInPage>
                        <Page
                          pageNumber={pageNumber}
                          renderMode={renderMode} // Use 'svg' or 'canvas'
                          scale={scale * 2.0} // 调整PDF显示比例，将原150%尺寸设为100%基准
                          devicePixelRatio={getForegroundCanvasDpr(pageNumber, scale * 2.0)}
                          onLoadSuccess={onPageLoadSuccess}
                          renderTextLayer={false}
                          renderAnnotationLayer={false}
                          loading={
                            <SmoothLoader>
                              <Spin size="large" tip="页面加载中..." />
                            </SmoothLoader>
                          }
                        />
                        <AnnotationLayer
                          $annotationMode={annotationMode || pipeSegmentMode}
                          onMouseDown={(e) => handleAnnotationLayerMouseDown(e, pageNumber)}
                          onMouseMove={(e) => handleAnnotationMove(e, pageNumber)}
                          onMouseUp={handleAnnotationEnd}
                        >
                          {renderAnnotationsCached(pageNumber)}
                          {renderAnnotationDragPreview(pageNumber)}
                          {renderPendingNumberingAnnotations(pageNumber)}
                          {currentAnnotation && currentAnnotation.page === pageNumber && renderCurrentAnnotation(pageNumber)}
                        </AnnotationLayer>
                        
                        {/* 矢量可视化调试层 */}
                        <VectorVisualizer
                          ref={(pageNumber === currentPage && pageVectors[pageNumber]?.length > 0) ? firstPageVisualizerRef : null}
                          vectors={pageVectors[pageNumber] || []}
                          scale={scale * 2.0} // 修复：与 Page 组件的缩放比例保持一致
                          visible={showVectorDebug}
                          showWeldDebug={showWeldDebug}
                          showFittingDebug={showFittingDebug}
                          showPipeLengthDebug={showPipeLengthDebug}
                          rulesVersion={rulesVersion}
                          ocrDetections={getPageTextLikeDetections(pageNumber)}
                          pageSize={getCachedPageInfo(pageNumber)?.size || pageSize}
                          enableOCRFilter={enableOCRFilter}
                          weldRecognitionArea={globalWeldRecognitionArea}
                          materialRows={materialRows}
                          materialScope={materialScope}
                          documentKey={pdfFilePath || file?.name || 'document'}
                          pageNumber={pageNumber}
                          pipelineNumber={textDetections[pageNumber]?.pipelineNumber || getPageRecognitionData(pageNumber)?.pipelineNumber || ''}
                          onExecuteUndoableCommand={onExecuteUndoableCommand}
                          onAutoBindFittingMaterials={handleAutoBindFittingMaterials}
                          onDisplayedWeldsChange={handleDisplayedWeldsChange}
                        />
                        
                        {/* 管道识别可视化层 */}
                        <PipelineOverlay
                          vectors={pageVectors[pageNumber] || []}
                          scale={scale * 2.0}
                          visible={showPipelineDebug}
                        />
                        
                        {/* 焊点编号可视化层 */}
                        {pageNumber === currentPage && (
                          <WeldNumberOverlay
                            welds={getNumberingWeldsForPage(pageNumber)}
                            vectors={pageVectors[pageNumber] || []}
                            weldRecognitionArea={latestAreasRef.current.weldRecognition || globalWeldRecognitionArea}
                            frameSize={getWeldPreviewFrameSize(pageNumber)}
                            scale={scale}
                            visible={showWeldNumbers && showWeldDebug && pendingNumberingAnnotations.length === 0}
                            animationSpeed={weldNumberAnimationSpeed}
                            selectionMode={(isWeldStartPickMode || manualWeldDeleteMode) && !manualWeldInsertMode}
                            selectionPreviewOnly={multiPageNumberPreview && (isWeldStartPickMode || manualWeldInsertMode || manualWeldDeleteMode)}
                            onWeldClick={handleNumberingWeldInteraction}
                            manualInsertMode={manualWeldInsertMode}
                            deleteMode={manualWeldDeleteMode}
                            onManualPointClick={handleManualWeldPointClick}
                            selectedStartWeldKey={selectedStartWeld ? getWeldSelectionKey(selectedStartWeld) : null}
                            highlightedWeldKeys={[
                              ...numberingSegments.flatMap(segment => [segment.startKey, segment.endKey]),
                              ...pendingManualWeldDeleteKeys
                            ].filter(Boolean)}
                            hiddenNumberWeldKeys={hiddenNumberWeldKeysForPreview}
                            orderedWelds={orderedNumberingWeldsForPreview}
                            showPathIdHint={true}
                            ocrData={textDetections[pageNumber] || null}
                          />
                        )}

                        {renderPipelineComparisonOverlay(pageNumber)}
                        
                        {/* 文字识别结果数据已保留用于焊点过滤，但不再显示可视化框 */}
                        
                        {/* OCR结果可视化层（材料表识别） */}
                        {(() => {
                          const pageData = getPageRecognitionData(pageNumber);
                          if (!pageData) return null;
                          // 支架模式和普通模式都使用原始 detections
                          // 🎯 材料表模式不应用支架过滤规则
                          const isScaffoldMode = pageData.isScaffoldMode === true;
                          const isMaterialMode = !isScaffoldMode; // 材料表模式
                          
                          const scaffoldDetections = [
                            ...(Array.isArray(pageData.scaffoldData) ? pageData.scaffoldData : []),
                            ...(Array.isArray(pageData.scaffolds) ? pageData.scaffolds : []),
                            ...(Array.isArray(pageData.detections) ? pageData.detections : [])
                          ];
                          const visualizationDetections = isScaffoldMode
                            ? scaffoldDetections
                            : pageData.detections;
                          const visualizationMaterialRows = [
                            ...(Array.isArray(materialRows) ? materialRows : []),
                            ...(Array.isArray(pageData.materials) ? pageData.materials : [])
                          ];

                          if (visualizationDetections && visualizationDetections.length > 0) {
                            return (
                        <OCRResultVisualization
                          detections={visualizationDetections}
                          scale={scale}
                          pageSize={pageSize}
                          currentPage={pageNumber}
                          isRawDetection={isMaterialMode}
                          normalizedArea={isMaterialMode ? globalOcrRegion : null}
                          materialRows={visualizationMaterialRows}
                          onAddScaffoldAnnotation={(scaffoldInfo) => onAddScaffoldAnnotation && onAddScaffoldAnnotation(scaffoldInfo, pageNumber)}
                          onBatchAddScaffoldAnnotations={(scaffoldInfos) => onBatchAddScaffoldAnnotations && onBatchAddScaffoldAnnotations(scaffoldInfos, pageNumber)}
                        />
                            );
                          }
                          return null;
                        })()}
                      </FadeInPage>
                    ) : (
                      // 骨架屏占位符，保持页面高度和位置
                      <PageSkeleton height={`${pageSize.height * scale * 2.0}px`} />
                    )}
                  </PageContainer>
                );
              })
            )}
            
          </>
        )}
      </Document>
      
      {/* 材料编号输入框 - 底部居中显示 */}
      {materialInputVisible && (
        <MaterialInputContainer>
          <MaterialInputTitle>
            材料编号输入
          </MaterialInputTitle>
          <MaterialInputRow>
            <MaterialInputField
              id="material-input-1"
              value={materialNumber1}
              onChange={handleMaterialNumber1Change}
              onFocus={handleInputFocus}
              onBlur={handleInputBlur}
              maxLength={2}
              placeholder="00"
            />
            <MaterialInputSeparator>-</MaterialInputSeparator>
            <MaterialInputField
              id="material-input-2"
              value={materialNumber2}
              onChange={handleMaterialNumber2Change}
              onFocus={handleInput2Focus}
              onBlur={handleInputBlur}
              maxLength={2}
              placeholder="00"
            />
          </MaterialInputRow>
          <MaterialInputButton
            onClick={closeMaterialInput}
          >
            确认保存
          </MaterialInputButton>
        </MaterialInputContainer>
      )}

      {/* 材料表结果对话框 */}
      <Modal
        title="材料表识别结果"
        open={ocrState.results.visible}
        onCancel={() => setOcrState(prev => ({ ...prev, results: { ...prev.results, visible: false } }))}
        width={1000}
        footer={[
          <Button 
            key="export" 
            type="primary" 
            icon={<DownloadOutlined />}
            onClick={() => {
              // 优先使用原始logical_rows数据，如果没有则转换materials
              const logical_rows = ocrState.results.rawLogicalRows && ocrState.results.rawLogicalRows.length > 0 
                ? ocrState.results.rawLogicalRows
                : ocrState.results.materials.map((item, index) => [
                    item.序号 || index + 1,
                    item.材料描述 || item.text || '',
                    item.规格 || '',
                    item.材料代码 || '',
                    item.数量 || '',
                    item.单位 || '',
                    item.类型 || ''
                  ]);
              exportToExcel(logical_rows);
            }}
          >
            导出焊口表
          </Button>,
          <Button key="close" onClick={() => setOcrState(prev => ({ ...prev, results: { ...prev.results, visible: false } }))}>
            关闭
          </Button>
        ]}
      >
        <Table
          columns={generateMaterialColumns(ocrState.results.materials)}
          dataSource={ocrState.results.materials}
          pagination={false}
          size="small"
          bordered
          scroll={{ y: 400, x: 'max-content' }}
          tableLayout="auto"
        />
      </Modal>

      {/* OCR区域和分割线渲染 */}
      {(() => {
        if (!ocrState.isActive || !canvasGeometry) return null;
        
        const { rect, scaleX, scaleY } = canvasGeometry;
        const overlays = [];
        
        // 使用renderKey确保scale变化时重新渲染
        const renderKey = `ocr-${ocrRenderKey}-${scale}`;
        
        // 渲染正在拖拽的区域
        if (ocrState.dragState.isDragging && ocrState.dragState.startPoint && mousePosition) {
          const region = ocrUtils.calculateRect(ocrState.dragState.startPoint, mousePosition);
          const screenX = rect.left + (region.x * scaleX);
          const screenY = rect.top + (region.y * scaleY);
          const screenW = region.width * scaleX;
          const screenH = region.height * scaleY;
          
          overlays.push(
            <div 
              key="dragging-region" 
              style={{
                position: 'fixed',
                left: screenX,
                top: screenY,
                width: screenW,
                height: screenH,
                border: '2px dashed #52c41a',
                background: 'rgba(82, 196, 26, 0.1)',
                pointerEvents: 'none',
                zIndex: 998
              }} 
            />
          );
        }
        
        // 渲染已确定的OCR区域
        if (globalOcrRegion) {
          // 获取Canvas几何信息以正确转换坐标
          const geo = ocrUtils.getCanvasGeometry();
          
          // 如果能获取到几何信息，才渲染OCR区域
          if (geo) {
            // 获取Canvas内部尺寸（使用统一的内部尺寸属性）
            const actualWidth = geo.internalWidth || geo.rect.width;
            const actualHeight = geo.internalHeight || geo.rect.height;
            
            // 将相对坐标转换为Canvas坐标
            const canvasX = globalOcrRegion.x * actualWidth;
            const canvasY = globalOcrRegion.y * actualHeight;
            const canvasW = globalOcrRegion.width * actualWidth;
            const canvasH = globalOcrRegion.height * actualHeight;
            
            // 将Canvas坐标转换为屏幕坐标
            // Use one geometry snapshot for every term. Mixing the stateful
            // rect above with a freshly measured canvas caused display-only
            // jumps while the stored relative region remained correct.
            const screenX = geo.rect.left + (canvasX * geo.scaleX);
            const screenY = geo.rect.top + (canvasY * geo.scaleY);
            const screenW = canvasW * geo.scaleX;
            const screenH = canvasH * geo.scaleY;
          
          // 主区域
          overlays.push(
            <div
              key="ocr-region"
              style={{
                position: 'fixed',
                left: screenX,
                top: screenY,
                width: screenW,
                height: screenH,
                border: '2px solid #52c41a',
                background: 'rgba(82, 196, 26, 0.08)',
                cursor: 'move',
                zIndex: 999
              }}
              title="双击识别；方向键微调（Shift×10）；Delete清空；Esc取消"
            >
              {/* 信息HUD */}
              <div style={{
                position: 'absolute',
                left: 4,
                top: 4,
                padding: '2px 6px',
                background: 'rgba(0, 0, 0, 0.65)',
                color: '#fff',
                fontSize: 11,
                borderRadius: 4,
                pointerEvents: 'none'
              }}>
                {`x:${globalOcrRegion.x}, y:${globalOcrRegion.y}, w:${globalOcrRegion.width}, h:${globalOcrRegion.height}`}
              </div>
              
              {/* 调整手柄 */}
              {Object.entries(ocrUtils.getResizeHandles({
                x: 0, y: 0, 
                width: screenW, 
                height: screenH
              })).map(([handleName, handle]) => (
                <div
                  key={handleName}
                  style={{
                    position: 'absolute',
                    left: handle.x,
                    top: handle.y,
                    width: handle.width,
                    height: handle.height,
                    background: '#52c41a',
                    borderRadius: 2,
                    cursor: {
                      'nw': 'nwse-resize', 'n': 'ns-resize', 'ne': 'nesw-resize',
                      'e': 'ew-resize', 'se': 'nwse-resize', 's': 'ns-resize',
                      'sw': 'nesw-resize', 'w': 'ew-resize'
                    }[handleName],
                    zIndex: 1000000
                  }}
                />
              ))}
            </div>
          );
          
          // 渲染分割线
          globalSplitLines.forEach((splitLine) => {
            // 检查分割线是否在区域内（使用相对坐标）
            if (splitLine.x < globalOcrRegion.x || splitLine.x > globalOcrRegion.x + globalOcrRegion.width) {
              return;
            }
            
            // 将相对坐标转换为Canvas坐标，再转换为屏幕坐标
            const lineCanvasX = splitLine.x * actualWidth;
            const lineScreenX = rect.left + (lineCanvasX * scaleX);
            const isHovered = hoveredSplitLineId === splitLine.id;
            const isDragging = draggingSplitLine && draggingSplitLine.id === splitLine.id;
            overlays.push(
              <div
                key={splitLine.id}
                title="拖拽移动 | 右键删除"
                data-split-line="true"
                style={{
                  position: 'fixed',
                  left: lineScreenX - 4,
                  top: screenY,
                  width: isHovered || isDragging ? 10 : 8,
                  height: screenH,
                  cursor: 'ew-resize',
                  zIndex: 1000,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                onMouseEnter={() => setHoveredSplitLineId(splitLine.id)}
                onMouseLeave={() => { if (!isDragging) setHoveredSplitLineId(null); }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  ocrActions.removeSplitLine(splitLine.id);
                  message.success('已删除分割线');
                }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.nativeEvent.stopImmediatePropagation();
                  isDraggingSplitLineRef.current = true;
                  const geo = ocrUtils.getCanvasGeometry();
                  if (!geo) return;
                  const aw = geo.internalWidth || geo.rect.width;
                  setDraggingSplitLine({
                    id: splitLine.id,
                    startClientX: e.clientX,
                    startRelativeX: splitLine.x,
                    actualWidth: aw,
                    scaleX: geo.scaleX,
                    rectLeft: geo.rect.left,
                  });
                }}
              >
                <div style={{
                  width: isHovered || isDragging ? 3 : 2,
                  height: '100%',
                  background: isHovered || isDragging ? '#ff4d4f' : '#fa8c16',
                  pointerEvents: 'none',
                  transition: 'background 0.15s, width 0.1s',
                }} />
              </div>
            );
          });
          } // 结束 if (geo)
        }

        // 渲染管线号/图号/页码小区域（若已设置）
        const renderSmallArea = (area, key, color, label) => {
          if (!area) return;
          
          // 🔧 实时获取最新的几何信息，确保所有变量来自同一来源
          const geo = ocrUtils.getCanvasGeometry();
          if (!geo) return;
          
          // 统一使用同一个 geo 对象的所有属性
          const { rect: geoRect, scaleX: geoScaleX, scaleY: geoScaleY, internalWidth, internalHeight } = geo;
          
          // 获取Canvas内部尺寸（使用统一的内部尺寸属性）
          const actualWidth = internalWidth || geoRect.width;
          const actualHeight = internalHeight || geoRect.height;
          
          // 将相对坐标转换为Canvas坐标
          const canvasX = area.x * actualWidth;
          const canvasY = area.y * actualHeight;
          const canvasW = area.width * actualWidth;
          const canvasH = area.height * actualHeight;
          
          // 将Canvas坐标转换为屏幕坐标（使用同一个 geo 的 rect 和 scale）
          const ax = geoRect.left + (canvasX * geoScaleX);
          const ay = geoRect.top + (canvasY * geoScaleY);
          const aw = canvasW * geoScaleX;
          const ah = canvasH * geoScaleY;
          
          // 标签样式的估算高度（padding + fontSize + margin）
          const labelHeight = 20;
          
          // 智能定位：如果区域高度太小（< 标签高度 + 8px），则显示在区域下方
          const isSmallArea = ah < labelHeight + 8;
          const labelStyle = isSmallArea ? {
            // 显示在区域下方
            position: 'absolute',
            left: 4,
            top: ah + 4, // 区域下方
            padding: '2px 6px',
            background: 'rgba(0,0,0,0.65)',
            color: '#fff',
            fontSize: 11,
            borderRadius: 4,
            pointerEvents: 'none',
            whiteSpace: 'nowrap'
          } : {
            // 显示在区域内部左上角
            position: 'absolute',
            left: 4,
            top: 4,
            padding: '2px 6px',
            background: 'rgba(0,0,0,0.65)',
            color: '#fff',
            fontSize: 11,
            borderRadius: 4,
            pointerEvents: 'none',
            whiteSpace: 'nowrap'
          };
          
          overlays.push(
            <div
              key={key}
              style={{
                position: 'fixed',
                left: ax,
                top: ay,
                width: aw,
                height: ah,
                border: `2px solid ${color}`,
                background: `${color}14`,
                zIndex: 998,
                pointerEvents: 'none'
              }}
            >
              <div style={labelStyle}>{label}</div>
            </div>
          );
        };

        renderSmallArea(globalPipelineArea, 'pipeline-area', '#1890ff', '管线号');
        renderSmallArea(globalPipeClassArea, 'pipeclass-area', '#13c2c2', '管道等级');
        renderSmallArea(globalDrawingNumberArea, 'drawingnumber-area', '#722ed1', '图号');
        renderSmallArea(globalPageNumberArea, 'pagenumber-area', '#fa8c16', '页码');
        renderSmallArea(globalScaffoldArea, 'scaffold-area', '#52c41a', '支架');
        renderSmallArea(globalWeldRecognitionArea, 'weld-recognition-area', '#ff4d4f', '焊点识别');
        
        return (
          <div key={renderKey}>
            {overlays}
          </div>
        );
      })()}
      

      {/* OCR区域选择器 */}
      <OCRRegionSelector
        pageRefsRef={pageRefsRef}
        currentPage={currentPage}
        scale={scale}
        containerRef={containerRef}
        mousePosition={mousePosition}
        setMousePosition={setMousePosition}
        setGlobalPipelineArea={setGlobalPipelineArea}
        setGlobalDrawingNumberArea={setGlobalDrawingNumberArea}
        setGlobalPageNumberArea={setGlobalPageNumberArea}
        setGlobalScaffoldArea={setGlobalScaffoldArea}
        setGlobalWeldRecognitionArea={setGlobalWeldRecognitionArea}
      />

      {/* 调试按钮 - 如果提供了容器ref，则渲染到容器中（embedded模式），否则渲染为fixed定位 */}
      {debugButtonsContainerRef ? (
        debugButtonsContainerRef.current ? createPortal(
        <>
      {/* 矢量调试切换按钮 */}
      <VectorDebugToggle
        visible={showVectorDebug}
        onToggle={() => setShowVectorDebug(!showVectorDebug)}
            embedded={true}
      />

          {/* 矢量测试按钮 */}
          {/* 文字识别按钮 */}
      <TextDetectionToggle
        detecting={textDetecting}
        hasDetections={!!textDetections[currentPage]}
        detectionCount={textDetections[currentPage]?.detections?.length || 0}
        pipelineNumber={textDetections[currentPage]?.pipelineNumber || ''}
        pipelineStatus={textDetections[currentPage]?.pipelineStatus || 'unresolved'}
        pipelineCandidateCount={textDetections[currentPage]?.pipelineCandidates?.length || 0}
        topPipelineCandidate={textDetections[currentPage]?.pipelineCandidates?.[0]?.normalizedText || ''}
        pipelineEngine={textDetections[currentPage]?.pipelineEngine || 'paddleocr'}
        pipelineFallbackUsed={!!textDetections[currentPage]?.pipelineFallbackUsed}
        onDetect={handleTextDetection}
        onExport={handleExportTextDetections}
            embedded={true}
      />

          <Button
            type="text"
            icon={<ScanOutlined />}
            onClick={handleTogglePipeLengthDebug}
            loading={pipeLengthRecognizing}
            disabled={!numPages || pipeLengthRecognizing}
            style={{
              width: '100%',
              background: showPipeLengthDebug ? 'rgba(14, 165, 233, 0.12)' : 'rgba(255, 255, 255, 0.9)',
              border: '1px solid #0ea5e9',
              borderRadius: '6px',
              fontSize: '12px',
              color: '#0284c7',
              fontWeight: showPipeLengthDebug ? 'bold' : 'normal'
            }}
            title="识别文字识别结果中的管道长度数字，并在当前页用蓝色标出候选管段"
          >
            {pipeLengthRecognizing ? '识别中' : '管道长度'}
          </Button>

          <Button
            type="text"
            icon={<TableOutlined />}
            onClick={() => setShowMaterialRecognitionPanel(true)}
            disabled={!numPages}
            style={{
              width: '100%',
              background: 'rgba(255, 255, 255, 0.9)',
              border: '1px solid #1677ff',
              borderRadius: '6px',
              fontSize: '12px',
              color: '#0958d9'
            }}
            title="使用多页处理中的材料表自动识别逻辑，按当前页码范围识别材料表"
          >
            材料表识别
          </Button>

          <Button
            type="text"
            icon={<BranchesOutlined />}
            onClick={handleBackfillAnnotationPipelines}
            loading={pipelineBackfillProgress.running}
            disabled={!numPages || pipelineBackfillProgress.running}
            style={{
              width: '100%',
              background: 'rgba(255, 255, 255, 0.9)',
              border: '1px solid #52c41a',
              borderRadius: '6px',
              fontSize: '12px',
              color: '#389e0d'
            }}
            title="根据已划定的管线号区域，为缺少管线号的焊口标注批量补全信息"
          >
            补全管线号
          </Button>

      {/* 焊点识别切换按钮 */}
      <WeldDebugToggle
        visible={showWeldDebug}
        onToggle={() => setShowWeldDebug(!showWeldDebug)}
        hasOCRData={!!textDetections[currentPage] || (getPageRecognitionData(currentPage)?.detections?.length > 0)}
        enableOCRFilter={enableOCRFilter}
            embedded={true}
      />

          {/* 管道识别切换按钮 */}


          <Button
            type="text"
            icon={<BranchesOutlined />}
            onClick={() => setShowFittingDebug(prev => !prev)}
            style={{
              width: '100%',
              background: showFittingDebug ? 'rgba(19, 194, 194, 0.12)' : 'rgba(255, 255, 255, 0.9)',
              border: '1px solid #13c2c2',
              borderRadius: '6px',
              fontSize: '12px',
              color: '#08979c',
              fontWeight: showFittingDebug ? 'bold' : 'normal'
            }}
            title="显示/隐藏管件识别候选。开启后显示弯头等管件编辑，不影响焊点识别开关"
          >
            管件识别
          </Button>

          <PipelineDebugToggle
            visible={showPipelineDebug}
            onToggle={() => setShowPipelineDebug(!showPipelineDebug)}
            embedded={true}
          />

      {/* 焊点批量编号按钮 - 切换编号预览 */}
      <WeldBatchNumberToggle
        onGenerate={handleConvertWeldsToAnnotations}
        onToggleNumbers={handleToggleSinglePageWeldNumbering}
        showNumbers={showWeldNumbers}
        disabled={!showWeldDebug}
        weldCount={displayedWelds.length}
        embedded={true}
        animationSpeed={weldNumberAnimationSpeed}
        onAnimationSpeedChange={setWeldNumberAnimationSpeed}
          />

          {/* 多页批量处理面板按钮 */}
          <Button
            type="text"
            onClick={() => setShowMultiPagePanel(true)}
            disabled={!numPages}
            style={{
              width: '100%',
              background: multiPageAbnormalCount > 0
                ? (showMultiPagePanel ? 'rgba(255, 77, 79, 0.14)' : 'rgba(255, 240, 240, 0.96)')
                : (showMultiPagePanel ? 'rgba(114, 46, 209, 0.1)' : 'rgba(255, 255, 255, 0.9)'),
              border: multiPageAbnormalCount > 0 ? '1px solid #ff4d4f' : '1px solid #722ed1',
              borderRadius: '6px',
              fontSize: '12px',
              color: multiPageAbnormalCount > 0 ? '#cf1322' : '#722ed1',
              fontWeight: showMultiPagePanel ? 'bold' : 'normal'
            }}
            title={multiPageAbnormalCount > 0
              ? `多页批量处理：当前有 ${multiPageAbnormalCount} 条管线对账异常`
              : '多页批量处理：分步骤执行 矢量提取→文字识别→焊点识别→批量编号'}
          >
            {renderMultiPageButtonContent()}
          </Button>

          {/* 书签按钮 */}
          <Button
            onClick={() => setShowBookmarkPanel(!showBookmarkPanel)}
            style={{
              width: '100%',
              background: showBookmarkPanel ? 'rgba(24, 144, 255, 0.1)' : 'rgba(255, 255, 255, 0.9)',
              border: '1px solid #1890ff',
              borderRadius: '6px',
              fontSize: '12px',
              color: '#1890ff',
              fontWeight: showBookmarkPanel ? 'bold' : 'normal',
              marginTop: 8
            }}
            icon={<BookOutlined />}
            title="显示/隐藏PDF书签导航"
          >
            {showBookmarkPanel ? '▼' : '▶'} 书签
          </Button>
          
          {/* 书签面板 */}
          {showBookmarkPanel && (
            <div style={{ 
              marginTop: 8, 
              background: 'white', 
              borderRadius: '6px',
              border: '1px solid #d9d9d9',
              maxHeight: '400px',
              overflow: 'hidden'
            }}>
              <BookmarkPanel
                pdfFilePath={pdfFilePath}
                pdfFile={file}
                currentPage={currentPage}
                onPageChange={onPageChange}
              />
            </div>
          )}

          {/* 焊点导出按钮 - 导出选中或所有焊点 */}
          <WeldExportButton
            visible={(showWeldDebug || showVectorDebug) && Object.keys(pageVectors).length > 0}
            onExport={handleExportWelds}
            hasSelection={hasSelection}
            embedded={true}
          />

          {/* 调试/标注导出按钮 - 仅在矢量调试时显示 */}
          <DebugExportButton
            visible={showVectorDebug && Object.keys(pageVectors).length > 0}
            onExport={handleExportDebugData}
            hasSelection={hasSelection}
            embedded={true}
      />

      {/* 焊点规则配置 - 独立显示，随时可配置 */}
      <WeldRuleConfig
        onRulesChange={() => {
          // 触发重新识别
          console.log('🔄 规则已变更，触发重新识别');
          setRulesVersion(prev => prev + 1);
        }}
        weldDebugEnabled={showWeldDebug}
        currentPage={currentPage}
        enableOCRFilter={enableOCRFilter}
        onOCRFilterChange={(enabled) => {
          console.log(enabled ? '✅ OCR文字过滤已启用' : '❌ OCR文字过滤已禁用');
          setEnableOCRFilter(enabled);
          setRulesVersion(prev => prev + 1); // 触发重新识别
        }}
            embedded={true}
          />
        </>,
        debugButtonsContainerRef.current
        ) : null
      ) : (
        <>
          {/* 矢量调试切换按钮 */}
          <VectorDebugToggle
            visible={showVectorDebug}
            onToggle={() => setShowVectorDebug(!showVectorDebug)}
          />

          {/* 矢量测试按钮 */}
          {/* 焊点识别切换按钮 */}
          <WeldDebugToggle
            visible={showWeldDebug}
            onToggle={() => setShowWeldDebug(!showWeldDebug)}
            hasOCRData={!!textDetections[currentPage] || (getPageRecognitionData(currentPage)?.detections?.length > 0)}
            enableOCRFilter={enableOCRFilter}
          />

          {/* 管道识别切换按钮 */}


          <Button
            type="text"
            icon={<BranchesOutlined />}
            onClick={() => setShowFittingDebug(prev => !prev)}
            style={{
              position: 'fixed',
              top: '250px',
              left: '270px',
              zIndex: 1000,
              background: showFittingDebug ? 'rgba(19, 194, 194, 0.12)' : 'rgba(255, 255, 255, 0.9)',
              border: '1px solid #13c2c2',
              borderRadius: '6px',
              fontSize: '12px',
              color: '#08979c',
              fontWeight: showFittingDebug ? 'bold' : 'normal'
            }}
            title="显示/隐藏管件识别候选。开启后显示弯头等管件编辑，不影响焊点识别开关"
          >
            管件识别
          </Button>

          <PipelineDebugToggle
            visible={showPipelineDebug}
            onToggle={() => setShowPipelineDebug(!showPipelineDebug)}
          />

          {/* 文字识别按钮（在焊点识别上方） */}
          <TextDetectionToggle
            detecting={textDetecting}
            hasDetections={!!textDetections[currentPage]}
            detectionCount={textDetections[currentPage]?.detections?.length || 0}
            pipelineNumber={textDetections[currentPage]?.pipelineNumber || ''}
            pipelineStatus={textDetections[currentPage]?.pipelineStatus || 'unresolved'}
            pipelineCandidateCount={textDetections[currentPage]?.pipelineCandidates?.length || 0}
            topPipelineCandidate={textDetections[currentPage]?.pipelineCandidates?.[0]?.normalizedText || ''}
            pipelineEngine={textDetections[currentPage]?.pipelineEngine || 'paddleocr'}
            pipelineFallbackUsed={!!textDetections[currentPage]?.pipelineFallbackUsed}
            onDetect={handleTextDetection}
            onExport={handleExportTextDetections}
          />

          <Button
            type="text"
            icon={<ScanOutlined />}
            onClick={handleTogglePipeLengthDebug}
            loading={pipeLengthRecognizing}
            disabled={!numPages || pipeLengthRecognizing}
            style={{
              position: 'fixed',
              top: '310px',
              left: '270px',
              zIndex: 1000,
              background: showPipeLengthDebug ? 'rgba(14, 165, 233, 0.12)' : 'rgba(255, 255, 255, 0.9)',
              border: '1px solid #0ea5e9',
              borderRadius: '6px',
              fontSize: '12px',
              color: '#0284c7',
              fontWeight: showPipeLengthDebug ? 'bold' : 'normal'
            }}
            title="识别文字识别结果中的管道长度数字，并在当前页用蓝色标出候选管段"
          >
            {pipeLengthRecognizing ? '识别中' : '管道长度'}
          </Button>

          <Button
            type="text"
            icon={<TableOutlined />}
            onClick={() => setShowMaterialRecognitionPanel(true)}
            disabled={!numPages}
            style={{
              position: 'fixed',
              top: '160px',
              left: '270px',
              zIndex: 1000,
              background: 'rgba(255, 255, 255, 0.9)',
              border: '1px solid #1677ff',
              borderRadius: '6px',
              fontSize: '12px',
              color: '#0958d9'
            }}
            title="使用多页处理中的材料表自动识别逻辑，按当前页码范围识别材料表"
          >
            材料表识别
          </Button>

          {/* 焊点批量编号按钮 - 切换编号预览 */}
          <WeldBatchNumberToggle
            onGenerate={handleConvertWeldsToAnnotations}
            onToggleNumbers={handleToggleSinglePageWeldNumbering}
            showNumbers={showWeldNumbers}
            disabled={!showWeldDebug}
            weldCount={displayedWelds.length}
            animationSpeed={weldNumberAnimationSpeed}
            onAnimationSpeedChange={setWeldNumberAnimationSpeed}
      />

          {/* 多页批量处理面板按钮 */}
          <Button
            type="text"
            onClick={() => setShowMultiPagePanel(true)}
            disabled={!numPages}
            style={{
              position: 'fixed',
              top: '370px',
              left: '270px',
              zIndex: 1000,
              background: multiPageAbnormalCount > 0
                ? (showMultiPagePanel ? 'rgba(255, 77, 79, 0.14)' : 'rgba(255, 240, 240, 0.96)')
                : (showMultiPagePanel ? 'rgba(114, 46, 209, 0.1)' : 'rgba(255, 255, 255, 0.9)'),
              border: multiPageAbnormalCount > 0 ? '1px solid #ff4d4f' : '1px solid #722ed1',
              borderRadius: '6px',
              fontSize: '12px',
              color: multiPageAbnormalCount > 0 ? '#cf1322' : '#722ed1',
              fontWeight: showMultiPagePanel ? 'bold' : 'normal'
            }}
            title={multiPageAbnormalCount > 0
              ? `多页批量处理：当前有 ${multiPageAbnormalCount} 条管线对账异常`
              : '多页批量处理：分步骤执行 矢量提取→文字识别→焊点识别→批量编号'}
          >
            {renderMultiPageButtonContent()}
          </Button>

      {/* 焊点导出按钮 - 导出选中或所有焊点 */}
      <WeldExportButton
        visible={(showWeldDebug || showVectorDebug) && Object.keys(pageVectors).length > 0}
        onExport={handleExportWelds}
        hasSelection={hasSelection}
      />

      {/* 调试/标注导出按钮 - 仅在矢量调试时显示 */}
      <DebugExportButton
        visible={showVectorDebug && Object.keys(pageVectors).length > 0}
        onExport={handleExportDebugData}
        hasSelection={hasSelection}
      />

          {/* 焊点规则配置 - 独立显示，随时可配置 */}
          <WeldRuleConfig
            onRulesChange={() => {
              // 触发重新识别
              console.log('🔄 规则已变更，触发重新识别');
              setRulesVersion(prev => prev + 1);
            }}
            weldDebugEnabled={showWeldDebug}
            currentPage={currentPage}
            enableOCRFilter={enableOCRFilter}
            onOCRFilterChange={(enabled) => {
              console.log(enabled ? '✅ OCR文字过滤已启用' : '❌ OCR文字过滤已禁用');
              setEnableOCRFilter(enabled);
              setRulesVersion(prev => prev + 1); // 触发重新识别
            }}
          />
        </>
      )}

      <Modal
        title="对照落图"
        open={compareLayoutVisible}
        width={860}
        onCancel={() => setCompareLayoutVisible(false)}
        footer={[
          <Button key="close" onClick={() => setCompareLayoutVisible(false)}>
            关闭
          </Button>,
          <Button key="run" loading={compareProcessing} onClick={handleRunCompareLayout}>
            识别并匹配
          </Button>,
          <Button
            key="apply"
            type="primary"
            disabled={!compareMatches.some(item => item.status === 'matched')}
            onClick={handleApplyCompareLayout}
          >
            生成到设计院PDF
          </Button>
        ]}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="第一版按页对照：Ep3d PDF 需要是本软件导出的可编辑版 PDF。系统会读取源标注，两边各识别一次焊点，再按相对位置匹配。"
        />
        <Space wrap style={{ marginBottom: 12 }}>
          <label>
            <span style={{ marginRight: 8 }}>Ep3d PDF：</span>
            <input type="file" accept="application/pdf,.pdf" onChange={handleCompareSourceFileChange} />
          </label>
          <span style={{ color: '#595959' }}>
            {compareSourceFile?.file?.name || '未选择'}
          </span>
        </Space>
        <Space wrap style={{ marginBottom: 12 }}>
          <span>源页：</span>
          <InputNumber
            min={1}
            max={compareSourcePageCount || undefined}
            value={compareSourcePage}
            onChange={(value) => setCompareSourcePage(value || 1)}
            style={{ width: 90 }}
          />
          <span style={{ color: '#8c8c8c' }}>
            / {compareSourcePageCount || '-'}
          </span>
          <span style={{ marginLeft: 16 }}>目标页：</span>
          <InputNumber
            min={1}
            max={numPages || undefined}
            value={compareTargetPage}
            onChange={(value) => setCompareTargetPage(value || currentPage || 1)}
            style={{ width: 90 }}
          />
          <Button size="small" onClick={() => setCompareTargetPage(currentPage || 1)}>
            当前页
          </Button>
        </Space>
        {compareSummary && (
          <div style={{ marginBottom: 12, padding: 10, background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 6 }}>
            源标注 {compareSummary.sourceAnnotationCount} 个，源焊点 {compareSummary.sourceWeldCount} 个，目标焊点 {compareSummary.targetWeldCount} 个，已匹配 {compareSummary.matchedCount} 个。
          </div>
        )}
        {compareSummary && (
          <div style={{ marginTop: -8, marginBottom: 12, padding: '0 10px', fontSize: 12, color: '#666' }}>
            Source leaders: {compareSummary.sourceLeaderCount || 0}
          </div>
        )}
        <Table
          size="small"
          rowKey="key"
          dataSource={compareMatches}
          pagination={{ pageSize: 8 }}
          columns={[
            {
              title: '源标注',
              dataIndex: ['annotation', 'text'],
              width: 140,
              render: (value) => value || '-'
            },
            {
              title: '源焊点',
              width: 160,
              render: (_, record) => record.sourcePoint
                ? `${record.sourcePoint.x.toFixed(1)}, ${record.sourcePoint.y.toFixed(1)}`
                : '-'
            },
            {
              title: '目标焊点',
              width: 160,
              render: (_, record) => record.targetPoint
                ? `${record.targetPoint.x.toFixed(1)}, ${record.targetPoint.y.toFixed(1)}`
                : '-'
            },
            {
              title: '匹配距离',
              width: 110,
              render: (_, record) => Number.isFinite(record.normalizedDistance)
                ? record.normalizedDistance.toFixed(3)
                : '-'
            },
            {
              title: '状态',
              width: 90,
              render: (_, record) => record.status === 'matched' ? '已匹配' : '未匹配'
            }
          ]}
        />
      </Modal>

      {/* 多页批量处理抽屉 - 全局挂载，不受侧栏宽度限制 */}
      <Drawer
        title="多页批量处理"
        placement="right"
        width={740}
        open={showMultiPagePanel}
        onClose={() => setShowMultiPagePanel(false)}
        destroyOnClose={false}
        styles={{ body: { padding: '16px', overflow: 'auto' } }}
      >
        <MultiPageProcessPanel
          visible={showMultiPagePanel}
          pdfDocument={pdfDocumentRef}
          pdfPath={pdfFilePath || file}
          pdfFile={file}
          totalPages={numPages}
          scale={scale}
          annotationRule={activeAnnotationRule}
          annotationRules={annotationRules}
          pipelineAreaTemplate={globalPipelineArea}
          pipeClassAreaTemplate={globalPipeClassArea}
          pageNumberAreaTemplate={globalPageNumberArea}
          materialAreaTemplate={globalOcrRegion}
          weldRecognitionAreaTemplate={globalWeldRecognitionArea}
          materialSplitLines={globalSplitLines}
          materialRows={materialRows}
          projectName={projectName}
          onVectorsExtracted={handleVectorsExtracted}
          onTextsDetected={handleTextsDetected}
          onWeldsDetected={handleWeldsDetected}
          onAnnotationsGenerated={handleAnnotationsGenerated}
          onShowNumberPreview={handleShowNumberPreview}
          onStartSegmentCorrection={handleStartMultiPageSegmentCorrection}
          onRestoreAutoOrder={handleRestoreMultiPageAutoOrder}
          onPipelineComparisonReady={handlePipelineComparisonReady}
        />
      </Drawer>

      <Modal
        title="补全焊口标注管线号"
        open={pipelineBackfillProgress.visible}
        closable={!pipelineBackfillProgress.running}
        maskClosable={!pipelineBackfillProgress.running}
        keyboard={!pipelineBackfillProgress.running}
        footer={pipelineBackfillProgress.running ? null : (
          <Button type="primary" onClick={() => setPipelineBackfillProgress(previous => ({ ...previous, visible: false }))}>
            完成
          </Button>
        )}
        onCancel={() => {
          if (!pipelineBackfillProgress.running) {
            setPipelineBackfillProgress(previous => ({ ...previous, visible: false }));
          }
        }}
      >
        <Progress
          percent={pipelineBackfillProgress.total > 0
            ? Math.round((pipelineBackfillProgress.current / pipelineBackfillProgress.total) * 100)
            : 0}
          status={pipelineBackfillProgress.running ? 'active' : 'normal'}
        />
        <div style={{ marginTop: 12, lineHeight: 1.8 }}>
          <div>
            {pipelineBackfillProgress.running && pipelineBackfillProgress.currentPage
              ? `正在处理第${pipelineBackfillProgress.currentPage}页`
              : `已处理 ${pipelineBackfillProgress.current}/${pipelineBackfillProgress.total} 页`}
          </div>
          <div>已补全：{pipelineBackfillProgress.updated} 个焊口标注</div>
          {pipelineBackfillProgress.failedPages.length > 0 && (
            <div style={{ color: '#cf1322' }}>
              未识别页：{pipelineBackfillProgress.failedPages.join('、')}
            </div>
          )}
        </div>
      </Modal>

      <Drawer
        title="材料表识别"
        placement="right"
        width={420}
        open={showMaterialRecognitionPanel}
        onClose={() => setShowMaterialRecognitionPanel(false)}
        destroyOnClose={false}
        styles={{ body: { padding: '16px', overflow: 'auto' } }}
      >
        <MaterialRecognitionPanel
          visible={showMaterialRecognitionPanel}
          pdfPath={pdfFilePath || file}
          pdfFile={file}
          totalPages={numPages}
          currentPage={currentPage}
          pipelineAreaTemplate={globalPipelineArea}
          materialAreaTemplate={globalOcrRegion}
          materialSplitLines={globalSplitLines}
          onClose={() => setShowMaterialRecognitionPanel(false)}
        />
      </Drawer>

    </ViewerContainer>
  );
};

export default PDFViewer;
