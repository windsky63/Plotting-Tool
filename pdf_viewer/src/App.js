import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import styled from 'styled-components';
import { ConfigProvider, message, Modal, Form, Input, InputNumber, Button } from 'antd';
import { ExclamationCircleOutlined } from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import PDFViewer from './components/PDFViewer';
import Toolbar from './components/Toolbar';
import ProgressModal from './components/ProgressModal';
import PdfExportProgress from './components/PdfExportProgress';
import { getPdfExportProgress, publishPdfExportProgress } from './utils/pdfExportProgress';
import { savePdfWithTimeBudget } from './utils/pdfSerialization';
import { buildAnnotationMoveTransaction, applyAnnotationMovePatches, getAnnotationMovePages } from './utils/annotationMoveTransaction';
import { getSquareLeaderConnection } from './utils/squareLeaderConnection';
import AnnotationRulesPanel from './components/AnnotationRulesPanel';
import StatsPanel from './components/StatsPanel';
import H3yunUploadModal from './components/H3yunUploadModal';
import VisualizationPanel from './components/VisualizationPanel';
import WelcomeScreen from './components/WelcomeScreen';
import { OCRProgressModal, OCRResultsTable } from './components/OCR';
import { OCRProvider, useOCRContext } from './contexts/OCRContext';
import { ocrService } from './services/ocrService';
import auditLogService from './services/auditLogService';
import weldAiService from './services/weldAiService';
import { summarizeConfirmedWeldLabels } from './utils/weldAiFusion';
import { ocrDataUtils } from './utils/ocrUtils';
import { buildOcrServerUrl } from './config/ocrServer';
import { useUndoRedo, createArrayCommands } from './hooks/useUndoRedo';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import './App.css';
// 平台适配器
import { isElectron, logPlatformInfo } from './utils/platformDetect';
import { fileAdapter } from './adapters/fileAdapter';
import { configAdapter } from './adapters/configAdapter';
import { createBoundedDraftScheduler } from './utils/boundedDraftScheduler';
import {
  buildPdfDraftFileInfo,
  clearLatestAnnotationDraft,
  isSamePdfDraftFile,
  loadLatestAnnotationDraft,
  markLatestAnnotationDraftSaved,
  saveEmergencyAnnotationDraft
} from './utils/annotationDraftStore';
import { loadCloudAnnotationDraft } from './utils/annotationCloudDraftStore';
import {
  saveCloudAnnotationDraftOffMainThread,
  saveLocalAnnotationDraftOffMainThread
} from './utils/annotationDraftPersistenceWorker';
import {
  buildScaffoldMaterialLibrary,
  cleanScaffoldText,
  isAnyMaterialSectionHeader,
  isScaffoldDetection,
  isSupportSectionHeader
} from './utils/scaffoldRecognitionUtils';
import {
  getFixedA3TenMmFrameSize,
  isFixedA3TenMmShape,
  scaleAnnotationValue
} from './utils/pageAnnotationScale';
import { getNextPipeSegmentLabel } from './utils/pipeSegmentUtils';
import { exportWeldTableFromTemplate } from './utils/weldTableTemplateExport';
import { saveAutomaticLayoutLog } from './utils/bookmarkLogger';
import { buildAnnotationReplacementPlan } from './utils/batchAnnotationReplacementUtils';
import { buildDirectWeldAdjustmentPlan } from './utils/weldAdjustmentDeltaUtils';
import { formatSplitCircleTopText } from './utils/splitCircleTextUtils';
import {
  createPageAnnotationIndex,
  getPageAnnotationRevision,
  getPageAnnotations
} from './utils/pageAnnotationIndex';
import {
  DEFAULT_TEXT_RECTANGLE_FRAME_SIZE,
  getAnnotationFrameSize,
  normalizeTextRectangleAnnotation,
  normalizeTextRectangleAnnotations
} from './utils/textRectangleFrame';
import {
  CANVAS_PERFORMANCE_STORAGE_KEY,
  normalizeCanvasPerformanceMode
} from './utils/canvasPerformanceProfiles';
// 内存监控
import memoryMonitor from './utils/memoryMonitor';
// 使用CDN加载的全局变量
const XLSX = window.XLSX;
const SHENYUAN_UIO_PROJECT_ID = 'b4e684e7-b75e-4bde-87a6-001c7dcdab9c';
const MAX_RESIDENT_PDF_BUFFER_BYTES = 64 * 1024 * 1024;
const usesPageScopedMaterials = (project = {}) => (
  String(project.projectId || '').trim() === SHENYUAN_UIO_PROJECT_ID ||
  String(project.projectName || '').includes('申远')
);

const ANNOTATION_POSITION_FIELDS = new Set(['startX', 'startY', 'endX', 'endY', 'hasLeaderLine']);
const ANNOTATION_CONTENT_FIELDS = new Set([
  'text', 'topText', 'jointTypeText', 'materialNumber', 'materialBinding', 'materialBindings',
  'materialBindingPage', 'borderShape', 'attributes', 'pipelineNumber', 'pipeClass', 'remark'
]);

// The status heartbeats run independently of annotation work. Returning the
// previous object when nothing changed prevents a 30-second health response
// from rerendering a large PDF annotation workspace.
const setServiceStatusIfChanged = (setter, nextStatus) => {
  setter(previous => (
    previous?.status === nextStatus.status &&
    previous?.message === nextStatus.message &&
    previous?.isReady === nextStatus.isReady
      ? previous
      : nextStatus
  ));
};
const getAnnotationOrigin = annotation => (
  annotation?.origin === 'auto' || annotation?.origin === 'manual'
    ? annotation.origin
    : (annotation?.isBatchGenerated ? 'auto' : 'manual')
);
const classifyAnnotationEdit = fields => {
  const keys = Array.from(new Set(fields || []));
  const hasPosition = keys.some(key => ANNOTATION_POSITION_FIELDS.has(key));
  const hasContent = keys.some(key => ANNOTATION_CONTENT_FIELDS.has(key));
  const hasStyle = keys.some(key => !ANNOTATION_POSITION_FIELDS.has(key) && !ANNOTATION_CONTENT_FIELDS.has(key));
  if (hasPosition && !hasContent && !hasStyle) return 'layout';
  if ([hasPosition, hasContent, hasStyle].filter(Boolean).length > 1) return 'mixed';
  if (hasContent) return 'content';
  return 'style';
};
const buildOriginCounts = annotations => (annotations || []).reduce((counts, annotation) => {
  const origin = getAnnotationOrigin(annotation);
  counts[origin] = (counts[origin] || 0) + 1;
  return counts;
}, {});
const buildPrimitiveChanges = (before, after, fields) => Object.fromEntries(
  (fields || []).filter(field => {
    const oldValue = before?.[field];
    const newValue = after?.[field];
    return ['string', 'number', 'boolean'].includes(typeof oldValue)
      || ['string', 'number', 'boolean'].includes(typeof newValue)
      || oldValue === null
      || newValue === null;
  }).map(field => [field, { from: before?.[field] ?? '', to: after?.[field] ?? '' }])
);

const buildLayoutQualitySnapshot = (annotations = [], weldStats = {}) => {
  const autoAnnotations = annotations.filter(annotation => (
    annotation?.type === 'text' &&
    annotation?.isBatchGenerated &&
    getAnnotationOrigin(annotation) === 'auto'
  ));
  const correctedAutoAnnotations = autoAnnotations.filter(annotation => annotation.qualityModified === true);
  const manualCorrectionAnnotations = annotations.filter(annotation => (
    annotation?.type === 'text' &&
    getAnnotationOrigin(annotation) === 'manual' &&
    (annotation.qualityCorrection === true || !!annotation.batchRunId)
  ));
  const deletedAutoCount = Math.max(0, Number(weldStats?.deleted || 0));
  const initialAutoCount = autoAnnotations.length + deletedAutoCount;
  const finalWeldCount = autoAnnotations.length + manualCorrectionAnnotations.length;
  const acceptedAutoCount = Math.max(0, autoAnnotations.length - correctedAutoAnnotations.length);
  return {
    initialAutoCount,
    currentAutoCount: autoAnnotations.length,
    acceptedAutoCount,
    correctedAutoCount: correctedAutoAnnotations.length,
    deletedAutoCount,
    manualCorrectionCount: manualCorrectionAnnotations.length,
    finalWeldCount,
    onePassAccuracy: finalWeldCount > 0 ? acceptedAutoCount / finalWeldCount : null,
    correctionRate: initialAutoCount > 0 ? correctedAutoAnnotations.length / initialAutoCount : null,
    deletionRate: initialAutoCount > 0 ? deletedAutoCount / initialAutoCount : null,
    missedAdditionRate: finalWeldCount > 0 ? manualCorrectionAnnotations.length / finalWeldCount : null
  };
};

const AppContainer = styled.div`
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f5f5f5;
  position: relative;
`;

const DragOverlay = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(24, 144, 255, 0.1);
  border: 3px dashed #1890ff;
  display: ${props => props.$show ? 'flex' : 'none'};
  align-items: center;
  justify-content: center;
  z-index: 9999;
  pointer-events: none;
`;

const DragOverlayText = styled.div`
  background: white;
  padding: 30px 50px;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  font-size: 20px;
  color: #1890ff;
  font-weight: 500;
`;

const CloudDraftStatusBadge = styled.div`
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 1200;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 18px;
  color: ${props => props.$status === 'error' ? '#a8071a' : props.$status === 'saving' ? '#0958d9' : '#237804'};
  background: ${props => props.$status === 'error' ? '#fff1f0' : props.$status === 'saving' ? '#e6f4ff' : '#f6ffed'};
  border: 1px solid ${props => props.$status === 'error' ? '#ffccc7' : props.$status === 'saving' ? '#91caff' : '#b7eb8f'};
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  pointer-events: none;
`;

const ReplaceDragFrame = styled.div`
  position: absolute;
  top: 16px;
  right: 16px;
  bottom: 16px;
  left: 16px;
  border: 2px dashed rgba(24, 144, 255, 0.45);
  border-radius: 14px;
  background: rgba(24, 144, 255, 0.04);
  box-shadow: inset 0 0 0 1px rgba(24, 144, 255, 0.08);
  opacity: ${props => props.$show ? 1 : 0};
  transform: ${props => props.$show ? 'scale(1)' : 'scale(0.985)'};
  transition: opacity 0.18s ease, transform 0.18s ease;
  pointer-events: none;
  z-index: 20;
`;

const ReplaceDragBadge = styled.div`
  position: absolute;
  top: 24px;
  right: 24px;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid rgba(24, 144, 255, 0.2);
  box-shadow: 0 8px 24px rgba(24, 144, 255, 0.12);
  color: #1677ff;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  opacity: ${props => props.$show ? 1 : 0};
  transform: ${props => props.$show ? 'translateY(0)' : 'translateY(-6px)'};
  transition: opacity 0.18s ease, transform 0.18s ease;
  pointer-events: none;
  z-index: 21;
`;

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  overflow: hidden;
  padding-top: var(--toolbar-height, 56px);
  box-sizing: border-box;
  min-height: 0;
`;

const MainContent = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
`;

const DRAG_REPLACE_HINT_TIMEOUT = 3000;

class RulesPanelErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('右侧标注管理栏渲染失败，已自动收起：', error, info);
    this.props.onError?.(error);
  }

  componentDidUpdate(previousProps) {
    if (
      this.state.hasError &&
      previousProps.resetKey !== this.props.resetKey &&
      this.props.resetKey === false
    ) {
      this.setState({ hasError: false });
    }
  }

  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

// 内部App组件，可以使用OCR Context
function AppContent() {
  // 使用OCR Context
  const ocrContext = useOCRContext();
  const { handleBatchOCR } = ocrContext;
  const checkWebOcrReady = useCallback(async () => {
    const mineruBaseUrl = await ocrService.getMineruBaseUrl();
    try {
      const response = await fetch(`${mineruBaseUrl}/health`, {
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) {
        return { available: false, ready: false, source: 'mineru', url: `${mineruBaseUrl}/health` };
      }
      const healthData = await response.json();
      return {
        available: true,
        ready: Boolean(healthData.ready),
        source: 'mineru',
        url: `${mineruBaseUrl}/health`,
        error: healthData.error || ''
      };
    } catch (mineruError) {
      return {
        available: false,
        ready: false,
        source: 'mineru',
        url: `${mineruBaseUrl}/health`,
        error: mineruError.message
      };
    }
  }, []);

  // 平台检测和OCR服务初始化
  useEffect(() => {
    const initializeApp = async () => {
      try {
        // 打印平台信息
        console.log('🎉 PDF 单线图焊口预制标注工具启动');
        logPlatformInfo();
        
        // 初始化OCR服务
        console.log('🚀 开始初始化OCR服务...');
        await ocrService.initialize();
        console.log('✅ OCR服务初始化完成');
        // Resume locally queued/accepted training samples after startup and
        // whenever the browser reports that the network is back online.
        weldAiService.startQueueRecovery();
        
        // Web 环境提示
        if (!isElectron()) {
          console.log('💡 Web模式提示:');
          console.log('  - 文件通过上传/拖放打开');
          console.log('  - 保存将下载到浏览器默认下载目录');
          console.log('  - OCR功能需要本地OCR服务运行');
          console.log('  - 所有标注功能正常可用');
        }
        
      } catch (error) {
        console.error('❌ 应用初始化失败:', error);
        console.error('💡 这可能影响OCR功能的使用，请查看上方的详细错误信息');
      }
    };

    initializeApp();
  }, []);
  const [pdfFile, setPdfFile] = useState(null);
  const [pdfDocumentForBatchSizing, setPdfDocumentForBatchSizing] = useState(null);
  const [weldAiSampleSubmitting, setWeldAiSampleSubmitting] = useState(false);
  const [weldAiSampleExporting, setWeldAiSampleExporting] = useState(false);
  const [pdfFileName, setPdfFileName] = useState(''); // 添加PDF文件名状态
  const [pdfFilePath, setPdfFilePath] = useState(null); // 添加PDF文件路径状态
  const [pdfArrayBuffer, setPdfArrayBuffer] = useState(null); // 保存PDF的ArrayBuffer以避免权限问题
  const [dragHintMode, setDragHintMode] = useState(null); // null | welcome | replace
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [canvasPerformanceMode, setCanvasPerformanceMode] = useState(() => {
    try {
      return normalizeCanvasPerformanceMode(localStorage.getItem(CANVAS_PERFORMANCE_STORAGE_KEY));
    } catch (error) {
      return 'smooth';
    }
  });
  const [pageSize, setPageSize] = useState({ width: 1190, height: 841 }); // 添加页面尺寸状态
  const dragStateRef = useRef({ active: false, muted: false, timer: null });
  const selectedH3ProjectRef = useRef(null);

  useEffect(() => {
    setPdfDocumentForBatchSizing(null);
  }, [pdfFile]);

  const getCurrentProjectContext = useCallback(() => {
    const project = selectedH3ProjectRef.current || window.__selectedH3Project__ || null;
    if (!project) return {};
    const projectName = String(project.name || project.label || '').trim();
    const projectId = String(project.value || project.ObjectId || project.BizObjectId || '').trim();
    return {
      projectId,
      projectName,
      projectManual: Boolean(project.manual)
    };
  }, []);

  const sanitizeDraftKeyPart = useCallback((value) => String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .slice(0, 48), []);

  const getCurrentProjectDraftFileInfo = useCallback((fileInfo) => {
    const project = getCurrentProjectContext();
    if (!fileInfo?.fingerprint || !project.projectId) {
      return fileInfo;
    }
    const safeProjectId = sanitizeDraftKeyPart(project.projectId);
    return {
      ...fileInfo,
      originalFingerprint: fileInfo.originalFingerprint || fileInfo.fingerprint,
      fingerprint: `${sanitizeDraftKeyPart(fileInfo.fingerprint)}_project_${safeProjectId}`.slice(0, 128),
      projectId: safeProjectId,
      originalProjectId: project.projectId,
      projectName: project.projectName
    };
  }, [getCurrentProjectContext, sanitizeDraftKeyPart]);

  const getCurrentProjectFileNamePart = useCallback(() => {
    const projectName = getCurrentProjectContext().projectName;
    return projectName
      ? projectName.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80)
      : '';
  }, [getCurrentProjectContext]);

  // Quality finalization callbacks below depend on these states, so they must
  // be initialized before those callbacks are created during the first render.
  const [annotations, setAnnotations] = useState([]);
  const annotationPageIndexRef = useRef(null);
  const annotationPageIndex = useMemo(() => {
    const nextIndex = createPageAnnotationIndex(annotations, annotationPageIndexRef.current);
    annotationPageIndexRef.current = nextIndex;
    return nextIndex;
  }, [annotations]);
  const currentPageAnnotations = getPageAnnotations(annotationPageIndex, currentPage);
  const currentPageAnnotationRevision = getPageAnnotationRevision(annotationPageIndex, currentPage);
  const [weldStats, setWeldStats] = useState({
    batchAdded: 0,
    deleted: 0,
    modified: 0,
    manuallyAdded: 0
  });

  const logAuditEvent = useCallback((action, payload = {}) => {
    const project = getCurrentProjectContext();
    auditLogService.log(action, {
      pdfFileName,
      page: currentPage,
      ...project,
      ...payload
    });
  }, [pdfFileName, currentPage, getCurrentProjectContext]);
  const activeWorkRef = useRef({
    sessionId: '',
    storageKey: '',
    activeMs: 0,
    reportedMs: 0,
    lastTickAt: 0,
    lastActivityAt: 0
  });
  const accumulateActiveWork = useCallback(() => {
    const state = activeWorkRef.current;
    if (!state.sessionId || !state.lastTickAt) return state.activeMs || 0;
    const now = Date.now();
    const elapsed = Math.max(0, now - state.lastTickAt);
    const multiPageRecognitionActive = window.__luotuMultiPagePreparationActive__ === true;
    const manualActivityActive = document.visibilityState === 'visible' &&
      now - state.lastActivityAt <= 60 * 1000;
    if (multiPageRecognitionActive) {
      // Recognition time is occupied wall-clock time. Do not cap it or depend
      // on page visibility because background tabs throttle JavaScript timers.
      state.activeMs += elapsed;
    } else if (manualActivityActive) {
      state.activeMs += Math.min(elapsed, 15 * 1000);
    }
    state.lastTickAt = now;
    if (state.storageKey) {
      try {
        window.sessionStorage.setItem(`${state.storageKey}:activeMs`, String(Math.round(state.activeMs)));
      } catch {
        // Work-time persistence must not affect annotation work.
      }
    }
    return state.activeMs;
  }, []);
  const reportActiveWork = useCallback((force = false) => {
    const state = activeWorkRef.current;
    const activeMs = Math.round(accumulateActiveWork());
    const deltaMs = Math.max(0, activeMs - Number(state.reportedMs || 0));
    if (!state.sessionId || (!force && deltaMs < 10 * 1000) || deltaMs <= 0) return activeMs;
    const project = getCurrentProjectContext();
    auditLogService.log('layout_work_active', {
      pdfFileName,
      ...project,
      count: 1,
      sessionId: state.sessionId,
      activeDeltaMs: deltaMs
    });
    state.reportedMs = activeMs;
    if (state.storageKey) {
      try {
        window.sessionStorage.setItem(`${state.storageKey}:reportedMs`, String(activeMs));
      } catch {
        // Work-time reporting must not affect annotation work.
      }
    }
    return activeMs;
  }, [accumulateActiveWork, getCurrentProjectContext, pdfFileName]);

  useEffect(() => {
    if (!pdfFileName) {
      activeWorkRef.current = { sessionId: '', storageKey: '', activeMs: 0, reportedMs: 0, lastTickAt: 0, lastActivityAt: 0 };
      return undefined;
    }
    const storageKey = `luotu_quality_session:${pdfFileName}`;
    let sessionId = '';
    let activeMs = 0;
    let reportedMs = 0;
    try {
      sessionId = window.sessionStorage.getItem(storageKey) || '';
      activeMs = Number(window.sessionStorage.getItem(`${storageKey}:activeMs`) || 0);
      reportedMs = Number(window.sessionStorage.getItem(`${storageKey}:reportedMs`) || 0);
      if (!sessionId) {
        sessionId = `quality-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        window.sessionStorage.setItem(storageKey, sessionId);
      }
    } catch {
      sessionId = `quality-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    }
    const now = Date.now();
    activeWorkRef.current = {
      sessionId,
      storageKey,
      activeMs: Number.isFinite(activeMs) ? Math.max(0, activeMs) : 0,
      reportedMs: Number.isFinite(reportedMs) ? Math.max(0, reportedMs) : 0,
      lastTickAt: now,
      lastActivityAt: now
    };
    const markActivity = () => {
      accumulateActiveWork();
      activeWorkRef.current.lastActivityAt = Date.now();
    };
    const handleMultiPageRecognitionTiming = event => {
      // Settle the interval using the previous state before switching it. This
      // records the full recognition duration even if the tab was minimized.
      accumulateActiveWork();
      window.__luotuMultiPagePreparationActive__ = event?.detail?.active === true;
      activeWorkRef.current.lastTickAt = Date.now();
    };
    const activityEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    activityEvents.forEach(eventName => window.addEventListener(eventName, markActivity, { passive: true }));
    window.addEventListener('multi-page-recognition-timing', handleMultiPageRecognitionTiming);
    const accumulateIntervalId = window.setInterval(accumulateActiveWork, 10 * 1000);
    const reportIntervalId = window.setInterval(() => reportActiveWork(false), 60 * 1000);
    return () => {
      reportActiveWork(true);
      window.clearInterval(accumulateIntervalId);
      window.clearInterval(reportIntervalId);
      activityEvents.forEach(eventName => window.removeEventListener(eventName, markActivity));
      window.removeEventListener('multi-page-recognition-timing', handleMultiPageRecognitionTiming);
    };
  }, [pdfFileName, accumulateActiveWork, reportActiveWork]);
  const logLayoutQualityFinalization = useCallback((completionType) => {
    const activeMs = Math.round(reportActiveWork(true));
    const quality = buildLayoutQualitySnapshot(annotations, weldStats);
    if (quality.initialAutoCount <= 0 && quality.manualCorrectionCount <= 0) return;
    logAuditEvent('layout_quality_finalize', {
      count: 1,
      sessionId: activeWorkRef.current.sessionId,
      completionType,
      totalPages,
      annotationCount: annotations.length,
      manualActiveMs: activeMs,
      ...quality
    });
  }, [annotations, weldStats, logAuditEvent, reportActiveWork, totalPages]);
  const logAnnotationSnapshot = useCallback((reason) => {
    logAuditEvent('annotation_snapshot', {
      count: 1,
      reason,
      annotationCount: annotations.length,
      originCounts: buildOriginCounts(annotations),
      totalPages
    });
  }, [annotations, logAuditEvent, totalPages]);
  const loggedPdfOpenRef = useRef('');

  useEffect(() => {
    if (!pdfFileName || !totalPages) return;
    const key = `${pdfFileName}:${totalPages}`;
    if (loggedPdfOpenRef.current === key) return;
    loggedPdfOpenRef.current = key;
    setWeldStats({ batchAdded: 0, deleted: 0, modified: 0, manuallyAdded: 0 });
    const project = getCurrentProjectContext();
    auditLogService.log('pdf_open', {
      pdfFileName,
      totalPages,
      pageCount: totalPages,
      count: 1,
      ...project
    });
  }, [pdfFileName, totalPages, getCurrentProjectContext]);

  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);
  
  // 标注相关状态
  const [annotationMode, setAnnotationMode] = useState(false);
  const [batchSequenceDraftState, setBatchSequenceDraftState] = useState(null);
  const [weldAdjustmentToolbarState, setWeldAdjustmentToolbarState] = useState({
    available: false,
    mode: 'idle',
    handleAction: null
  });
  // 移除currentAnnotationTool状态，因为现在固定为文字标注
  const [annotationColor, setAnnotationColor] = useState('#FF0000'); // 默认红色
  const [annotationFontSize, setAnnotationFontSize] = useState(34); // 默认字体大小为34px
  const [annotationTopFontSize, setAnnotationTopFontSize] = useState(16);
  const [annotationBottomFontSize, setAnnotationBottomFontSize] = useState(34);
  const [annotationFrameSize, setAnnotationFrameSize] = useState(56.7); // 默认框大小对角线
  const [annotationBorderShape, setAnnotationBorderShape] = useState('circle'); // 默认圆形边框
  const [annotationPipeTagRotation, setAnnotationPipeTagRotation] = useState(0);
  const [annotationPipeTagZeroPadCount, setAnnotationPipeTagZeroPadCount] = useState(0);
  
  // 用于存储来自AnnotationRulesPanel的handleEditAnnotation函数引用
  const annotationEditHandlerRef = useRef(null);
  
  // 调试按钮容器的ref，用于Portal渲染
  const debugButtonsContainerRef = useRef(null);
  
  // 标注规则相关状态
  const [annotationRules, setAnnotationRules] = useState([]);
  const [activeAnnotationRule, setActiveAnnotationRule] = useState(null);
  const [continuousRuleNumberingEnabled, setContinuousRuleNumberingEnabled] = useState(
    () => localStorage.getItem('continuousRuleNumberingEnabled') === 'true'
  );
  const [continuousRuleNumber, setContinuousRuleNumber] = useState(() => {
    const savedNumber = Number.parseInt(localStorage.getItem('continuousRuleNumber'), 10);
    return Number.isFinite(savedNumber) ? savedNumber : 1;
  });
  const effectiveActiveAnnotationRule = useMemo(() => {
    if (!activeAnnotationRule || !continuousRuleNumberingEnabled) {
      return activeAnnotationRule;
    }
    return {
      ...activeAnnotationRule,
      currentNumber: continuousRuleNumber
    };
  }, [activeAnnotationRule, continuousRuleNumberingEnabled, continuousRuleNumber]);
  const [rulesVisible, setRulesVisible] = useState(false);
  
  // 使用新的撤销重做系统
  const undoRedoSystem = useUndoRedo({ maxHistorySize: 50 });
  
  // 跟踪新添加的标注，防止自动更新产生独立的撤销记录
  const [newlyAddedAnnotations, setNewlyAddedAnnotations] = useState(new Set());
  
  // 防抖处理：避免频繁更新同一个标注
  const [updateTimeouts, setUpdateTimeouts] = useState(new Map());
  const annotationsRef = useRef([]);
  const moveUndoRef = useRef({ initial: new Map(), timer: null });
  const copiedAnnotationRef = useRef(null);
  const lastSelectedAnnotationIdRef = useRef(null);
  const pdfPointerPositionRef = useRef(null);
  const currentPdfDraftInfoRef = useRef(null);
  const currentPageForDraftRef = useRef(currentPage);
  const annotationDraftDirtyRef = useRef(false);
  const annotationDraftFlushTimerRef = useRef(null);
  const annotationDraftSaveInFlightRef = useRef(null);
  const annotationDraftSaveErrorShownRef = useRef(false);
  const latestAnnotationDraftRef = useRef(null);
  const localAnnotationDraftInitializedRef = useRef(false);
  const localAnnotationDraftFullCheckpointVersionRef = useRef(1);
  const localAnnotationDraftCompletedFullVersionRef = useRef(0);
  const annotationDraftDirtyPageVersionsRef = useRef(new Map());
  const annotationCheckpointPagesRef = useRef(new Set());
  const annotationCheckpointInFlightRef = useRef(false);
  const latestAutoBatchAnnotationRef = useRef(null);
  const previouslyIndexedAnnotationsRef = useRef([]);
  const startupDraftPromptShownRef = useRef(false);
  const cloudAnnotationDraftSchedulerRef = useRef(null);
  const cloudAnnotationDraftGenerationRef = useRef(0);
  const localAnnotationDraftPendingSinceRef = useRef(null);
  const cloudAnnotationDraftInFlightRef = useRef(null);
  const latestCloudAnnotationDraftRef = useRef(null);
  const cloudAnnotationDraftErrorShownRef = useRef(false);
  const cloudAnnotationDraftUnsupportedRef = useRef(false);
  const [cloudAnnotationDraftStatus, setCloudAnnotationDraftStatus] = useState('idle');

  // 添加选中标注状态
  const [selectedAnnotation, setSelectedAnnotation] = useState(null);
  const [selectedAnnotationIds, setSelectedAnnotationIds] = useState([]);

  useEffect(() => {
    annotationsRef.current = annotations;

    const previous = previouslyIndexedAnnotationsRef.current;
    const appendOnly = annotations.length >= previous.length && (
      previous.length === 0 || annotations[previous.length - 1] === previous[previous.length - 1]
    );
    const scanStart = appendOnly ? previous.length : 0;
    if (!appendOnly) latestAutoBatchAnnotationRef.current = null;
    for (let index = scanStart; index < annotations.length; index += 1) {
      const item = annotations[index];
      if (item?.isBatchGenerated && getAnnotationOrigin(item) === 'auto' && item.batchRunId) {
        latestAutoBatchAnnotationRef.current = item;
      }
    }
    previouslyIndexedAnnotationsRef.current = annotations;
  }, [annotations]);

  useEffect(() => {
    currentPageForDraftRef.current = currentPage;
  }, [currentPage]);

  const handlePdfPointerPositionChange = useCallback((position) => {
    pdfPointerPositionRef.current = position;
  }, []);

  const markAnnotationDraftDirty = useCallback((pages = null) => {
    if (isElectron() || !currentPdfDraftInfoRef.current) {
      return;
    }
    annotationDraftDirtyRef.current = true;
    // Callers that cannot identify every affected page force one complete
    // checkpoint. Ordinary per-page annotation work supplies its page number
    // and thereafter sends only that page to the persistence worker.
    if (pages == null) localAnnotationDraftFullCheckpointVersionRef.current += 1;
    const normalizedPages = Array.isArray(pages)
      ? pages
      : [pages == null ? currentPageForDraftRef.current : pages];
    normalizedPages.forEach(pageValue => {
      const page = Number(pageValue);
      if (!Number.isInteger(page) || page < 1) return;
      const versions = annotationDraftDirtyPageVersionsRef.current;
      versions.set(page, Number(versions.get(page) || 0) + 1);
    });
  }, []);

  const handleBatchSequenceStateChange = useCallback((nextState) => {
    setBatchSequenceDraftState(nextState || null);
    markAnnotationDraftDirty();
  }, [markAnnotationDraftDirty]);

  const resetAnnotationDraftState = useCallback(() => {
    cloudAnnotationDraftGenerationRef.current += 1;
    cloudAnnotationDraftSchedulerRef.current?.cancel();
    localAnnotationDraftPendingSinceRef.current = null;
    annotationDraftDirtyRef.current = false;
    annotationDraftSaveErrorShownRef.current = false;
    latestAnnotationDraftRef.current = null;
    localAnnotationDraftInitializedRef.current = false;
    localAnnotationDraftFullCheckpointVersionRef.current += 1;
    localAnnotationDraftCompletedFullVersionRef.current = 0;
    annotationDraftDirtyPageVersionsRef.current.clear();
    latestCloudAnnotationDraftRef.current = null;
    annotationCheckpointPagesRef.current.clear();
    annotationCheckpointInFlightRef.current = false;
    cloudAnnotationDraftErrorShownRef.current = false;
    setCloudAnnotationDraftStatus('idle');
    if (annotationDraftFlushTimerRef.current) {
      clearTimeout(annotationDraftFlushTimerRef.current);
      annotationDraftFlushTimerRef.current = null;
    }
  }, []);

  const persistCloudAnnotationDraft = useCallback((draftToSave) => {
    if (isElectron() || cloudAnnotationDraftUnsupportedRef.current || !draftToSave?.fileInfo?.fingerprint) {
      return Promise.resolve(null);
    }

    latestCloudAnnotationDraftRef.current = draftToSave;

    if (cloudAnnotationDraftInFlightRef.current) {
      return cloudAnnotationDraftInFlightRef.current;
    }

    setCloudAnnotationDraftStatus('saving');
    cloudAnnotationDraftSchedulerRef.current?.cancel();
    const generation = cloudAnnotationDraftGenerationRef.current;

    const runSave = (currentDraft) => {
      let failed = false;
      return saveCloudAnnotationDraftOffMainThread(currentDraft)
      .then((result) => {
        if (generation !== cloudAnnotationDraftGenerationRef.current) return result;
        cloudAnnotationDraftErrorShownRef.current = false;
        setCloudAnnotationDraftStatus('saved');
        return result;
      })
      .catch((error) => {
        failed = true;
        if (generation !== cloudAnnotationDraftGenerationRef.current) return null;
        console.warn('保存云端标注草稿失败:', error);
        setCloudAnnotationDraftStatus('error');
        if (error?.status === 404) {
          cloudAnnotationDraftUnsupportedRef.current = true;
        }
        if (!cloudAnnotationDraftErrorShownRef.current) {
          message.warning(error?.status === 404
            ? '当前 OCR 后端未升级云端草稿接口，请重启或更新 OCR 服务；本机草稿仍已保存'
            : '云端标注草稿保存失败，本机草稿仍已保存');
          cloudAnnotationDraftErrorShownRef.current = true;
        }
        if (error?.status !== 404) {
          cloudAnnotationDraftSchedulerRef.current?.retry(latestCloudAnnotationDraftRef.current || currentDraft, 60000);
        }
        return null;
      })
      .finally(() => {
        const pendingDraft = latestCloudAnnotationDraftRef.current;
        if (!failed && pendingDraft && pendingDraft !== currentDraft && generation === cloudAnnotationDraftGenerationRef.current) {
          cloudAnnotationDraftSchedulerRef.current?.cancel();
          cloudAnnotationDraftInFlightRef.current = runSave(pendingDraft);
          return cloudAnnotationDraftInFlightRef.current;
        }
        cloudAnnotationDraftInFlightRef.current = null;
        // A previous document's request may finish after a new document opens.
        if (pendingDraft && generation !== cloudAnnotationDraftGenerationRef.current) {
          cloudAnnotationDraftSchedulerRef.current?.schedule(pendingDraft, 0);
        }
      });
    };

    cloudAnnotationDraftInFlightRef.current = runSave(draftToSave);
    return cloudAnnotationDraftInFlightRef.current;
  }, []);

  const scheduleCloudAnnotationDraftSave = useCallback((draft) => {
    if (isElectron() || cloudAnnotationDraftUnsupportedRef.current || !draft?.fileInfo?.fingerprint) {
      return;
    }

    latestCloudAnnotationDraftRef.current = draft;
    setCloudAnnotationDraftStatus('saving');

    if (!cloudAnnotationDraftSchedulerRef.current) {
      cloudAnnotationDraftSchedulerRef.current = createBoundedDraftScheduler(persistCloudAnnotationDraft);
    }
    cloudAnnotationDraftSchedulerRef.current.schedule(draft);
  }, [persistCloudAnnotationDraft]);

  useEffect(() => {
    const retry = () => {
      const draft = latestCloudAnnotationDraftRef.current;
      if (draft) persistCloudAnnotationDraft(draft);
    };
    window.addEventListener('online', retry);
    return () => {
      window.removeEventListener('online', retry);
      cloudAnnotationDraftSchedulerRef.current?.cancel();
    };
  }, [persistCloudAnnotationDraft]);

  const discardLatestAnnotationDraft = useCallback(async () => {
    if (isElectron()) {
      return;
    }

    try {
      if (annotationDraftSaveInFlightRef.current) {
        await annotationDraftSaveInFlightRef.current;
      }
      resetAnnotationDraftState();
      await clearLatestAnnotationDraft();
    } catch (error) {
      console.warn('清除标注草稿失败:', error);
    }
  }, [resetAnnotationDraftState]);

  const markAnnotationDraftSaved = useCallback(async () => {
    if (isElectron()) {
      return;
    }

    if (annotationDraftSaveInFlightRef.current) {
      await annotationDraftSaveInFlightRef.current;
    }
    if (latestCloudAnnotationDraftRef.current) {
      const cloudResult = await persistCloudAnnotationDraft(latestCloudAnnotationDraftRef.current);
      // A failed cloud save must retain the recovery checkpoint and its retry.
      if (!cloudResult) return;
    }
    resetAnnotationDraftState();
    try {
      await markLatestAnnotationDraftSaved();
    } catch (error) {
      console.warn('标记标注草稿已保存失败:', error);
    }
  }, [persistCloudAnnotationDraft, resetAnnotationDraftState]);

  const flushAnnotationDraft = useCallback(async ({ emergency = false } = {}) => {
    if (
      isElectron() ||
      !annotationDraftDirtyRef.current ||
      !currentPdfDraftInfoRef.current ||
      !pdfFile
    ) {
      return null;
    }
    localAnnotationDraftPendingSinceRef.current = null;

    const project = getCurrentProjectContext();
    const draft = {
      fileInfo: getCurrentProjectDraftFileInfo(currentPdfDraftInfoRef.current),
      fileName: pdfFileName,
      project,
      annotations,
      batchSequenceState: batchSequenceDraftState,
      currentPage: currentPageForDraftRef.current,
      scale,
      totalPages,
      updatedAt: new Date().toISOString()
    };
    const dirtyPageVersions = new Map(annotationDraftDirtyPageVersionsRef.current);
    const annotationPages = Array.from(new Set(
      annotations.map(annotation => Math.max(1, Number(annotation?.page) || 1))
    )).sort((left, right) => left - right);
    const fullCheckpointVersion = localAnnotationDraftFullCheckpointVersionRef.current;
    const requiresFullCheckpoint = !localAnnotationDraftInitializedRef.current ||
      localAnnotationDraftCompletedFullVersionRef.current < fullCheckpointVersion;
    let localDraft = draft;
    if (!requiresFullCheckpoint) {
      const dirtyPages = new Set(dirtyPageVersions.keys());
      const annotationsByPage = new Map(Array.from(dirtyPages, page => [page, []]));
      annotations.forEach(annotation => {
        const page = Math.max(1, Number(annotation?.page) || 1);
        if (annotationsByPage.has(page)) annotationsByPage.get(page).push(annotation);
      });
      const draftMeta = { ...draft };
      delete draftMeta.annotations;
      localDraft = {
        ...draftMeta,
        annotationCount: annotations.length,
        annotationPages,
        annotationPageUpdates: Array.from(annotationsByPage, ([page, pageAnnotations]) => ({
          page,
          annotations: pageAnnotations
        }))
      };
    }
    const pendingSave = {
      localDraft,
      dirtyPageVersions,
      isFullCheckpoint: requiresFullCheckpoint,
      fullCheckpointVersion
    };
    latestAnnotationDraftRef.current = pendingSave;
    if (emergency) {
      // Browser shutdown does not wait for IndexedDB. Keep one synchronous
      // recovery copy only at lifecycle boundaries, never on every edit.
      saveEmergencyAnnotationDraft(draft);
    }
    scheduleCloudAnnotationDraftSave(draft);

    if (annotationDraftSaveInFlightRef.current) {
      return annotationDraftSaveInFlightRef.current;
    }

    const persistDraft = (saveRequest) => saveLocalAnnotationDraftOffMainThread(saveRequest.localDraft)
      .then((savedDraft) => {
        annotationDraftSaveErrorShownRef.current = false;
        if (savedDraft) {
          window.__luotuLastLocalDraftSave = { ...savedDraft, completedAt: Date.now() };
          window.__luotuLocalDraftSaveHistory = [
            ...(window.__luotuLocalDraftSaveHistory || []),
            window.__luotuLastLocalDraftSave
          ].slice(-30);
          localAnnotationDraftInitializedRef.current = true;
          if (saveRequest.isFullCheckpoint) {
            localAnnotationDraftCompletedFullVersionRef.current = Math.max(
              localAnnotationDraftCompletedFullVersionRef.current,
              saveRequest.fullCheckpointVersion
            );
          }
          saveRequest.dirtyPageVersions.forEach((version, page) => {
            if (annotationDraftDirtyPageVersionsRef.current.get(page) === version) {
              annotationDraftDirtyPageVersionsRef.current.delete(page);
            }
          });
        }
        return savedDraft;
      })
      .catch((error) => {
        console.error('保存标注草稿失败:', error);
        if (!annotationDraftSaveErrorShownRef.current) {
          message.error('自动保存标注草稿失败，请尽快手动保存 PDF');
          annotationDraftSaveErrorShownRef.current = true;
        }
        return null;
      })
      .finally(() => {
        const pendingDraft = latestAnnotationDraftRef.current;
        if (annotationDraftDirtyRef.current && pendingDraft && pendingDraft !== saveRequest) {
          annotationDraftSaveInFlightRef.current = persistDraft(pendingDraft);
          return annotationDraftSaveInFlightRef.current;
        }
        annotationDraftSaveInFlightRef.current = null;
      });

    annotationDraftSaveInFlightRef.current = persistDraft(pendingSave);

    return annotationDraftSaveInFlightRef.current;
  }, [annotations, batchSequenceDraftState, pdfFile, pdfFileName, scale, scheduleCloudAnnotationDraftSave, totalPages, getCurrentProjectContext, getCurrentProjectDraftFileInfo]);

  useEffect(() => {
    if (
      isElectron() ||
      !annotationDraftDirtyRef.current ||
      !currentPdfDraftInfoRef.current ||
      !pdfFile
    ) {
      return undefined;
    }

    if (annotationDraftFlushTimerRef.current) {
      clearTimeout(annotationDraftFlushTimerRef.current);
    }

    if (localAnnotationDraftPendingSinceRef.current === null) {
      localAnnotationDraftPendingSinceRef.current = Date.now();
    }
    annotationDraftFlushTimerRef.current = setTimeout(() => {
      annotationDraftFlushTimerRef.current = null;
      flushAnnotationDraft();
    }, Math.max(0, Math.min(2000, 10000 - (Date.now() - localAnnotationDraftPendingSinceRef.current))));

    return () => {
      if (annotationDraftFlushTimerRef.current) {
        clearTimeout(annotationDraftFlushTimerRef.current);
        annotationDraftFlushTimerRef.current = null;
      }
    };
  }, [annotations, batchSequenceDraftState, flushAnnotationDraft, pdfFile, scale]);

  // Every 10 edited pages, force a durable IndexedDB checkpoint and release
  // older undo closures. This bounds long-session memory on 16 GB terminals.
  useEffect(() => {
    if (
      isElectron() ||
      annotationCheckpointPagesRef.current.size < 10 ||
      annotationCheckpointInFlightRef.current ||
      !annotationDraftDirtyRef.current
    ) return;

    annotationCheckpointInFlightRef.current = true;
    annotationCheckpointPagesRef.current.clear();
    // A periodic full manifest repairs any interrupted/missing page shard.
    // Normal two-second saves between checkpoints remain page-delta only.
    localAnnotationDraftFullCheckpointVersionRef.current += 1;
    flushAnnotationDraft()
      .then(savedDraft => {
        if (savedDraft) {
          undoRedoSystem.trimHistory(5);
          window.dispatchEvent(new CustomEvent('luotu-annotation-memory-checkpoint', {
            detail: { currentPage: currentPageForDraftRef.current }
          }));
        }
      })
      .finally(() => {
        annotationCheckpointInFlightRef.current = false;
      });
  }, [annotations, flushAnnotationDraft, undoRedoSystem]);

  useEffect(() => {
    if (isElectron()) {
      return undefined;
    }

    const flushIfNeeded = (emergency = false) => {
      if (annotationDraftDirtyRef.current) {
        flushAnnotationDraft({ emergency });
      }
    };

    const handleBeforeUnload = (event) => {
      if (!annotationDraftDirtyRef.current) {
        return undefined;
      }

      flushIfNeeded(true);
      event.preventDefault();
      event.returnValue = '';
      return '';
    };

    const handlePageHide = () => {
      flushIfNeeded(true);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushIfNeeded(true);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [flushAnnotationDraft]);


  // 添加管段号模式状态
  const [pipeSegmentMode, setPipeSegmentMode] = useState(false);
  const [pipeSegmentCounter, setPipeSegmentCounter] = useState(0); // 序号计数器，从0开始递增
  const [pipeSegmentStartLetter, setPipeSegmentStartLetter] = useState('A'); // 起始序号（可以是字母、数字或混合）
  const [pipeSegmentFontSize, setPipeSegmentFontSize] = useState(16); // 管段号字体大小

  // 添加强制更新状态
  const [forceUpdateKey, setForceUpdateKey] = useState(0);
  
  // 添加显示模式状态（单页显示）
  const [viewMode, setViewMode] = useState('single');
  
  // 添加模板上传状态
  const [templateUploaded, setTemplateUploaded] = useState(false);
  const [currentTemplate, setCurrentTemplate] = useState(null);
  
  // 添加支架模板状态
  const [scaffoldTemplateUploaded, setScaffoldTemplateUploaded] = useState(false);
  
  // 添加混合模板状态（材料+支架+页码）
  const [mixedTemplateUploaded, setMixedTemplateUploaded] = useState(false);
  
  // 检测是否为混合模板的函数（同时包含材料表区域和支架区域）
  const isMixedTemplate = useCallback((template) => {
    if (!template) return false;
    
    // 混合模板应该同时有材料区域和支架区域
    return template.materialArea && 
           template.scaffoldArea &&
           typeof template.materialArea.x === 'number' &&
           typeof template.scaffoldArea.x === 'number';
  }, []);
  
  // 检测是否为支架模板的函数
  const isScaffoldTemplate = useCallback((template) => {
    if (!template) return false;
    
    // 支架模板应该有支架区域，且材料区域为null或undefined
    return template.scaffoldArea && 
           (template.materialArea === null || template.materialArea === undefined);
  }, []);

  // 添加材料编码功能状态（从localStorage恢复）
  const [enableMaterialEncoding, setEnableMaterialEncoding] = useState(() => {
    try {
      const savedState = localStorage.getItem('enableMaterialEncoding');
      if (savedState !== null) {
        return JSON.parse(savedState);
      }
    } catch (error) {
      // 静默处理错误
    }
    return false;
  });

  // OCR服务状态
  const [ocrServerStatus, setOcrServerStatus] = useState({
    status: 'starting', // starting, ready, error
    message: '正在启动OCR服务...',
    isReady: false

  });

  // Web端UI缩放（仅在非Electron环境中使用）
  const [mineruServerStatus, setMineruServerStatus] = useState({
    status: 'starting',
    message: '正在启动MinerU服务...',
    isReady: false
  });

  const [webZoomFactor, setWebZoomFactor] = useState(() => {
    // 从localStorage读取保存的缩放值
    try {
      const saved = localStorage.getItem('webZoomFactor');
      return saved ? parseFloat(saved) : 1.0;
    } catch {
      return 1.0;
    }
  });

  // 可视化识别相关状态
  const [visualizationPanelVisible, setVisualizationPanelVisible] = useState(false);

  // 按页面管理识别数据和状态 - 使用缓存管理器优化内存
  const [pageRecognitionData, setPageRecognitionData] = useState({}); // 保留作为兼容性（导出等功能）
  const [cacheUpdateTrigger, setCacheUpdateTrigger] = useState(0); // 触发React重渲染

  // 引入页面数据缓存管理器
  const pageCache = useMemo(() => {
    const cache = require('./utils/pageDataCache').default;
    return cache;
  }, []);

  // 监控页面识别数据变化
  useEffect(() => {
    const cachedPage = pageCache.getPage(currentPage);
    const currentPageData = cachedPage?.data || pageRecognitionData[currentPage]?.data || pageRecognitionData[currentPage];
    if (!currentPageData) {
      handleMaterialRowsChange([], [], currentPage);
      return;
    }

    const normalizePipelineNumber = (value) => String(value || '')
      .replace(/LINE\s*NO\.?\s*[:：]?/ig, '')
      .replace(/管线号\s*[:：]?/g, '')
      .replace(/\s+/g, '')
      .replace(/[^A-Z0-9-]/ig, '')
      .toUpperCase();
    const getPagePipeline = (pageData) => normalizePipelineNumber(
      pageData?.pipelineNumber
      || pageData?.pipeline?.text
      || pageData?.pipeline
      || pageData?.materials?.find(item => item?.pipelineNumber)?.pipelineNumber
    );
    const currentPipeline = getPagePipeline(currentPageData);
    const isShenyuanPageScopedMaterials = usesPageScopedMaterials(getCurrentProjectContext());

    // 申远项目的每一张单线图都带有本页专属材料表。即使相邻页管线号
    // 相同，也不能把材料数量跨页相加；其他项目保持原来的按管线汇总逻辑。
    const pageNumbers = isShenyuanPageScopedMaterials
      ? [currentPage]
      : currentPipeline
      ? Array.from(new Set([
          currentPage,
          ...Object.keys(pageRecognitionData || {}).map(page => Number(page)).filter(Boolean),
          ...pageCache.getRecognizedPages()
        ])).sort((a, b) => a - b)
      : [currentPage];

    const combinedMaterials = [];
    const combinedRawRows = [];

    pageNumbers.forEach((pageNum) => {
      const pageData = pageCache.getPageData(pageNum) || pageRecognitionData[pageNum]?.data || pageRecognitionData[pageNum];
      if (!pageData) return;
      const pagePipeline = getPagePipeline(pageData);
      if (pageNum !== currentPage && (!currentPipeline || !pagePipeline || pagePipeline !== currentPipeline)) return;

      const pageMaterials = Array.isArray(pageData.materials) ? pageData.materials : [];
      const pageRawRows = Array.isArray(pageData.rawLogicalRows) ? pageData.rawLogicalRows : [];
      if (pageMaterials.length > 0) {
        pageMaterials.forEach((material, index) => {
          combinedMaterials.push({
            ...material,
            sourcePage: material.sourcePage || pageNum,
            pipelineNumber: material.pipelineNumber || pageData.pipelineNumber || ''
          });
          combinedRawRows.push(pageRawRows[index] || material.rawLogicalRow || []);
        });
      } else {
        pageRawRows.forEach((row) => combinedRawRows.push(row));
      }
    });

    handleMaterialRowsChange(combinedMaterials, combinedRawRows, currentPage);
  }, [pageRecognitionData, currentPage, cacheUpdateTrigger, pageCache, getCurrentProjectContext]);

  // 🧹 页面切换时触发内存清理
  useEffect(() => {
    if (currentPage > 0) {
      // Cache cleanup can scan many entries. Run it only when the browser is
      // idle so a page flip never competes with this maintenance work.
      const runCleanup = () => {
        if (navigator.scheduling?.isInputPending?.()) {
          cleanupTask = { type: 'timeout', id: setTimeout(runCleanup, 1000) };
          return;
        }
        pageCache.cleanup(currentPage);
        
        // 输出统计信息（仅开发环境）
        if (process.env.NODE_ENV === 'development') {
          const stats = pageCache.getStats();
          console.log(`📊 内存统计 (当前第${currentPage}页):`, stats);
        }
      };
      let cleanupTask;
      if (typeof window.requestIdleCallback === 'function') {
        cleanupTask = {
          type: 'idle',
          id: window.requestIdleCallback(runCleanup, { timeout: 5000 })
        };
      } else {
        cleanupTask = { type: 'timeout', id: setTimeout(runCleanup, 2000) };
      }

      return () => {
        if (cleanupTask?.type === 'idle' && typeof window.cancelIdleCallback === 'function') {
          window.cancelIdleCallback(cleanupTask.id);
        } else if (cleanupTask?.id) {
          clearTimeout(cleanupTask.id);
        }
      };
    }
  }, [currentPage, pageCache]);

  // 当前页面的识别数据和状态（使用缓存管理器）
  const { recognitionData, recognitionStatus } = useMemo(() => {
    const pageData = pageCache.getPage(currentPage);
    return {
      recognitionData: pageData.data,
      recognitionStatus: pageData.status
    };
  }, [currentPage, cacheUpdateTrigger, pageCache]);

  const [materialBindingRows, setMaterialBindingRows] = useState([]);

  const handleMaterialRowsChange = useCallback((materials = [], rawLogicalRows = [], sourcePage = currentPage) => {
    const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const sourceDocument = String(
      pdfFilePath ||
      (pdfFile ? `${pdfFile.name || pdfFileName || 'document'}:${pdfFile.size || ''}:${pdfFile.lastModified || ''}` : '') ||
      pdfFileName ||
      ''
    ).trim();
    const normalizeForSimilarity = (value) => normalizeText(value)
      .toUpperCase()
      .replace(/[\s|,;:：，；。.'"`~!@#$%^&*()_+=[\]{}<>?/\\-]+/g, '');
    const getSimilarity = (left, right) => {
      if (left === right) return 1;
      if (!left || !right) return 0;
      const a = left.length <= right.length ? left : right;
      const b = left.length <= right.length ? right : left;
      const previous = Array.from({ length: a.length + 1 }, (_, index) => index);
      for (let i = 1; i <= b.length; i++) {
        let prevDiagonal = previous[0];
        previous[0] = i;
        for (let j = 1; j <= a.length; j++) {
          const temp = previous[j];
          previous[j] = b[i - 1] === a[j - 1]
            ? prevDiagonal
            : Math.min(previous[j - 1], previous[j], prevDiagonal) + 1;
          prevDiagonal = temp;
        }
      }
      const distance = previous[a.length];
      return 1 - distance / Math.max(left.length, right.length);
    };
    const isMaterialHeaderRow = (row) => {
      const id = normalizeText(row.materialId || row.column1);
      const description = normalizeText(row.description || row.text || row.column2);
      const specification = normalizeText(row.specification || row.diameter || row.column3);
      const code = normalizeText(row.materialCode || row.column4);
      const quantity = normalizeText(row.quantity || row.column5);
      const combined = `${id} ${specification} ${description}`.toUpperCase();
      if (!combined.trim()) return true;
      if (/COMPONENT\s+DESCRIPTION|PT\s*NO|ITEM\s+CODE|QTY/.test(combined) && !code && !quantity) return true;
      if (/^(PIPE|FITTINGS?|FLANGES?|GASKETS?|SUPPORTS?|BOLTS?|NUTS?|VALVES?\s*\/?\s*IN-?LINE\s+ITEMS?|FABRICATION\s+ITEMS?|ERECTION\s+ITEMS?|CUT\s+PIECE\s+LIST|WELD\s+LIST)$/i.test(description)) return true;
      return false;
    };
    const normalizeMaterialIdentityValue = (value) => normalizeForSimilarity(String(value || ''));
    const buildMaterialComparableKey = (row) => {
      if (row.standardMaterialColumns) {
        const materialSpec = row.specification || row.diameter || '';
        return [
          row.sourceDocument,
          row.pipelineNumber,
          row.description,
          materialSpec,
          row.materialCode
        ].map(normalizeMaterialIdentityValue).join('|');
      }
      return [
        row.sourceDocument,
        row.pipelineNumber,
        row.description,
        row.specification,
        row.diameter,
        row.materialCode,
        row.unit,
        row.jointType,
        row.type
      ].map(normalizeMaterialIdentityValue).join('|');
    };
    const parseMaterialQuantity = (value) => {
      const text = normalizeText(value).replace(/,/g, '');
      const match = text.match(/\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : null;
    };
    const formatMaterialQuantity = (value) => {
      if (!Number.isFinite(value)) return '';
      return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
    };
    const mergeMaterialRows = (existing, row) => {
      const existingQuantity = parseMaterialQuantity(existing.quantity);
      const rowQuantity = parseMaterialQuantity(row.quantity);
      const canSumQuantity = Number.isFinite(existingQuantity) && Number.isFinite(rowQuantity);
      const mergedQuantity = canSumQuantity
        ? formatMaterialQuantity(existingQuantity + rowQuantity)
        : (existing.quantity || row.quantity || '');
      const sourcePages = Array.from(new Set([
        ...(Array.isArray(existing.sourcePages) ? existing.sourcePages : [existing.sourcePage]),
        ...(Array.isArray(row.sourcePages) ? row.sourcePages : [row.sourcePage])
      ].filter(value => value !== undefined && value !== null && value !== '')));
      return {
        ...existing,
        quantity: mergedQuantity,
        sourcePages,
        sourcePage: existing.sourcePage || row.sourcePage,
        mergedMaterialIds: Array.from(new Set([
          ...(existing.mergedMaterialIds || [existing.materialId]),
          row.materialId
        ].filter(Boolean))),
        rawMaterial: {
          ...(existing.rawMaterial || {}),
          QTY: mergedQuantity,
          quantity: mergedQuantity,
          ['数量']: mergedQuantity
        }
      };
    };

    const sourceMaterials = (Array.isArray(materials) && materials.length > 0)
      ? materials
      : (rawLogicalRows || []).map((raw) => {
          if (!Array.isArray(raw)) return raw;
          return {
            column1: raw[0],
            column2: raw[1],
            column3: raw[2],
            column4: raw[3],
            column5: raw[4],
            column6: raw[5],
            column7: raw[6],
            column8: raw[7],
            column9: raw[8],
            column10: raw[9],
            column11: raw[10]
          };
        });

    const rows = (sourceMaterials || []).map((material, index) => {
      const raw = rawLogicalRows?.[index] || (Array.isArray(material) ? material : []);
      const materialId = material.序号 || material.ID || material.id || material.column1 || raw[0] || index + 1;
      const description = material.材料描述 || material.DESCRIPTION || material.description || material.text || material.column2 || raw[1] || '';
      const specification = material.规格 || material.ND || material.specification || material.column3 || raw[2] || '';
      const materialCode = material.材料代码 || material.材料编码 || material.ITEM_CODE || material.itemCode || material.column4 || raw[3] || '';
      const quantity = material.数量 || material.QTY || material.quantity || material.column5 || raw[4] || '';
      const unit = material.单位 || material.unit || material.column6 || raw[5] || '';
      const type = material.类型 || material.type || material.column7 || raw[6] || '';
      const rowSourcePage = material.sourcePage || sourcePage;
      const pipelineNumber = material.pipelineNumber || raw[5] || raw[7] || '';
      const drawingNumber = raw[8] || material.图号 || '';
      const ocrPage = raw[9] || material.OCR页码 || '';
      const calculatedPage = material.calculatedPage || raw[10] || rowSourcePage || '';
      const documentPart = sourceDocument || 'document';
      const materialIdentityKey = [
        documentPart,
        pipelineNumber,
        description,
        specification,
        materialCode,
        unit,
        type
      ].map(value => normalizeForSimilarity(String(value || ''))).join('|');

      return {
        key: materialIdentityKey || material.key || `${documentPart}-${rowSourcePage}-${index}`,
        materialId: String(materialId || ''),
        description: String(description || ''),
        specification: String(specification || ''),
        materialCode: String(materialCode || ''),
        quantity: String(quantity || ''),
        unit: String(unit || ''),
        type: String(type || ''),
        pipelineNumber: String(pipelineNumber || ''),
        drawingNumber: String(drawingNumber || ''),
        ocrPage: String(ocrPage || ''),
        calculatedPage: String(calculatedPage || ''),
        sourceDocument,
        sourcePage: rowSourcePage,
        rawMaterial: material,
        rawLogicalRow: raw
      };
    });

    const pickMaterialField = (material, keys, fallback = '') => {
      for (const key of keys) {
        if (material && material[key] !== undefined && material[key] !== null && material[key] !== '') {
          return material[key];
        }
      }
      return fallback;
    };

    const getMaterialColumn = (material, raw, index) => {
      const columnKey = `column${index + 1}`;
      if (material && material[columnKey] !== undefined && material[columnKey] !== null && material[columnKey] !== '') {
        return material[columnKey];
      }
      return Array.isArray(raw) ? raw[index] : '';
    };

    const getMaterialRowColumns = (material, raw) => {
      const maxColumnCount = Math.max(
        Array.isArray(raw) ? raw.length : 0,
        ...Object.keys(material || {})
          .map(key => /^column(\d+)$/.exec(key))
          .filter(Boolean)
          .map(match => Number(match[1]))
      );
      return Array.from({ length: Math.max(maxColumnCount, 5) }, (_, index) => normalizeText(getMaterialColumn(material, raw, index)));
    };

    const findHeaderColumnIndex = (columns, patterns) => {
      return columns.findIndex((value) => {
        const normalized = value.toUpperCase().replace(/\s+/g, ' ').trim();
        return patterns.some(pattern => pattern.test(normalized));
      });
    };

    const getMaterialHeaderMap = () => {
      const candidates = [
        ...(sourceMaterials || []).map((material, index) => ({
          material,
          raw: rawLogicalRows?.[index] || (Array.isArray(material) ? material : [])
        })),
        ...(rawLogicalRows || []).map(raw => ({ material: Array.isArray(raw) ? {} : raw, raw }))
      ];

      for (const candidate of candidates) {
        const columns = getMaterialRowColumns(candidate.material || {}, candidate.raw || []);
        const idIndex = findHeaderColumnIndex(columns, [/^PT\s*NO\.?$/, /^PART\s*NO\.?$/, /^ID$/, /^序号$/]);
        const descriptionIndex = findHeaderColumnIndex(columns, [/COMPONENT\s+DESCRIPTION/, /MATERIAL\s+DESCRIPTION/, /^DESCRIPTION$/, /材料描述/]);
        const diameterIndex = findHeaderColumnIndex(columns, [/^D[NN](?:\s*\(.*\))?$/, /^NPS$/, /^SIZE(?:\s*\(.*\))?$/, /管径/, /^规格$/]);
        const codeIndex = findHeaderColumnIndex(columns, [/ITEM\s+CODE/, /MATERIAL\s+CODE/, /材料代?码/, /材料编码/, /^CODE$/]);
        const quantityIndex = findHeaderColumnIndex(columns, [/^QTY$/, /^QUANTITY$/, /^数量$/]);

        if (descriptionIndex >= 0 && diameterIndex >= 0 && codeIndex >= 0) {
          return {
            idIndex: idIndex >= 0 ? idIndex : 0,
            descriptionIndex,
            diameterIndex,
            codeIndex,
            quantityIndex: quantityIndex >= 0 ? quantityIndex : -1
          };
        }
      }

      return null;
    };

    const materialHeaderMap = getMaterialHeaderMap();
    const supportSectionByIndex = new Map();
    let inSupportMaterialSection = false;

    (sourceMaterials || []).forEach((material, index) => {
      const raw = rawLogicalRows?.[index] || (Array.isArray(material) ? material : []);
      const columns = getMaterialRowColumns(material || {}, raw || []);
      const description = materialHeaderMap
        ? normalizeText(columns[materialHeaderMap.descriptionIndex] || '')
        : normalizeText(columns[1] || material?.description || material?.DESCRIPTION || material?.text || material?.column2 || '');
      const supportHeader = columns.find(value => isSupportSectionHeader(value));
      const anySectionHeader = columns.find(value => isAnyMaterialSectionHeader(value));

      if (isSupportSectionHeader(description) || supportHeader) {
        inSupportMaterialSection = true;
        supportSectionByIndex.set(index, false);
        return;
      }

      if (isAnyMaterialSectionHeader(description) || anySectionHeader) {
        inSupportMaterialSection = false;
        supportSectionByIndex.set(index, false);
        return;
      }

      supportSectionByIndex.set(index, inSupportMaterialSection);
    });

    const pickSupportDescriptionFromColumns = (columns, headerMap) => {
      const ignoredIndexes = new Set([
        headerMap?.idIndex,
        headerMap?.diameterIndex,
        headerMap?.codeIndex,
        headerMap?.quantityIndex
      ].filter(index => Number.isInteger(index) && index >= 0));

      const headerWords = /^(PART\s*NO\.?|PT\s*NO\.?|ITEM\s*CODE|SIZE(?:\s*\(.*\))?|ACC|QTY|QUANTITY|MATERIAL\s+DESCRIPTION|COMPONENT\s+DESCRIPTION|DESCRIPTION)$/i;
      const candidates = columns
        .map((value, index) => ({ value: normalizeText(value), index }))
        .filter(({ value, index }) => {
          if (!value || ignoredIndexes.has(index)) return false;
          if (headerWords.test(value)) return false;
          if (isAnyMaterialSectionHeader(value)) return false;
          if (/^\d+(?:\.\d+)?(?:\s*[A-Z]+)?$/i.test(value)) return false;
          return /[A-Z]/i.test(value) && /\d/.test(value) && value.length >= 4;
        })
        .map(candidate => ({
          ...candidate,
          score:
            candidate.value.length +
            (/[;；,，/]/.test(candidate.value) ? 20 : 0) +
            (/-/.test(candidate.value) ? 12 : 0) +
            (/\bSUPPORTS?\b|支架/i.test(candidate.value) ? 30 : 0)
        }))
        .sort((a, b) => b.score - a.score);

      return candidates[0]?.value || '';
    };

    const getStandardMaterialColumns = (material, raw, isSupportSectionRow = false) => {
      if (materialHeaderMap) {
        const columns = getMaterialRowColumns(material, raw);
        const materialId = columns[materialHeaderMap.idIndex] || '';
        const description = columns[materialHeaderMap.descriptionIndex] || (isSupportSectionRow ? pickSupportDescriptionFromColumns(columns, materialHeaderMap) : '');
        const dn = columns[materialHeaderMap.diameterIndex] || '';
        const itemCode = columns[materialHeaderMap.codeIndex] || '';
        const qty = materialHeaderMap.quantityIndex >= 0 ? (columns[materialHeaderMap.quantityIndex] || '') : '';
        const isHeader = /COMPONENT\s+DESCRIPTION|MATERIAL\s+DESCRIPTION|^DESCRIPTION$|材料描述/i.test(description);
        const isSectionHeader = /^(PIPE|FITTINGS?|FLANGES?|GASKETS?|SUPPORTS?|BOLTS?|NUTS?|VALVES?\s*\/?\s*IN-?LINE\s+ITEMS?)$/i.test(description);
        const hasMaterialText = (
          /管|弯头|弯管|三通|法兰|垫片|阀|螺栓|支架|短型直管|PIPE|ELBOW|TEE|FLANGE|GASKET|VALVE|BOLT|SUPPORT/.test(description.toUpperCase())
          || /;|；|,|，|\//.test(description)
        );
        const hasEnoughData = isSupportSectionRow
          ? !!description && (!!dn || !!itemCode || !!materialId)
          : description && dn && itemCode;

        if (!isHeader && !isSectionHeader && hasEnoughData && (hasMaterialText || isSupportSectionRow)) {
          return {
            materialId,
            description,
            diameter: dn,
            specification: dn,
            materialCode: itemCode,
            quantity: qty
          };
        }
      }

      // Standard isometric material lists can arrive without their header row.
      // Their fixed order is:
      // PART NO. | ITEM CODE | SIZE | ACC | MATERIAL DESCRIPTION | QTY
      const standardListColumns = [0, 1, 2, 3, 4, 5]
        .map(index => normalizeText(getMaterialColumn(material, raw, index)));
      const [
        standardPtNo,
        standardItemCode,
        standardDn,
        ,
        standardDescription,
        standardQty
      ] = standardListColumns;
      const standardDescriptionUpper = standardDescription.toUpperCase();
      const isStandardMaterialRow =
        /^\d+[A-Z]?$/.test(standardPtNo) &&
        !!standardItemCode &&
        /^\d+(?:\s*(?:X|×)\s*\d+)?(?:\s*[A-Z]+)?$/i.test(standardDn) &&
        /管|弯头|弯管|三通|法兰|垫片|阀|螺栓|支架|PIPE|ELBOW|TEE|FLANGE|GASKET|VALVE|BOLT|SUPPORT/.test(standardDescriptionUpper);
      if (isStandardMaterialRow) {
        return {
          materialId: standardPtNo,
          description: standardDescription,
          diameter: standardDn,
          specification: standardDn,
          materialCode: standardItemCode,
          quantity: standardQty
        };
      }

      const columns = [0, 1, 2, 3, 4].map(index => normalizeText(getMaterialColumn(material, raw, index)));
      const [ptNo, description, dn, itemCode, qty] = columns;
      const upperDescription = description.toUpperCase();
      const upperItemCode = itemCode.toUpperCase();
      const isSectionHeader = /^(PIPE|FITTINGS?|FLANGES?|GASKETS?|SUPPORTS?|BOLTS?|NUTS?|VALVES?\s*\/?\s*IN-?LINE\s+ITEMS?)$/i.test(description);
      const looksLikePtNo = /^\d+[A-Z]?$/.test(ptNo);
      const looksLikeDn = /^\d+(?:\s*(?:X|×)\s*\d+)?(?:\s*[A-Z]+)?$/i.test(dn);
      const looksLikeItemCode = /[A-Z]{2,}[\w./-]*\d/i.test(upperItemCode) || /_/.test(itemCode);
      const looksLikeQty = /^\d+(?:\.\d+)?(?:\s*[A-Z]+)?$/i.test(qty);
      const hasMaterialText = (
        /管|弯头|弯管|三通|法兰|垫片|阀|螺栓|支架|短型直管|PIPE|ELBOW|TEE|FLANGE|GASKET|VALVE|BOLT|SUPPORT/.test(upperDescription)
        || /;|；|,|，|\//.test(description)
      );

      if (!looksLikePtNo || !description || isSectionHeader || !looksLikeDn || !looksLikeItemCode || !looksLikeQty || !hasMaterialText) {
        return null;
      }

      return {
        materialId: ptNo,
        description,
        diameter: dn,
        specification: dn,
        materialCode: itemCode,
        quantity: qty
      };
    };

    const normalizedRows = rows.map((row, index) => {
      const material = row.rawMaterial || {};
      const raw = row.rawLogicalRow || [];
      const isSupportSectionRow = supportSectionByIndex.get(index) === true;
      const standardColumns = getStandardMaterialColumns(material, raw, isSupportSectionRow);
      const materialId = material['序号'] || material.ID || material.id || material.column1 || raw[0] || row.materialId || index + 1;
      const diameter = material['管径'] || material.ND || material.diameter || material['规格'] || material.specification || material.column3 || raw[2] || row.specification || '';
      const description = material['材料描述'] || material.DESCRIPTION || material.description || material.text || material.column2 || raw[1] || row.description || '';
      const specification = material['规格'] || material.ND || material.specification || material.diameter || material.column3 || raw[2] || row.specification || '';
      const materialCode = material['材料代码'] || material['材料编码'] || material.ITEM_CODE || material.itemCode || material.column4 || row.materialCode || '';
      const quantity = material['焊缝数量'] || material['焊点数量'] || material.QTY || material.quantity || material.column5 || raw[4] || row.quantity || '';
      const unit = standardColumns
        ? (material['单位'] || material.unit || '')
        : (material['单位'] || material.unit || material.column6 || row.unit || '');
      const jointType = standardColumns
        ? (material['接头形式'] || material.jointType || material.Type || material.type || '')
        : (material['接头形式'] || material.jointType || material.Type || material.type || material.column7 || row.jointType || row.type || '');

      const normalizedRow = {
        ...row,
        materialId: String(standardColumns?.materialId || pickMaterialField(material, ['\u5e8f\u53f7', 'ID', 'id'], raw[0] || materialId || '') || ''),
        diameter: String(standardColumns?.diameter || pickMaterialField(material, ['\u7ba1\u5f84', 'ND', 'DN', 'diameter'], row.diameter || row.specification || '') || ''),
        description: String(standardColumns?.description || pickMaterialField(material, ['\u6750\u6599\u63cf\u8ff0', 'DESCRIPTION', 'description', 'text'], description || '') || ''),
        specification: String(standardColumns?.specification || pickMaterialField(material, ['\u89c4\u683c', 'specification'], specification || diameter || '') || ''),
        materialCode: String(standardColumns?.materialCode || pickMaterialField(material, ['\u6750\u6599\u4ee3\u7801', '\u6750\u6599\u7f16\u7801', 'ITEM_CODE', 'itemCode'], materialCode || '') || ''),
        quantity: String(standardColumns?.quantity || pickMaterialField(material, ['\u6570\u91cf', '\u710a\u7f1d\u6570\u91cf', '\u710a\u70b9\u6570\u91cf', 'QTY', 'quantity'], quantity || '') || ''),
        unit: String(pickMaterialField(material, ['\u5355\u4f4d', 'unit'], unit || '') || ''),
        jointType: String(pickMaterialField(material, ['\u63a5\u5934\u5f62\u5f0f', 'jointType', 'Type', 'type'], jointType || '') || ''),
        type: String(row.type || jointType || ''),
        isSupportSectionMaterial: isSupportSectionRow,
        standardMaterialColumns: !!standardColumns
      };
      return {
        ...normalizedRow,
        key: buildMaterialComparableKey(normalizedRow)
      };
    }).filter(row => !isMaterialHeaderRow(row));

    const dedupedRows = [];
    const dedupeIndex = new Map();
    normalizedRows.forEach((row) => {
      const dedupeKey = buildMaterialComparableKey(row);
      if (dedupeIndex.has(dedupeKey)) {
        const existingIndex = dedupeIndex.get(dedupeKey);
        dedupedRows[existingIndex] = mergeMaterialRows(dedupedRows[existingIndex], row);
        return;
      }
      dedupeIndex.set(dedupeKey, dedupedRows.length);
      dedupedRows.push({
        ...row,
        sourcePages: Array.from(new Set([row.sourcePage].filter(value => value !== undefined && value !== null && value !== '')))
      });
    });

    setMaterialBindingRows(dedupedRows);
  }, [currentPage, pdfFileName, pdfFilePath, pdfFile]);

  useEffect(() => {
    setMaterialBindingRows([]);
  }, [pdfFileName]);



  // 批量更新计数器和定时器
  const batchUpdateTimerRef = useRef(null);
  const pendingUpdatesRef = useRef({ data: {}, status: {} });

  // 执行批量更新
  const flushBatchUpdates = useCallback(() => {
    const { data, status } = pendingUpdatesRef.current;
    
    if (Object.keys(data).length > 0 || Object.keys(status).length > 0) {
      // 🚀 内存优化：批量识别模式下，只更新状态，不在React state中存储完整数据
      // 完整数据由pageCache管理，避免大批量识别时内存溢出导致白屏
      const isBatchMode = pageCache.isBatchMode;
      
      setPageRecognitionData(prev => {
        const newData = { ...prev };
        
        // 批量模式下不存储完整数据到React state，只存储状态
        if (!isBatchMode) {
          Object.entries(data).forEach(([pageNum, pageData]) => {
            newData[pageNum] = {
              ...newData[pageNum],
              data: pageData
            };
          });
        }
        
        Object.entries(status).forEach(([pageNum, pageStatus]) => {
          newData[pageNum] = {
            ...newData[pageNum],
            status: pageStatus
          };
        });
        
        return newData;
      });
      
      // 清空待更新列表
      pendingUpdatesRef.current = { data: {}, status: {} };
      
      // 触发React重渲染
      setCacheUpdateTrigger(prev => prev + 1);
    }
  }, [pageCache]);

  // 更新特定页面的识别数据（使用缓存管理器 + 批量更新优化）
  const updatePageRecognitionData = useCallback((pageNum, data, immediate = false) => {
    pageCache.setPageData(pageNum, data);
    
    // 🚀 内存优化：批量识别模式下，不在React state中存储完整数据
    // 完整数据由pageCache管理，避免大批量识别时内存溢出导致白屏
    const isBatchMode = pageCache.isBatchMode;
    
    if (immediate && !isBatchMode) {
      // 立即更新（仅非批量模式）
      setPageRecognitionData(prev => ({
        ...prev,
        [pageNum]: {
          ...prev[pageNum],
          data: data
        }
      }));
      setCacheUpdateTrigger(prev => prev + 1);
    } else if (!isBatchMode) {
      // 批量更新：累积更新请求，100ms后统一处理（仅非批量模式）
      pendingUpdatesRef.current.data[pageNum] = data;
      
      if (batchUpdateTimerRef.current) {
        clearTimeout(batchUpdateTimerRef.current);
      }
      
      batchUpdateTimerRef.current = setTimeout(() => {
        flushBatchUpdates();
        batchUpdateTimerRef.current = null;
      }, 100);
    }
    // 批量模式下只触发重渲染，不存储数据到state
    if (isBatchMode) {
      setCacheUpdateTrigger(prev => prev + 1);
    }
  }, [pageCache, flushBatchUpdates]);

  // 更新特定页面的识别状态（使用缓存管理器 + 批量更新优化）
  const updatePageRecognitionStatus = useCallback((pageNum, status, immediate = false) => {
    pageCache.setPageStatus(pageNum, status);
    
    if (immediate) {
      // 立即更新
      setPageRecognitionData(prev => ({
        ...prev,
        [pageNum]: {
          ...prev[pageNum],
          status: status
        }
      }));
      setCacheUpdateTrigger(prev => prev + 1);
    } else {
      // 批量更新
      pendingUpdatesRef.current.status[pageNum] = status;
      
      if (batchUpdateTimerRef.current) {
        clearTimeout(batchUpdateTimerRef.current);
      }
      
      batchUpdateTimerRef.current = setTimeout(() => {
        flushBatchUpdates();
        batchUpdateTimerRef.current = null;
      }, 100);
    }
  }, [pageCache, flushBatchUpdates]);

  // 清空所有页面的识别信息
  const handleClearAllRecognitionData = useCallback(() => {
    pageCache.reset();
    setPageRecognitionData({});
    setCacheUpdateTrigger(prev => prev + 1);
  }, [pageCache]);

  // 清空当前页面的识别信息
  const handleClearCurrentRecognitionData = useCallback((pageNum = currentPage) => {
    // 清空缓存中的数据
    pageCache.setPageData(pageNum, null);
    pageCache.setPageStatus(pageNum, 'unrecognized');
    
    // 清空旧状态对象
    setPageRecognitionData(prev => {
      const newData = { ...prev };
      delete newData[pageNum];
      return newData;
    });
    
    setCacheUpdateTrigger(prev => prev + 1);
  }, [currentPage, pageCache]);

  // 处理识别数据变化
  const handleRecognitionDataChange = useCallback((newData) => {
    updatePageRecognitionData(currentPage, newData);
  }, [currentPage, updatePageRecognitionData]);

  const handlePageTextDetectionsChange = useCallback((pageResults = {}) => {
    Object.entries(pageResults || {}).forEach(([page, result]) => {
      const pageNum = Number(page);
      if (!Number.isFinite(pageNum)) return;
      const existing = pageCache.getPageData(pageNum) ||
        pageRecognitionData[pageNum]?.data ||
        pageRecognitionData[pageNum] ||
        {};
      updatePageRecognitionData(pageNum, {
        ...existing,
        ...result,
        pipeClass: result?.pipeClass || result?.pipelineClass || existing?.pipeClass || existing?.pipelineClass || '',
        pipelineClass: result?.pipeClass || result?.pipelineClass || existing?.pipeClass || existing?.pipelineClass || ''
      });
    });
  }, [pageCache, pageRecognitionData, updatePageRecognitionData]);

  // 导出所有已识别页的识别结果
  const handleExportAllRecognition = useCallback(() => {
    // 🚀 优先从pageCache获取已识别的页面列表（支持1000+页批量识别导出）
    const recognizedPages = pageCache.getRecognizedPages();

    if (recognizedPages.length === 0) {
      message.warning('没有已识别的页面数据可导出');
      return;
    }

    console.log(`📊 准备导出 ${recognizedPages.length} 页识别数据`);

    try {
      const materialData = [];
      const scaffoldData = [];
      let hasMaterials = false;
      let hasScaffolds = false;

      // 🔢 第一遍：收集所有页面数据，提取页码
      const allPagesData = [];
      
      recognizedPages.forEach(pageNum => {
        const pageData = pageCache.getPageData(pageNum);
        if (!pageData) return;
        
        const pageNumber = pageData.pageNumber || '';
        
        // 提取页码数字（可能是 "1"、"2" 或 "1/2" 格式）
        let currentPageNum = 0;
        if (pageNumber) {
          const match = pageNumber.toString().match(/(\d+)/);
          if (match) {
            currentPageNum = parseInt(match[1], 10);
          }
        }
        
        allPagesData.push({
          pageNum,
          pageData,
          currentPageNum
        });
      });
      
      // 🔢 第二遍：根据页码变化划分组，当页码=1时开始新组
      // 通过回溯，找出每个组的总页数
      const groups = []; // [{startIdx, endIdx, totalPages}]
      let groupStartIdx = 0;
      
      for (let i = 0; i < allPagesData.length; i++) {
        const currentPageNum = allPagesData[i].currentPageNum;
        
        // 当页码变回1时（且不是第一条），说明新组开始，前一组结束
        if (currentPageNum === 1 && i > 0) {
          // 前一组结束
          const prevGroupMaxPage = allPagesData[i - 1].currentPageNum || 1;
          groups.push({
            startIdx: groupStartIdx,
            endIdx: i - 1,
            totalPages: prevGroupMaxPage
          });
          groupStartIdx = i;
        }
      }
      
      // 最后一组
      if (allPagesData.length > 0) {
        const lastPageNum = allPagesData[allPagesData.length - 1].currentPageNum || 1;
        groups.push({
          startIdx: groupStartIdx,
          endIdx: allPagesData.length - 1,
          totalPages: lastPageNum
        });
      }
      
      console.log('📊 页码分组:', groups.map(g => `[${g.startIdx}-${g.endIdx}] 共${g.totalPages}页`));
      
      // 创建索引到总页数的映射
      const indexToTotalPages = {};
      groups.forEach(group => {
        for (let i = group.startIdx; i <= group.endIdx; i++) {
          indexToTotalPages[i] = group.totalPages;
        }
      });
      
      // 🔢 第三遍：格式化输出
      allPagesData.forEach(({ pageNum, pageData, currentPageNum }, index) => {
        // 计算"第X页，共N页"格式
        const totalPages = indexToTotalPages[index] || 1;
        const formattedPageNumber = currentPageNum > 0 
          ? `第${currentPageNum}页，共${totalPages}页` 
          : (pageData.pageNumber || '');
        
        // 处理材料数据
        const materials = pageData.materials || [];
        if (materials.length > 0) {
          hasMaterials = true;
          materials.forEach((material, index) => {
            const row = [
              material.column1 || '', // 材料编号
              material.column2 || '', // 材料描述
              material.column3 || '', // 规格
              material.column4 || '', // 材料代码
              material.column5 || '', // 数量
              pageData.pipelineNumber || '', // 管线号
              pageData.drawingNumber || '', // 图号
              formattedPageNumber, // 🔢 格式化后的页码（第X页，共N页）
              pageNum  // PDF页码
            ];
            materialData.push(row);
          });
        }

        // 处理支架数据
        const scaffolds = pageData.scaffolds || [];
        if (scaffolds.length > 0) {
          hasScaffolds = true;
          scaffolds.forEach((scaffold, index) => {
            const row = [
              scaffold.scaffoldInfo || scaffold.text || '', // 支架原编号
              pageData.pipelineNumber || '', // 管线号
              scaffold.groupNumber || '', // 支架序号
              pageNum  // PDF页码
            ];
            scaffoldData.push(row);
          });
        }
      });

      // 如果两种数据都没有，提示用户
      if (!hasMaterials && !hasScaffolds) {
        message.warning('没有识别数据可导出');
        return;
      }

      const wb = XLSX.utils.book_new();

      // 导出材料数据（如果有）
      if (hasMaterials && materialData.length > 0) {
        const materialHeaders = ['材料编号', '材料描述', '规格', '材料代码', '数量', '管线号', '图号', 'OCR页码', 'PDF页码'];
        const materialWsData = [materialHeaders, ...materialData];
        const materialWs = XLSX.utils.aoa_to_sheet(materialWsData);
        
        materialWs['!cols'] = [
          { wch: 10 }, // 材料编号
          { wch: 25 }, // 材料描述
          { wch: 15 }, // 规格
          { wch: 12 }, // 材料代码
          { wch: 8 },  // 数量
          { wch: 15 }, // 管线号
          { wch: 15 }, // 图号
          { wch: 12 }, // OCR页码
          { wch: 12 }  // PDF页码
        ];
        
        XLSX.utils.book_append_sheet(wb, materialWs, '材料表');
      }

      // 导出支架数据（如果有）
      if (hasScaffolds && scaffoldData.length > 0) {
        // 添加序号列
        const scaffoldDataWithIndex = scaffoldData.map((row, index) => [index + 1, ...row]);
        
        const scaffoldHeaders = ['序号', '支架原编号', '管线号', '支架序号', 'PDF页码'];
        const scaffoldWsData = [scaffoldHeaders, ...scaffoldDataWithIndex];
        const scaffoldWs = XLSX.utils.aoa_to_sheet(scaffoldWsData);
        
        scaffoldWs['!cols'] = [
          { wch: 8 },  // 序号
          { wch: 20 }, // 支架原编号
          { wch: 15 }, // 管线号
          { wch: 12 }, // 支架序号
          { wch: 12 }  // PDF页码
        ];
        
        XLSX.utils.book_append_sheet(wb, scaffoldWs, '支架信息');
      }

      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      // 根据数据类型决定文件名
      let fileName;
      if (hasScaffolds && !hasMaterials) {
        fileName = `支架信息库_${timestamp}.xlsx`;
      } else if (hasMaterials && !hasScaffolds) {
        fileName = `OCR识别结果_${timestamp}.xlsx`;
      } else {
        fileName = `OCR识别结果_${timestamp}.xlsx`;
      }

      XLSX.writeFile(wb, fileName);
      
      // 显示导出成功消息
      let successMsg = '导出成功：';
      if (hasMaterials) successMsg += ` 材料${materialData.length}条`;
      if (hasMaterials && hasScaffolds) successMsg += '，';
      if (hasScaffolds) successMsg += ` 支架${scaffoldData.length}条`;
      message.success(successMsg);
    } catch (error) {
      console.error('导出失败:', error);
      message.error(`导出失败: ${error.message}`);
    }
  }, [pageCache]);

  // OCR相关状态现在由OCRProvider管理
  const [progressModalVisible, setProgressModalVisible] = useState(false);
  const [ocrResultsVisible, setOcrResultsVisible] = useState(false);
  const [currentOcrResults, setCurrentOcrResults] = useState([]);
  
  // 氚云上传相关状态
  const [tritiumUploadModalVisible, setTritiumUploadModalVisible] = useState(false);
  // 上传统计信息状态
  const [uploadStats, setUploadStats] = useState({ weldCount: 0, pageCount: 0 });
  const [tritiumUploadForm] = Form.useForm();
  const [h3ProjectOptions, setH3ProjectOptions] = useState([]);
  const [h3ProjectsLoading, setH3ProjectsLoading] = useState(false);
  const [selectedH3ProjectValue, setSelectedH3ProjectValue] = useState('');
  const [manualH3ProjectName, setManualH3ProjectName] = useState('');
  const [h3ProjectSelectorVisible, setH3ProjectSelectorVisible] = useState(false);
  const h3ProjectSelectResolverRef = useRef(null);
  const filteredH3ProjectOptions = useMemo(() => {
    const keyword = manualH3ProjectName.trim().toLowerCase();
    if (!keyword) return h3ProjectOptions;
    return h3ProjectOptions.filter(project => {
      const searchableText = [
        project.name,
        project.label,
        project.value,
        project.status
      ].filter(Boolean).join(' ').toLowerCase();
      return searchableText.includes(keyword);
    });
  }, [h3ProjectOptions, manualH3ProjectName]);
  
  // 强制更新函数
  const forceUpdate = () => setForceUpdateKey(prev => prev + 1);
  
  // OCR相关函数现在由OCR服务处理

  // 性能监控引用
  const performanceRef = useRef({ lastUpdateTime: Date.now() });

  // 支架模板验证函数 - 与单页识别保持一致的宽松验证
  const validateScaffoldTemplate = useCallback((template) => {
    const errors = [];
    
    // 只进行基本的存在性检查，与单页识别保持一致
    if (!template) {
      errors.push('模板数据为空');
      return { isValid: false, errors };
    }
    
    // 检查模板是否是有效的对象
    if (typeof template !== 'object') {
      errors.push('模板格式不正确');
      return { isValid: false, errors };
    }
    
    // 检查模板大小（只防止明显异常的情况）
    const templateStr = JSON.stringify(template);
    if (templateStr.length < 10) {
      errors.push('模板数据过小');
    } else if (templateStr.length > 5000000) {
      errors.push('模板数据过大');
    }
    
    // 记录模板结构用于调试（但不作为验证失败的原因）
    console.log('🔍 [模板验证] 支架模板结构:', {
      keys: Object.keys(template),
      hasType: !!template.type,
      hasScaffoldFields: !!template.scaffoldFields,
      hasRegions: !!template.regions,
      hasFields: !!template.fields,
      templateSize: templateStr.length
    });
    
    return {
      isValid: errors.length === 0,
      errors: errors
    };
  }, []);

  // 可视化识别处理函数（使用新的OCR服务）
  const handleRecognizeSinglePage = useCallback(async (templateData = null) => {
    if (!pdfFile) {
      message.warning('请先选择PDF文件');
      return;
    }

    // 优先使用传入的模板数据，否则使用状态中的模板
    const templateToUse = templateData || currentTemplate;

    if (!templateToUse) {
      message.error('请先导入模板配置后再进行识别');
      return;
    }

    // 验证模板是否有有效的区域定义
    // 检测模板类型
    const isMixed = isMixedTemplate(templateToUse);
    const isScaffold = !isMixed && isScaffoldTemplate(templateToUse);
    
    if (isMixed) {
      // 混合模板：同时验证 materialArea 和 scaffoldArea
      console.log('🔀 检测到混合模板（材料+支架），进行阀门识别验证');
      
      if (!templateToUse.materialArea || 
          typeof templateToUse.materialArea.x !== 'number' || 
          typeof templateToUse.materialArea.y !== 'number' ||
          typeof templateToUse.materialArea.width !== 'number' ||
          typeof templateToUse.materialArea.height !== 'number') {
        message.error('混合模板配置无效：材料区域坐标不完整');
        console.error('❌ 混合模板materialArea验证失败:', templateToUse.materialArea);
        return;
      }
      
      if (!templateToUse.scaffoldArea || 
          typeof templateToUse.scaffoldArea.x !== 'number' || 
          typeof templateToUse.scaffoldArea.y !== 'number' ||
          typeof templateToUse.scaffoldArea.width !== 'number' ||
          typeof templateToUse.scaffoldArea.height !== 'number') {
        message.error('混合模板配置无效：支架区域坐标不完整');
        console.error('❌ 混合模板scaffoldArea验证失败:', templateToUse.scaffoldArea);
        return;
      }
    } else if (isScaffold) {
      // 支架模板：验证scaffoldArea
      if (!templateToUse.scaffoldArea || 
          typeof templateToUse.scaffoldArea.x !== 'number' || 
          typeof templateToUse.scaffoldArea.y !== 'number' ||
          typeof templateToUse.scaffoldArea.width !== 'number' ||
          typeof templateToUse.scaffoldArea.height !== 'number') {
        message.error('支架模板配置无效：请先在PDF上绘制支架识别区域');
        console.error('❌ 支架模板验证失败:', templateToUse);
        return;
      }
    } else {
      // 普通模板：验证materialArea
      if (!templateToUse.materialArea || 
          typeof templateToUse.materialArea.x !== 'number' || 
          typeof templateToUse.materialArea.y !== 'number' ||
          typeof templateToUse.materialArea.width !== 'number' ||
          typeof templateToUse.materialArea.height !== 'number') {
        message.error('模板配置无效：请先在PDF上绘制识别区域后再进行OCR识别');
        console.error('❌ 模板验证失败:', templateToUse);
        return;
      }
    }

    try {
      // 设置识别中状态
      updatePageRecognitionStatus(currentPage, 'recognizing');
      updatePageRecognitionData(currentPage, null);
      setVisualizationPanelVisible(true);

      // 🌐 支持Web端：优先使用路径，没有路径时使用文件对象
      let pdfPathOrFile = (typeof pdfFile === 'string' && !pdfFile.startsWith('blob:')) ? pdfFile : window.__lastOpenedPdfPath__;
      if (!pdfPathOrFile && window.__lastOpenedPdfFile__) {
        pdfPathOrFile = window.__lastOpenedPdfFile__;
        console.log('🌐 [Web] 单页识别使用文件对象');
      }
      if (!pdfPathOrFile) {
        updatePageRecognitionStatus(currentPage, 'unrecognized');
        message.error('无法获取PDF文件，请重新打开PDF文件后再试');
        return;
      }

      // 调用单页识别服务
      console.log('🔍 [App.js] 传给识别服务的 templateToUse.columns:', templateToUse?.columns, '数量:', templateToUse?.columns?.length || 0);
      const recognitionData = await ocrContext.handleRecognizeSinglePage(templateToUse, currentPage, pdfPathOrFile);
      
      console.log('📥 App.js 接收到识别数据:', {
        materials: recognitionData.materials?.length || 0,
        scaffolds: recognitionData.scaffolds?.length || 0,
        detections: recognitionData.detections?.length || 0,
        keys: Object.keys(recognitionData)
      });
      
      // 更新识别结果
      updatePageRecognitionData(currentPage, recognitionData);
      updatePageRecognitionStatus(currentPage, 'completed');
      if (templateToUse?.materialArea) {
        const materials = Array.isArray(recognitionData.materials) ? recognitionData.materials : [];
        const rawLogicalRows = materials.map((material, index) => {
          const columnValues = Array.from({ length: 12 }, (_, columnIndex) => {
            const key = `column${columnIndex + 1}`;
            return material?.[key] ?? '';
          });
          const hasRawColumns = columnValues.some(value => value !== undefined && value !== null && String(value).trim());
          if (hasRawColumns) {
            return columnValues;
          }

          return [
            material.序号 || material.ID || material.id || index + 1,
            material.材料描述 || material.DESCRIPTION || material.description || material.text || '',
            material.规格 || material.ND || material.specification || '',
            material.材料代码 || material.材料编码 || material.ITEM_CODE || material.itemCode || '',
            material.数量 || material.QTY || material.quantity || '',
            material.单位 || material.unit || '',
            material.类型 || material.type || ''
          ];
        });
        handleMaterialRowsChange(materials, rawLogicalRows, currentPage);
      } else {
        handleMaterialRowsChange([], [], currentPage);
      }

    } catch (error) {
      console.error('识别失败:', error);
      updatePageRecognitionStatus(currentPage, 'unrecognized');
      message.error(`识别失败: ${error.message}`);
    }
  }, [pdfFile, currentPage, currentTemplate, updatePageRecognitionData, updatePageRecognitionStatus, ocrContext, handleMaterialRowsChange]);

  const handleRecognizeAll = useCallback(async () => {
    if (!pdfFile) {
      message.warning('请先选择PDF文件');
      return;
    }

    try {
      // 设置当前页面识别中状态
      updatePageRecognitionStatus(currentPage, 'recognizing');
      updatePageRecognitionData(currentPage, null);

      // 模拟识别过程
      setTimeout(() => {
        const mockData = {
          drawingNumber: 'DWG-ALL-001',
          pipelineNumber: 'PL-MAIN-001',
          pageNumber: `1-${totalPages}`,
          materials: [
            {
              key: '1',
              index: 1,
              name: '钢管',
              specification: 'Φ108×4',
              quantity: 120,
              unit: 'm',
              remark: '碳钢'
            },
            {
              key: '2',
              index: 2,
              name: '弯头',
              specification: 'Φ108×4-90°',
              quantity: 40,
              unit: '个',
              remark: '无缝'
            },
            {
              key: '3',
              index: 3,
              name: '法兰',
              specification: 'DN100 PN16',
              quantity: 80,
              unit: '个',
              remark: '对焊'
            },
            {
              key: '4',
              index: 4,
              name: '阀门',
              specification: 'DN100 球阀',
              quantity: 12,
              unit: '个',
              remark: '手动'
            },
            {
              key: '5',
              index: 5,
              name: '支架',
              specification: 'L50×5',
              quantity: 24,
              unit: '套',
              remark: '角钢'
            }
          ]
        };

        // 为所有页面设置识别数据
        for (let i = 1; i <= totalPages; i++) {
          const pageData = {
            ...mockData,
            drawingNumber: `DWG-${i.toString().padStart(3, '0')}`,
            pageNumber: i
          };
          updatePageRecognitionData(i, pageData);
          updatePageRecognitionStatus(i, 'completed');
        }
        setVisualizationPanelVisible(true);
        // 只有识别完成才显示成功提示
      }, 5000);

    } catch (error) {
      console.error('识别失败:', error);
      updatePageRecognitionStatus(currentPage, 'unrecognized');
      message.error('识别失败，请重试');
    }
  }, [pdfFile, totalPages, currentPage, currentTemplate, updatePageRecognitionData, updatePageRecognitionStatus]);
  
  // 使用useCallback确保事件处理函数能访问最新状态
  const handleTemplateImport = useCallback((event) => {
    const template = event.detail;
    setCurrentTemplate(template);
    setTemplateUploaded(true);
    
    // 检测模板类型（优先级：混合 > 支架 > 普通）
    const isMixed = isMixedTemplate(template);
    const isScaffold = !isMixed && isScaffoldTemplate(template);
    
    setMixedTemplateUploaded(isMixed);
    setScaffoldTemplateUploaded(isScaffold);
    
    if (isMixed) {
      message.success('混合模板导入成功！可以使用阀门识别功能（包含材料表和支架区域）。');
      console.log('✅ 检测到混合模板:', {
        hasMaterialArea: !!template.materialArea,
        hasScaffoldArea: !!template.scaffoldArea,
        hasPageNumberArea: !!template.pageNumberArea
      });
    } else if (isScaffold) {
      message.success('支架模板导入成功！可以使用支架识别功能了。');
    } else {
      message.success('模板导入成功！');
    }

    // 如果有PDF文件，可以直接使用新导入的模板进行识别
    if (pdfFile && event.detail.autoRecognize) {
      handleRecognizeSinglePage(template);
    }
  }, [pdfFile, handleRecognizeSinglePage, isScaffoldTemplate, isMixedTemplate]);

  const handleTemplateClear = useCallback((event) => {
    setCurrentTemplate(null);
    setTemplateUploaded(false);
    setScaffoldTemplateUploaded(false);
    setMixedTemplateUploaded(false);
  }, []);

  const handleTemplateUpdate = useCallback((event) => {
    const template = event.detail;
    setCurrentTemplate(template);
    setTemplateUploaded(true);

    const isMixed = isMixedTemplate(template);
    const isScaffold = !isMixed && isScaffoldTemplate(template);
    setMixedTemplateUploaded(isMixed);
    setScaffoldTemplateUploaded(isScaffold);
  }, [isScaffoldTemplate, isMixedTemplate]);

  // 监听模板导入事件
  useEffect(() => {
    window.addEventListener('template-imported', handleTemplateImport);
    window.addEventListener('template-updated', handleTemplateUpdate);
    window.addEventListener('template-cleared', handleTemplateClear);

    return () => {
      window.removeEventListener('template-imported', handleTemplateImport);
      window.removeEventListener('template-updated', handleTemplateUpdate);
      window.removeEventListener('template-cleared', handleTemplateClear);
    };
  }, [handleTemplateImport, handleTemplateUpdate, handleTemplateClear]);

  // 监听OCR服务状态变化
  useEffect(() => {
    console.log('🚀 [前端] 初始化OCR服务状态监听...');
    if (window.electronAPI && window.electronAPI.onOCRServerStatus) {
      console.log('✅ [前端] electronAPI 和 onOCRServerStatus 都可用');
      let lastStatusMessage = ''; // 记录上次状态消息，避免重复显示
      
      const handleOCRServerStatus = (statusData) => {
        console.log('🔔 [前端] 收到OCR服务状态更新:', statusData);
        
        setOcrServerStatus(prev => {
          console.log('🔄 [前端] 当前状态:', prev, '→ 新状态:', statusData);
          
          // 如果状态没有变化，不更新
          if (prev.status === statusData.status && prev.message === statusData.message) {
            console.log('⏭️ [前端] 状态未变化，跳过更新');
            return prev;
          }
          
          const newStatus = {
            status: statusData.status,
            message: statusData.message,
            isReady: statusData.status === 'ready'
          };
          
          console.log('✅ [前端] 状态已更新:', newStatus);
          return newStatus;
        });

        // 显示状态消息（避免重复消息）- 已取消弹出提示，仅保留控制台输出
        if (statusData.message !== lastStatusMessage) {
          lastStatusMessage = statusData.message;
          
          console.log('💬 [前端] 显示状态消息:', statusData.message);
          
          // 已取消所有弹出提示，仅保留控制台日志
          // if (statusData.status === 'ready') {
          //   message.success(statusData.message, 2);
          // } else if (statusData.status === 'error') {
          //   message.error(statusData.message, 5);
          // } else if (statusData.status === 'starting') {
          //   message.info(statusData.message, 2);
          // }
        } else {
          console.log('🔇 [前端] 跳过重复消息:', statusData.message);
        }
      };

      console.log('🎧 [前端] 设置OCR服务状态监听器');
      window.electronAPI.onOCRServerStatus(handleOCRServerStatus);

      // 页面加载完成后主动查询一次OCR服务状态
      const checkInitialStatus = async () => {
        try {
          console.log('🔍 [前端] 开始主动查询OCR状态...');
          const status = await window.electronAPI.getOCRServerStatus();
          console.log('📊 [前端] 主动查询结果:', status);
          
          const statusData = {
            status: status.isHealthy ? 'ready' : 
                   (status.isStarting || (status.isRunning && !status.isHealthy)) ? 'starting' : 
                   'error',
            message: status.isHealthy ? 'OCR服务已就绪' : 
                    (status.isStarting || (status.isRunning && !status.isHealthy)) ? '正在启动OCR服务...' : 
                    'OCR服务未运行'
          };
          
          console.log('🎯 [前端] 计算出的状态:', statusData);
          handleOCRServerStatus(statusData);
        } catch (error) {
          console.error('❌ [前端] 查询状态失败:', error);
          // 查询失败时设置为启动中状态
          handleOCRServerStatus({
            status: 'starting',
            message: '正在检查OCR服务状态...'
          });
        }
      };

      // 同步状态的额外方法
      const syncStatus = async () => {
        try {
          if (window.electronAPI.syncOCRServerStatus) {
            console.log('🔄 [前端] 尝试同步OCR状态...');
            await window.electronAPI.syncOCRServerStatus();
          } else {
            console.log('⚠️ [前端] syncOCRServerStatus API 不可用');
          }
        } catch (error) {
          console.error('❌ [前端] 同步状态失败:', error);
        }
      };

      // 多次检查确保状态同步
      const timer1 = setTimeout(checkInitialStatus, 500);
      const timer2 = setTimeout(checkInitialStatus, 2000);
      const timer3 = setTimeout(syncStatus, 1000);
      const timer4 = setTimeout(syncStatus, 3000);

      return () => {
        clearTimeout(timer1);
        clearTimeout(timer2);
        clearTimeout(timer3);
        clearTimeout(timer4);
        if (window.electronAPI.removeOCRServerStatusListener) {
          window.electronAPI.removeOCRServerStatusListener();
        }
      };
    } else {
      // Web端：使用HTTP轮询检查OCR服务状态
      console.log('🌐 [前端] Web模式：使用HTTP轮询检查OCR服务状态');
      
      let isMounted = true;
      
      const checkOCRServiceHealth = async () => {
        try {
          const healthData = await ocrService.healthCheck();

          if (!healthData.available) {
            throw new Error(healthData.error || `OCR service unavailable: ${healthData.url}`);
          }

          if (isMounted) {
            setServiceStatusIfChanged(setOcrServerStatus, {
              status: healthData.ready ? 'ready' : 'starting',
              message: healthData.ready
                ? (healthData.stale ? 'OCR服务已就绪（状态检查延迟）' : 'OCR服务已就绪')
                : (healthData.transient ? 'OCR服务状态检查中...' : (healthData.error || 'OCR服务正在初始化...')),
              isReady: healthData.ready
            });
          }
        } catch (error) {
          if (isMounted) {
            if (error.name === 'AbortError') {
              setServiceStatusIfChanged(setOcrServerStatus, {
                status: 'error',
                message: 'OCR服务连接超时',
                isReady: false
              });
            } else {
              setServiceStatusIfChanged(setOcrServerStatus, {
                status: 'error',
                message: 'OCR服务未运行',
                isReady: false
              });
            }
          }
          console.log('⚠️ [Web] OCR服务不可用:', error.message);
        }
      };
      
      // 初始检查
      checkOCRServiceHealth();
      
      // Initial health is checked immediately; a slower heartbeat avoids
      // reconciling the full annotation workspace every five seconds.
      const intervalId = setInterval(checkOCRServiceHealth, 30000);
      
      return () => {
        isMounted = false;
        clearInterval(intervalId);
      };
    }
  }, []);

  // 重启OCR服务
  const handleRestartOCRServer = useCallback(async () => {
    try {
      setOcrServerStatus(prev => ({
        ...prev,
        status: 'starting',
        message: '正在重启OCR服务...',
        isReady: false
      }));

      if (window.electronAPI && window.electronAPI.restartOCRServer) {
        const result = await window.electronAPI.restartOCRServer();
        if (result.success) {
          message.success(result.message, 3);
        } else {
          message.error(result.message, 5);
          setOcrServerStatus(prev => ({
            ...prev,
            status: 'error',
            message: result.message,
            isReady: false
          }));
        }
      } else {
        // Web端：尝试检查OCR服务状态
        message.info('正在检查OCR服务状态...', 2);
        
        try {
          const healthResult = await ocrService.healthCheck({ force: true });
          
          if (healthResult.available && healthResult.ready) {
            message.success('OCR服务运行正常', 3);
            setOcrServerStatus({
              status: 'ready',
              message: 'OCR服务已就绪',
              isReady: true
            });
          } else {
            message.warning('OCR服务未运行，请检查 MinerU 或 OCR.exe', 8);
            setOcrServerStatus({
              status: 'error',
              message: 'OCR服务未运行',
              isReady: false
            });
          }
        } catch (error) {
          // 连接失败
          message.warning(
            <span>
              无法连接OCR服务。请手动启动：<br/>
              1. 运行 <code>ocr_server/ocr_server.exe</code><br/>
              2. 或使用 <code>start-web-mode.bat</code> 一键启动
            </span>,
            8
          );
          setOcrServerStatus({
            status: 'error',
            message: '请手动启动OCR服务',
            isReady: false
          });
        }
      }
    } catch (error) {
      console.error('重启OCR服务失败:', error);
      message.error(`重启OCR服务失败: ${error.message}`, 5);
      setOcrServerStatus(prev => ({
        ...prev,
        status: 'error',
        message: `重启失败: ${error.message}`,
        isReady: false
      }));
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    const checkMineruHealth = async () => {
      try {
        const healthData = await checkWebOcrReady();
        if (!isMounted) return;

        setServiceStatusIfChanged(setMineruServerStatus, {
          status: healthData.ready ? 'ready' : 'starting',
          message: healthData.ready ? 'MinerU服务已就绪' : (healthData.error || 'MinerU服务正在初始化...'),
          isReady: healthData.ready
        });
      } catch (error) {
        if (!isMounted) return;
        setServiceStatusIfChanged(setMineruServerStatus, {
          status: 'error',
          message: error.name === 'AbortError' ? 'MinerU服务连接超时' : 'MinerU服务未运行',
          isReady: false
        });
      }
    };

    checkMineruHealth();
    const intervalId = setInterval(checkMineruHealth, 30000);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [checkWebOcrReady]);

  // Web端UI缩放处理
  const handleWebZoomChange = useCallback((factor) => {
    if (!isElectron()) {
      // 保存到localStorage
      try {
        localStorage.setItem('webZoomFactor', factor.toString());
      } catch (e) {
        console.warn('保存缩放设置失败:', e);
      }
      setWebZoomFactor(factor);
      message.success(`界面缩放已设置为 ${Math.round(factor * 100)}%`);
    }
  }, []);

  // 支架识别事件处理函数
  const handleScaffoldOCRAction = useCallback(async (event) => {
    const { action, pageRange } = event.detail;
    
    if (!pdfFile) {
      message.error('请先选择PDF文件');
      return;
    }
    
    if (!scaffoldTemplateUploaded || !currentTemplate || !isScaffoldTemplate(currentTemplate)) {
      message.error('请先导入支架模板');
      return;
    }
    
    console.log('🏗️ 支架识别事件:', action);
    
    if (action === 'recognizeScaffoldSinglePage') {
      setTimeout(async () => {
        if (!pdfFile) {
          message.error('请先选择PDF文件');
          return;
        }
        
        try {
          console.log('🏗️ 开始支架单页识别...');
          await handleRecognizeSinglePage(currentTemplate);
          console.log('🏗️ 支架单页识别完成，可视化面板应该已显示');
        } catch (error) {
          console.error('🏗️ 支架识别失败:', error);
          
          // 检查是否为支架模板相关错误
          if (error.message.includes('NoneType') || error.message.includes('500')) {
            message.error({
              content: (
                <div>
                  <div>支架识别失败</div>
                  <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                    OCR服务器可能不支持当前的支架模板格式，请检查服务器端配置
                  </div>
                </div>
              ),
              duration: 6
            });
          } else {
            message.error('支架识别失败: ' + error.message);
          }
        }
      }, 0);
    } else if (action === 'recognizeScaffoldAll' || action === 'recognizeScaffoldSelectedPages') {
      setTimeout(async () => {
        try {
          // 🌐 支持Web端：优先使用路径，没有路径时使用文件对象
          let pdfPathOrFile = (typeof pdfFile === 'string' && !pdfFile.startsWith('blob:')) ? pdfFile : window.__lastOpenedPdfPath__;
          if (!pdfPathOrFile && window.__lastOpenedPdfFile__) {
            pdfPathOrFile = window.__lastOpenedPdfFile__;
            console.log('🌐 [Web] 支架识别使用文件对象');
          }
          if (!pdfPathOrFile) {
            message.error('无法获取PDF文件，请重新打开PDF文件后再试');
            return;
          }
          
          // 验证支架模板格式（仅记录，不阻止执行）
          console.log('🔍 验证支架模板格式...');
          const templateValidation = validateScaffoldTemplate(currentTemplate);
          if (!templateValidation.isValid) {
            console.warn('⚠️ 模板验证警告:', templateValidation.errors);
            message.warning({
              content: (
                <div>
                  <div>模板格式警告</div>
                  <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                    {templateValidation.errors.join('；')} - 继续执行识别
                  </div>
                </div>
              ),
              duration: 4
            });
            // 不返回，继续执行识别
          }
          
          let successCount = 0;
          let errorCount = 0;
          let hasNoneTypeError = false;
          
          await ocrContext.startRecognizeAll({
            pdfPath: pdfPathOrFile,
            template: currentTemplate,
            totalPages: totalPages, // 🌐 Web端需要总页数
            pageRange: action === 'recognizeScaffoldSelectedPages' ? pageRange : null,
            onPageStart: (page) => {
              updatePageRecognitionStatus(page, 'recognizing');
            },
            onPageComplete: (page, data) => {
              updatePageRecognitionData(page, data);
              updatePageRecognitionStatus(page, 'recognized');
              successCount++;
            },
            onError: (page, error) => {
              console.error(`支架识别页面 ${page} 失败:`, error);
              updatePageRecognitionStatus(page, 'unrecognized');
              errorCount++;
              
              // 检查是否为支架模板相关错误
              if (error.includes('NoneType') || error.includes('500')) {
                hasNoneTypeError = true;
                console.warn(`📋 页面 ${page} 支架识别失败，可能是模板格式问题`);
              }
            }
          });
          
          // 根据识别结果显示不同的提示
          if (successCount > 0 && errorCount === 0) {
            message.success(`支架批量识别完成！成功识别 ${successCount} 页`);
          } else if (successCount > 0) {
            message.warning(`支架批量识别完成！成功 ${successCount} 页，失败 ${errorCount} 页`);
          } else {
            // 所有页面都失败
            if (hasNoneTypeError) {
              message.error({
                content: (
                  <div>
                    <div>支架批量识别失败</div>
                    <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                      OCR服务器可能不支持当前的支架模板格式，请检查模板配置或联系技术支持
                    </div>
                  </div>
                ),
                duration: 8
              });
            } else {
              message.error(`支架批量识别失败！所有 ${errorCount} 页都识别失败`);
            }
          }
        } catch (error) {
          console.error('支架批量识别失败:', error);
          message.error('支架批量识别失败: ' + error.message);
        }
      }, 0);
    }
  }, [pdfFile, scaffoldTemplateUploaded, currentTemplate, isScaffoldTemplate, handleRecognizeSinglePage, ocrContext, updatePageRecognitionStatus, updatePageRecognitionData]);
  
  // 监听支架识别事件
  useEffect(() => {
    window.addEventListener('scaffold-ocr-action', handleScaffoldOCRAction);
    return () => {
      window.removeEventListener('scaffold-ocr-action', handleScaffoldOCRAction);
    };
  }, [handleScaffoldOCRAction]);


  // OCR结果导出处理函数
  const handleExportOcrResults = useCallback(async (results) => {
    try {
      const { fileName } = await ocrDataUtils.exportLogicalRowsToExcel(results, pdfFileName, enableMaterialEncoding);
    } catch (error) {
      console.error('导出失败:', error);
      message.error('导出失败');
    }
  }, [pdfFileName, enableMaterialEncoding]);

  // OCR关联处理函数
  const handleOcrAssociation = useCallback(async () => {
    try {
      const ocrResults = ocrService.associateWeldSeamWithOCR(weldSeamDataFromAnnotations, window.lastOcrLogicalRows);
      setCurrentOcrResults(ocrResults);
      setOcrResultsVisible(true);
    } catch (error) {
      console.error('关联失败:', error);
      message.error('关联失败');
    }
  }, []);

  const performMinerUServiceDiagnosis = useCallback(async () => {
    console.log('🔍 [MinerU诊断] 开始执行 MinerU 服务诊断...');

    const diagnosis = {
      success: false,
      issues: [],
      recommendations: []
    };

    const baseUrl = typeof ocrService.getMineruBaseUrl === 'function'
      ? await ocrService.getMineruBaseUrl()
      : 'http://192.168.32.61:8081';
    let port = '8081';
    try {
      port = new URL(baseUrl).port || '8081';
    } catch (error) {
      console.warn('[MinerU诊断] 无法解析 MinerU 地址端口，使用默认 8081:', error);
    }
    const healthUrl = `${baseUrl}/health`;

    try {
      console.log('🔍 [MinerU诊断] 检查地址:', healthUrl);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(healthUrl, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const healthData = await response.json();
        console.log('📊 [MinerU诊断] 健康检查响应:', healthData);

        if (healthData.ready) {
          console.log('✅ [MinerU诊断] MinerU 服务健康检查通过');
          diagnosis.success = true;
        } else {
          console.warn('⚠️ [MinerU诊断] MinerU 服务未就绪:', healthData.error);
          diagnosis.issues.push(`MinerU 服务未就绪: ${healthData.error || '未知原因'}`);
          diagnosis.recommendations.push('检查 WSL 中的 MinerU 服务是否正常启动');

          Modal.warning({
            title: '⚠️ MinerU 服务未完全就绪',
            content: (
              <div>
                <p><strong>状态:</strong> MinerU 服务已启动，但当前未就绪</p>
                <p><strong>原因:</strong> {healthData.error || '后台 worker 未正常运行'}</p>
                <p><strong>建议:</strong></p>
                <ul>
                  <li>检查 WSL 中的 MinerU 服务日志</li>
                  <li>确认 `mineru/app.py` 已在 8081 端口启动</li>
                  <li>如刚启动服务，请稍后重试</li>
                </ul>
                <p><strong>详细信息请查看控制台 (F12)</strong></p>
              </div>
            ),
            okText: '我知道了'
          });
        }
      } else {
        console.error('❌ [MinerU诊断] 健康检查失败:', response.status, response.statusText);
        diagnosis.issues.push(`MinerU 健康检查失败: HTTP ${response.status}`);
        diagnosis.recommendations.push('检查 WSL 中的 MinerU 服务是否正常运行');

        Modal.error({
          title: '❌ MinerU 服务健康检查失败',
          content: (
            <div>
              <p><strong>错误:</strong> HTTP {response.status} - {response.statusText}</p>
              <p><strong>可能原因:</strong></p>
              <ul>
                <li>MinerU 服务未正确启动</li>
                <li>WSL 端口 8081 未暴露或未监听</li>
                <li>服务内部报错</li>
              </ul>
              <p><strong>建议解决方案:</strong></p>
              <ul>
                <li>检查 WSL 中 `mineru/app.py` 是否正在运行</li>
                <li>确认 8081 端口可以从浏览器所在主机访问</li>
                <li>查看 WSL 侧服务日志获取详细错误信息</li>
              </ul>
            </div>
          ),
          okText: '我知道了'
        });
      }
    } catch (networkError) {
      if (networkError.name === 'AbortError') {
        console.error('❌ [MinerU诊断] 网络超时 (5秒)');
        diagnosis.issues.push('MinerU 服务连接超时');
        diagnosis.recommendations.push('检查 WSL 中的 MinerU 服务是否启动完成');
      } else {
        console.error('❌ [MinerU诊断] 网络连接失败:', networkError);
        diagnosis.issues.push(`MinerU 服务连接失败: ${networkError.message}`);
        diagnosis.recommendations.push('检查 WSL 中的 MinerU 服务进程和端口映射');
      }

      Modal.error({
        title: '🌐 MinerU 服务连接失败',
        content: (
          <div>
            <p><strong>无法连接到 MinerU 服务</strong></p>
            <p><strong>端口:</strong> {port}</p>
            <p><strong>可能原因:</strong></p>
            <ul>
              <li>WSL 中的 MinerU 服务未启动</li>
              <li>端口 {port} 未监听或未转发</li>
              <li>防火墙阻止浏览器访问该端口</li>
            </ul>
            <p><strong>解决方案:</strong></p>
            <ol>
              <li>确认 WSL 中已经启动 `mineru/app.py`</li>
              <li>检查 8081 端口监听情况</li>
              <li>确认当前页面的 hostname 能访问到该 MinerU 服务</li>
              <li>查看浏览器控制台和 WSL 服务日志</li>
            </ol>
          </div>
        ),
        okText: '我知道了'
      });
    }

    console.log('📋 [MinerU诊断] 诊断完成，总结如下:');
    console.log('  诊断结果:', diagnosis.success ? '✅ 通过' : '❌ 失败');
    if (diagnosis.issues.length > 0) {
      console.log('  发现的问题:', diagnosis.issues);
    }
    if (diagnosis.recommendations.length > 0) {
      console.log('  建议的解决方案:', diagnosis.recommendations);
    }

    return diagnosis;
  }, []);

  // OCR服务诊断函数
  const performOCRServiceDiagnosis = useCallback(async (engine = 'paddleocr') => {
    if (engine === 'mineru') {
      return await performMinerUServiceDiagnosis();
    }

    console.log('🔍 [OCR诊断] 开始执行OCR服务全面诊断...');
    
    const diagnosis = {
      success: false,
      issues: [],
      recommendations: []
    };

    try {
      // 步骤1: 检查OCR服务配置
      console.log('🔍 [OCR诊断] 步骤1: 检查OCR服务配置...');
      try {
        await ocrService.initialize();
        console.log('✅ [OCR诊断] OCR服务配置检查通过');
      } catch (configError) {
        console.error('❌ [OCR诊断] OCR服务配置检查失败:', configError);
        diagnosis.issues.push(`配置文件问题: ${configError.message}`);
        diagnosis.recommendations.push('检查app-config.json文件是否存在且格式正确');
        
        // 配置失败直接返回
        Modal.error({
          title: '🔧 OCR服务配置检查失败',
          content: (
            <div>
              <p><strong>问题:</strong> {configError.message}</p>
              <p><strong>解决方案:</strong></p>
              <ul>
                <li>检查 app-config.json 文件是否存在</li>
                <li>确认文件格式正确: {`{"ocr_server_port": 8765}`}</li>
                <li>重启应用重新加载配置</li>
              </ul>
              <p><strong>详细信息请查看控制台 (F12)</strong></p>
            </div>
          ),
          okText: '我知道了'
        });
        return diagnosis;
      }

      // 步骤2: 检查网络连通性
      console.log('🔍 [OCR诊断] 步骤2: 检查网络连通性...');
      const port = ocrService.port || 8765;
      const healthUrl = typeof ocrService.getOcrUrl === 'function'
        ? ocrService.getOcrUrl('/health')
        : `${buildOcrServerUrl()}/health`;
      console.log('🔍 [OCR诊断] 检查地址:', healthUrl);
      
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const response = await fetch(healthUrl, {
          signal: controller.signal,
          headers: { 'Accept': 'application/json' }
        });
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
          const healthData = await response.json();
          console.log('📊 [OCR诊断] 健康检查响应:', healthData);
          
          if (healthData.ready) {
            console.log('✅ [OCR诊断] OCR服务健康检查通过');
            diagnosis.success = true;
          } else {
            console.warn('⚠️ [OCR诊断] OCR服务未就绪:', healthData.error);
            diagnosis.issues.push(`OCR引擎未就绪: ${healthData.error || '未知原因'}`);
            diagnosis.recommendations.push('等待OCR引擎初始化完成，或重启应用');
            
            Modal.warning({
              title: '⚠️ OCR服务未完全就绪',
              content: (
                <div>
                  <p><strong>状态:</strong> OCR服务已启动，但引擎未就绪</p>
                  <p><strong>原因:</strong> {healthData.error || '引擎正在初始化中'}</p>
                  <p><strong>建议:</strong></p>
                  <ul>
                    <li>等待1-2分钟让OCR引擎完成初始化</li>
                    <li>检查模型文件是否完整</li>
                    <li>如果问题持续，请重启应用</li>
                  </ul>
                  <p><strong>详细信息请查看控制台 (F12)</strong></p>
                </div>
              ),
              okText: '我知道了'
            });
          }
        } else {
          console.error('❌ [OCR诊断] 健康检查失败:', response.status, response.statusText);
          diagnosis.issues.push(`健康检查失败: HTTP ${response.status}`);
          diagnosis.recommendations.push('检查OCR服务是否正常运行');
          
          Modal.error({
            title: '❌ OCR服务健康检查失败',
            content: (
              <div>
                <p><strong>错误:</strong> HTTP {response.status} - {response.statusText}</p>
                <p><strong>可能原因:</strong></p>
                <ul>
                  <li>OCR服务内部错误</li>
                  <li>服务正在启动中</li>
                  <li>端口被其他程序占用</li>
                </ul>
                <p><strong>建议解决方案:</strong></p>
                <ul>
                  <li>重启应用</li>
                  <li>检查端口 {port} 是否被占用</li>
                  <li>查看控制台获取详细错误信息</li>
                </ul>
              </div>
            ),
            okText: '我知道了'
          });
        }
      } catch (networkError) {
        if (networkError.name === 'AbortError') {
          console.error('❌ [OCR诊断] 网络超时 (5秒)');
          diagnosis.issues.push('网络连接超时');
          diagnosis.recommendations.push('检查OCR服务是否启动');
        } else {
          console.error('❌ [OCR诊断] 网络连接失败:', networkError);
          diagnosis.issues.push(`网络连接失败: ${networkError.message}`);
          diagnosis.recommendations.push('检查OCR服务进程是否运行');
        }
        
        // 进一步检查端口占用
        console.log('🔍 [OCR诊断] 步骤3: 检查端口占用情况...');
        Modal.error({
          title: '🌐 OCR服务连接失败',
          content: (
            <div>
              <p><strong>无法连接到OCR服务</strong></p>
              <p><strong>端口:</strong> {port}</p>
              <p><strong>可能原因:</strong></p>
              <ul>
                <li>OCR服务未启动 (最常见)</li>
                <li>端口 {port} 被其他程序占用</li>
                <li>防火墙阻止连接</li>
                <li>OCR服务启动失败</li>
              </ul>
              <p><strong>解决方案:</strong></p>
              <ol>
                <li><strong>重启应用</strong> (推荐首选)</li>
                <li>检查端口占用: <code>netstat -ano | findstr :{port}</code></li>
                <li>更换端口: 使用 <code>change_ocr_port.js</code> 脚本</li>
                <li>查看控制台 (F12) 获取详细错误信息</li>
              </ol>
            </div>
          ),
          okText: '我知道了'
        });
      }

    } catch (error) {
      console.error('❌ [OCR诊断] 诊断过程出错:', error);
      diagnosis.issues.push(`诊断过程错误: ${error.message}`);
      diagnosis.recommendations.push('重启应用并重试');
      
      Modal.error({
        title: '⚠️ OCR服务诊断失败',
        content: (
          <div>
            <p><strong>诊断过程中发生错误:</strong> {error.message}</p>
            <p><strong>建议:</strong> 重启应用并重试</p>
          </div>
        ),
        okText: '我知道了'
      });
    }

    // 输出诊断总结
    console.log('📋 [OCR诊断] 诊断完成，总结如下:');
    console.log('  诊断结果:', diagnosis.success ? '✅ 通过' : '❌ 失败');
    if (diagnosis.issues.length > 0) {
      console.log('  发现的问题:', diagnosis.issues);
    }
    if (diagnosis.recommendations.length > 0) {
      console.log('  建议的解决方案:', diagnosis.recommendations);
    }

    return diagnosis;
  }, [performMinerUServiceDiagnosis]);

  // 监听可视化识别事件
  useEffect(() => {
    const handleVisualOCRAction = (event) => {
      const { action } = event.detail;

      // 立即显示可视化面板
      setVisualizationPanelVisible(true);

      if (action === 'recognizeSinglePage') {
        // 使用setTimeout确保能获取到最新的模板状态
        setTimeout(async () => {
          console.log('🚀 [单页识别] 用户点击单页识别按钮');
          
          // 执行详细的OCR服务诊断
          const diagnosisResult = await performOCRServiceDiagnosis();
          if (!diagnosisResult.success) {
            console.error('❌ [单页识别] OCR服务诊断失败，停止识别');
            return;
          }
          
          handleRecognizeSinglePage(currentTemplate);
        }, 0);
      } else if (action === 'recognizeAll') {
        setTimeout(async () => {
          try {
            console.log('🚀 [识别全部] 用户点击识别全部页面按钮');
            
            // 执行详细的OCR服务诊断
            const diagnosisResult = await performOCRServiceDiagnosis();
            if (!diagnosisResult.success) {
              console.error('❌ [识别全部] OCR服务诊断失败，停止识别');
              return;
            }
            
            // 🌐 支持Web端：优先使用路径，没有路径时使用文件对象
            let pdfPathOrFile = (typeof pdfFile === 'string' && !pdfFile.startsWith('blob:')) ? pdfFile : window.__lastOpenedPdfPath__;
            if (!pdfPathOrFile && window.__lastOpenedPdfFile__) {
              pdfPathOrFile = window.__lastOpenedPdfFile__;
              console.log('🌐 [Web] 使用文件对象进行识别');
            }
            if (!pdfPathOrFile) {
              console.error('❌ [识别全部] PDF文件路径和文件对象都不可用');
              message.error('无法获取PDF文件，请重新打开PDF文件后再试');
              return;
            }
            if (!currentTemplate) {
              console.error('❌ [识别全部] 模板未导入');
              message.error('请先导入模板配置');
              return;
            }

            // 清空所有页面的识别数据和状态
            pageCache.reset();
            setPageRecognitionData({});

            // 🚀 启用批量识别模式（激进内存管理）
            pageCache.enableBatchMode(1);
            console.log('💡 批量识别优化提示: 已禁用自动翻页，每50页翻页一次，避免内存溢出');

            // 🔍 启动内存监控（静默模式，不弹窗）
            memoryMonitor.setWarningCallback((usage) => {
              console.warn(`⚠️ 内存警告: ${usage.usedMB}MB / ${usage.limitMB}MB - 系统正在自动清理`);
              // 不显示弹窗，避免打断用户操作
            });
            
            memoryMonitor.setCriticalCallback((usage) => {
              console.error(`🚨 内存严重不足: ${usage.usedMB}MB / ${usage.limitMB}MB - 已执行紧急清理`);
              // 不显示弹窗，避免打断用户操作
            });
            
            memoryMonitor.startMonitoring(5000); // 每5秒检查一次（从10秒缩短到5秒）
            memoryMonitor.logSnapshot('批量识别开始');

            // 立即设置第一页为识别中状态
            updatePageRecognitionStatus(1, 'recognizing', true);
            updatePageRecognitionData(1, null, true);

            await ocrContext.startRecognizeAll({
              pdfPath: pdfPathOrFile,
              template: currentTemplate,
              totalPages: totalPages, // 🌐 Web端需要总页数
              onPageStart: (page) => {
                // 页面开始识别时设置状态
                updatePageRecognitionStatus(page, 'recognizing');
                updatePageRecognitionData(page, null);
                
                // 🚀 性能优化：批量识别时完全禁用自动翻页，避免频繁PDF渲染导致内存溢出
                // 用户可以随时手动翻页查看任意页面的识别结果
                if (page === 1) {
                  console.log(`🚀 批量识别已启动，后台识别进行中（不自动翻页）`);
                } else if (page % 100 === 0) {
                  console.log(`📊 批量识别进度: 已完成 ${page} 页`);
                }
              },
              onPageComplete: async (page, data) => {
                // 页面识别完成时立即更新数据和状态
                console.log(`📥 批量识别-第${page}页完成，数据:`, {
                  materials: data.materials?.length || 0,
                  scaffolds: data.scaffolds?.length || 0,
                  detections: data.detections?.length || 0,
                  keys: Object.keys(data)
                });
                updatePageRecognitionData(page, data);
                updatePageRecognitionStatus(page, 'completed');
                setVisualizationPanelVisible(true);

                // 🚀 优化：移除RAF等待，避免大批量识别时的性能瓶颈
                // 每10页触发一次内存清理（自动在缓存管理器中执行）
              },
              onJumpPage: (page) => {
                // 页面识别完成后可能需要跳转（但已在onPageStart中跳转）
                // setCurrentPage(page); // 注释掉避免重复跳转
              },
              onStopped: (page) => {
                // 识别停止时的处理
                pageCache.disableBatchMode();
                memoryMonitor.stopMonitoring();
                memoryMonitor.logSnapshot('识别已停止');
                flushBatchUpdates(); // 立即刷新待处理的更新
              },
              onCompleted: () => {
                // 识别完成时的处理
                pageCache.disableBatchMode();
                memoryMonitor.stopMonitoring();
                memoryMonitor.logSnapshot('识别完成');
                flushBatchUpdates(); // 立即刷新待处理的更新
                
                const stats = pageCache.getStats();
                message.success(`全部识别完成！共识别 ${stats.totalRecognized} 页`);
                console.log(`✅ 识别完成统计:`, stats);
              }
            });
          } catch (e) {
            // startRecognizeAll may reject without calling onStopped/onCompleted.
            // Leaving the 5-second memory monitor alive made its emergency
            // cleanup repeat forever after an interrupted recognition task.
            pageCache.disableBatchMode();
            memoryMonitor.stopMonitoring();
            flushBatchUpdates();
            console.error('全部识别失败:', e);
            message.error(`全部识别失败: ${e.message}`);
          }
        }, 0);
      } else if (action === 'stopRecognize') {
        setTimeout(() => {
          if (ocrContext.currentOcrProcess) {
            ocrContext.handleStopOCR().then(() => {
              // 将当前页状态从"识别中"改为"未识别"（如果还在识别中）
              const currentPageData = pageRecognitionData[currentPage];
              if (currentPageData && currentPageData.status === 'recognizing') {
                updatePageRecognitionStatus(currentPage, 'unrecognized');
                updatePageRecognitionData(currentPage, null);
              }
            }).catch((e) => {
              message.error('停止识别失败');
            });
          } else {
            message.warning('没有正在运行的识别任务');
          }
        }, 0);
      } else if (action === 'exportRecognition') {
        setTimeout(() => {
          handleExportAllRecognition();
        }, 0);
      }
    };

    window.addEventListener('visual-ocr-action', handleVisualOCRAction);

    return () => {
      window.removeEventListener('visual-ocr-action', handleVisualOCRAction);
    };
  }, [handleRecognizeSinglePage, handleRecognizeAll, currentTemplate, handleExportAllRecognition, performOCRServiceDiagnosis]);

  // 监听批量OCR事件（使用新的OCR服务）
  useEffect(() => {
    const handleBatchOCREvent = async (event) => {
      try {
        const engine = event.detail?.engine || 'paddleocr';
        console.log(`🚀 [开始识别] 用户点击开始识别按钮，引擎: ${engine}`);

        // 执行详细的OCR服务诊断
        const diagnosisResult = await performOCRServiceDiagnosis(engine);
        if (!diagnosisResult.success) {
          console.error(`❌ [开始识别] ${engine} 服务诊断失败，停止识别`);
          return;
        }

        // 检查是否已导入模板
        if (!currentTemplate) {
          console.error('❌ [开始识别] 模板未导入');
          message.error('请先导入模板配置后再进行批量识别');
          return;
        }

        // 使用当前已加载的PDF文件而不是事件中的file参数
        if (!pdfFile) {
          console.error('❌ [开始识别] PDF文件未加载');
          message.error('请先打开PDF文件');
          return;
        }


        // 检查文件路径或文件对象是否可用（用于OCR功能）
        // 🌐 Web模式：支持通过 window.__lastOpenedPdfFile__ 上传文件对象
        // 当前 state 中的 File/Blob 是网页端 MinerU 上传的有效来源。
        // 刷新、恢复草稿或切换打开方式时，全局引用可能尚未恢复；不能因此
        // 把已经打开的 PDF 误判为“没有文件路径”。
        const hasCurrentPdfFile = pdfFile instanceof File || pdfFile instanceof Blob;
        const hasFilePath = window.__lastOpenedPdfPath__ || 
                           window.__lastOpenedPdfFile__ ||  // Web模式：文件对象
                           hasCurrentPdfFile ||
                           (typeof pdfFile === 'string' && !pdfFile.startsWith('blob:'));
        
        if (!hasFilePath) {
          Modal.warning({
            title: 'OCR功能需要文件路径',
            content: (
              <div>
                <p>当前PDF文件是通过网页文件选择器加载的，OCR功能需要访问实际的文件路径。</p>
                <p>请使用以下方式重新打开PDF文件：</p>
                <ul>
                  <li>使用"文件"菜单中的"打开PDF"</li>
                  <li>使用快捷键 Ctrl+O</li>
                </ul>
              </div>
            ),
            okText: '我知道了'
          });
          return;
        }
        
        // 显示进度弹窗并调用OCR服务
        setProgressModalVisible(true);
        
        // 使用OCR Context中的批量OCR处理函数
        await handleBatchOCR({
          pdfFile: pdfFile,
          template: currentTemplate,
          pdfFileName: pdfFileName,
          enableMaterialEncoding: enableMaterialEncoding,
          annotations: annotations,
          engine,
          pages: event.detail?.pages || null  // MinerU 页码选择：null=全部, {type:'range',start,end} 或 {type:'custom',pages:[...]}
        });
      } catch (error) {
        console.error('批量OCR失败:', error);
        message.error(`批量识别失败: ${error.message}`);
      } finally {
        setProgressModalVisible(false);
      }
    };

    window.addEventListener('start-batch-ocr', handleBatchOCREvent);

    return () => {
      window.removeEventListener('start-batch-ocr', handleBatchOCREvent);
    };
  }, [currentTemplate, pdfFileName, pdfFile, handleBatchOCR, enableMaterialEncoding, annotations, performOCRServiceDiagnosis]);

  // 监听批量OCR完成事件
  useEffect(() => {
    const handleOcrBatchCompleted = (event) => {
      const { success, fileName, totalRows, error } = event.detail;

      // 自动关闭进度弹窗
      setProgressModalVisible(false);

      if (success) {
      } else {
        console.error('❌ 批量OCR完成但有错误:', error);
      }
    };

    window.addEventListener('ocr-batch-completed', handleOcrBatchCompleted);
    
    return () => {
      window.removeEventListener('ocr-batch-completed', handleOcrBatchCompleted);
    };
  }, []);

  // 导出函数现在使用ocrDataUtils
  useEffect(() => {
    const handleMaterialBatchCompleted = (event) => {
      const { success, mode, pageResults, startPage, endPage, totalRows, fileName } = event.detail || {};
      if (!success || mode !== 'material' || !pageResults || typeof pageResults !== 'object') {
        return;
      }

      const recognizedPages = Object.keys(pageResults).map(page => Number(page)).filter(Boolean);
      const recognitionResults = Object.entries(pageResults).map(([page, pageData]) => ({
        page: Number(page),
        pipelineNumber: pageData?.pipelineNumber || '',
        pipeClass: pageData?.pipeClass || pageData?.pipelineClass || '',
        drawingNumber: pageData?.drawingNumber || '',
        pageNumber: pageData?.pageNumber || '',
        materials: Array.isArray(pageData?.materials) ? pageData.materials : [],
        rawLogicalRows: Array.isArray(pageData?.rawLogicalRows) ? pageData.rawLogicalRows : []
      }));
      logAuditEvent('material_table_recognize', {
        pdfFileName: fileName || pdfFileName,
        count: totalRows || recognizedPages.length || 1,
        pages: recognizedPages.length > 0
          ? recognizedPages
          : (startPage && endPage ? Array.from({ length: endPage - startPage + 1 }, (_, index) => startPage + index) : []),
        recognizedRows: totalRows || 0,
        recognitionResults
      });

      Object.entries(pageResults).forEach(([pageNumStr, pageData]) => {
        const pageNum = Number(pageNumStr);
        if (!pageNum || !pageData) return;

        const existing = pageCache.getPageData(pageNum) ||
          pageRecognitionData[pageNum]?.data ||
          pageRecognitionData[pageNum] ||
          {};
        updatePageRecognitionData(pageNum, {
          ...existing,
          ...pageData,
          pipelineNumber: pageData.pipelineNumber || existing.pipelineNumber || '',
          pipeClass: pageData.pipeClass || pageData.pipelineClass || existing.pipeClass || existing.pipelineClass || '',
          pipelineClass: pageData.pipeClass || pageData.pipelineClass || existing.pipeClass || existing.pipelineClass || '',
          pageNumber: pageData.pageNumber || existing.pageNumber || ''
        }, true);
        updatePageRecognitionStatus(pageNum, 'completed', true);

        if (pageNum === currentPage) {
          const materials = Array.isArray(pageData.materials) ? pageData.materials : [];
          handleMaterialRowsChange(materials, pageData.rawLogicalRows || [], pageNum);
        }
      });
    };

    window.addEventListener('ocr-batch-completed', handleMaterialBatchCompleted);
    return () => window.removeEventListener('ocr-batch-completed', handleMaterialBatchCompleted);
  }, [
    currentPage,
    handleMaterialRowsChange,
    logAuditEvent,
    pageCache,
    pageRecognitionData,
    pdfFileName,
    updatePageRecognitionData,
    updatePageRecognitionStatus
  ]);

  const exportOcrLogicalRowsToExcel = async (logicalRows) => {
    try {
      // 将当前标注数据传递给全局变量，供焊口关联使用
      window.currentAnnotations = annotations;
      
      // 检查标注中是否有材料编号
      const annotationsWithMaterialNumber = annotations.filter(ann => ann.materialNumber);
      
      return await ocrDataUtils.exportLogicalRowsToExcel(logicalRows, pdfFileName, enableMaterialEncoding);
    } catch (error) {
      console.error('Excel导出失败:', error);
      throw error;
    }
  };

  // OCR进度监听现在由OCRProvider处理

  // 创建标注相关的命令助手函数
  const createAnnotationCommand = useCallback((description, executeAction, undoAction) => {
    return {
      description,
      execute: executeAction,
      undo: undoAction
    };
  }, []);

  // 从标注文本中提取序号
  const extractNumberFromAnnotation = useCallback((annotation) => {
    if (!annotation.text) return null;
    const match = annotation.text.match(/(\d+)/);
    return match ? parseInt(match[1]) : null;
  }, []);

  // 更新规则的当前序号到正确的值
  const updateRuleCurrentNumber = useCallback((ruleId, latestAnnotations = annotations) => {
    if (!ruleId) return;
    
    // 找到使用该规则的所有标注
    const ruleAnnotations = latestAnnotations.filter(ann => ann.ruleId === ruleId);
    
    if (ruleAnnotations.length === 0) {
      // 如果没有使用该规则的标注，重置到起始序号（可以是null/undefined）
      const rule = annotationRules.find(r => r.id === ruleId);
      if (rule) {
        const updatedRule = {
          ...rule,
          currentNumber: rule.startNumber ?? null  // 保持null、undefined或具体的值
        };
        const updatedRules = annotationRules.map(r => 
          r.id === ruleId ? updatedRule : r
        );
        setAnnotationRules(updatedRules);
        
        if (activeAnnotationRule?.id === ruleId) {
          setActiveAnnotationRule(updatedRule);
        }
      }
    } else {
      // 找到最大的序号，下一个序号应该是最大序号+递增值
      const maxNumber = Math.max(...ruleAnnotations
        .map(ann => extractNumberFromAnnotation(ann))
        .filter(num => num !== null)
      );
      
      const rule = annotationRules.find(r => r.id === ruleId);
      if (rule && !isNaN(maxNumber)) {
        const increment = rule.increment !== undefined ? rule.increment : 1;
        const updatedRule = {
          ...rule,
          currentNumber: maxNumber + increment
        };
        const updatedRules = annotationRules.map(r => 
          r.id === ruleId ? updatedRule : r
        );
        setAnnotationRules(updatedRules);
        
        if (activeAnnotationRule?.id === ruleId) {
          setActiveAnnotationRule(updatedRule);
        }
      }
    }
  }, [annotations, annotationRules, activeAnnotationRule, extractNumberFromAnnotation]);

  // 加载保存的规则
  useEffect(() => {
    const savedRules = localStorage.getItem('annotationRules');
    const savedActiveRule = localStorage.getItem('activeAnnotationRule');
    
    if (savedRules) {
      try {
        const rules = JSON.parse(savedRules);
        setAnnotationRules(rules);
        
        if (savedActiveRule) {
          const activeRule = JSON.parse(savedActiveRule);
          const foundRule = rules.find(r => r.id === activeRule.id);
          if (foundRule) {
            setActiveAnnotationRule(foundRule);
          }
        }
      } catch (error) {
        console.error('加载规则失败:', error);
      }
    }
  }, [setAnnotations]);

  // 保存规则到本地存储
  useEffect(() => {
    if (annotationRules.length > 0) {
      localStorage.setItem('annotationRules', JSON.stringify(annotationRules));
    }
  }, [annotationRules]);

  // 保存激活规则到本地存储
  useEffect(() => {
    if (activeAnnotationRule) {
      localStorage.setItem('activeAnnotationRule', JSON.stringify(activeAnnotationRule));
    }
  }, [activeAnnotationRule]);

  useEffect(() => {
    localStorage.setItem('continuousRuleNumberingEnabled', String(continuousRuleNumberingEnabled));
  }, [continuousRuleNumberingEnabled]);

  useEffect(() => {
    localStorage.setItem('continuousRuleNumber', String(continuousRuleNumber));
  }, [continuousRuleNumber]);

  const handleContinuousRuleNumberingChange = useCallback((enabled) => {
    setContinuousRuleNumberingEnabled(enabled);
    if (enabled && activeAnnotationRule) {
      const ruleNumber = activeAnnotationRule.currentNumber !== undefined
        && activeAnnotationRule.currentNumber !== null
        ? activeAnnotationRule.currentNumber
        : activeAnnotationRule.startNumber;
      if (ruleNumber !== undefined && ruleNumber !== null && ruleNumber !== '') {
        setContinuousRuleNumber(Number(ruleNumber));
      }
    }
  }, [activeAnnotationRule]);

  // 处理支架一键标注
  const handleAddScaffoldAnnotation = useCallback((scaffoldInfo, pageNumber) => {
    markAnnotationDraftDirty();
    console.log('🏗️ 添加支架标注:', scaffoldInfo, '页码:', pageNumber);
    
    // 🚀 从pageCache获取页面尺寸信息
    const pageData = pageCache.getPageData(pageNumber);
    
    console.log('🔍 调试页面数据结构:', {
      pageNumber,
      pageData: pageData,
      hasPageInfo: !!pageData?.pageInfo,
      dataKeys: pageData ? Object.keys(pageData) : 'null',
      currentPageSize: pageSize
    });
    
    // 优先使用当前页面尺寸，如果没有则使用OCR数据中的页面信息，最后使用默认值
    const pageWidth = pageSize?.width || pageData?.pageInfo?.page_width || 1190;
    const pageHeight = pageSize?.height || pageData?.pageInfo?.page_height || 841;
    
    console.log('📏 使用的页面尺寸:', { width: pageWidth, height: pageHeight });
    
    // 坐标转换分析：
    // 1. OCR相对坐标(0-1)是基于 scale * 2.0 渲染的PDF页面
    // 2. pageWidth/pageHeight 已经是 scale * 2.0 渲染后的尺寸
    // 3. 标注坐标需要是未缩放的PDF页面坐标（渲染时会乘以scale）
    // 4. 转换公式：相对坐标 * 渲染后尺寸 / scale = 未缩放页面坐标
    const annotationX = (scaffoldInfo.x * pageWidth) / scale;
    const annotationY = (scaffoldInfo.y * pageHeight) / scale;
    
    console.log('🔄 详细坐标转换分析:', {
      '1_OCR原始相对坐标': { x: scaffoldInfo.x, y: scaffoldInfo.y },
      '2_页面尺寸来源': pageSize?.width ? 'PDF实时尺寸' : (pageData?.pageInfo ? 'OCR数据' : '默认值'),
      '3_页面尺寸': { width: pageWidth, height: pageHeight },
      '4_当前缩放比例': scale,
      '5_PDF渲染比例': scale * 2.0,
      '6_计算过程': {
        步骤1_相对坐标转渲染后绝对坐标: `${scaffoldInfo.x} * ${pageWidth} = ${scaffoldInfo.x * pageWidth}`,
        步骤2_转换为未缩放页面坐标: `${scaffoldInfo.x * pageWidth} / ${scale} = ${annotationX}`
      },
      '7_最终标注坐标': { x: annotationX, y: annotationY },
      '8_标注渲染时会乘以': scale,
      '9_最终屏幕坐标': { x: annotationX * scale, y: annotationY * scale }
    });
    
    // 计算当前页面已有的支架标注数量
    const existingScaffoldCount = annotations.filter(ann => 
      ann.page === pageNumber && ann.isScaffoldAnnotation
    ).length;
    
    // 生成简化编号
    const simplifiedNumber = `S${existingScaffoldCount + 1}`;
    const annotationPageSize = { width: pageWidth, height: pageHeight };
    const scaledFontSize = scaleAnnotationValue(annotationFontSize, annotationPageSize, 34);
    const scaledFrameSize = scaleAnnotationValue(annotationFrameSize || 56.7, annotationPageSize, 56.7);
    
    const newAnnotation = {
      id: Date.now().toString(),
      type: 'text', // 添加类型标识，确保在标注信息栏显示
      startX: annotationX,
      startY: annotationY,
      endX: annotationX,
      endY: annotationY,
      text: simplifiedNumber, // 使用简化编号
      page: pageNumber,
      color: '#FF0000', // 支架标注使用红色
      borderShape: 'diamond', // 使用菱形
      fontSize: scaledFontSize,
      frameSize: scaledFrameSize,
      ruleId: null, // 支架标注不使用规则
      materialNumber: '', // 初始为空
      scaffoldNumber: scaffoldInfo.text, // 保存原始支架编号
      simplifiedNumber: simplifiedNumber, // 保存简化编号
      isScaffoldAnnotation: true, // 标记为支架标注
      isUploaded: false // 新添加的标注默认未上传
    };
    
    // 创建撤销命令
    const command = createAnnotationCommand(
      `添加支架标注: ${simplifiedNumber} (${scaffoldInfo.text})`,
      () => {
        setAnnotations(prev => [...prev, newAnnotation]);
      },
      () => {
        setAnnotations(prev => prev.filter(ann => ann.id !== newAnnotation.id));
      }
    );
    
    // 执行命令并添加到撤销系统
    undoRedoSystem.executeCommand(command);
    
    console.log(`✅ 已添加支架标注: ${simplifiedNumber} (${scaffoldInfo.text}) 在页面 ${pageNumber}`);
  }, [annotationFontSize, annotationFrameSize, createAnnotationCommand, undoRedoSystem, scale, pageCache, pageSize, annotations]);

  // 处理全局批量添加支架标注（所有页面）
  const handleBatchAddAllScaffoldAnnotations = useCallback(() => {
    markAnnotationDraftDirty();
    console.log('🚀 开始全局批量添加支架标注...');
    
    // 🚀 从pageCache获取所有已识别的页面（支持1000+页批量识别）
    const allRecognizedPages = pageCache.getRecognizedPages();
    
    // 调试：打印当前页面识别数据的概要
    const debugInfo = allRecognizedPages.slice(0, 10).map(pageNum => {
      const pageData = pageCache.getPageData(pageNum);
      return {
        page: pageNum,
        hasData: !!pageData,
        isScaffoldMode: pageData?.isScaffoldMode,
        scaffoldDataCount: pageData?.scaffoldData?.length || pageData?.scaffolds?.length || 0,
        detectionsCount: pageData?.detections?.length || 0
      };
    });
    console.log('🔍 全局批量标注 - 调试识别数据概要 (前10页):', debugInfo);
    
    // 获取所有已识别的页面数据
    console.log('🔍 开始过滤已识别的页面...');
    const recognizedPages = allRecognizedPages
      .filter(pageNum => {
        const pageData = pageCache.getPageData(pageNum);
        
        if (!pageData) {
          console.log(`❌ 页面 ${pageNum} 没有数据`);
          return false;
        }
        
        // 支架模式：检查scaffoldData或scaffolds
        const scaffoldData = pageData.scaffoldData || pageData.scaffolds || [];
        if (pageData.isScaffoldMode && scaffoldData.length > 0) {
          console.log(`✅ 页面 ${pageNum} 支架模式，scaffoldData数量: ${scaffoldData.length}`);
          return true;
        }
        
        // 普通模式：检查detections
        const hasDetections = pageData.detections && pageData.detections.length > 0;
        if (hasDetections) {
          console.log(`✅ 页面 ${pageNum} 普通模式，detections数量: ${pageData.detections.length}`);
        }
        return hasDetections;
      });

    console.log(`🔍 过滤结果: ${recognizedPages.length} 个有效页面`);

    if (recognizedPages.length === 0) {
      message.warning('没有已识别的支架数据可进行批量标注');
      return;
    }

    const allRecognizedMaterials = pageCache.getRecognizedPages()
      .flatMap(pageNum => pageCache.getPageData(pageNum)?.materials || []);
    const scaffoldMaterialLibrary = buildScaffoldMaterialLibrary([
      ...materialBindingRows,
      ...allRecognizedMaterials
    ]);
    console.log(`📚 支架材料库生成完成，共 ${scaffoldMaterialLibrary.length} 条`, scaffoldMaterialLibrary.map(item => item.description));

    // 收集所有页面的支架数据（按图号分组）
    console.log('🔍 开始收集支架数据...');
    let allScaffoldInfos = [];
    let scaffoldCounter = 1; // 当前组的支架计数器
    let lastDrawingNumber = null; // 上一页的图号
    
    recognizedPages.forEach(pageNum => {
      let scaffoldDetections = [];
      let currentPageInfo = ''; // 在外层声明，确保整个迭代中都可访问
      let currentDrawingNumber = ''; // 当前图号
      
      try {
        console.log(`🔍 处理页面 ${pageNum}...`);
        // 🚀 从pageCache获取数据（支持1000+页批量识别）
        const pageData = pageCache.getPageData(pageNum);
        if (!pageData) {
          console.log(`⚠️ 页面 ${pageNum} 数据不存在，跳过`);
          return;
        }
        
        // 获取当前页的图纸页码和图号
        currentPageInfo = pageData.pageNumber || '';
        currentDrawingNumber = pageData.drawingNumber || '';
        console.log(`🔍 页面 ${pageNum} - 图纸页码: "${currentPageInfo}", 图号: "${currentDrawingNumber}"`);
        
        // 检测图号是否变化（按图号分组，图号变化时重置计数器）
        if (currentDrawingNumber && lastDrawingNumber && currentDrawingNumber !== lastDrawingNumber) {
          console.log(`🔄 检测到图号变化: "${lastDrawingNumber}" → "${currentDrawingNumber}"，支架编号重置`);
          scaffoldCounter = 1; // 重置计数器
        }
        
        // 更新上一个图号
        if (currentDrawingNumber) {
          lastDrawingNumber = currentDrawingNumber;
        }
        
        // 支架模式：从scaffoldData获取支架和阀门信息
        const scaffoldDataList = pageData.scaffoldData || pageData.scaffolds || [];
        if (pageData.isScaffoldMode && scaffoldDataList.length > 0) {
          console.log(`🔍 页面 ${pageNum} 支架模式，原始scaffoldData:`, scaffoldDataList);
          
          scaffoldDetections = scaffoldDataList.map(scaffoldItem => {
            const isValve = scaffoldItem.isValveInfo === true || scaffoldItem.itemType === 'valve';
            
            return {
              text: scaffoldItem.scaffoldInfo || scaffoldItem.text || scaffoldItem.originalText || '',
              box: scaffoldItem.position ? [[scaffoldItem.position.x, scaffoldItem.position.y]] : null,
              area_type: isValve ? 'valve' : 'scaffold',
              score: 1.0,
              isValve: isValve,                    // 标记是否为阀门
              mergedFrom: scaffoldItem.mergedFrom  // 保留合并来源
            };
          }).filter(item => {
            // 阀门信息直接接受
            if (item.isValve) {
              console.log(`🔧 检查阀门信息 "${item.text}": ✅ 有效`);
              return true;
            }
            
            // 支架信息需要验证：编号规则或命中支架材料库
            const matchResult = isScaffoldDetection(item.text, scaffoldMaterialLibrary);
            if (matchResult.matched) {
              item.scaffoldMatchSource = matchResult.source;
              item.supportMaterial = matchResult.libraryMatch?.material || null;
              item.supportMaterialDescription = matchResult.libraryMatch?.description || '';
            }
            console.log(`🔍 检查支架 "${item.text}": ${matchResult.matched ? `✅ 有效(${matchResult.source})` : '❌ 无效'}`);
            return matchResult.matched;
          });
          
          const valveCount = scaffoldDetections.filter(d => d.isValve).length;
          const scaffoldCount = scaffoldDetections.length - valveCount;
          console.log(`🔍 页面 ${pageNum} 过滤结果: 支架${scaffoldCount}个, 阀门${valveCount}个`);
        } else {
          // 普通模式：从detections筛选支架检测结果
          const detections = pageData.detections || [];
          scaffoldDetections = detections.filter(detection => {
            const detectionText = detection.text || detection.scaffoldInfo || detection.originalText || '';
            const matchResult = isScaffoldDetection(detectionText, scaffoldMaterialLibrary);
            if (matchResult.matched) {
              detection.scaffoldMatchSource = matchResult.source;
              detection.supportMaterial = matchResult.libraryMatch?.material || null;
              detection.supportMaterialDescription = matchResult.libraryMatch?.description || '';
            }
            return matchResult.matched;
          });
          console.log(`🔍 页面 ${pageNum} 普通模式，支架检测数量: ${scaffoldDetections.length}`);
        }

        if (scaffoldDetections.length === 0) {
          console.log(`⚠️ 页面 ${pageNum} 没有有效的支架数据，跳过`);
          return; // 跳过没有支架的页面
        }
      } catch (error) {
        console.error(`❌ 处理页面 ${pageNum} 时出错:`, error);
        return;
      }

      // 对当前页面的支架检测结果按编号排序
      const sortedScaffoldDetections = [...scaffoldDetections].sort((a, b) => {
        const getScaffoldNumber = (text) => {
          if (!text) return 0;
          const match = text.match(/S-?(\d+)/i);
          return match ? parseInt(match[1], 10) : 0;
        };
        return getScaffoldNumber(a.text) - getScaffoldNumber(b.text);
      });

      // 为每个支架/阀门分配编号（支架按图纸页码分组编号，阀门保留原始编号）
      sortedScaffoldDetections.forEach(detection => {
        // 计算中心点坐标（相对于PDF页面）
        let centerX, centerY;
        
        if (detection.box && detection.box.length >= 4) {
          // 完整边界框格式：[[x1,y1], [x2,y1], [x2,y2], [x1,y2]]
          centerX = detection.box[0][0] + (detection.box[1][0] - detection.box[0][0]) / 2;
          centerY = detection.box[0][1] + (detection.box[2][1] - detection.box[0][1]) / 2;
        } else if (detection.box && detection.box.length === 1) {
          // 简化格式：[[x, y]] - 支架模式下的格式
          centerX = parseFloat(detection.box[0][0]);
          centerY = parseFloat(detection.box[0][1]);
        } else {
          // 没有位置信息，使用默认值
          const itemType = detection.isValve ? '阀门' : '支架';
          console.warn(`⚠️ ${itemType} "${detection.text}" 缺少位置信息，使用默认坐标`);
          centerX = 0.5;
          centerY = 0.5;
        }
        
        // 对于支架，使用清洗后的文本；对于阀门，使用原始文本
        let displayText = detection.text;
        if (!detection.isValve) {
          // 支架：使用清洗后的文本
          const cleanedText = cleanScaffoldText(detection.text);
          displayText = cleanedText ? cleanedText.replace('/', '') : detection.text.replace('/', '');
        } else {
          // 阀门：使用原始文本
          displayText = detection.text.replace('/', '');
        }
        
        const itemInfo = {
          pageNumber: parseInt(pageNum),
          originalText: displayText, // 支架使用清洗后的文本，阀门使用原始文本
          rawText: detection.text,   // 保留原始OCR文本用于调试
          drawingPageNumber: currentPageInfo, // 图纸页码
          drawingNumber: currentDrawingNumber, // 🆕 图号
          x: centerX,
          y: centerY,
          detection: detection,
          isValve: detection.isValve || false,
          mergedFrom: detection.mergedFrom,
          scaffoldMatchSource: detection.scaffoldMatchSource || '',
          supportMaterial: detection.supportMaterial || null,
          supportMaterialDescription: detection.supportMaterialDescription || ''
        };
        
        // 仅为支架分配组编号，阀门不需要编号
        if (!detection.isValve) {
          itemInfo.groupNumber = scaffoldCounter++; // 支架按图号分组编号
        }
        
        allScaffoldInfos.push(itemInfo);
      });
    });

    const totalValveCount = allScaffoldInfos.filter(info => info.isValve).length;
    const totalScaffoldCount = allScaffoldInfos.length - totalValveCount;
    
    console.log(`📊 收集到 ${allScaffoldInfos.length} 项，分布在 ${recognizedPages.length} 页 (支架:${totalScaffoldCount}, 阀门:${totalValveCount})`);
    console.log('🔍 详细信息:', allScaffoldInfos.map(info => ({
      类型: info.isValve ? '🔧 阀门' : '🏗️ 支架',
      PDF页码: info.pageNumber,
      图号: info.drawingNumber || '-',
      图纸页码: info.drawingPageNumber,
      原始文本: info.originalText,
      分组编号: info.groupNumber || '-',
      坐标: `(${info.x.toFixed(2)}, ${info.y.toFixed(2)})`
    })));

    if (allScaffoldInfos.length === 0) {
      message.warning('在已识别的页面中没有找到有效的支架或阀门数据');
      return;
    }

    // 批量创建标注
    console.log('🏗️ 开始创建批量标注...');
    const newAnnotations = [];
    allScaffoldInfos.forEach((itemInfo, index) => {
      try {
        // 🚀 从pageCache获取页面信息
        const pageData = pageCache.getPageData(itemInfo.pageNumber);
        const pageWidth = pageSize?.width || pageData?.pageInfo?.page_width || 1190;
        const pageHeight = pageSize?.height || pageData?.pageInfo?.page_height || 841;
        
        // 坐标转换（与单页批量标注保持一致）
        const annotationX = (itemInfo.x * pageWidth) / scale;
        const annotationY = (itemInfo.y * pageHeight) / scale;
        
        // 验证坐标是否有效
        if (isNaN(annotationX) || isNaN(annotationY)) {
          const itemType = itemInfo.isValve ? '阀门' : '支架';
          console.warn(`⚠️ 跳过无效坐标的${itemType}: ${itemInfo.originalText}`);
          return;
        }

        const annotationPageSize = { width: pageWidth, height: pageHeight };
        const scaledFontSize = scaleAnnotationValue(annotationFontSize, annotationPageSize, 34);
        const scaledFrameSize = scaleAnnotationValue(annotationFrameSize || 56.7, annotationPageSize, 56.7);
        
        if (itemInfo.isValve) {
          // ========== 阀门标注 ==========
          console.log(`🔧 [全局] 创建阀门标注: "${itemInfo.originalText}" 页面${itemInfo.pageNumber} (图号:${itemInfo.drawingNumber}, 图纸页码:${itemInfo.drawingPageNumber}), 坐标(${annotationX.toFixed(2)}, ${annotationY.toFixed(2)})`);
          
          const valveAnnotation = {
            id: `valve-global-${itemInfo.pageNumber}-${Date.now()}-${index}`,
            type: 'text',
            startX: annotationX,
            startY: annotationY,
            endX: annotationX,
            endY: annotationY,
            text: itemInfo.originalText,            // 显示原始阀门编号
            page: itemInfo.pageNumber,
            color: '#FF0000',                       // 红色（与支架相同）
            borderShape: 'diamond',
            fontSize: scaledFontSize,
            frameSize: scaledFrameSize,
            ruleId: null,
            materialNumber: '',
            valveNumber: itemInfo.originalText,
            valveType: itemInfo.originalText.replace(/\d+/g, ''),
            mergedFrom: itemInfo.mergedFrom,
            drawingPageNumber: itemInfo.drawingPageNumber,
            isScaffoldAnnotation: false,
            isValveAnnotation: true,
            isGlobalBatch: true
          };
          
          newAnnotations.push(valveAnnotation);
          
        } else {
          // ========== 支架标注 ==========
          console.log(`🏗️ [全局] 创建支架标注: S${itemInfo.groupNumber} (${itemInfo.originalText}) 页面${itemInfo.pageNumber} (图号:${itemInfo.drawingNumber}, 图纸页码:${itemInfo.drawingPageNumber}), 坐标(${annotationX.toFixed(2)}, ${annotationY.toFixed(2)})`);
          
          const scaffoldAnnotation = {
            id: `group-scaffold-${itemInfo.pageNumber}-${itemInfo.groupNumber}`,
            type: 'text',
            startX: annotationX,
            startY: annotationY,
            endX: annotationX,
            endY: annotationY,
            text: `S${itemInfo.groupNumber}`,      // 按图号分组编号 S1, S2, S3...
            page: itemInfo.pageNumber,
            color: '#FF0000',                       // 红色
            borderShape: 'diamond',
            fontSize: scaledFontSize,
            frameSize: scaledFrameSize,
            ruleId: null,
            materialNumber: '',
            scaffoldNumber: itemInfo.originalText,
            simplifiedNumber: `S${itemInfo.groupNumber}`,
            drawingPageNumber: itemInfo.drawingPageNumber,
            scaffoldMatchSource: itemInfo.scaffoldMatchSource,
            supportMaterial: itemInfo.supportMaterial,
            supportMaterialDescription: itemInfo.supportMaterialDescription,
            isScaffoldAnnotation: true,
            isValveAnnotation: false,
            isGlobalBatch: true
          };
          
          newAnnotations.push(scaffoldAnnotation);
        }
      } catch (error) {
        const itemType = itemInfo.isValve ? '阀门' : '支架';
        console.error(`❌ 处理${itemType}标注时出错: ${itemInfo.originalText}`, error);
      }
    });

    // 创建批量撤销命令
    const command = createAnnotationCommand(
      `全局批量添加 ${totalScaffoldCount} 个支架和 ${totalValveCount} 个阀门标注（${recognizedPages.length} 页）`,
      () => {
        setAnnotations(prev => [...prev, ...newAnnotations]);
      },
      () => {
        const annotationIds = newAnnotations.map(ann => ann.id);
        setAnnotations(prev => prev.filter(ann => !annotationIds.includes(ann.id)));
      }
    );

    // 执行命令并添加到撤销系统
    console.log(`🎯 准备执行批量标注命令，将添加 ${newAnnotations.length} 个标注 (支架:${totalScaffoldCount}, 阀门:${totalValveCount})`);
    undoRedoSystem.executeCommand(command);

    message.success(`已成功批量添加 ${totalScaffoldCount} 个支架和 ${totalValveCount} 个阀门标注，分布在 ${recognizedPages.length} 页`);
    console.log(`✅ 全局批量标注完成: 支架${totalScaffoldCount}个, 阀门${totalValveCount}个, 实际创建 ${newAnnotations.length} 个标注`);
  }, [pageCache, materialBindingRows, pageSize, scale, annotationFontSize, annotationFrameSize, createAnnotationCommand, undoRedoSystem]);

  // 监听全局批量标注事件
  useEffect(() => {
    const handleGlobalBatchAnnotation = (event) => {
      const { action } = event.detail;
      if (action === 'batchAddAllScaffoldAnnotations') {
        handleBatchAddAllScaffoldAnnotations();
      }
    };

    window.addEventListener('global-batch-annotation', handleGlobalBatchAnnotation);
    return () => {
      window.removeEventListener('global-batch-annotation', handleGlobalBatchAnnotation);
    };
  }, [handleBatchAddAllScaffoldAnnotations]);

  // 处理批量添加支架和阀门标注（单页）
  const handleBatchAddScaffoldAnnotations = useCallback((itemInfos, pageNumber) => {
    markAnnotationDraftDirty();
    const valveCount = itemInfos.filter(item => item.isValve).length;
    const scaffoldCount = itemInfos.length - valveCount;
    console.log(`🚀 批量添加标注: ${itemInfos.length} 项 (支架:${scaffoldCount}, 阀门:${valveCount}), 页码: ${pageNumber}`);
    
    // 🚀 从pageCache获取页面尺寸信息
    const pageData = pageCache.getPageData(pageNumber);
    
    console.log('🔍 批量标注 - 调试页面数据结构:', {
      pageNumber,
      pageData: pageData,
      hasPageInfo: !!pageData?.pageInfo,
      dataKeys: pageData ? Object.keys(pageData) : 'null',
      currentPageSize: pageSize
    });
    
    // 优先使用当前页面尺寸，如果没有则使用OCR数据中的页面信息，最后使用默认值
    const pageWidth = pageSize?.width || pageData?.pageInfo?.page_width || 1190;
    const pageHeight = pageSize?.height || pageData?.pageInfo?.page_height || 841;
    const annotationPageSize = { width: pageWidth, height: pageHeight };
    const scaledFontSize = scaleAnnotationValue(annotationFontSize, annotationPageSize, 34);
    const scaledFrameSize = scaleAnnotationValue(annotationFrameSize || 56.7, annotationPageSize, 56.7);
    
    console.log('📏 批量标注 - 使用的页面尺寸:', { width: pageWidth, height: pageHeight });
    
    // 分离支架和阀门
    const scaffoldItems = itemInfos.filter(item => !item.isValve);
    const valveItems = itemInfos.filter(item => item.isValve);
    
    // 对支架信息按编号排序（从小到大）
    const sortedScaffoldItems = [...scaffoldItems].sort((a, b) => {
      // 提取支架编号中的数字部分进行比较
      const getScaffoldNumber = (text) => {
        const match = text.match(/S-(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
      };
      
      const numA = getScaffoldNumber(a.text);
      const numB = getScaffoldNumber(b.text);
      return numA - numB; // 从小到大排序
    });
    
    console.log('🔢 支架排序结果:', sortedScaffoldItems.map(s => s.text));
    
    // 显示编号对应关系
    const numberMapping = sortedScaffoldItems.map((scaffoldInfo, index) => ({
      simplified: `S${index + 1}`,
      original: scaffoldInfo.text
    }));
    console.log('📋 支架编号对应关系:', numberMapping);
    console.log('🔧 阀门信息:', valveItems.map(v => v.text));
    
    const newAnnotations = [];
    
    // 创建支架标注
    sortedScaffoldItems.forEach((scaffoldInfo, index) => {
      // 坐标转换：相对坐标 * 渲染后尺寸 / scale = 未缩放页面坐标
      const annotationX = (scaffoldInfo.x * pageWidth) / scale;
      const annotationY = (scaffoldInfo.y * pageHeight) / scale;
      
      // 生成简化编号 S1, S2, S3...
      const simplifiedNumber = `S${index + 1}`;
      
      const scaffoldAnnotation = {
        id: `scaffold-${pageNumber}-${Date.now()}-${index}`,
        type: 'text',
        startX: annotationX,
        startY: annotationY,
        endX: annotationX,
        endY: annotationY,
        text: simplifiedNumber,               // 显示简化编号 S1, S2, S3...
        page: pageNumber,
        color: '#FF0000',                     // 红色
        borderShape: 'diamond',
        fontSize: scaledFontSize,
        frameSize: scaledFrameSize,
        ruleId: null,
        materialNumber: '',
        scaffoldNumber: scaffoldInfo.text,    // 保存原始支架编号
        simplifiedNumber: simplifiedNumber,
        scaffoldMatchSource: scaffoldInfo.scaffoldMatchSource || '',
        supportMaterial: scaffoldInfo.supportMaterial || null,
        supportMaterialDescription: scaffoldInfo.supportMaterialDescription || '',
        isScaffoldAnnotation: true,
        isValveAnnotation: false,
        originalText: scaffoldInfo.originalText,
        isUploaded: false // 新批量添加的标注默认未上传
      };
      
      console.log(`🏗️ [App] 创建支架标注: "${simplifiedNumber}" (${scaffoldInfo.text}) at (${annotationX.toFixed(2)}, ${annotationY.toFixed(2)})`);
      newAnnotations.push(scaffoldAnnotation);
    });
    
    // 创建阀门标注
    valveItems.forEach((valveInfo, index) => {
      // 坐标转换：相对坐标 * 渲染后尺寸 / scale = 未缩放页面坐标
      const annotationX = (valveInfo.x * pageWidth) / scale;
      const annotationY = (valveInfo.y * pageHeight) / scale;
      
      const valveAnnotation = {
        id: `valve-${pageNumber}-${Date.now()}-${index}`,
        type: 'text',
        startX: annotationX,
        startY: annotationY,
        endX: annotationX,
        endY: annotationY,
        text: valveInfo.text,                 // 显示原始阀门编号（如 PDV6101）
        page: pageNumber,
        color: '#FF0000',                     // 红色（与支架相同）
        borderShape: 'diamond',
        fontSize: scaledFontSize,
        frameSize: scaledFrameSize,
        ruleId: null,
        materialNumber: '',
        valveNumber: valveInfo.text,          // 保存阀门编号
        valveType: valveInfo.text.replace(/\d+/g, ''), // 提取阀门类型（如 PDV）
        mergedFrom: valveInfo.mergedFrom,
        isScaffoldAnnotation: false,
        isValveAnnotation: true,
        originalText: valveInfo.originalText,
        isUploaded: false // 新批量添加的标注默认未上传
      };
      
      console.log(`🔧 [App] 创建阀门标注: "${valveInfo.text}" at (${annotationX.toFixed(2)}, ${annotationY.toFixed(2)})`);
      newAnnotations.push(valveAnnotation);
    });
    
    // 创建批量撤销命令
    const command = createAnnotationCommand(
      `批量添加 ${scaffoldCount} 个支架和 ${valveCount} 个阀门标注`,
      () => {
        setAnnotations(prev => [...prev, ...newAnnotations]);
      },
      () => {
        const annotationIds = newAnnotations.map(ann => ann.id);
        setAnnotations(prev => prev.filter(ann => !annotationIds.includes(ann.id)));
      }
    );
    
    // 执行命令并添加到撤销系统
    undoRedoSystem.executeCommand(command);
    
    message.success(`已批量添加 ${scaffoldCount} 个支架和 ${valveCount} 个阀门标注`);
    console.log(`✅ 已批量添加 ${scaffoldCount} 个支架和 ${valveCount} 个阀门标注在页面 ${pageNumber}`);
  }, [annotationFontSize, annotationFrameSize, createAnnotationCommand, undoRedoSystem, scale, pageCache, pageSize]);

  // 新增：批量添加普通标注的回调（用于焊点编号转标注）
  const handleBatchAddAnnotations = useCallback((newAnnotations, updatedRule) => {
    if (!newAnnotations || newAnnotations.length === 0) return;
    markAnnotationDraftDirty();

    const isManualInsertedAnnotation = annotation => !!(
      annotation?.weldData?.isManualInserted ||
      annotation?.weldData?.manualInsertId ||
      annotation?.isManualInserted ||
      annotation?.manualInsertId
    );
    
    // 补点虽然通过多页批量界面生成，但业务来源仍是人工新增。
    const incomingAnnotations = newAnnotations.map(ann => ({
      ...ann,
      frameSize: ann.frameSize ?? (annotationFrameSize || 56.7),
      origin: isManualInsertedAnnotation(ann) ? 'manual' : 'auto',
      qualityCorrection: isManualInsertedAnnotation(ann),
      qualityModified: ann.qualityModified === true,
      isBatchGenerated: true // 标记为批量生成
    }));
    const replacementPlan = buildAnnotationReplacementPlan(annotations, incomingAnnotations);
    const {
      batchRunIds,
      replacedAnnotations,
      shouldReplace
    } = replacementPlan;
    const getStableWeldKey = annotation => {
      const stableKey = annotation?.weldData?.stableKey;
      if (stableKey) return `${annotation.page || 1}__${stableKey}`;
      const pathId = annotation?.weldData?.pathId;
      if (pathId !== undefined && pathId !== null) {
        return `${annotation.page || 1}__path:${pathId}`;
      }
      return '';
    };
    const existingByWeldKey = new Map(
      replacedAnnotations
        .map(annotation => [getStableWeldKey(annotation), annotation])
        .filter(([key]) => !!key)
    );
    const existingByAnnotationId = new Map(
      replacedAnnotations
        .filter(annotation => annotation?.id)
        .map(annotation => [annotation.id, annotation])
    );
    const findExistingAnnotation = incoming => {
      const sourceAnnotationId = incoming?.weldData?.sourceAnnotationId;
      if (sourceAnnotationId && existingByAnnotationId.has(sourceAnnotationId)) {
        return existingByAnnotationId.get(sourceAnnotationId);
      }
      return existingByWeldKey.get(getStableWeldKey(incoming));
    };
    const renumberedExistingAnnotations = incomingAnnotations.filter(incoming => {
      const existing = findExistingAnnotation(incoming);
      return existing && String(existing.text ?? '') !== String(incoming.text ?? '');
    });
    const markedAnnotations = incomingAnnotations.map(incoming => {
      // Prefer the exact source annotation id. Stable weld keys are only a
      // fallback for older generated files; matching by id guarantees that a
      // numbering shift cannot move a circle/leader or replace its content.
      const existing = findExistingAnnotation(incoming);
      if (!existing) return incoming;
      const isRenumbered = String(existing.text ?? '') !== String(incoming.text ?? '');
      // 顺序修正只更新编号和编号元数据；已有标注的位置、引线、内容和样式全部保留。
      return {
        ...incoming,
        ...existing,
        id: existing.id,
        text: incoming.text,
        weldData: {
          ...(existing.weldData || {}),
          ...(incoming.weldData || {})
        },
        batchRunId: incoming.batchRunId,
        pipelineNumber: incoming.pipelineNumber || existing.pipelineNumber,
        // 修复旧版本曾把补点标成 auto 的数据；来源以当前焊点元数据为准。
        origin: isManualInsertedAnnotation(incoming) ? 'manual' : (existing.origin || 'auto'),
        // Existing welds whose numbers moved are modifications, not newly
        // generated annotations. This also feeds the quality statistics.
        qualityModified: existing.qualityModified === true || isRenumbered,
        isBatchGenerated: true,
        isUploaded: false
      };
    });
    const isReplacingBatchRun = replacedAnnotations.length > 0;
    const newlyAddedAnnotations = markedAnnotations.filter(annotation => {
      return !findExistingAnnotation(annotation);
    });
    const manualAddedAnnotations = newlyAddedAnnotations.filter(isManualInsertedAnnotation);
    const autoAddedAnnotations = newlyAddedAnnotations.filter(annotation => !isManualInsertedAnnotation(annotation));
    
    // 更新统计数据
    setWeldStats(prev => ({
      ...prev,
      batchAdded: prev.batchAdded + autoAddedAnnotations.length,
      manuallyAdded: prev.manuallyAdded + manualAddedAnnotations.length,
      modified: prev.modified + renumberedExistingAnnotations.length
    }));
    
    // 获取更新前的规则状态（用于撤销）
    // 注意：这里直接使用 annotationRules 可能会导致闭包问题，但由于 handleBatchAddAnnotations 
    // 依赖了 annotationRules，每次规则变化都会重新创建函数，所以获取到的是最新的
    const prevRule = updatedRule ? annotationRules.find(r => r.id === updatedRule.id) : null;
    
    // 创建撤销命令
    const command = createAnnotationCommand(
      `${isReplacingBatchRun ? '更新' : '批量添加'}标注: ${markedAnnotations.length}个`,
      () => {
        setAnnotations(prev => {
          if (replacedAnnotations.length === 0) {
            return [...prev, ...markedAnnotations];
          }
          return [
            ...prev.filter(annotation => !shouldReplace(annotation)),
            ...markedAnnotations
          ];
        });
        
        // 更新规则状态
        if (updatedRule) {
          setAnnotationRules(prevRules => prevRules.map(r => r.id === updatedRule.id ? updatedRule : r));
          // 如果当前激活的规则是被更新的规则，也更新激活规则状态
          setActiveAnnotationRule(current => current?.id === updatedRule.id ? updatedRule : current);
        }
      },
      () => {
        const ids = new Set(markedAnnotations.map(annotation => annotation.id));
        setAnnotations(prev => {
          const withoutNewBatch = prev.filter(annotation => !ids.has(annotation.id));
          return [...withoutNewBatch, ...replacedAnnotations];
        });
        
        // 恢复规则状态
        if (prevRule) {
          setAnnotationRules(prevRules => prevRules.map(r => r.id === prevRule.id ? prevRule : r));
          setActiveAnnotationRule(current => current?.id === prevRule.id ? prevRule : current);
        }
      }
    );
    
    undoRedoSystem.executeCommand(command);
    if (autoAddedAnnotations.length > 0) {
      const pages = Array.from(new Set(
        autoAddedAnnotations.map(annotation => annotation.page || currentPage).filter(Boolean)
      ));
      logAuditEvent('weld_add_auto', {
        count: autoAddedAnnotations.length,
        pages,
        autoPages: pages.length || 1,
        batchRunIds: Array.from(batchRunIds)
      });
    }

    // 后台的手动新增页数按单页事件统计，因此按页拆分补点事件。
    const manualAddsByPage = manualAddedAnnotations.reduce((groups, annotation) => {
      const page = Number(annotation.page || currentPage) || currentPage;
      if (!groups.has(page)) groups.set(page, []);
      groups.get(page).push(annotation);
      return groups;
    }, new Map());
    manualAddsByPage.forEach((pageAnnotations, page) => {
      logAuditEvent('weld_add_manual', {
        count: pageAnnotations.length,
        page,
        pages: [page],
        manualPages: 1,
        source: 'multi_page_manual_insert',
        batchRunIds: Array.from(new Set(pageAnnotations.map(item => item.batchRunId).filter(Boolean))),
        recoveredSourceCount: incomingAnnotations.filter(item => item?.weldData?.sourceAnnotationId).length,
        renumberedExistingCount: renumberedExistingAnnotations.length,
        renumberedPages: Array.from(new Set(
          renumberedExistingAnnotations.map(item => item.page).filter(Boolean)
        )),
        generatedFrameSizes: Array.from(new Set(
          pageAnnotations.map(item => Number(item.frameSize)).filter(Number.isFinite)
        ))
      });
    });

    if (renumberedExistingAnnotations.length > 0) {
      const modifiedPages = Array.from(new Set(
        renumberedExistingAnnotations.map(annotation => annotation.page).filter(Boolean)
      ));
      logAuditEvent('weld_edit', {
        count: renumberedExistingAnnotations.length,
        pages: modifiedPages,
        changedFields: ['text', 'weldData.weldNumber'],
        editCategory: 'content',
        source: 'weld_adjustment_renumber',
        originCounts: buildOriginCounts(
          renumberedExistingAnnotations.map(incoming => findExistingAnnotation(incoming)).filter(Boolean)
        )
      });
    }

    // 已打开文件的焊点调整只记录本次新补的标注，避免旧标注把诊断日志淹没。
    const layoutLogAnnotations = isReplacingBatchRun ? newlyAddedAnnotations : markedAnnotations;
    if (layoutLogAnnotations.some(annotation => annotation.layoutDiagnostics)) {
      saveAutomaticLayoutLog(pdfFileName || 'unknown.pdf', layoutLogAnnotations).catch((error) => {
        console.error('自动落图诊断日志保存失败:', error);
      });
    }
    
    if (isReplacingBatchRun) {
      message.success(`已新增 ${manualAddedAnnotations.length} 个焊点，修改 ${renumberedExistingAnnotations.length} 个原有编号`);
    } else {
      message.success(`已生成 ${markedAnnotations.length} 个标注${updatedRule ? '，并更新规则序号' : ''}`);
    }
  }, [createAnnotationCommand, undoRedoSystem, annotationRules, annotationFrameSize, logAuditEvent, currentPage, pdfFileName, annotations]);

  // 撤销功能
  const handleUndo = useCallback(() => {
    markAnnotationDraftDirty();
    undoRedoSystem.undo();
  }, [undoRedoSystem]);

  // 第一个快捷键处理函数已移除，避免与第二个函数冲突

  const warnIfPdfEncrypted = useCallback(async (arrayBuffer, displayName = 'PDF文件') => {
    if (!arrayBuffer || !window.PDFLib?.PDFDocument) {
      return false;
    }

    try {
      const bufferCopy = arrayBuffer.slice ? arrayBuffer.slice(0) : arrayBuffer;
      await window.PDFLib.PDFDocument.load(bufferCopy, { ignoreEncryption: false });
      return false;
    } catch (error) {
      const errorText = String(error?.message || error || '');
      const isEncrypted = /encrypted|encryption|password|encrypt/i.test(errorText);
      if (!isEncrypted) {
        return false;
      }

      Modal.warning({
        title: '检测到 PDF 加密',
        content: (
          <div>
            <p>当前文件“{displayName || 'PDF文件'}”带有加密或权限限制。</p>
            <p>可以继续查看和识别，但导出标注版 PDF、保存标注到文件或写入附件时可能失败。</p>
            <p>建议先转换为无加密 PDF 后再正式落图。</p>
          </div>
        ),
        okText: '我知道了',
        maskClosable: false,
        keyboard: false
      });
      return true;
    }
  }, []);

  // 监听Electron的文件打开事件
  useEffect(() => {
    console.log('===== 开始设置Electron文件监听 =====');
    console.log('window.require:', typeof window.require);
    console.log('window.electronAPI:', window.electronAPI);
    
    try {
      // 共用的PDF处理函数
      const processPDFData = async (data) => {
        if (typeof data === 'string') {
          // 兼容旧格式（文件路径）
          console.log('📁 收到PDF文件路径:', data);
          setPdfFile(data);
          // 读取文件内容到ArrayBuffer
          try {
            const response = await fetch(data);
            const arrayBuffer = await response.arrayBuffer();
            await warnIfPdfEncrypted(arrayBuffer, data.split(/[\\\/]/).pop() || 'PDF文件');
            setPdfArrayBuffer(arrayBuffer);
            console.log('✅ 已读取PDF文件内容到内存');
          } catch (error) {
            console.error('❌ 读取PDF文件内容失败:', error);
            setPdfArrayBuffer(null);
          }
          // 保存文件路径
          setPdfFilePath(data);
          // 从路径中提取文件名（去除扩展名）
          const fileName = data.split(/[\\\/]/).pop().replace(/\.pdf$/i, '');
          setPdfFileName(fileName);
          // 重置页面状态
          setCurrentPage(1);
          // 重置搜索状态
          setSearchText('');
          setSearchResults([]);
          setCurrentSearchIndex(-1);
          // 重置所有页面的识别状态
          setPageRecognitionData({});
          // 尝试从PDF元数据中加载标注信息
          await loadAnnotationsFromPDFMetadata(data);
        } else if (data && data.url) {
          // 新格式（Blob URL）
          console.log('📁 收到PDF文件:', data.fileName, 'URL:', data.url);
          setPdfFile(data.url);
          // 读取URL内容到ArrayBuffer
          try {
            const response = await fetch(data.url);
            const arrayBuffer = await response.arrayBuffer();
            await warnIfPdfEncrypted(arrayBuffer, data.fileName || 'PDF文件');
            setPdfArrayBuffer(arrayBuffer);
            console.log('✅ 已从URL读取PDF内容到内存');
          } catch (error) {
            console.error('❌ 读取PDF内容失败:', error);
            setPdfArrayBuffer(null);
          }
          // 保存文件名（去除扩展名）
          if (data.fileName) {
            const fileName = data.fileName.replace(/\.pdf$/i, '');
            setPdfFileName(fileName);
          }
          // 保存文件路径到全局变量，供OCR使用
          if (data.filePath) {
            window.__lastOpenedPdfPath__ = data.filePath;
            // 同时保存到React状态，供保存功能使用
            setPdfFilePath(data.filePath);
          }
          // 重置页面状态
          setCurrentPage(1);
          // 重置搜索状态
          setSearchText('');
          setSearchResults([]);
          setCurrentSearchIndex(-1);
          // 重置所有页面的识别状态
          setPageRecognitionData({});
          // 尝试从PDF元数据中加载标注信息
          await loadAnnotationsFromPDFMetadata(data.url);
        } else {
          console.error('❌ 无效的PDF数据格式:', data);
        }
      };

      // 方案1：尝试使用electronAPI（如果preload脚本工作）
      if (window.electronAPI) {

        const handleOpenPDF = async (event, data) => {
          await processPDFData(data);
        };

        const handleOpenPDFError = (event, errorMessage) => {
          console.error('❌ PDF打开失败:', errorMessage);
          // 可以显示错误消息给用户
        };

        window.electronAPI.onOpenPDF(handleOpenPDF);
        window.electronAPI.onOpenPDFError(handleOpenPDFError);
        
        return () => {
          window.electronAPI.removeOpenPDFListener(handleOpenPDF);
          window.electronAPI.removeOpenPDFErrorListener(handleOpenPDFError);
        };
      }
      
      // 方案2：直接使用require（如果启用了nodeIntegration）
      if (window.require) {
        const { ipcRenderer } = window.require('electron');
        
        const handleOpenPDF = async (event, data) => {
          await processPDFData(data);
        };

        const handleOpenPDFError = (event, errorMessage) => {
          console.error('❌ PDF打开失败:', errorMessage);
        };

        ipcRenderer.on('open-pdf', handleOpenPDF);
        ipcRenderer.on('open-pdf-error', handleOpenPDFError);
        
        return () => {
          ipcRenderer.removeListener('open-pdf', handleOpenPDF);
          ipcRenderer.removeListener('open-pdf-error', handleOpenPDFError);
        };
      }
      
      console.log('❌ 两种方案都不可用，可能在浏览器中运行');
      
    } catch (error) {
      console.error('❌ 设置Electron监听器失败:', error);
    }
  }, [warnIfPdfEncrypted]);

  const handleEditCurrentAnnotationShortcut = useCallback(() => {
    if (!annotationEditHandlerRef.current) {
      message.warning('标注编辑功能尚未就绪');
      return;
    }

    const selected = selectedAnnotation
      ? annotations.find(ann => ann.id === selectedAnnotation)
      : null;

    const latestOnCurrentPage = [...annotations]
      .reverse()
      .find(ann => ann.page === currentPage && ann.remark !== '管段号');

    const targetAnnotation = selected || latestOnCurrentPage;

    if (!targetAnnotation) {
      message.info('当前页没有可编辑的焊口标注');
      return;
    }

    annotationEditHandlerRef.current(targetAnnotation);
  }, [annotations, currentPage, selectedAnnotation]);

  const handleCopySelectedAnnotation = useCallback(() => {
    const selectionIds = selectedAnnotationIds.length > 0
      ? selectedAnnotationIds
      : [selectedAnnotation || lastSelectedAnnotationIdRef.current].filter(Boolean);
    const uniqueSelectionIds = Array.from(new Set(selectionIds));
    const selectedIdSet = new Set(uniqueSelectionIds);
    const targetAnnotations = annotationsRef.current.filter(annotation => selectedIdSet.has(annotation.id));
    const weldAnnotations = targetAnnotations.filter(annotation => annotation.remark !== '管段号');

    if (weldAnnotations.length === 0) {
      message.info('请先选中一个焊口标注');
      return;
    }

    const primaryId = selectedAnnotation && weldAnnotations.some(annotation => annotation.id === selectedAnnotation)
      ? selectedAnnotation
      : weldAnnotations[0].id;
    const primaryAnnotation = weldAnnotations.find(annotation => annotation.id === primaryId) || weldAnnotations[0];

    copiedAnnotationRef.current = {
      annotations: weldAnnotations.map(annotation => ({ ...annotation })),
      anchor: {
        x: primaryAnnotation.endX ?? primaryAnnotation.startX ?? 0,
        y: primaryAnnotation.endY ?? primaryAnnotation.startY ?? 0
      }
    };
    message.success(`已复制 ${weldAnnotations.length} 个焊口`);
  }, [selectedAnnotation, selectedAnnotationIds]);

  const handlePasteCopiedAnnotation = useCallback(() => {
    const copiedPayload = copiedAnnotationRef.current;
    if (!copiedPayload?.annotations?.length) {
      message.info('请先选中焊口并按 Ctrl+C 复制');
      return;
    }

    const pastePosition = pdfPointerPositionRef.current;
    if (!pastePosition) {
      message.info('请先把鼠标移动到 PDF 页面上的粘贴位置');
      return;
    }

    markAnnotationDraftDirty();
    const pasteDeltaX = pastePosition.x - copiedPayload.anchor.x;
    const pasteDeltaY = pastePosition.y - copiedPayload.anchor.y;
    const latestAutoBatchAnnotation = [...annotationsRef.current]
      .reverse()
      .find(item => item?.isBatchGenerated && getAnnotationOrigin(item) === 'auto' && item.batchRunId);
    const pastedAnnotations = copiedPayload.annotations.map((copiedAnnotation, index) => ({
      ...copiedAnnotation,
      id: `${Date.now()}_${index}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      page: pastePosition.page,
      startX: (copiedAnnotation.startX ?? 0) + pasteDeltaX,
      startY: (copiedAnnotation.startY ?? 0) + pasteDeltaY,
      endX: (copiedAnnotation.endX ?? copiedAnnotation.startX ?? 0) + pasteDeltaX,
      endY: (copiedAnnotation.endY ?? copiedAnnotation.startY ?? 0) + pasteDeltaY,
      isUploaded: false,
      origin: 'manual',
      batchRunId: latestAutoBatchAnnotation?.batchRunId || null,
      qualityCorrection: !!latestAutoBatchAnnotation?.batchRunId,
      qualityModified: false,
      isBatchGenerated: false
    }));
    const pastedIds = pastedAnnotations.map(annotation => annotation.id);

    const pasteCommand = {
      description: `粘贴焊口 (${pastedAnnotations.length}个)`,
      execute: () => {
        setAnnotations(prev => [...prev, ...pastedAnnotations]);
        setSelectedAnnotation(pastedIds[pastedIds.length - 1]);
        setSelectedAnnotationIds(pastedIds);
        lastSelectedAnnotationIdRef.current = pastedIds[pastedIds.length - 1];
        setWeldStats(prev => ({
          ...prev,
          manuallyAdded: prev.manuallyAdded + pastedAnnotations.length
        }));
      },
      undo: () => {
        const pastedIdSet = new Set(pastedIds);
        setAnnotations(prev => prev.filter(annotation => !pastedIdSet.has(annotation.id)));
        setWeldStats(prev => ({
          ...prev,
          manuallyAdded: Math.max(0, prev.manuallyAdded - pastedAnnotations.length)
        }));
        if (pastedIdSet.has(lastSelectedAnnotationIdRef.current)) {
          lastSelectedAnnotationIdRef.current = null;
        }
        setSelectedAnnotation(prev => (pastedIdSet.has(prev) ? null : prev));
        setSelectedAnnotationIds(prev => prev.filter(id => !pastedIdSet.has(id)));
      }
    };

    undoRedoSystem.executeCommand(pasteCommand);
    logAuditEvent('weld_add_manual', {
      count: pastedAnnotations.length,
      page: pastePosition.page || currentPage,
      pages: [pastePosition.page || currentPage],
      manualPages: 1,
      source: 'paste',
      batchRunIds: [latestAutoBatchAnnotation?.batchRunId].filter(Boolean)
    });
    message.success(`已粘贴 ${pastedAnnotations.length} 个焊口`);
  }, [undoRedoSystem, logAuditEvent, currentPage]);

  // 键盘快捷键处理
  useEffect(() => {
    const handleKeyDown = (event) => {
      // 检查是否在输入框中，如果是则不处理快捷键
      const activeElement = document.activeElement;
      const isInputElement = activeElement && (
        activeElement.tagName === 'INPUT' || 
        activeElement.tagName === 'TEXTAREA' || 
        activeElement.contentEditable === 'true'
      );

      if (isInputElement) {
        return;
      }

      // 处理快捷键，忽略大小写
      // 使用 event.key.toLowerCase() 和 event.code 双重判断，确保在所有情况下都不区分大小写
      const key = event.key.toLowerCase();
      const code = event.code; // 物理按键代码，不受大小写影响

      // Ctrl+Z: 撤销
      if (event.ctrlKey && (key === 'z' || code === 'KeyZ') && !event.shiftKey) {
        event.preventDefault();
        if (undoRedoSystem.canUndo) {
          handleUndo();
        }
        return;
      }

      // Ctrl+Y 或 Ctrl+Shift+Z: 重做
      if ((event.ctrlKey && (key === 'y' || code === 'KeyY')) || (event.ctrlKey && event.shiftKey && (key === 'z' || code === 'KeyZ'))) {
        event.preventDefault();
        if (undoRedoSystem.canRedo) {
          handleRedo();
        }
        return;
      }

      // Ctrl+C: 复制选中的焊口标注
      if (event.ctrlKey && (key === 'c' || code === 'KeyC')) {
        event.preventDefault();
        handleCopySelectedAnnotation();
        return;
      }

      // Ctrl+V: 粘贴复制的焊口标注到鼠标所在PDF位置
      if (event.ctrlKey && (key === 'v' || code === 'KeyV')) {
        event.preventDefault();
        handlePasteCopiedAnnotation();
        return;
      }

      // Ctrl+P: 打印
      if (event.ctrlKey && (key === 'p' || code === 'KeyP')) {
        event.preventDefault();
        handlePrint();
        return;
      }

      // Ctrl+O: 打开文件
      if (event.ctrlKey && (key === 'o' || code === 'KeyO')) {
        event.preventDefault();
        handleOpenPDFClick();
        return;
      }
      
      // Ctrl+S: 保存到原文件
      if (event.ctrlKey && (key === 's' || code === 'KeyS')) {
        event.preventDefault();
        handleQuickSave();
        return;
      }

      // F: 搜索
      if ((key === 'f' || code === 'KeyF') && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        // 聚焦到搜索框
        const searchInput = document.querySelector('.ant-input-search input');
        if (searchInput) {
          searchInput.focus();
        }
        return;
      }

      // A: 切换标注模式
      if ((key === 'a' || code === 'KeyA') && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        handleToggleAnnotationMode();
        return;
      }

      // E: 标注模式下编辑当前页最近的焊口标注
      if ((key === 'e' || code === 'KeyE') && !event.ctrlKey && !event.altKey && !event.shiftKey && annotationMode) {
        event.preventDefault();
        handleEditCurrentAnnotationShortcut();
        return;
      }

      // Q: 在菱形框与圆形框之间切换
      if ((key === 'q' || code === 'KeyQ') && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        const qShapeCycle = ['diamond', 'circle'];
        const currentShapeIndex = qShapeCycle.indexOf(annotationBorderShape);
        const newShape = qShapeCycle[(currentShapeIndex + 1) % qShapeCycle.length];
        setAnnotationBorderShape(newShape);
        return;
      }

      // W: 切换现场焊缝与车间焊缝
      if ((key === 'w' || code === 'KeyW') && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        const newShape = annotationBorderShape === 'field-weld' ? 'shop-weld' : 'field-weld';
        setAnnotationBorderShape(newShape);
        return;
      }

      // D: 切换管段号模式
      if ((key === 'd' || code === 'KeyD') && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        handleTogglePipeSegmentMode();
        return;
      }

      // 空格键: 切换标注管理栏显示/隐藏
      if (event.key === ' ' && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        setRulesVisible(visible => !visible);
        return;
      }

      // 其他快捷键的正常处理
      // 检查是否是按钮或其他可聚焦的UI元素
      const isUIElement = activeElement && (
        activeElement.tagName === 'BUTTON' ||
        activeElement.classList.contains('ant-btn') ||
        activeElement.classList.contains('ant-select') ||
        activeElement.classList.contains('ant-input-number') ||
        activeElement.closest('.ant-btn') ||
        activeElement.closest('.ant-select') ||
        activeElement.closest('.ant-input-number')
      );
      
      // 如果当前焦点在UI元素上，移除焦点并继续处理快捷键
      if (isUIElement) {
        activeElement.blur(); // 移除按钮焦点
        // 将焦点转移到document.body上，确保快捷键能正常工作
        document.body.focus();
      }

      // 左右箭头键: 翻页
      if (event.key === 'ArrowLeft' && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        if (currentPage > 1) {
          handlePageChange(currentPage - 1);
        }
        return;
      }

      if (event.key === 'ArrowRight' && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        if (currentPage < totalPages) {
          handlePageChange(currentPage + 1);
        }
        return;
      }

      // +/-: 缩放
      if (event.key === '=' && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        handleScaleChange(Math.min(3.0, scale + 0.25));
        return;
      }

      if (event.key === '-' && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        handleScaleChange(Math.max(0.25, scale - 0.25));
        return;
      }





      // R键已用于标注框选择（车间焊缝），不再用于切换规则面板
    };

    document.addEventListener('keydown', handleKeyDown);
    
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    undoRedoSystem.canUndo, 
    undoRedoSystem.canRedo, 
    currentPage, 
    totalPages, 
    scale, 
    rulesVisible,
    annotationMode,
    pipeSegmentMode,
    annotationBorderShape,
    pdfFilePath,
    annotations,
    handleEditCurrentAnnotationShortcut,
    handleCopySelectedAnnotation,
    handlePasteCopiedAnnotation
  ]);

  // 从PDF元数据中读取标注信息
  const loadAnnotationsFromPDFMetadata = useCallback(async (file) => {
    const annotationIdsAtLoadStart = new Set(
      annotationsRef.current.map(annotation => annotation.id)
    );

    const applyLoadedAnnotations = (loadedAnnotations) => {
      const normalizedLoadedAnnotations = normalizeTextRectangleAnnotations(loadedAnnotations);
      // Metadata may finish loading after a user has already started marking.
      // The next local save must therefore reconcile every page, not assume
      // the earlier page-delta draft already contains these historical marks.
      localAnnotationDraftFullCheckpointVersionRef.current += 1;
      setAnnotations(prev => {
        const addedDuringLoad = prev.filter(annotation => !annotationIdsAtLoadStart.has(annotation.id));

        if (addedDuringLoad.length === 0) {
          return normalizedLoadedAnnotations;
        }

        const loadedIds = new Set(normalizedLoadedAnnotations.map(annotation => annotation.id));
        const preservedAnnotations = addedDuringLoad.filter(annotation => !loadedIds.has(annotation.id));
        return [...normalizedLoadedAnnotations, ...preservedAnnotations];
      });
    };

    const clearLoadedAnnotations = () => {
      localAnnotationDraftFullCheckpointVersionRef.current += 1;
      setAnnotations(prev => prev.filter(annotation => !annotationIdsAtLoadStart.has(annotation.id)));
    };

    try {
      const { PDFDocument } = window.PDFLib;
      
      // 获取PDF文件的ArrayBuffer
      let arrayBuffer;
      if (typeof file === 'string') {
        // 如果是URL，需要先获取ArrayBuffer
        const response = await fetch(file);
        arrayBuffer = await response.arrayBuffer();
      } else if (file instanceof File) {
        // 如果是File对象
        arrayBuffer = await file.arrayBuffer();
      } else {
        return;
      }
      
      // 加载PDF文档
      const pdfDoc = await PDFDocument.load(arrayBuffer);

      // 检测PDF页面旋转角度和基本信息
      const pages = pdfDoc.getPages();


      // 检测所有页面的旋转角度（静默检测，不输出）
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const { width, height } = page.getSize();
        const rotation = page.getRotation() || 0; // 确保是数字
        const rotationDegrees = typeof rotation === 'object' ? (rotation.angle || 0) : rotation;
        const isLandscape = width > height;
        const orientation = isLandscape ? '横向' : '纵向';

        // 静默检测，不输出日志
      }

      // 检测PDF是否包含图像标注（通过检查页面内容）
      let hasImageAnnotations = false;
      
      try {
        // 简单检测：如果PDF有多个图像对象，可能包含嵌入的标注图像
        for (let i = 0; i < Math.min(pages.length, 3); i++) { // 只检查前3页以提高性能
          const page = pages[i];
          const resources = page.node.Resources;
          if (resources && resources.XObject) {
            const xObjects = Object.keys(resources.XObject);
            if (xObjects.length > 1) { // 如果有多个图像对象，可能包含标注图像
              hasImageAnnotations = true;
              break;
            }
          }
        }
      } catch (detectError) {
        console.warn('⚠️ 检测图像标注失败，继续加载:', detectError);
      }
      
      // 安全读取标准元数据中的标注数据（从Keywords字段或附件）
      let keywords = null;
      let keywordString = '';
      let annotationData = null;
      let loadedAnnotationResult = null;
      let loadMethod = null; // 记录加载方式
      
      try {
        keywords = pdfDoc.getKeywords();
        keywordString = Array.isArray(keywords) ? keywords.join(' ') : (keywords || '');
      } catch (keywordError) {
        console.warn('⚠️ 读取PDF Keywords失败，跳过元数据标注加载:', keywordError.message);
        keywords = null;
        keywordString = '';
      }
      
      // 检查是否使用了附件存储
      if (keywordString && keywordString.includes('ANNOTATION_DATA:PDF标注查看器:1.0:ATTACHMENT')) {
        console.log('📎 检测到附件标记，尝试从PDF附件读取标注数据...');
        
        try {
          const { PDFName } = window.PDFLib;
          let foundAttachment = false;
          
          // 方法1: 通过Names字典查找附件
          try {
            const catalog = pdfDoc.catalog;
            const namesDict = catalog.get(PDFName.of('Names'));
            
            if (namesDict) {
              const embeddedFilesDict = namesDict.get(PDFName.of('EmbeddedFiles'));
              
              if (embeddedFilesDict) {
                const namesArray = embeddedFilesDict.get(PDFName.of('Names'));
                
                if (namesArray && Array.isArray(namesArray)) {
                  // namesArray 格式: [name1, ref1, name2, ref2, ...]
                  for (let i = 0; i < namesArray.length; i += 2) {
                    const fileName = namesArray[i];
                    const fileRef = namesArray[i + 1];
                    
                    // 检查文件名
                    const fileNameStr = fileName?.toString().replace(/[()]/g, '');
                    if (fileNameStr === 'annotations.json' && fileRef) {
                      console.log('🔍 找到附件引用，正在读取...');
                      
                      // 获取文件规范对象
                      const fileSpecObj = pdfDoc.context.lookup(fileRef);
                      
                      if (fileSpecObj) {
                        const efDict = fileSpecObj.get(PDFName.of('EF'));
                        if (efDict) {
                          const embeddedFileRef = efDict.get(PDFName.of('F'));
                          if (embeddedFileRef) {
                            const embeddedFileStream = pdfDoc.context.lookup(embeddedFileRef);
                            
                            if (embeddedFileStream) {
                              try {
                                // pdf-lib的流对象需要解压缩
                                let attachmentBytes = null;
                                
                                // 优先使用decode方法（解压）
                                if (typeof embeddedFileStream.decode === 'function') {
                                  attachmentBytes = embeddedFileStream.decode();
                                } else if (embeddedFileStream.contents) {
                                  attachmentBytes = embeddedFileStream.contents;
                                } else if (embeddedFileStream.getContents) {
                                  attachmentBytes = embeddedFileStream.getContents();
                                }
                                
                                if (attachmentBytes) {
                                  // 读取附件内容
                                  const decoder = new TextDecoder();
                                  const jsonString = decoder.decode(attachmentBytes);
                                  
                                  // 解析JSON数据
                                  annotationData = JSON.parse(jsonString);
                                  loadMethod = 'attachment';
                                  foundAttachment = true;
                                  console.log(`✅ 成功从PDF附件读取 ${annotationData.annotations?.length || 0} 个标注`);
                                  break;
                                }
                              } catch (parseError) {
                                console.error('❌ 解析附件JSON失败:', parseError);
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          } catch (namesError) {
            console.warn('⚠️ 通过Names字典读取失败:', namesError.message);
          }
          
          // 方法2: 如果方法1失败，遍历所有对象查找附件
          if (!foundAttachment) {
            console.log('🔍 尝试遍历所有对象查找附件...');
            const attachmentRefs = pdfDoc.context.enumerateIndirectObjects();
            
            for (const [ref, obj] of attachmentRefs) {
              try {
                // 检查是否是文件规范（附件）对象
                if (obj && obj.dict) {
                  const typeObj = obj.dict.get(PDFName.of('Type'));
                  if (typeObj?.toString() === '/Filespec') {
                    // 检查文件名
                    const fName = obj.dict.get(PDFName.of('F')) || obj.dict.get(PDFName.of('UF'));
                    const fileName = fName?.toString().replace(/[()]/g, '');
                    
                    if (fileName === 'annotations.json') {
                      console.log('🔍 找到annotations.json附件，正在读取...');
                      
                      const efDict = obj.dict.get(PDFName.of('EF'));
                      console.log('🔍 EF字典:', efDict ? '存在' : '不存在');
                      
                      if (efDict) {
                        const embeddedFileRef = efDict.get(PDFName.of('F'));
                        console.log('🔍 嵌入文件引用:', embeddedFileRef ? '存在' : '不存在');
                        
                        if (embeddedFileRef) {
                          const embeddedFileStream = pdfDoc.context.lookup(embeddedFileRef);
                          console.log('🔍 嵌入文件流:', embeddedFileStream ? '存在' : '不存在');
                          
                            if (embeddedFileStream) {
                              try {
                                // pdf-lib的流对象需要解压缩
                                let attachmentBytes = null;
                                
                                // 检查流的类型和属性
                                const streamType = embeddedFileStream.constructor.name;
                                console.log('🔍 流对象类型:', streamType);
                                console.log('🔍 流对象属性:', Object.keys(embeddedFileStream).join(', '));
                                
                                // 检查是否有Filter（表示数据被压缩）
                                const { PDFName } = window.PDFLib;
                                const filter = embeddedFileStream.dict?.get(PDFName.of('Filter'));
                                const hasFlateFilter = filter?.toString().includes('FlateDecode');
                                console.log('🔍 是否使用FlateDecode压缩:', hasFlateFilter);
                                
                                // 方法1: 尝试使用pdf-lib的解压功能
                                if (hasFlateFilter || streamType.includes('Raw')) {
                                  console.log('🔧 尝试手动解压数据...');
                                  
                                  // 使用pako库解压（pdf-lib内部使用的）
                                  if (window.pako) {
                                    try {
                                      const compressedData = embeddedFileStream.contents;
                                      attachmentBytes = window.pako.inflate(compressedData);
                                      console.log('✅ 使用pako成功解压');
                                    } catch (pakoError) {
                                      console.warn('⚠️ pako解压失败:', pakoError.message);
                                    }
                                  }
                                  
                                  // 如果pako不可用，尝试decode方法
                                  if (!attachmentBytes && typeof embeddedFileStream.decode === 'function') {
                                    try {
                                      attachmentBytes = embeddedFileStream.decode();
                                      console.log('✅ 使用decode方法解压');
                                    } catch (decErr) {
                                      console.warn('⚠️ decode方法失败:', decErr.message);
                                    }
                                  }
                                  
                                  // 如果还是失败，尝试手动使用CompressionStream API
                                  if (!attachmentBytes && embeddedFileStream.contents) {
                                    try {
                                      // 尝试使用浏览器的DecompressionStream API
                                      if (typeof DecompressionStream !== 'undefined') {
                                        const compressedData = embeddedFileStream.contents;
                                        const ds = new DecompressionStream('deflate');
                                        const writer = ds.writable.getWriter();
                                        writer.write(compressedData);
                                        writer.close();
                                        const reader = ds.readable.getReader();
                                        const chunks = [];
                                        let result;
                                        while (!(result = await reader.read()).done) {
                                          chunks.push(result.value);
                                        }
                                        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
                                        attachmentBytes = new Uint8Array(totalLength);
                                        let offset = 0;
                                        for (const chunk of chunks) {
                                          attachmentBytes.set(chunk, offset);
                                          offset += chunk.length;
                                        }
                                        console.log('✅ 使用DecompressionStream解压');
                                      }
                                    } catch (dsErr) {
                                      console.warn('⚠️ DecompressionStream失败:', dsErr.message);
                                    }
                                  }
                                } else {
                                  // 未压缩，直接读取
                                  console.log('✅ 数据未压缩，直接读取');
                                  attachmentBytes = embeddedFileStream.contents;
                                }
                                
                                if (attachmentBytes) {
                                  console.log('📊 解压后数据大小:', attachmentBytes.length, 'bytes');
                                  
                                  // 读取附件内容
                                  const decoder = new TextDecoder();
                                  const jsonString = decoder.decode(attachmentBytes);
                                  console.log('📝 JSON字符串长度:', jsonString.length);
                                  console.log('📝 JSON开头:', jsonString.substring(0, 100));
                                  
                                  // 验证是否是有效的JSON
                                  if (jsonString.startsWith('{') || jsonString.startsWith('[')) {
                                    // 解析JSON数据
                                    annotationData = JSON.parse(jsonString);
                                    loadMethod = 'attachment';
                                    foundAttachment = true;
                                    const loadedCount = annotationData.annotations?.length || 0;
                                    console.log(`✅ 成功从PDF附件读取 ${loadedCount} 个标注`);
                                    break;
                                  } else {
                                    console.error('❌ 数据仍然是压缩格式或损坏');
                                  }
                                } else {
                                  console.warn('⚠️ 无法读取附件内容');
                                }
                              } catch (decodeError) {
                                console.error('❌ 解压或解析附件失败:', decodeError);
                                console.error('错误详情:', decodeError.stack);
                              }
                            }
                        }
                      }
                    }
                  }
                }
              } catch (objError) {
                // 跳过无法处理的对象
                continue;
              }
            }
          }
          
          if (!foundAttachment) {
            console.warn('⚠️ 未找到标注附件，可能保存时出现了问题');
            console.warn('💡 建议：重新保存PDF以修复此问题');
          }
        } catch (attachError) {
          console.error('❌ 从附件读取标注失败:', attachError);
          console.log('尝试从Keywords字段读取...');
        }
      }
      
      // 如果没有从附件读取到数据，尝试从Keywords读取
      if (!annotationData && keywordString && keywordString.includes('ANNOTATION_DATA:')) {
        try {
          // 解析格式：ANNOTATION_DATA:工具名称:版本:JSON数据 或 ANNOTATION_DATA:工具名称:版本:ATTACHMENT
          const annotationMatch = keywordString.match(/ANNOTATION_DATA:([^:]+):([^:]+):(.+)/);
          if (annotationMatch) {
            const [, toolName, toolVersion, jsonData] = annotationMatch;
            if (toolName === 'PDF标注查看器' && jsonData !== 'ATTACHMENT') {
              // 从Keywords字段解析标注数据
              annotationData = JSON.parse(jsonData);
              loadMethod = 'keywords';
              console.log(`✅ 成功从PDF Keywords读取 ${annotationData.annotations?.length || 0} 个标注`);
            }
          }
        } catch (parseError) {
          console.error('❌ 解析Keywords中的标注数据失败:', parseError);
        }
      }
      
      // 处理加载到的标注数据
      if (annotationData && annotationData.version && annotationData.annotations) {
                // 如果检测到图像标注，询问用户如何处理
                if (hasImageAnnotations && annotationData.annotations.length > 0) {
                  const choice = await new Promise((resolve) => {
                    Modal.confirm({
                      title: '检测到重复标注',
                      content: (
                        <div>
                          <p>此PDF包含两种标注：</p>
                          <ul>
                            <li><strong>图像标注</strong>：已嵌入PDF中，其他工具可见但不可编辑</li>
                            <li><strong>元数据标注</strong>：可在本工具中编辑的标注数据</li>
                          </ul>
                          <p>请选择要显示的标注类型：</p>
                        </div>
                      ),
                      okText: '只显示可编辑标注',
                      cancelText: '显示所有标注',
                      onOk: () => resolve('metadata-only'),
                      onCancel: () => resolve('show-all'),
                    });
                  });
                  
                  // 预处理标注数据，确保所有标注都有 isUploaded 属性
                  // ⚠️ 关键修改：从文件加载的标注，一律视为"已上传/旧数据" (isUploaded = true)
                  // 这样可以确保"增量上传"只统计本次会话新添加的标注，符合用户的使用习惯
                  const processedAnnotations = annotationData.annotations.map(ann => ({
                    ...ann,
                    isUploaded: true 
                  }));
                  loadedAnnotationResult = {
                    source: loadMethod === 'attachment' ? 'PDF附件' : 'PDF元数据',
                    annotations: processedAnnotations,
                    updatedAt: annotationData.updatedAt || annotationData.savedAt || annotationData.serverSavedAt || annotationData.timestamp || null
                  };
                  
                  if (choice === 'metadata-only') {
            console.log(`📋 仅加载元数据标注 ${processedAnnotations.length} 个 (来源: ${loadMethod})`);
                    applyLoadedAnnotations(processedAnnotations);
                    message.success(`已加载 ${processedAnnotations.length} 个可编辑标注（已隐藏PDF中的图像标注）`);
                  } else {
                    applyLoadedAnnotations(processedAnnotations);
                    message.info(`已加载 ${processedAnnotations.length} 个可编辑标注（PDF中的图像标注仍然可见）`);
                  }
                } else {
                  // 没有图像标注冲突，直接加载
                  // ⚠️ 关键修改：从文件加载的标注，一律视为"已上传/旧数据" (isUploaded = true)
                  const processedAnnotations = annotationData.annotations.map(ann => ({
                    ...ann,
                    isUploaded: true
                  }));
                  loadedAnnotationResult = {
                    source: loadMethod === 'attachment' ? 'PDF附件' : 'PDF元数据',
                    annotations: processedAnnotations,
                    updatedAt: annotationData.updatedAt || annotationData.savedAt || annotationData.serverSavedAt || annotationData.timestamp || null
                  };
                  applyLoadedAnnotations(processedAnnotations);
          message.success(`成功加载 ${processedAnnotations.length} 个历史标注 (来源: ${loadMethod === 'attachment' ? 'PDF附件' : 'PDF元数据'})`);
        }
      } else if (keywordString && keywordString.includes('ANNOTATION_DATA:')) {
        // 有标记但无法读取数据
        console.log('📄 检测到标注标记但无法读取数据');
              clearLoadedAnnotations();
      } else {
        console.log('📄 PDF中未发现标注数据');
        // 清空现有标注
        clearLoadedAnnotations();
      }
      return loadedAnnotationResult;
    } catch (error) {
      console.error('❌ 读取PDF元数据失败:', error);
      // 不显示错误消息，因为大多数PDF都没有标注数据
      clearLoadedAnnotations();
    }
  }, []);

  // 性能优化：提前声明需要在键盘事件中使用的函数
  const getDraftUpdatedTime = useCallback((draft) => {
    const value = draft?.updatedAt || draft?.savedAt || draft?.serverSavedAt || null;
    const time = value ? new Date(value).getTime() : 0;
    return Number.isFinite(time) ? time : 0;
  }, []);

  const formatDraftTime = useCallback((draft) => {
    const time = getDraftUpdatedTime(draft);
    return time ? new Date(time).toLocaleString() : '未知';
  }, [getDraftUpdatedTime]);

  const restoreAnnotationDraftData = useCallback((draft, sourceLabel = '草稿') => {
    if (!draft || !Array.isArray(draft.annotations)) {
      return;
    }

    setAnnotations(normalizeTextRectangleAnnotations(draft.annotations));
    setBatchSequenceDraftState(draft.batchSequenceState || null);
    setCurrentPage(draft.currentPage || 1);
    setScale(draft.scale || 1);
    annotationDraftDirtyRef.current = true;
    message.success(`已恢复 ${draft.annotations.length} 条${sourceLabel}标注`);
  }, []);

  const maybeRestoreCloudAnnotationDraft = useCallback(async (selectedFileInfo, pdfDraftSummary = null, localDraft = null) => {
    if (isElectron() || !selectedFileInfo?.fingerprint) {
      return false;
    }

    try {
      const projectFileInfo = getCurrentProjectDraftFileInfo(selectedFileInfo);
      const cloudDraft = await loadCloudAnnotationDraft(projectFileInfo.fingerprint);
      if (
        !cloudDraft ||
        !Array.isArray(cloudDraft.annotations) ||
        cloudDraft.annotations.length === 0 ||
        !isSamePdfDraftFile(cloudDraft.fileInfo, selectedFileInfo)
      ) {
        return false;
      }

      const pdfSummary = pdfDraftSummary?.annotations ? {
        updatedAt: pdfDraftSummary.updatedAt,
        annotations: pdfDraftSummary.annotations
      } : null;
      const latestLocalOrPdfTime = Math.max(
        getDraftUpdatedTime(localDraft),
        getDraftUpdatedTime(pdfSummary)
      );
      const cloudTime = getDraftUpdatedTime(cloudDraft);

      if (cloudTime <= latestLocalOrPdfTime) {
        return false;
      }

      return await new Promise((resolve) => {
        Modal.confirm({
          title: '发现更新的云端标注草稿',
          content: (
            <div>
              <p>当前 PDF 在 OCR 后端有一份更新的云端草稿。</p>
              <p>PDF 文件内标注：{pdfSummary?.annotations?.length || 0} 条，{formatDraftTime(pdfSummary)}</p>
              <p>本机草稿：{localDraft?.annotations?.length || 0} 条，{formatDraftTime(localDraft)}</p>
              <p>云端草稿：{cloudDraft.annotations.length} 条，{formatDraftTime(cloudDraft)}</p>
              <p>推荐恢复云端草稿。</p>
            </div>
          ),
          okText: '恢复云端草稿',
          cancelText: '保留当前标注',
          onOk: () => {
            restoreAnnotationDraftData(cloudDraft, '云端草稿');
            resolve(true);
          },
          onCancel: () => resolve(false),
        });
      });
    } catch (error) {
      console.warn('查询云端标注草稿失败:', error);
      if (error?.status === 404) {
        cloudAnnotationDraftUnsupportedRef.current = true;
      }
      setCloudAnnotationDraftStatus('error');
      return false;
    }
  }, [formatDraftTime, getDraftUpdatedTime, restoreAnnotationDraftData, getCurrentProjectDraftFileInfo]);

  const handleFileSelect = useCallback(async (file, options = {}) => {
    // 性能监控：记录开始时间
    const startTime = Date.now();

    // 撤销命令的闭包可能持有上一份 PDF 的完整标注数组。切换文档时
    // 立即释放旧历史，避免连续处理多个大项目后仍保留旧文档对象。
    undoRedoSystem.clearHistory();

    // 更新PDF状态
    const fileName = file instanceof File ? file.name.replace(/\.pdf$/i, '') : '';
    // Inspect recovery data before resetting runtime state; opening a PDF is
    // not consent to discard an interrupted browser download's checkpoint.
    const openingDraft = !isElectron() && !options.preserveDraft
      ? await loadLatestAnnotationDraft()
      : options.localDraft || null;
    resetAnnotationDraftState();

    setPdfFile(file);
    setPdfFileName(fileName);
    
    // 立即读取文件内容为ArrayBuffer，避免后续权限问题
    // ⚠️ 重要：这会替换旧的pdfArrayBuffer缓存，确保使用最新的PDF内容
    try {
      let arrayBuffer;
      if (file instanceof File) {
        if (file.size <= MAX_RESIDENT_PDF_BUFFER_BYTES) {
          arrayBuffer = await file.arrayBuffer();
          console.log('✅ 已读取PDF文件内容到内存，大小:', (arrayBuffer.byteLength / 1024 / 1024).toFixed(2), 'MB');
        } else {
          // React-PDF already owns the data needed for viewing. Keeping a
          // second complete ArrayBuffer for a large file can consume hundreds
          // of MB (and much more after parsing) for the lifetime of the tab.
          console.log('♻️ 大PDF不保留第二份常驻ArrayBuffer，导出时按需读取:', {
            name: file.name,
            sizeMB: (file.size / 1024 / 1024).toFixed(2)
          });
        }
      } else if (typeof file === 'string') {
        // 如果是URL，需要fetch获取
        const response = await fetch(file);
        arrayBuffer = await response.arrayBuffer();
        console.log('✅ 已从URL读取PDF内容到内存');
      }
      if (arrayBuffer) {
        await warnIfPdfEncrypted(arrayBuffer, fileName || (file instanceof File ? file.name : 'PDF文件'));
      }
      setPdfArrayBuffer(arrayBuffer || null);
      window.__luotuPdfResidentBufferInfo = {
        fileBytes: Number(file?.size || arrayBuffer?.byteLength || 0),
        retainedArrayBufferBytes: Number(arrayBuffer?.byteLength || 0),
        largeFileOnDemand: Boolean(file instanceof File && file.size > MAX_RESIDENT_PDF_BUFFER_BYTES),
        recordedAt: Date.now()
      };
      if (!isElectron()) {
        currentPdfDraftInfoRef.current = await buildPdfDraftFileInfo(file, arrayBuffer || null);
      }
    } catch (error) {
      console.error('❌ 读取PDF文件内容失败:', error);
      setPdfArrayBuffer(null);
      if (!isElectron()) {
        currentPdfDraftInfoRef.current = await buildPdfDraftFileInfo(file);
      }
    }
    
    // 保存文件路径（如果存在）
    if (file && file.path) {
      setPdfFilePath(file.path);
      // 保存到全局变量，供OCR功能使用
      window.__lastOpenedPdfPath__ = file.path;
      console.log('✅ 已保存PDF路径到全局变量:', file.path);
      // 保存路径到主进程配置，以便下次启动时自动加载
      if (window.electronAPI && typeof window.electronAPI.setCurrentPdfPath === 'function') {
        try {
          await window.electronAPI.setCurrentPdfPath(file.path);
          console.log('✅ 已保存PDF路径到配置:', file.path);
        } catch (error) {
          console.warn('⚠️ 保存PDF路径失败:', error);
        }
      }
    } else {
      setPdfFilePath(null);
      window.__lastOpenedPdfPath__ = null;
    }
    
    // 🌐 Web端：保存PDF文件对象到全局变量，供OCR功能使用
    if (file instanceof File || file instanceof Blob) {
      window.__lastOpenedPdfFile__ = file;
      window.__currentPdfFile__ = file;  // 供矢量提取使用
      console.log('✅ [Web] 已保存PDF文件对象到全局变量:', file.name || 'blob');
    } else {
      window.__lastOpenedPdfFile__ = null;
      window.__currentPdfFile__ = null;
    }
    setCurrentPage(1);

    // 重置搜索状态
    setSearchText('');
    setSearchResults([]);
    setCurrentSearchIndex(-1);

    // 重置所有页面的识别状态
    setPageRecognitionData({});

    // 尝试从PDF元数据中加载标注信息
    const pdfAnnotationResult = await loadAnnotationsFromPDFMetadata(file);
    if (!options.skipCloudDraftPrompt && currentPdfDraftInfoRef.current) {
      const matchingLocalDraft = isSamePdfDraftFile(openingDraft?.fileInfo, currentPdfDraftInfoRef.current)
        ? openingDraft : null;
      const restoredCloud = await maybeRestoreCloudAnnotationDraft(currentPdfDraftInfoRef.current, pdfAnnotationResult, matchingLocalDraft);
      if (!restoredCloud && matchingLocalDraft && getDraftUpdatedTime(matchingLocalDraft) > getDraftUpdatedTime(pdfAnnotationResult)) {
        await new Promise(resolve => Modal.confirm({
          title: '发现可恢复的本机标注草稿',
          content: `找到 ${matchingLocalDraft.annotations.length} 条标注。下载可能未完成，是否恢复这份草稿？`,
          okText: '恢复本机草稿',
          cancelText: '保留 PDF 标注',
          onOk: () => { restoreAnnotationDraftData(matchingLocalDraft, '本机草稿'); resolve(); },
          onCancel: () => resolve(),
        }));
      }
    }

    // 性能监控：记录加载时间
    const loadTime = Date.now() - startTime;
    if (loadTime > 1000) {
      console.warn(`⚠️ PDF加载耗时较长: ${loadTime}ms`);
    }

    // 更新性能引用
    performanceRef.current.lastUpdateTime = Date.now();
  }, [getDraftUpdatedTime, restoreAnnotationDraftData, loadAnnotationsFromPDFMetadata, maybeRestoreCloudAnnotationDraft, performanceRef, resetAnnotationDraftState, undoRedoSystem, warnIfPdfEncrypted]);

  const requestH3yunProxy = useCallback(async (requestData) => {
    if (window.electronAPI && window.electronAPI.tritiumUpload) {
      return await window.electronAPI.tritiumUpload(requestData);
    }

    const response = await fetch('/api/proxy/h3yun', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestData)
    });
    const contentType = response.headers.get('content-type') || '';
    const result = contentType.includes('application/json')
      ? await response.json()
      : { success: false, error: await response.text() };
    if (!response.ok || result.success === false) {
      throw new Error(result.error || result.message || `氚云请求失败: ${response.status}`);
    }
    return result;
  }, []);

  const getSelectedH3Project = useCallback(() => {
    return h3ProjectOptions.find(project => project.value === selectedH3ProjectValue) || null;
  }, [h3ProjectOptions, selectedH3ProjectValue]);

  const loadH3ProjectOptions = useCallback(async () => {
    setH3ProjectsLoading(true);
    try {
      const result = await requestH3yunProxy({
        url: 'https://www.h3yun.com/OpenApi/Invoke',
        body: {
          ActionName: 'LoadBizObjects',
          SchemaCode: 'D000886XMXX01',
          Filter: JSON.stringify({
            FromRowNum: 0,
            RequireCount: false,
            ReturnItems: [],
            SortByCollection: [],
            ToRowNum: 500,
            Matcher: { Type: 'And', Matchers: [] }
          })
        }
      });
      const rows = result?.data?.ReturnData?.BizObjectArray
        || result?.ReturnData?.BizObjectArray
        || result?.BizObjectArray
        || [];
      const options = rows
        .map((row, index) => {
          const name = String(row.F0000032 || '').trim();
          const status = String(row.F0000039 || '').trim();
          if (!name || status === '已结束') return null;
          return {
            label: name,
            value: row.ObjectId || row.BizObjectId || `${name}-${index}`,
            name,
            status,
            raw: row
          };
        })
        .filter(Boolean);
      setH3ProjectOptions(options);
      if (selectedH3ProjectValue && !options.some(project => project.value === selectedH3ProjectValue)) {
        setSelectedH3ProjectValue('');
      }
    } catch (error) {
      console.error('加载氚云项目基础库失败:', error);
      message.warning(`加载氚云项目失败: ${error.message}`);
    } finally {
      setH3ProjectsLoading(false);
    }
  }, [requestH3yunProxy, selectedH3ProjectValue]);

  const requestH3ProjectSelection = useCallback(async () => {
    const selectedProject = getSelectedH3Project();
    if (selectedProject) {
      return selectedProject;
    }
    setH3ProjectSelectorVisible(true);
    if (h3ProjectOptions.length === 0 && !h3ProjectsLoading) {
      loadH3ProjectOptions();
    }
    return new Promise(resolve => {
      h3ProjectSelectResolverRef.current = resolve;
    });
  }, [getSelectedH3Project, h3ProjectOptions.length, h3ProjectsLoading, loadH3ProjectOptions]);

  const handleConfirmH3ProjectSelection = useCallback(() => {
    const selectedProject = getSelectedH3Project();
    const manualName = manualH3ProjectName.trim();
    const project = selectedProject || (manualName ? {
      label: manualName,
      value: `manual:${manualName}`,
      name: manualName,
      status: '手动输入',
      manual: true
    } : null);
    if (!project) {
      message.warning('请先选择或输入氚云项目');
      return;
    }
    selectedH3ProjectRef.current = project;
    window.__selectedH3Project__ = project;
    auditLogService.log('project_select', {
      projectId: project.value || '',
      projectName: project.name || project.label || '',
      projectManual: Boolean(project.manual),
      count: 1
    });
    setH3ProjectSelectorVisible(false);
    h3ProjectSelectResolverRef.current?.(project);
    h3ProjectSelectResolverRef.current = null;
  }, [getSelectedH3Project, manualH3ProjectName]);

  const handleCancelH3ProjectSelection = useCallback(() => {
    setH3ProjectSelectorVisible(false);
    h3ProjectSelectResolverRef.current?.(null);
    h3ProjectSelectResolverRef.current = null;
  }, []);

  const handleOpenPDFClick = useCallback(async () => {
    try {
      console.log('📂 打开PDF文件对话框...');
      console.log('🌐 运行环境:', isElectron() ? 'Electron' : 'Web');
      
      // 使用文件适配器（自动适配 Electron 和 Web 环境）
      const result = await fileAdapter.openPDF();

      const project = await requestH3ProjectSelection();
      if (!project) {
        return;
      }
      
      console.log('✅ 文件选择成功:', result.fileName);
      
      // 处理选中的文件（先等待完成，再补充 Electron 特有的路径/字节设置）
      if (!isElectron() && result.canWriteBack === false && result.fallbackReason) {
        message.warning(`${result.fallbackReason}，保存时会下载新 PDF。`);
      }
      await handleFileSelect(result.file);

      // Electron 环境：fileAdapter.openPDF 通过 openFile API 返回了真实路径和字节数据
      // handleFileSelect 只接收 file 参数，对字符串路径无法提取 filePath，
      // 且字符串 fetch 在 Electron 中通常会失败导致 pdfArrayBuffer 被置 null。
      // 在 handleFileSelect 完成后覆盖，确保 pdfFilePath 和 pdfArrayBuffer 正确。
      if (isElectron() && result.filePath && !result.filePath.startsWith('blob:')) {
        setPdfFilePath(result.filePath);
        window.__lastOpenedPdfPath__ = result.filePath;
        console.log('✅ 已从 openFile 结果设置 pdfFilePath:', result.filePath);
        if (result.arrayBuffer) {
          // IPC 传来的 buffer 是 Uint8Array，需转为独立 ArrayBuffer
          const uint8 = new Uint8Array(result.arrayBuffer);
          const ab = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
          setPdfArrayBuffer(ab);
          console.log('✅ 已从 openFile 结果设置 pdfArrayBuffer');
        }
      }
      
    } catch (error) {
      // 用户取消选择不显示错误
      if (error.message.includes('取消')) {
        console.log('ℹ️ 用户取消选择文件');
      } else {
        console.error('❌ 打开文件失败:', error);
        message.error('打开文件失败: ' + error.message);
      }
    }
  }, [handleFileSelect, requestH3ProjectSelection]);

  const handleRestoreAnnotationDraft = useCallback(async (draft) => {
    if (!draft) {
      return;
    }

    try {
      if (draft.project?.projectName || draft.fileInfo?.projectName) {
        const restoredProject = {
          name: draft.project?.projectName || draft.fileInfo?.projectName,
          label: draft.project?.projectName || draft.fileInfo?.projectName,
          value: draft.project?.projectId || draft.fileInfo?.projectId || `restored:${draft.project?.projectName || draft.fileInfo?.projectName}`,
          manual: Boolean(draft.project?.projectManual)
        };
        selectedH3ProjectRef.current = restoredProject;
        window.__selectedH3Project__ = restoredProject;
      }
      const result = await fileAdapter.openPDF();
      const selectedFileInfo = await buildPdfDraftFileInfo(result.file, result.arrayBuffer);

      if (!isSamePdfDraftFile(draft.fileInfo, selectedFileInfo)) {
        message.error('选择的 PDF 与草稿记录不匹配，请选择原来的 PDF 文件');
        return;
      }

      await handleFileSelect(result.file, { preserveDraft: true, skipCloudDraftPrompt: true });
      currentPdfDraftInfoRef.current = selectedFileInfo;
      const restoredCloudDraft = await maybeRestoreCloudAnnotationDraft(selectedFileInfo, null, draft);
      if (!restoredCloudDraft) {
        restoreAnnotationDraftData(draft, '本机草稿');
      }
      message.success(`已恢复 ${draft.annotations?.length || 0} 条未保存标注草稿`);
    } catch (error) {
      if (error?.message?.includes('取消')) {
        return;
      }
      console.error('恢复标注草稿失败:', error);
      message.error(`恢复标注草稿失败: ${error.message}`);
    }
  }, [handleFileSelect, maybeRestoreCloudAnnotationDraft, restoreAnnotationDraftData]);

  useEffect(() => {
    if (isElectron() || startupDraftPromptShownRef.current) {
      return;
    }

    startupDraftPromptShownRef.current = true;
    let active = true;

    loadLatestAnnotationDraft().then((draft) => {
      if (!active || !draft) {
        return;
      }

      latestAnnotationDraftRef.current = draft;
      Modal.confirm({
        title: '发现未保存的标注草稿',
        content: (
          <div>
            <p>上次可能未正常保存，已找到最近一个 PDF 的标注草稿。</p>
            <p>
              文件：{draft.fileInfo?.name || draft.fileName || '未知 PDF'}，
              标注：{draft.annotations?.length || 0} 条
            </p>
            <p>请选择原 PDF 文件后恢复标注，或丢弃这份草稿。</p>
          </div>
        ),
        okText: '选择原 PDF 并恢复',
        cancelText: '丢弃草稿',
        onOk: () => handleRestoreAnnotationDraft(draft),
        onCancel: () => discardLatestAnnotationDraft(),
      });
    });

    return () => {
      active = false;
    };
  }, [discardLatestAnnotationDraft, handleRestoreAnnotationDraft]);

  const clearDragHintTimer = useCallback(() => {
    if (dragStateRef.current.timer) {
      clearTimeout(dragStateRef.current.timer);
      dragStateRef.current.timer = null;
    }
  }, []);

  const resetDragState = useCallback((resetMute = true) => {
    clearDragHintTimer();
    dragStateRef.current.active = false;
    setDragHintMode(null);

    if (resetMute) {
      dragStateRef.current.muted = false;
    }
  }, [clearDragHintTimer]);

  const isFileDragEvent = useCallback((event) => {
    const types = event?.dataTransfer?.types;
    return Array.from(types || []).includes('Files');
  }, []);

  const startDragHint = useCallback((mode) => {
    const isReplaceMode = mode === 'replace';

    dragStateRef.current.active = true;

    if (isReplaceMode && dragStateRef.current.muted) {
      setDragHintMode(null);
      return;
    }

    setDragHintMode(mode);
    clearDragHintTimer();

    if (isReplaceMode) {
      dragStateRef.current.timer = setTimeout(() => {
        dragStateRef.current.timer = null;
        dragStateRef.current.muted = true;
        setDragHintMode(null);
      }, DRAG_REPLACE_HINT_TIMEOUT);
    }
  }, [clearDragHintTimer]);

  useEffect(() => {
    return () => {
      clearDragHintTimer();
    };
  }, [clearDragHintTimer]);

  // 拖拽打开PDF功能
  const handleDragOver = useCallback((e) => {
    if (!isFileDragEvent(e)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    // 设置拖拽效果为复制
    e.dataTransfer.dropEffect = 'copy';
  }, [isFileDragEvent]);

  const handleDrop = useCallback(async (e) => {
    if (!isFileDragEvent(e)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    resetDragState();

    try {
      // 拖拽文件必须在 drop 事件同步上下文中优先读取；弹窗等待后 DataTransfer 会失效。
      const result = await fileAdapter.handleFileDrop(e);
      const project = await requestH3ProjectSelection();
      if (!project) {
        return;
      }

      console.log('📁 拖拽打开PDF文件:', result.fileName);
      console.log('📍 文件路径:', result.filePath);
      console.log('🌐 运行环境:', isElectron() ? 'Electron' : 'Web');

      // 处理文件
      await handleFileSelect(result.file);

      // Web 环境提示
      if (!isElectron()) {
        console.log('💡 Web环境：文件将在浏览器中处理，不会保存到本地');
      }
    } catch (error) {
      console.error('❌ 拖拽文件处理失败:', error);
      message.error(error.message || '拖拽文件处理失败');
    }
  }, [handleFileSelect, isFileDragEvent, requestH3ProjectSelection, resetDragState]);

  const handleDragEnter = useCallback((e) => {
    if (!isFileDragEvent(e)) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (dragStateRef.current.active) {
      return;
    }

    startDragHint(pdfFile ? 'replace' : 'welcome');
  }, [isFileDragEvent, pdfFile, startDragHint]);

  const handleDragLeave = useCallback((e) => {
    if (!dragStateRef.current.active) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const leftWindow =
      e.clientX <= 0 ||
      e.clientY <= 0 ||
      e.clientX >= window.innerWidth ||
      e.clientY >= window.innerHeight;

    if (leftWindow) {
      resetDragState();
    }
  }, [resetDragState]);





  const handlePageChange = (page) => {
    setCurrentPage(page);
    
    // 🎯 立即刷新待处理的批量更新（如果有的话）
    // 这样用户翻到某页时，如果该页刚识别完成，可以立即看到结果
    if (batchUpdateTimerRef.current) {
      clearTimeout(batchUpdateTimerRef.current);
      batchUpdateTimerRef.current = null;
      flushBatchUpdates();
    }
    
    // currentPage itself already refreshes every page-scoped consumer. An
    // additional cache version bump rebuilt the whole application tree during
    // every turn and competed with PDF.js while it was drawing the new Canvas.
    // Recognition updates still advance cacheUpdateTrigger at their source.
    
    // 输出当前页的识别状态（调试用）
    if (process.env.NODE_ENV === 'development') {
      const pageData = pageCache.getPage(page);
      console.log(`📖 翻页到第${page}页, 识别状态: ${pageData.status}, 有数据: ${!!pageData.data}`);
    }
  };

  const handleScaleChange = (newScale) => {
    setScale(newScale);
  };

  const handleCanvasPerformanceModeChange = useCallback((mode) => {
    const normalizedMode = normalizeCanvasPerformanceMode(mode);
    setCanvasPerformanceMode(normalizedMode);
    try {
      localStorage.setItem(CANVAS_PERFORMANCE_STORAGE_KEY, normalizedMode);
    } catch (error) {
      console.warn('保存Canvas性能档位失败:', error);
    }
    message.success('Canvas性能档位已更新');
  }, []);

  const handleSearch = (text, results) => {
    setSearchText(text);
    setSearchResults(results);
    setCurrentSearchIndex(results.length > 0 ? 0 : -1);
  };

  const handleSearchNext = () => {
    if (searchResults.length > 0) {
      const nextIndex = (currentSearchIndex + 1) % searchResults.length;
      setCurrentSearchIndex(nextIndex);
      setCurrentPage(searchResults[nextIndex].page);
    }
  };

  const handleSearchPrev = () => {
    if (searchResults.length > 0) {
      const prevIndex = currentSearchIndex > 0 ? currentSearchIndex - 1 : searchResults.length - 1;
      setCurrentSearchIndex(prevIndex);
      setCurrentPage(searchResults[prevIndex].page);
    }
  };

  // 标注功能处理函数
  const handleToggleAnnotationMode = () => {
    // 互斥逻辑：进入标注模式时，关闭其他模式
    if (!annotationMode) {
      setPipeSegmentMode(false);
      setAreaDeleteMode(false);
    }
    setAnnotationMode(!annotationMode);
  };

  const [areaDeleteMode, setAreaDeleteMode] = useState(false);
  const [areaDeleteType, setAreaDeleteType] = useState('all'); // 'all' | 'text-only'
  
  // 氚云上传弹窗状态
  const [h3yunUploadVisible, setH3yunUploadVisible] = useState(false);
  const [editableMergeVisible, setEditableMergeVisible] = useState(false);
  const [editableMergeFiles, setEditableMergeFiles] = useState([]);
  const [editableMergeLoading, setEditableMergeLoading] = useState(false);
  const [editableSplitVisible, setEditableSplitVisible] = useState(false);
  const [editableSplitFile, setEditableSplitFile] = useState(null);
  const [editableSplitMode, setEditableSplitMode] = useState('ranges');
  const [editableSplitRanges, setEditableSplitRanges] = useState('');
  const [editableSplitLoading, setEditableSplitLoading] = useState(false);

  // 处理氚云上传
  const handleH3yunUpload = useCallback(() => {
    setH3yunUploadVisible(true);
  }, []);

  const handleToggleAreaDeleteMode = (type = null) => {
    // 如果没有指定类型，使用当前类型或默认为 'all'
    const targetType = type || areaDeleteType || 'all';
    
    // 如果已经处于该模式且类型相同，则关闭
    if (areaDeleteMode && areaDeleteType === targetType) {
      setAreaDeleteMode(false);
      return;
    }
    
    // 互斥逻辑：进入区域删除模式时，关闭标注模式
    if (!areaDeleteMode) {
      setAnnotationMode(false);
      setPipeSegmentMode(false);
    }
    
    setAreaDeleteMode(true);
    setAreaDeleteType(targetType);
  };

  // 批量删除标注的回调
  const handleBatchDeleteAnnotations = useCallback((annotationIds) => {
    if (!annotationIds || annotationIds.length === 0) return;
    
    // 计算批量生成的标注数量
    const batchGeneratedCount = annotations.filter(ann => 
      annotationIds.includes(ann.id) && ann.isBatchGenerated
    ).length;
    
    // 保存当前状态用于撤销
    const currentAnnotations = [...annotations];
    
    // 创建撤销命令
    const command = createAnnotationCommand(
      `区域删除标注: ${annotationIds.length}个`,
      () => {
        setAnnotations(prev => prev.filter(a => !annotationIds.includes(a.id)));
        
        // 更新统计数据 - 只统计批量生成的标注被删除
        if (batchGeneratedCount > 0) {
          setWeldStats(prev => ({
            ...prev,
            deleted: prev.deleted + batchGeneratedCount
          }));
        }
      },
      () => {
        // 恢复：这里需要知道被删除的标注的完整信息
        // 简单起见，我们恢复整个 annotations 数组，或者只恢复被删除的部分
        // 由于 createAnnotationCommand 的 undo 逻辑通常是反向操作
        // 如果我们只存储了 IDs，我们在 undo 时无法恢复数据
        // 所以我们需要在 execute 之前捕获被删除的数据
        
        // 修正：在 execute 中并没有传递 deletedAnnotations，所以这里的 undo 逻辑有问题
        // 正确的做法应该是把 deletedAnnotations 传进来
        
        // 由于时间关系，简单的 undo 逻辑：
        // 如果是复杂的区域删除，建议将整个 annotations 状态快照保存
        // 或者在 command 创建时就计算好 deletedAnnotations
        
        // 这里使用全量恢复（性能略差但安全）
        setAnnotations(currentAnnotations);
        
        // 撤销统计
        if (batchGeneratedCount > 0) {
          setWeldStats(prev => ({
            ...prev,
            deleted: prev.deleted - batchGeneratedCount
          }));
        }
      }
    );
    
    undoRedoSystem.executeCommand(command);
  }, [annotations, createAnnotationCommand, undoRedoSystem]);

  const handleAnnotationAdd = useCallback((annotation) => {
    // 更新统计数据 - 只统计在标注模式下手动添加的
    if (annotationMode) {
      setWeldStats(prev => ({
        ...prev,
        manuallyAdded: prev.manuallyAdded + 1
      }));
    }
    
    const latestAutoBatchAnnotation = latestAutoBatchAnnotationRef.current;
    const newAnnotation = normalizeTextRectangleAnnotation({
      ...annotation,
      // 如果标注已经有ID，保持原ID；否则生成新ID
      id: annotation.id || `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: annotation.timestamp || new Date().toISOString(),
      type: 'text', // 固定为文字标注
      color: annotationColor,
      frameSize: annotation.borderShape === 'text-rectangle'
        ? DEFAULT_TEXT_RECTANGLE_FRAME_SIZE
        : (annotation.frameSize ?? (annotationFrameSize || 56.7)),
      isUploaded: false, // 新添加的标注默认未上传
      origin: 'manual',
      batchRunId: annotation.batchRunId || latestAutoBatchAnnotation?.batchRunId || null,
      qualityCorrection: !!(annotation.batchRunId || latestAutoBatchAnnotation?.batchRunId),
      qualityModified: false,
      isBatchGenerated: false // 标记为非批量生成
    });
    
    // 使用新的撤销重做系统，添加防自动更新逻辑
    const addCommand = {
      description: `添加标注: ${newAnnotation.text || '无文字'}`,
      execute: () => {
        // Track the dirty page in the same committed state update. Updating
        // the checkpoint ref before React applied this annotation let a fast
        // next-page action save the previous page snapshot and then clear the
        // new page's dirty flag.
        setAnnotations(prev => {
          markAnnotationDraftDirty(newAnnotation.page);
          if (Number(newAnnotation.page) > 0) {
            annotationCheckpointPagesRef.current.add(Number(newAnnotation.page));
          }
          return [...prev, newAnnotation];
        });
        setNewlyAddedAnnotations(prev => {
          const next = new Set(prev);
          next.add(newAnnotation.id);
          return next;
        });
        // 3秒后从新添加列表中移除，允许后续手动编辑产生撤销记录
        setTimeout(() => {
          setNewlyAddedAnnotations(prev => {
            const newSet = new Set(prev);
            newSet.delete(newAnnotation.id);
            return newSet;
          });
        }, 3000); // 增加到3秒
      },
      undo: () => {
        setAnnotations(prev => {
          markAnnotationDraftDirty(newAnnotation.page);
          return prev.filter(ann => ann.id !== newAnnotation.id);
        });
        
        // 也要从新添加列表中移除
        setNewlyAddedAnnotations(prev => {
          const newSet = new Set(prev);
          newSet.delete(newAnnotation.id);
          return newSet;
        });
      }
    };
    undoRedoSystem.executeCommand(addCommand);
    logAuditEvent('weld_add_manual', {
      count: 1,
      page: newAnnotation.page || currentPage,
      weldText: newAnnotation.text || '',
      manualPages: 1,
      batchRunIds: [newAnnotation.batchRunId].filter(Boolean)
    });
  }, [annotationColor, annotationFrameSize, undoRedoSystem, annotationMode, logAuditEvent, currentPage, markAnnotationDraftDirty]);

  const applyCommittedAnnotationMoves = useCallback(patches => {
    const pages = getAnnotationMovePages(patches, annotationPageIndexRef.current?.byId);
    if (pages.length) markAnnotationDraftDirty(pages);
    setAnnotations(current => applyAnnotationMovePatches(current, patches));
  }, [markAnnotationDraftDirty]);

  const handleAnnotationMoveCommit = useCallback(moves => {
    const { before, after, changedAnnotations } = buildAnnotationMoveTransaction(
      annotationsRef.current, moves, annotation => getAnnotationOrigin(annotation) === 'auto',
      annotationPageIndexRef.current?.byId
    );
    if (!after.size) return;
    undoRedoSystem.executeCommand({
      description: `移动标注 (${after.size}个)`,
      execute: () => applyCommittedAnnotationMoves(after),
      undo: () => applyCommittedAnnotationMoves(before),
    });
    logAuditEvent('weld_edit', {
      count: after.size,
      pages: Array.from(new Set(changedAnnotations.map(annotation => annotation.page).filter(Boolean))),
      editCategory: 'layout',
      changedFields: ['startX', 'startY', 'endX', 'endY'],
      originCounts: buildOriginCounts(changedAnnotations),
    });
  }, [undoRedoSystem.executeCommand, applyCommittedAnnotationMoves, logAuditEvent]);

  const handleAnnotationUpdate = useCallback((annotationId, updates) => {
    markAnnotationDraftDirty();
    // 检查更新类型
    const updateKeys = Object.keys(updates);
    const isMaterialNumberOnlyUpdate = updateKeys.length === 1 && updates.hasOwnProperty('materialNumber');
    
    // 判断是否为纯位置更新（只包含位置字段，不包含其他业务字段）
    const positionKeys = ['startX', 'startY', 'endX', 'endY', 'hasLeaderLine'];
    const hasPositionFields = positionKeys.some(key => updates.hasOwnProperty(key));
    const nonPositionKeys = updateKeys.filter(key => !positionKeys.includes(key));
    const isPositionOnlyUpdate = hasPositionFields && nonPositionKeys.length === 0;
    const scheduleMoveUndoCommand = () => {
      if (moveUndoRef.current.timer) {
        clearTimeout(moveUndoRef.current.timer);
      }

      moveUndoRef.current.timer = setTimeout(() => {
        const initialMap = moveUndoRef.current.initial;
        moveUndoRef.current = { initial: new Map(), timer: null };

        if (!initialMap.size) return;

        const currentById = new Map(annotationsRef.current.map(ann => [ann.id, ann]));
        const before = [];
        const after = [];

        initialMap.forEach((oldAnnotation, id) => {
          const currentAnnotation = currentById.get(id);
          if (!currentAnnotation) return;

          const moved = ['startX', 'startY', 'endX', 'endY', 'hasLeaderLine'].some(
            key => oldAnnotation[key] !== currentAnnotation[key]
          );

          if (moved) {
            before.push(oldAnnotation);
            after.push({ ...currentAnnotation });
          }
        });

        if (!before.length) return;

        logAuditEvent('weld_edit', {
          count: after.length,
          pages: Array.from(new Set(after.map(item => item.page || currentPage).filter(Boolean))),
          editCategory: 'layout',
          changedFields: ['startX', 'startY', 'endX', 'endY', 'hasLeaderLine'],
          originCounts: buildOriginCounts(before)
        });

        const applySnapshots = (snapshots) => {
          const snapshotById = new Map(snapshots.map(item => [item.id, item]));
          setAnnotations(prev => prev.map(ann => (
            snapshotById.has(ann.id) ? { ...ann, ...snapshotById.get(ann.id) } : ann
          )));
        };

        undoRedoSystem.executeCommand({
          description: `移动标注 (${before.length}个)`,
          execute: () => applySnapshots(after),
          undo: () => applySnapshots(before)
        });
      }, 250);
    };
    
    const isNewlyAdded = newlyAddedAnnotations.has(annotationId);
    
    console.log(`🔍 更新类型检查 ${annotationId}:`);
    console.log(`  - 是否为仅材料编号更新: ${isMaterialNumberOnlyUpdate}`);
    console.log(`  - 是否为纯位置更新: ${isPositionOnlyUpdate}`);
    console.log(`  - 包含位置字段: ${hasPositionFields}`);
    console.log(`  - 非位置字段: ${nonPositionKeys.join(', ')}`);
    console.log(`  - 是否为新添加标注: ${isNewlyAdded}`);
    console.log(`  - 更新的字段:`, updateKeys);
    console.log(`  - 更新内容:`, updates);
    
    // 如果只是材料编号更新（没有其他字段），直接应用，不创建撤销记录
    if (isMaterialNumberOnlyUpdate) {
      console.log(`🔄 跳过材料编号自动更新: ${annotationId}`);
      setAnnotations(prev => {
        const newArray = [...prev];
        const index = prev.findIndex(ann => ann.id === annotationId);
        if (index !== -1) {
          newArray[index] = { ...prev[index], ...updates };
        }
        return newArray;
      });
      return;
    }
    
    // 如果是纯位置更新（只有位置字段，拖拽移动），直接应用，不创建撤销记录
    if (isPositionOnlyUpdate) {
      console.log(`🔄 跳过纯位置更新（拖拽移动）: ${annotationId}`);
      setAnnotations(prev => {
        const newArray = [...prev];
        const index = prev.findIndex(ann => ann.id === annotationId);
        if (index !== -1) {
          if (!moveUndoRef.current.initial.has(annotationId)) {
            moveUndoRef.current.initial.set(annotationId, { ...prev[index] });
          }
          console.log(`  - 更新前位置:`, {
            startX: prev[index]?.startX,
            endX: prev[index]?.endX
          });
          newArray[index] = {
            ...prev[index],
            ...updates,
            ...(getAnnotationOrigin(prev[index]) === 'auto' ? { qualityModified: true } : {})
          };
          console.log(`  - 更新后位置:`, {
            startX: newArray[index]?.startX,
            endX: newArray[index]?.endX
          });
        }
        return newArray;
      });
      scheduleMoveUndoCommand();
      return;
    }
    
    // 如果是新添加标注的自动更新（但不包括用户主动编辑）
    // 用户主动编辑会包含 text、color 等业务字段，应该创建撤销记录
    if (isNewlyAdded && nonPositionKeys.length === 0) {
      console.log(`🔄 跳过新添加标注的自动位置更新: ${annotationId}`);
      setAnnotations(prev => {
        const newArray = [...prev];
        const index = prev.findIndex(ann => ann.id === annotationId);
        if (index !== -1) {
          newArray[index] = { ...prev[index], ...updates };
        }
        return newArray;
      });
      return;
    }
    
    // 防抖处理：清除之前的定时器
    const existingTimeout = updateTimeouts.get(annotationId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }
    
    // 使用函数式更新立即执行UI更新，并捕获旧的和新的状态
    let capturedOldAnnotation = null;
    let capturedNewAnnotation = null;
    
    setAnnotations(prev => {
      const newArray = [...prev];
      const index = prev.findIndex(ann => ann.id === annotationId);
      if (index !== -1) {
        capturedOldAnnotation = { ...prev[index] };
        capturedNewAnnotation = {
          ...prev[index],
          ...updates,
          ...(getAnnotationOrigin(prev[index]) === 'auto' ? { qualityModified: true } : {})
        };
        newArray[index] = capturedNewAnnotation;
        
        console.log(`📸 捕获状态快照:`);
        console.log(`  - 旧状态位置:`, {
          startX: capturedOldAnnotation.startX,
          endX: capturedOldAnnotation.endX
        });
        console.log(`  - 新状态位置:`, {
          startX: capturedNewAnnotation.startX,
          endX: capturedNewAnnotation.endX
        });
      }
      return newArray;
    });
    
    // 如果没有找到标注，直接返回
    if (!capturedOldAnnotation || !capturedNewAnnotation) {
      console.error(`❌ 找不到要更新的标注: ${annotationId}`);
      return;
    }
    
    // 设置新的防抖定时器，用于创建撤销记录
    const timeoutId = setTimeout(() => {
      // 只有非位置更新且非纯材料编号更新且是批量生成的标注才计入修改统计
      if (!isPositionOnlyUpdate && !isMaterialNumberOnlyUpdate && capturedOldAnnotation.isBatchGenerated) {
        setWeldStats(prev => ({
          ...prev,
          modified: prev.modified + 1
        }));
      }
      if (!isPositionOnlyUpdate && !isMaterialNumberOnlyUpdate) {
        const editCategory = classifyAnnotationEdit(nonPositionKeys);
        logAuditEvent('weld_edit', {
          count: 1,
          page: capturedNewAnnotation.page || currentPage,
          weldText: capturedNewAnnotation.text || '',
          changedFields: nonPositionKeys,
          editCategory,
          origin: getAnnotationOrigin(capturedOldAnnotation),
          changes: buildPrimitiveChanges(capturedOldAnnotation, capturedNewAnnotation, nonPositionKeys)
        });
      }

      // 创建撤销命令（使用捕获的状态）
      const updateCommand = {
        description: `更新标注: ${capturedOldAnnotation.text || '无文字'}`,
        execute: () => {
          // 重做：应用新的标注状态
          console.log(`🔄 [重做] 应用新状态，位置:`, {
            startX: capturedNewAnnotation.startX,
            endX: capturedNewAnnotation.endX
          });
          setAnnotations(prev => {
            const newArray = [...prev];
            const currentIndex = prev.findIndex(ann => ann.id === annotationId);
            if (currentIndex !== -1) {
              newArray[currentIndex] = capturedNewAnnotation;
            }
            return newArray;
          });
        },
        undo: () => {
          // 撤销：恢复到旧的标注状态
          console.log(`🔄 [撤销] 恢复旧状态，位置:`, {
            startX: capturedOldAnnotation.startX,
            endX: capturedOldAnnotation.endX
          });
          setAnnotations(prev => {
            const newArray = [...prev];
            const currentIndex = prev.findIndex(ann => ann.id === annotationId);
            if (currentIndex !== -1) {
              newArray[currentIndex] = capturedOldAnnotation;
            }
            return newArray;
          });
        }
      };
      
      // ⚠️ 注意：executeCommand 会调用 execute()，但此时状态已经更新过了
      // 这会导致重复更新，但为了保持撤销重做的一致性，我们接受这个小开销
      undoRedoSystem.executeCommand(updateCommand);
      
      // 清除定时器记录
      setUpdateTimeouts(prev => {
        const newMap = new Map(prev);
        newMap.delete(annotationId);
        return newMap;
      });
    }, 300); // 300ms防抖
    
    // 记录新的定时器
    setUpdateTimeouts(prev => new Map(prev).set(annotationId, timeoutId));
  }, [undoRedoSystem, newlyAddedAnnotations, updateTimeouts, logAuditEvent, currentPage]);

  const handleBatchAnnotationUpdates = useCallback((updatesById, description = '批量更新标注') => {
    if (!updatesById || typeof updatesById !== 'object') return;
    const entries = Object.entries(updatesById).filter(([, updates]) => updates && typeof updates === 'object');
    if (entries.length === 0) return;

    markAnnotationDraftDirty();

    const currentAnnotations = annotationsRef.current || [];
    const beforeSnapshots = [];
    const afterSnapshots = [];
    const updateMap = new Map(entries);

    currentAnnotations.forEach(annotation => {
      const updates = updateMap.get(annotation.id);
      if (!updates) return;
      beforeSnapshots.push({ ...annotation });
      afterSnapshots.push({
        ...annotation,
        ...updates,
        ...(getAnnotationOrigin(annotation) === 'auto' ? { qualityModified: true } : {})
      });
    });

    if (beforeSnapshots.length === 0) return;

    const applySnapshots = (snapshots) => {
      const snapshotById = new Map(snapshots.map(item => [item.id, item]));
      setAnnotations(prev => prev.map(annotation => (
        snapshotById.has(annotation.id)
          ? { ...annotation, ...snapshotById.get(annotation.id) }
          : annotation
      )));
    };

    undoRedoSystem.executeCommand({
      description,
      execute: () => applySnapshots(afterSnapshots),
      undo: () => applySnapshots(beforeSnapshots)
    });
    const changedFields = Array.from(new Set(entries.flatMap(([, updates]) => Object.keys(updates))));
    logAuditEvent('weld_edit', {
      count: beforeSnapshots.length,
      pages: Array.from(new Set(beforeSnapshots.map(item => item.page || currentPage).filter(Boolean))),
      changedFields,
      editCategory: classifyAnnotationEdit(changedFields),
      originCounts: buildOriginCounts(beforeSnapshots),
      batch: true,
      description
    });
  }, [markAnnotationDraftDirty, undoRedoSystem, logAuditEvent, currentPage]);

  const handleApplyWeldAdjustment = useCallback((incomingAnnotations) => {
    const currentAnnotations = annotationsRef.current || [];
    const plan = buildDirectWeldAdjustmentPlan(currentAnnotations, incomingAnnotations);
    const updateEntries = Object.entries(plan.updatesById);
    if (!updateEntries.length && !plan.deletedIds.length && !plan.additions.length) return plan;

    markAnnotationDraftDirty();
    const deletedIdSet = new Set(plan.deletedIds);
    const updateMap = new Map(updateEntries);
    const manualAdditions = plan.additions.map(annotation => ({
      ...annotation,
      frameSize: annotation.frameSize ?? (annotationFrameSize || 56.7),
      origin: 'manual',
      qualityCorrection: true,
      qualityModified: false,
      isBatchGenerated: true,
      isUploaded: false
    }));
    const beforeAnnotations = currentAnnotations;
    const afterAnnotations = [
      ...currentAnnotations
        .filter(annotation => !deletedIdSet.has(annotation.id))
        .map(annotation => {
          const updates = updateMap.get(annotation.id);
          return updates ? { ...annotation, ...updates } : annotation;
        }),
      ...manualAdditions
    ];

    undoRedoSystem.executeCommand({
      description: `焊点调整：新增${manualAdditions.length}、删除${plan.deletedIds.length}、改号${updateEntries.length}`,
      execute: () => setAnnotations(afterAnnotations),
      undo: () => setAnnotations(beforeAnnotations)
    });
    setWeldStats(prev => ({
      ...prev,
      manuallyAdded: prev.manuallyAdded + manualAdditions.length,
      deleted: prev.deleted + plan.deletedIds.length,
      modified: prev.modified + updateEntries.length
    }));

    const affectedPages = Array.from(new Set([
      ...manualAdditions.map(item => item.page),
      ...plan.deletedIds.map(id => currentAnnotations.find(item => item.id === id)?.page),
      ...updateEntries.map(([id]) => currentAnnotations.find(item => item.id === id)?.page)
    ].filter(Boolean)));
    if (manualAdditions.length) {
      logAuditEvent('weld_add_manual', {
        count: manualAdditions.length,
        pages: Array.from(new Set(manualAdditions.map(item => item.page).filter(Boolean))),
        source: 'weld_adjustment_manual_insert'
      });
    }
    if (plan.deletedIds.length || updateEntries.length) {
      logAuditEvent('weld_edit', {
        count: plan.deletedIds.length + updateEntries.length,
        pages: affectedPages,
        changedFields: ['text', 'weldData.weldNumber'],
        editCategory: 'content',
        source: 'weld_adjustment_atomic_commit'
      });
    }
    message.success(`焊点调整已应用：新增 ${manualAdditions.length}，删除 ${plan.deletedIds.length}，改号 ${updateEntries.length}`);
    return plan;
  }, [annotationFrameSize, logAuditEvent, markAnnotationDraftDirty, undoRedoSystem]);

  const handleAnnotationDelete = useCallback((annotationId) => {
    // 找到要删除的标注索引和数据
    const annotationIndex = annotations.findIndex(ann => ann.id === annotationId);
    if (annotationIndex === -1) return;
    markAnnotationDraftDirty();
    
    const annotationToDelete = annotations[annotationIndex];
    
    // 判断是否需要统计
    const shouldUpdateStats = annotationToDelete.isBatchGenerated;
    
    // 使用新的撤销重做系统
    const deleteCommand = {
      description: `删除标注: ${annotationToDelete.text || '无文字'}`,
      execute: () => {
        const newAnnotations = annotations.filter(ann => ann.id !== annotationId);
        setAnnotations(newAnnotations);
        
        // 更新统计数据 - 只统计批量生成的标注被删除
        if (shouldUpdateStats) {
          setWeldStats(prev => ({
            ...prev,
            deleted: prev.deleted + 1
          }));
        }
        
        // 从新添加列表中移除（如果存在）
        setNewlyAddedAnnotations(prev => {
          const newSet = new Set(prev);
          newSet.delete(annotationId);
          return newSet;
        });
        
        // 如果删除的标注使用了规则，更新规则的当前序号
        if (annotationToDelete.ruleId) {
          setTimeout(() => {
            updateRuleCurrentNumber(annotationToDelete.ruleId, newAnnotations);
          }, 0);
        }
      },
      undo: () => {
        setAnnotations(prev => {
          const newArray = [...prev];
          newArray.splice(annotationIndex, 0, annotationToDelete);
          return newArray;
        });
        
        // 撤销统计
        if (shouldUpdateStats) {
          setWeldStats(prev => ({
            ...prev,
            deleted: prev.deleted - 1
          }));
        }
        
        // 恢复规则序号（如果需要）
        if (annotationToDelete.ruleId) {
          setTimeout(() => {
            updateRuleCurrentNumber(annotationToDelete.ruleId, [...annotations]);
          }, 0);
        }
      }
    };
    undoRedoSystem.executeCommand(deleteCommand);
    logAuditEvent('weld_delete', {
      count: 1,
      page: annotationToDelete.page || currentPage,
      weldText: annotationToDelete.text || '',
      generatedBy: annotationToDelete.isBatchGenerated ? 'auto' : 'manual'
    });
  }, [annotations, updateRuleCurrentNumber, undoRedoSystem, logAuditEvent, currentPage]);

  // 批量删除所有标注的函数
  // 使用 useRef 来追踪最新的 currentPage，避免闭包陷阱
  const currentPageRef = useRef(currentPage);
  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  const handleClearAllAnnotations = useCallback((options = {}) => {
    if (annotations.length === 0) {
      return;
    }
    
    // 获取最新的 currentPage
    const currentPg = currentPageRef.current;
    
    // 默认scope为删除所有页，如果指定为current则只删除当前页
    const scope = options.scope || 'current';
    
    // 计算要删除的数量，用于描述
    const targetAnnotations = scope === 'all' 
      ? annotations 
      : annotations.filter(a => a.page === currentPg);
      
    if (targetAnnotations.length === 0) {
      message.warning('当前页没有标注信息');
      return;
    }
    
    // 计算批量生成的标注数量
    markAnnotationDraftDirty();
    if (scope === 'all' && !options.keepBox) {
      discardLatestAnnotationDraft();
    }
    const batchGeneratedCount = targetAnnotations.filter(ann => ann.isBatchGenerated).length;
    
    // 保存当前状态
    const currentAnnotations = [...annotations];
    const currentRules = [...annotationRules];
    const currentActiveRule = activeAnnotationRule ? { ...activeAnnotationRule } : null;
    
    const scopeDesc = scope === 'all' ? '所有页' : '当前页';
    const actionDesc = options.keepBox ? '清除焊口号' : '删除标注';
    
    // 使用新的撤销重做系统
    const clearCommand = {
      description: `${scopeDesc}${actionDesc} (${targetAnnotations.length}个)`,
      execute: () => {
        // 在 execute 内部再次获取最新的 currentPage，双重保险
        const executePg = currentPageRef.current;
        console.log(`执行删除操作: scope=${scope}, executePg=${executePg}, targetCount=${targetAnnotations.length}`);
        
        // 更新统计数据 - 只统计批量生成的标注
        if (batchGeneratedCount > 0) {
          if (!options.keepBox) {
            setWeldStats(prev => ({
              ...prev,
              deleted: prev.deleted + batchGeneratedCount
            }));
          } else {
            setWeldStats(prev => ({
              ...prev,
              modified: prev.modified + batchGeneratedCount
            }));
          }
        }

        if (options.keepBox) {
          // 仅清除文本，保留框
          setAnnotations(prev => prev.map(ann => {
             // 检查作用域
             if (scope === 'current' && ann.page !== executePg) {
               return ann;
             }
             
             // 检查是否为焊口标注（根据属性或类型）
             if (ann.type === 'text') {
               return {
                 ...ann,
                 text: '', // 清空文本
                 materialNumber: '', // 清空材料编号
                 remark: '', // 清空备注
                 ...(getAnnotationOrigin(ann) === 'auto' ? { qualityModified: true } : {}),
                 // 保持位置、颜色、形状等样式不变
               };
             }
             return ann;
          }));
        } else {
          // 删除标注
          if (scope === 'all') {
            setAnnotations([]);
            setNewlyAddedAnnotations(new Set());
          } else {
            // 仅删除当前页
            console.log(`正在删除第 ${executePg} 页的所有标注...`);
            setAnnotations(prev => {
              // 使用 executePg 进行过滤
              const remaining = prev.filter(ann => ann.page !== executePg);
              console.log(`删除前: ${prev.length}, 删除后: ${remaining.length}`);
              return remaining;
            });
            setNewlyAddedAnnotations(prev => {
               const newSet = new Set(prev);
               return newSet;
            });
          }
        }
        
        // 只有在删除所有页或者清除所有页文本时，才重置规则序号
        if (scope === 'all') {
          const resetRules = annotationRules.map(rule => ({
            ...rule,
            currentNumber: rule.startNumber
          }));
          setAnnotationRules(resetRules);
          
          if (activeAnnotationRule) {
            const resetActiveRule = {
              ...activeAnnotationRule,
              currentNumber: activeAnnotationRule.startNumber
            };
            setActiveAnnotationRule(resetActiveRule);
          }
        }
      },
      undo: () => {
        setAnnotations(currentAnnotations);
        setAnnotationRules(currentRules);
        setActiveAnnotationRule(currentActiveRule);
        
        // 撤销统计
        if (batchGeneratedCount > 0) {
          if (!options.keepBox) {
            setWeldStats(prev => ({
              ...prev,
              deleted: prev.deleted - batchGeneratedCount
            }));
          } else {
            setWeldStats(prev => ({
              ...prev,
              modified: prev.modified - batchGeneratedCount
            }));
          }
        }
      }
    };
    undoRedoSystem.executeCommand(clearCommand);
    const affectedPages = Array.from(new Set(targetAnnotations.map(ann => ann.page).filter(Boolean)));
    logAuditEvent(options.keepBox ? 'weld_edit_clear_text' : 'weld_delete_bulk', {
      count: targetAnnotations.length,
      page: scope === 'current' ? currentPg : '',
      affectedPages,
      scope,
      generatedCount: batchGeneratedCount,
      editCategory: 'content',
      changedFields: ['text', 'materialNumber', 'remark'],
      originCounts: buildOriginCounts(targetAnnotations)
    });
  }, [annotations, annotationRules, activeAnnotationRule, undoRedoSystem, logAuditEvent]); // 移除 currentPage 依赖，改为使用 ref

  // 区域删除功能
  const handleAreaDelete = useCallback((rect, page) => {
    if (!rect || annotations.length === 0) {
      return;
    }

    // 计算选择区域的边界
    const minX = Math.min(rect.startX, rect.endX);
    const maxX = Math.max(rect.startX, rect.endX);
    const minY = Math.min(rect.startY, rect.endY);
    const maxY = Math.max(rect.startY, rect.endY);

    // 过滤出在选择区域内的标注
    const annotationsToDelete = annotations.filter(ann => {
      if (ann.page !== page) return false;

      // 计算标注的中心点
      const centerX = (ann.startX + ann.endX) / 2;
      const centerY = (ann.startY + ann.endY) / 2;

      // 检查中心点是否在选择区域内
      return centerX >= minX && centerX <= maxX && centerY >= minY && centerY <= maxY;
    });

    if (annotationsToDelete.length === 0) {
      message.info('选择区域内没有标注');
      return;
    }

    // 根据当前的删除类型执行操作
    markAnnotationDraftDirty();
    if (areaDeleteType === 'text-only') {
      // 仅清除文字逻辑
      const currentAnnotations = [...annotations];
      const targetIds = new Set(annotationsToDelete.map(ann => ann.id));
      
      // 计算批量生成的标注数量
      const batchGeneratedCount = annotationsToDelete.filter(ann => ann.isBatchGenerated).length;
      
      const clearTextCommand = {
        description: `区域清除文字 (${annotationsToDelete.length}个)`,
        execute: () => {
          setAnnotations(prev => prev.map(ann => {
            if (targetIds.has(ann.id) && ann.type === 'text') {
              return {
                ...ann,
                text: '',
                materialNumber: '',
                remark: '',
                ...(getAnnotationOrigin(ann) === 'auto' ? { qualityModified: true } : {}),
              };
            }
            return ann;
          }));
          
          // 统计批量生成的标注被修改
          if (batchGeneratedCount > 0) {
            setWeldStats(prev => ({
              ...prev,
              modified: prev.modified + batchGeneratedCount
            }));
          }
          
          message.success(`已清除 ${annotationsToDelete.length} 个标注的文字`);
        },
        undo: () => {
          setAnnotations(currentAnnotations);
          
          // 撤销统计
          if (batchGeneratedCount > 0) {
            setWeldStats(prev => ({
              ...prev,
              modified: prev.modified - batchGeneratedCount
            }));
          }
        }
      };
      undoRedoSystem.executeCommand(clearTextCommand);
      logAuditEvent('weld_edit_clear_text', {
        count: annotationsToDelete.length,
        page,
        scope: 'area',
        generatedCount: batchGeneratedCount,
        editCategory: 'content',
        changedFields: ['text', 'materialNumber', 'remark'],
        originCounts: buildOriginCounts(annotationsToDelete)
      });
    } else {
      // 完全删除逻辑 (默认)
      const currentAnnotations = [...annotations];
      const deletedIds = new Set(annotationsToDelete.map(ann => ann.id));
      
      // 计算批量生成的标注数量
      const batchGeneratedCount = annotationsToDelete.filter(ann => ann.isBatchGenerated).length;
      
      const areaDeleteCommand = {
        description: `区域删除 (${annotationsToDelete.length}个标注)`,
        execute: () => {
          setAnnotations(prev => prev.filter(ann => !deletedIds.has(ann.id)));
          
          // 统计批量生成的标注被删除
          if (batchGeneratedCount > 0) {
            setWeldStats(prev => ({
              ...prev,
              deleted: prev.deleted + batchGeneratedCount
            }));
          }
          
          message.success(`已删除 ${annotationsToDelete.length} 个标注`);
        },
        undo: () => {
          setAnnotations(currentAnnotations);
          
          // 撤销统计
          if (batchGeneratedCount > 0) {
            setWeldStats(prev => ({
              ...prev,
              deleted: prev.deleted - batchGeneratedCount
            }));
          }
        }
      };
      undoRedoSystem.executeCommand(areaDeleteCommand);
      logAuditEvent('weld_delete_bulk', {
        count: annotationsToDelete.length,
        page,
        scope: 'area',
        generatedCount: batchGeneratedCount
      });
    }
  }, [annotations, undoRedoSystem, areaDeleteType, logAuditEvent]);

  // 重做功能
  const handleRedo = useCallback(() => {
    markAnnotationDraftDirty();
    undoRedoSystem.redo();
  }, [undoRedoSystem]);


  const handlePrint = () => {
    // TODO: 实现打印功能
    window.print();
  };


  // 快速保存到原文件
  const handleQuickSave = async () => {
    console.log('🔍 保存检查 - pdfFilePath:', pdfFilePath);
    console.log('🔍 保存检查 - annotations长度:', annotations.length);
    console.log('🌐 运行环境:', isElectron() ? 'Electron' : 'Web');
    
    // Electron 环境：需要文件路径
    if (isElectron() && !pdfFilePath) {
      console.warn('⚠️ 文件路径不可用，无法保存到原文件');
      message.warning('无法保存到原文件：文件路径不可用。请使用"文件"菜单或Ctrl+O打开PDF文件。');
      return;
    }

    // Web 环境：不需要文件路径，直接下载
    if (!isElectron() && !pdfFile) {
      message.warning('请先打开PDF文件');
      return;
    }

    if (annotations.length === 0) {
      Modal.confirm({
        title: '没有标注数据',
        content: '当前没有标注数据。是否仍要保存？这将清除PDF中已存储的所有标注记录。',
        okText: '确认保存',
        cancelText: '取消',
        onOk: () => handleAutoSaveToOriginalFile(),
      });
      return;
    }

    await handleAutoSaveToOriginalFile();
  };

  // 自动保存到原文件
  const handleAutoSaveToOriginalFile = async () => {
    try {
      if (!isElectron()) {
        markAnnotationDraftDirty();
        await flushAnnotationDraft({ emergency: true });
      }
      const t0 = performance.now();
      message.loading({ content: '正在保存PDF...', key: 'quickSave' });

      // 🚀 性能优化：生成带标注的PDF字节数据（不包含图像标注，但保存元数据以便继续编辑）
      const pdfBytes = await generateAnnotatedPDFBytes(false, true);
      const t1 = performance.now();
      console.log(`✅ PDF生成完成，耗时: ${(t1 - t0).toFixed(2)}ms`);

      // 使用文件适配器保存文件（自动适配 Electron 和 Web 环境）
      // Web 模式使用原文件名（不加 -标注版 后缀），便于用户直接替换原文件
      const defaultFileName = pdfFileName ? `${pdfFileName}.pdf` : '标注版.pdf';
      const result = await fileAdapter.savePDF(pdfBytes, isElectron() ? pdfFilePath : defaultFileName);
      
      const t2 = performance.now();
      console.log(`✅ 文件保存完成，耗时: ${(t2 - t1).toFixed(2)}ms`);
      
      console.log('保存结果:', result);
      if (result.success) {
        // 🚀 性能优化：直接使用刚生成的pdfBytes更新缓存，避免重新读取文件
        // 这样可以节省大量时间（特别是大文件）
        if (pdfBytes.byteLength <= MAX_RESIDENT_PDF_BUFFER_BYTES) {
          setPdfArrayBuffer(pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength));
          console.log('✅ 已更新PDF缓存（使用生成的数据，无需重新读取）');
        } else {
          // 保持与打开大文件时相同的策略：标注状态是后续保存的事实来源，
          // 不为大输出再永久保留一份完整连续 ArrayBuffer。
          setPdfArrayBuffer(null);
          console.log('♻️ 保存结果超过64MB，不保留常驻PDF副本:', {
            sizeMB: (pdfBytes.byteLength / 1024 / 1024).toFixed(2)
          });
        }
        window.__luotuPdfResidentBufferInfo = {
          fileBytes: Number(pdfBytes.byteLength || 0),
          retainedArrayBufferBytes: pdfBytes.byteLength <= MAX_RESIDENT_PDF_BUFFER_BYTES
            ? Number(pdfBytes.byteLength) : 0,
          largeFileOnDemand: pdfBytes.byteLength > MAX_RESIDENT_PDF_BUFFER_BYTES,
          recordedAt: Date.now()
        };
        
        // 更新文件路径（Electron 环境）
        if (result.savedPath && isElectron()) {
          setPdfFilePath(result.savedPath);
          // 更新文件名显示
          const newFileName = result.savedPath.split(/[\\\/]/).pop().replace(/\.pdf$/i, '');
          setPdfFileName(newFileName);
        }
        
        const t3 = performance.now();
        console.log(`🎉 保存完成，总耗时: ${(t3 - t0).toFixed(2)}ms`);

        if (isElectron() || result.saveMethod === 'original' || result.saveMethod === 'save-as') {
          await markAnnotationDraftSaved();
        } else if (latestCloudAnnotationDraftRef.current) {
          // Download completion is invisible to the page. Keep recovery data.
          persistCloudAnnotationDraft(latestCloudAnnotationDraftRef.current);
        }
        logLayoutQualityFinalization('quick_save');
        logAnnotationSnapshot('quick_save');
        let successMessage;
        if (isElectron()) {
          successMessage = result.wasSavedAs ? result.message : '已成功保存到原文件';
        } else if (result.saveMethod === 'original') {
          successMessage = result.message || '已成功保存到原文件';
        } else if (result.saveMethod === 'save-as') {
          successMessage = result.message || `文件已保存: ${defaultFileName}`;
        } else {
          successMessage = `文件已下载：${result.savedPath || defaultFileName}，请用下载的文件替换原文件`;
        }
        
        if (!isElectron() && result.saveMethod === 'download') {
          const reason = result.fallbackReason ? `原因：${result.fallbackReason}。` : '';
          successMessage = `${reason}已发起下载：${result.savedPath || defaultFileName}，请检查下载列表；恢复草稿已保留`;
        }
        message.success({ content: successMessage, key: 'quickSave' });
      } else {
        throw new Error(result.error || '保存失败');
      }
    } catch (error) {
      console.error('保存文件失败:', error);
      message.error({ content: `保存失败: ${error.message}`, key: 'quickSave' });
    }
  };

  // 超简单的PDF保存 - 使用浏览器打印
  const handleSimpleSave = () => {
    if (!pdfFile) {
      message.warning('请先打开PDF文件');
      return;
    }

    if (annotations.length === 0) {
      message.warning('没有标注数据可保存');
      return;
    }

    // 隐藏不需要打印的UI元素
    const elementsToHide = document.querySelectorAll('.ant-layout-sider, .toolbar, .status-indicator');
    elementsToHide.forEach(el => {
      if (el) el.style.display = 'none';
    });

    // 提示用户操作
    message.info('请在打印对话框中选择"保存为PDF"');
    
    // 调用浏览器打印
    setTimeout(() => {
      window.print();
      
      // 打印后恢复UI元素
      setTimeout(() => {
        elementsToHide.forEach(el => {
          if (el) el.style.display = '';
        });
      }, 1000);
    }, 500);
  };

  // 焊口标注处理
  const handleWeldingAnnotate = () => {
    if (!activeAnnotationRule) {
      console.log('没有激活的标注规则');
      return;
    }

    // 激活标注模式（现在固定为文字标注）
    setAnnotationMode(true);
    
    console.log('焊口标注模式已激活，当前编号:', generateRulePreview(activeAnnotationRule));
  };

  // 生成规则预览文本
  const formatAnnotationRuleNumber = (value, zeroPadCount = 0) => {
    const text = String(value);
    const parsed = Number.parseInt(zeroPadCount, 10);
    const zeros = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 8) : 0;
    return zeros > 0 ? text.padStart(zeros + 1, '0') : text;
  };

  const generateRulePreview = (rule, options = {}) => {
    if (!rule) return '';
    // 如果startNumber和currentNumber都是undefined或null，则不显示数字
    const currentNum = rule.currentNumber !== undefined && rule.currentNumber !== null 
      ? rule.currentNumber 
      : rule.startNumber;
    // 检查是否为 null、undefined 或者不是有效数字
    if (currentNum === undefined || currentNum === null || currentNum === '') {
      return `${rule.prefix || ''}${rule.suffix || ''}`;
    }
    return `${rule.prefix || ''}${formatAnnotationRuleNumber(currentNum, options.zeroPadCount)}${rule.suffix || ''}`;
  };

  const splitRulePreviewForSplitCircle = (rule) => {
    if (!rule) return { topText: '', bottomText: '' };
    const jointTypeText = String(rule.jointTypeText || '').trim();
    const topText = '';
    const currentNum = rule.currentNumber !== undefined && rule.currentNumber !== null
      ? rule.currentNumber
      : rule.startNumber;
    if (currentNum === undefined || currentNum === null || currentNum === '') {
      return { topText, bottomText: `${rule.prefix || ''}${rule.suffix || ''}`, jointTypeText };
    }
    return {
      topText,
      bottomText: `${rule.prefix || ''}${String(currentNum)}${rule.suffix || ''}`,
      jointTypeText
    };
  };

  // 处理标注添加（包含规则应用）
  const handleAnnotationAddWithRule = (annotation) => {
    if (activeAnnotationRule && annotation.type === 'text') {
      const effectiveRule = continuousRuleNumberingEnabled
        ? { ...activeAnnotationRule, currentNumber: continuousRuleNumber }
        : activeAnnotationRule;
      // 应用当前规则生成文字
      const ruleText = generateRulePreview(effectiveRule, {
        zeroPadCount: annotation.borderShape === 'pipe-tag' ? annotationPipeTagZeroPadCount : 0
      });
      const splitRuleText = splitRulePreviewForSplitCircle(effectiveRule);
      const isSplitCircle = annotation.borderShape === 'split-circle';
      const annotationWithRule = {
        ...annotation,
        text: isSplitCircle ? splitRuleText.bottomText : ruleText,
        topText: isSplitCircle ? splitRuleText.topText : (annotation.topText || ''),
        jointTypeText: isSplitCircle ? (splitRuleText.jointTypeText || annotation.jointTypeText || '') : '',
        ruleTopText: '',
        ruleId: activeAnnotationRule.id,
        ruleName: activeAnnotationRule.name,
        remark: activeAnnotationRule.remark || '', // 直接使用规则备注作为标注备注
        ruleRemark: activeAnnotationRule.remark || '', // 保持兼容性
        attributes: activeAnnotationRule.attributes || {}, // 保存规则属性
        ruleAttributes: activeAnnotationRule.attributes || {} // 保持兼容性
      };
      
      // 创建新标注
      const latestAutoBatchAnnotation = [...annotations]
        .reverse()
        .find(item => item?.isBatchGenerated && getAnnotationOrigin(item) === 'auto' && item.batchRunId);
      const newAnnotation = normalizeTextRectangleAnnotation({
        ...annotationWithRule,
        // 如果标注已经有ID，保持原ID；否则生成新ID
        id: annotation.id || `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: annotation.timestamp || new Date().toISOString(),
        type: 'text',
        color: annotationColor,
        frameSize: annotation.borderShape === 'text-rectangle'
          ? DEFAULT_TEXT_RECTANGLE_FRAME_SIZE
          : (annotation.frameSize ?? (annotationFrameSize || 56.7)),
        isUploaded: false, // 新添加的标注默认未上传
        origin: 'manual',
        batchRunId: annotation.batchRunId || latestAutoBatchAnnotation?.batchRunId || null,
        qualityCorrection: !!(annotation.batchRunId || latestAutoBatchAnnotation?.batchRunId),
        qualityModified: false,
        isBatchGenerated: false // 标记为非批量生成
      });
      
      // 更新统计数据 - 手动添加（使用规则）
      setWeldStats(prev => ({
        ...prev,
        manuallyAdded: prev.manuallyAdded + 1
      }));
      
      // 保存当前状态
      const oldRule = { ...activeAnnotationRule };
      const oldRules = [...annotationRules];
      const oldAnnotations = [...annotations];
      const oldContinuousRuleNumber = continuousRuleNumber;
      
      // 更新规则的当前序号
      const currentNum = continuousRuleNumberingEnabled
        ? continuousRuleNumber
        : (activeAnnotationRule.currentNumber !== undefined && activeAnnotationRule.currentNumber !== null
          ? activeAnnotationRule.currentNumber
          : activeAnnotationRule.startNumber);
      const increment = activeAnnotationRule.increment !== undefined && activeAnnotationRule.increment !== null
        ? activeAnnotationRule.increment 
        : 1;
      
      const updatedRule = {
        ...activeAnnotationRule,
        // 如果currentNum为null或undefined，保持为null
        currentNumber: currentNum !== undefined && currentNum !== null ? currentNum + increment : null,
        lastUsed: new Date().toISOString()
      };
      
      const updatedRules = annotationRules.map(rule => 
        rule.id === activeAnnotationRule.id ? updatedRule : rule
      );
      
      // 创建完整的添加命令，包含所有可能的状态变化
      const addWithRuleCommand = {
        description: `添加规则标注: ${newAnnotation.text}`,
        execute: () => {
          // 批量更新所有状态，React 18 会自动合并渲染
          setAnnotations(prev => [...prev, newAnnotation]);
          if (continuousRuleNumberingEnabled) {
            // 连续模式只推进共享焊口号，不覆盖各条规则原有的独立序号。
            setContinuousRuleNumber(currentNum !== undefined && currentNum !== null ? currentNum + 1 : 1);
          } else {
            setAnnotationRules(updatedRules);
            setActiveAnnotationRule(updatedRule);
          }
          setNewlyAddedAnnotations(prev => new Set([...prev, newAnnotation.id]));
          
          console.log(`📝 标记新添加的标注: ${newAnnotation.id}`);
          
          // 3秒后从新添加列表中移除，允许后续手动编辑产生撤销记录
          setTimeout(() => {
            console.log(`⏰ 从新添加列表中移除标注: ${newAnnotation.id}`);
            setNewlyAddedAnnotations(prev => {
              const newSet = new Set(prev);
              newSet.delete(newAnnotation.id);
              return newSet;
            });
          }, 3000); // 增加到3秒
        },
        undo: () => {
          // 只移除新添加的标注，保持其他标注的当前状态
          setAnnotations(prev => prev.filter(ann => ann.id !== newAnnotation.id));
          if (continuousRuleNumberingEnabled) {
            setContinuousRuleNumber(oldContinuousRuleNumber);
          } else {
            setAnnotationRules(oldRules);
            setActiveAnnotationRule(oldRule);
          }
          
          // 也要从新添加列表中移除
          setNewlyAddedAnnotations(prev => {
            const newSet = new Set(prev);
            newSet.delete(newAnnotation.id);
            return newSet;
          });
        }
      };
      undoRedoSystem.executeCommand(addWithRuleCommand);
      logAuditEvent('weld_add_manual', {
        count: 1,
        page: newAnnotation.page || currentPage,
        weldText: newAnnotation.text || '',
        manualPages: 1,
        source: 'rule_annotation',
        batchRunIds: [newAnnotation.batchRunId].filter(Boolean)
      });
    } else {
      // 普通标注
      handleAnnotationAdd(annotation);
    }
  };

  // 处理标注点击跳转
  const handleAnnotationClick = useCallback((annotation) => {
    
    // 执行页面跳转和视觉反馈
    if (annotation.page) {
      setCurrentPage(annotation.page);
    }
    
    // 设置选中的标注并添加高亮效果
    setSelectedAnnotation(annotation.id);
    setSelectedAnnotationIds(previous => previous.length === 1 && previous[0] === annotation.id
      ? previous : [annotation.id]);
    lastSelectedAnnotationIdRef.current = annotation.id;
  }, []);

  const handleAnnotationSelectionChange = useCallback((annotationIds = []) => {
    const nextIds = Array.from(new Set(annotationIds.filter(Boolean)));
    setSelectedAnnotationIds(previous => previous.length === nextIds.length &&
      previous.every((id, index) => id === nextIds[index]) ? previous : nextIds);
    if (nextIds.length === 0) {
      setSelectedAnnotation(null);
      return;
    }

    const nextSelectedId = nextIds[nextIds.length - 1];
    setSelectedAnnotation(nextSelectedId);
    lastSelectedAnnotationIdRef.current = nextSelectedId;
  }, []);
  
  // 处理PDF标注双击直接编辑（不通过selectedAnnotation机制）
  const handleAnnotationDirectEdit = useCallback((annotation) => {
    console.log('🎯 PDF标注双击直接编辑:', annotation.text);
    
    // 执行页面跳转
    if (annotation.page) {
      setCurrentPage(annotation.page);
    }
    
    // 直接调用编辑函数，不设置selectedAnnotation
    if (annotationEditHandlerRef.current) {
      annotationEditHandlerRef.current(annotation);
    }
  }, []);


  // 处理管段号模式切换
  const handleTogglePipeSegmentMode = () => {
    if (!pipeSegmentMode) {
      // 关闭其他模式
      setAnnotationMode(false);
      // 清除当前选中的规则
      setActiveAnnotationRule(null);
      // 开启管段号模式
      setPipeSegmentMode(true);
    } else {
      setPipeSegmentMode(false);
    }
  };

  // 处理管段号起始序号变更
  const handlePipeSegmentStartLetterChange = (text) => {
    setPipeSegmentStartLetter(text);
  };

  // 处理管段号字体大小变更
  const handlePipeSegmentFontSizeChange = (size) => {
    setPipeSegmentFontSize(size);
  };

  const handleAnnotationPipeTagZeroPadCountChange = (width) => {
    const parsed = Number.parseInt(width, 10);
    setAnnotationPipeTagZeroPadCount(Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 8) : 0);
  };

  const handleAnnotationBorderShapeChange = useCallback((shape) => {
    setAnnotationBorderShape(shape);
    if (shape === 'pipe-tag') {
      setAnnotationFontSize(28);
    } else if (shape === 'text-rectangle') {
      setAnnotationFontSize(34);
      setAnnotationFrameSize(57);
    }
  }, []);

  // 处理重置管段号计数器
  const handleResetPipeSegmentCounterUI = () => {
    setPipeSegmentCounter(0);
  };

  // 处理材料编码开关切换
  const handleToggleMaterialEncoding = () => {
    const newState = !enableMaterialEncoding;
    
    // 更新React状态
    setEnableMaterialEncoding(newState);
    
    // 保存状态到localStorage，确保持久化
    try {
      localStorage.setItem('enableMaterialEncoding', JSON.stringify(newState));
    } catch (error) {
      // 静默处理错误
    }
    
    // 用户提示消息
    if (newState) {
      // 材料编码已启用
    } else {
      // 材料编码已禁用
    }
  };

  // 生成管段号序列的函数
  const generatePipeSegmentLetter = (counter) => {
    return getNextPipeSegmentLabel(pipeSegmentStartLetter || 'A', counter);
  };

  // 重置管段号计数器
  const handleResetPipeSegmentCounter = () => {
    setPipeSegmentCounter(0);
  };

  // 导出Excel功能
  // 处理相邻行之间材料编号重复的函数
  const processAllMaterialNumbers = (annotations) => {
    const processedAnnotations = [...annotations];
    
    for (let i = 0; i < processedAnnotations.length; i++) {
      const currentMaterial = processedAnnotations[i].materialNumber;
      
      if (!currentMaterial || typeof currentMaterial !== 'string') {
        continue;
      }
      
      // 如果是第一行，直接保留
      if (i === 0) {
        continue;
      }
      
      // 获取上一行的材料编号
      const previousMaterial = processedAnnotations[i - 1].materialNumber;
      
      if (!previousMaterial || typeof previousMaterial !== 'string') {
        continue;
      }
      
      // 提取上一行材料编号的结尾数字
      const previousMatch = previousMaterial.match(/(\d+)$/); // 匹配结尾的数字
      
      if (!previousMatch) {
        continue;
      }
      
    const previousEndNumber = previousMatch[1];
    
    // 检查当前行材料编号是否以相同数字开头
    // 支持两种格式：1) 数字-其他内容  2) 单独的数字
    const currentMatch = currentMaterial.match(/^(\d+)(?:-(.+))?$/);
    
    if (currentMatch) {
      const [, startNumber, rest] = currentMatch;
      
      // 如果当前行的起始数字与上一行的结尾数字相同，替换为G
      if (startNumber === previousEndNumber) {
        // 如果有后缀内容，保留后缀；如果只是单独数字，只显示G
        processedAnnotations[i].materialNumber = rest ? `G-${rest}` : 'G';
      }
    }
    }
    
    return processedAnnotations;
  };

  // 标注形状名称映射
  const getBorderShapeName = (borderShape) => {
    switch (borderShape) {
      case 'none':
        return '无边框';
      case 'circle':
        return 'S';
      case 'split-circle':
        return 'S';
      case 'diamond':
        return 'F';
      case 'field-weld':
        return '现场焊缝';
      case 'shop-weld':
        return '车间焊缝';
      case 'pipe-tag':
        return '管段框';
      default:
        return '无边框';
    }
  };

  const handleExportExcel = async () => {
    const projectContext = getCurrentProjectContext();
    const isShenyuanProject = projectContext.projectName.includes('申远');
    if (annotations.length === 0 && !isShenyuanProject) {
      message.warning('没有标注数据可导出');
      return;
    }
    if (isShenyuanProject && totalPages <= 0) {
      message.warning('请先打开需要导出的PDF文件');
      return;
    }

    const processedAnnotations = processAllMaterialNumbers(annotations);

    // 生成文件名
    let fileName = '焊口表';
    const projectFileNamePart = getCurrentProjectFileNamePart();
    if (projectFileNamePart) {
      fileName += `-${projectFileNamePart}`;
    }
    // 如果有PDF文件名，则添加到文件名中
    if (pdfFileName) {
      fileName += `-${pdfFileName}`;
    }
    fileName += '.xlsx';

    // “申远”项目使用业主指定模板；其他项目保持原有通用格式。
    if (isShenyuanProject) {
      try {
        const pages = Array.from({ length: totalPages }, (_, index) => {
          const pdfPage = index + 1;
          const cachedData = pageCache.getPageData(pdfPage);
          const stateData = pageRecognitionData[pdfPage]?.data || pageRecognitionData[pdfPage];
          const pageData = cachedData || stateData || {};
          const pipelineNumber = pageData.pipelineNumber ||
            pageData.pipeline?.text ||
            pageData.pipeline ||
            pageData.materials?.find(item => item?.pipelineNumber)?.pipelineNumber ||
            '';
          const pageNumber = pageData.pageNumber?.text ||
            pageData.pageNumber ||
            pageData.pageInfo?.pageNumber ||
            '';
          const pipeClass = pageData.pipeClass || pageData.pipelineClass || '';
          return { pdfPage, pipelineNumber, pageNumber, pipeClass, pipelineClass: pipeClass };
        });
        const result = await exportWeldTableFromTemplate({
          annotations: processedAnnotations,
          pages,
          fileName,
          projectName: projectContext.projectName
        });
        message.success(`已按申远模板导出 ${result.weldCount} 个焊口、${result.importRowCount} 行数据`);
      } catch (error) {
        console.error('按申远模板导出焊口表失败:', error);
        message.error(`焊口表导出失败：${error.message}`);
      }
      return;
    }

    const excelData = processedAnnotations.map((annotation, index) => {
      const materials = Array.isArray(annotation.materialBindings) && annotation.materialBindings.length > 0
        ? annotation.materialBindings
        : (annotation.materialBinding ? [annotation.materialBinding] : []);
      const material = materials[0] || {};
      const material1 = materials[0] || {};
      const material2 = materials[1] || {};
      const pipelineNumber = annotation.pipelineNumber ||
        annotation.weldData?.pipelineNumber ||
        material1.pipelineNumber ||
        material2.pipelineNumber ||
        annotation.materialBinding?.pipelineNumber ||
        '';
      const getMaterialField = (item, keys, fallback = '') => {
        for (const key of keys) {
          if (item && item[key] !== undefined && item[key] !== null && item[key] !== '') {
            return item[key];
          }
        }
        return fallback;
      };
      const normalizeDiameter = () => {
        const values = materials
          .map(item => String(getMaterialField(item, ['diameter', '管径', 'ND', 'specification'], '') || '').trim())
          .filter(Boolean);
        const direct = values.find(value => !/[xX×*]/.test(value));
        if (direct) return direct;
        const first = values[0] || material.diameter || material.specification || '';
        return String(first).split(/[xX×*]/)[0].trim();
      };
      return {
        '序号': index + 1,
        '管线号': pipelineNumber,
        '焊口': annotation.text || '',
        '章': getBorderShapeName(annotation.borderShape),
        '备注': annotation.remark || '',
        '材料编号1': getMaterialField(material1, ['materialId', '序号', 'ID', 'id'], ''),
        '材料描述1': getMaterialField(material1, ['description', '材料描述', 'DESCRIPTION', 'text'], ''),
        '材料代码1': getMaterialField(material1, ['materialCode', '材料代码', '材料编码', 'ITEM_CODE', 'itemCode'], ''),
        '数量1': getMaterialField(material1, ['quantity', '数量', 'QTY'], ''),
        '材料编号2': getMaterialField(material2, ['materialId', '序号', 'ID', 'id'], ''),
        '材料描述2': getMaterialField(material2, ['description', '材料描述', 'DESCRIPTION', 'text'], ''),
        '材料代码2': getMaterialField(material2, ['materialCode', '材料代码', '材料编码', 'ITEM_CODE', 'itemCode'], ''),
        '数量2': getMaterialField(material2, ['quantity', '数量', 'QTY'], ''),
        '管径': normalizeDiameter(),
        '接头形式': getMaterialField(material, ['jointType', '接头形式', 'type', '类型'], ''),
        '单位': getMaterialField(material, ['unit', '单位'], '')
      };
    });
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(excelData);
    worksheet['!cols'] = [
      { wch: 6 }, { wch: 24 }, { wch: 15 }, { wch: 12 },
      { wch: 20 }, { wch: 12 }, { wch: 40 }, { wch: 22 },
      { wch: 10 }, { wch: 12 }, { wch: 40 }, { wch: 22 },
      { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 10 }
    ];
    XLSX.utils.book_append_sheet(workbook, worksheet, '标注数据');
    XLSX.writeFile(workbook, fileName);
    message.success(`已按通用格式导出 ${processedAnnotations.length} 条标注数据到 ${fileName}`);
  };

  // 打开上传Modal
  const handleUploadTritium = () => {
    // 过滤出未上传的标注（isUploaded 为 false 或 undefined 的标注，但前面已经处理了默认为true，所以主要是false）
    // 注意：如果是旧数据刚加载，会被置为true，所以这里主要针对新添加的
    const newAnnotations = annotations.filter(ann => ann.isUploaded === false);
    
    // 如果没有新增标注，但有历史标注，且用户非要上传（可能是重新上传），则使用全部标注？
    // 现在的需求是增量上传，所以如果没有新增标注，提示用户
    
    // 计算新增焊口所在的页数
    const newPages = new Set(newAnnotations.map(ann => ann.page));
    const newPageCount = newPages.size;
    const newWeldCount = newAnnotations.length;
    
    // 设置上传统计信息
    setUploadStats({
      weldCount: newWeldCount,
      pageCount: newPageCount
    });
    
    console.log(`📊 准备上传: 总标注 ${annotations.length} 个, 新增 ${newWeldCount} 个, 新增涉及 ${newPageCount} 页`);
    
    if (newWeldCount === 0 && annotations.length > 0) {
      // 询问用户是否强制上传所有数据（备用选项）
      Modal.confirm({
        title: '没有检测到新增标注',
        content: '所有标注似乎都已经上传过了。是否要强制重新上传所有标注？',
        okText: '强制上传所有',
        cancelText: '取消',
        onOk: () => {
           const totalStats = {
             weldCount: annotations.length,
             pageCount: totalPages || 0
           };
           setUploadStats(totalStats);
           
           // 强制上传模式：使用所有数据
           tritiumUploadForm.setFieldsValue({
            userName: '',
            projectName: pdfFileName || '',
            pageCount: totalStats.pageCount, // 强制上传时使用总页数
            weldCount: totalStats.weldCount, // 强制上传时使用总数量
            isForceUpload: true // 标记为强制上传
          });
          setTritiumUploadModalVisible(true);
        }
      });
      return;
    }
    
    if (annotations.length === 0) {
      message.warning('没有标注数据可上传');
      return;
    }
    
    // 重置表单并显示 Modal
    tritiumUploadForm.setFieldsValue({
      userName: '',
      projectName: pdfFileName || '',
      pageCount: newPageCount, // 使用新增标注涉及的页数
      weldCount: newWeldCount, // 使用新增标注的数量
      isForceUpload: false
    });
    setTritiumUploadModalVisible(true);
  };
  
  // 处理上传表单提交
  const handleTritiumUploadSubmit = async (values) => {
    const { userName, projectName, pageCount, personnelType, date, workHours, weldCount, isForceUpload } = values;
    
    // 🔧 通用氚云请求函数：支持 Electron 和 Web 环境
    const tritiumRequest = async (requestData) => {
      if (window.electronAPI && window.electronAPI.tritiumUpload) {
        // Electron 环境：使用 IPC
        return await window.electronAPI.tritiumUpload(requestData);
      } else {
        // Web 环境：使用 OCR 服务的代理 API
        console.log('🌐 [Web] 使用代理 API 请求氚云...');
        try {
          const proxyUrl = '/api/proxy/h3yun';
          const response = await fetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestData)
          });
          
          if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ 代理请求失败:', errorText);
            return { success: false, error: `代理请求失败 (${response.status}): ${errorText}` };
          }
          
          const result = await response.json();
          console.log('📨 代理响应:', result);
          return result;
        } catch (error) {
          console.error('❌ Web 代理请求异常:', error);
          return { success: false, error: `网络请求失败: ${error.message}` };
        }
      }
    };
    
    // 确定要上传的焊口数量
    // 如果是强制上传，或者表单中指定了数量，则使用表单值
    // 否则计算新增数量
    let targetWeldCount = weldCount;
    // 如果表单中未填写weldCount，使用默认值
    if (targetWeldCount === undefined || targetWeldCount === null) {
      if (isForceUpload) {
        targetWeldCount = annotations.length;
      } else {
        targetWeldCount = annotations.filter(ann => ann.isUploaded === false).length;
      }
    }
    
    const currentWeldCount = targetWeldCount; 
    
    // 处理可选字段的默认值
    const finalProjectName = projectName || '';
    const finalPageCount = pageCount !== undefined && pageCount !== null ? pageCount : 0;
    const finalPersonnelType = personnelType || '';
    
    try {
      message.loading({ content: '正在准备上传数据...', key: 'tritiumUpload' });
      
      // ==================================================================================
      // 💡 氚云人员ID映射配置 (针对人员单选控件)
      // 如果氚云中的"姓名"控件类型为[人员单选]，则必须传递人员ID (36位UUID)
      // 请在此处填入 姓名 -> 人员ID 的映射关系
      // ==================================================================================
      const USER_ID_MAP = {
        "纪婕": "592eb0aa-3840-4cee-ad59-5fe4b8816214",
        "张丽妹": "69ea8dd7-e3c5-4f4f-860c-5e73ae7ba3ac",
        "曹传章妈妈": "6eee8037-40d2-440b-a4c6-628fcbd8d77b",
        "陶炎": "7ef6e048-6868-442d-b495-d2aa193168c0",
        "沙雪平": "8d1b7663-10d1-4f91-a647-f9cccb1e3fd4",
        "凌秋月": "ac4cfca9-80ca-4499-b98f-27127563289f",
        "谷成浩": "b994b99c-16e6-467f-8579-806177709436",
        "王井会": "c36f9c28-895e-4f98-ab08-8fe8276dd7eb",
        "赵玲": "c4c2824b-300d-4700-a6bc-1ee608fbb110",
        "吴冠桦": "dbe65f22-5a9a-4510-a951-577ee6b0a59f",
        "殷玉善": "dcdf8bd9-e8c2-425c-a56d-d321a1e20fa2"
      };
      
      let submitUserName = userName;
      
      // 检查是否有对应的ID映射
      if (USER_ID_MAP[userName]) {
          submitUserName = USER_ID_MAP[userName];
          console.log(`👤 已将姓名 "${userName}" 转换为人员ID: ${submitUserName}`);
      } else {
          // 如果定义了映射但没找到匹配项，给出警告
          if (Object.keys(USER_ID_MAP).length > 0) {
              console.warn(`⚠️ 未找到姓名 "${userName}" 的ID映射，将直接使用姓名字符串提交。如果氚云控件是人员单选，这可能会失败。`);
          }
      }
      // ==================================================================================
      
      // 处理相邻行之间的材料编号重复
      const processedAnnotations = processAllMaterialNumbers(annotations);
      
      // 准备上传数据 - 转换为氚云格式的字符串数组
      // 数据工作日志表单：姓名在主表，项目名称和处理张数在子表
      
      // ⚠️ 调试：检查姓名字段是否有值
      console.log('📝 表单数据检查:', { 
        userName, 
        submitUserName, // 添加提交值的日志
        userNameType: typeof userName,
        userNameEmpty: !userName,
        personnelType: finalPersonnelType, 
        date 
      });

      // 如果姓名为空，给出警告
      if (!userName || userName.trim() === '') {
        message.warning('姓名字段为空，请填写姓名！');
        console.error('❌ 姓名字段为空，无法上传');
        return;
      }

      const bizObject = {
        F0000037: userName, // 姓名文本（主表字段）- 直接使用原始姓名文本
        F0000019: submitUserName, // 人员单选（主表字段）- 使用映射后的人员ID
        F0000029: finalPersonnelType, // 人员类型（主表字段）
        F0000020: date, // 时间（主表字段，格式：YYYY-MM-DD）
        // 子表数据：D148357F67d10547274c48d7bc977b28a4a9c6a6 是子表编码
        // 子表格式：直接是数组，不需要JSON.stringify
        D148357F67d10547274c48d7bc977b28a4a9c6a6: [
          {
            F0000025: finalProjectName,  // 子表字段：项目名称
            F0000030: finalPageCount,     // 子表字段：处理张数
            F0000026: workHours,     // 子表字段：工时
            F0000036: currentWeldCount, // 子表字段：焊口数量
            F0000035: '单线图落图' // 子表字段：数据来源（默认传入“单线图落图”）
          }
        ]
      };

      const bizObjectArray = [JSON.stringify(bizObject)];

      console.log('✅ 准备上传的工作日志数据:', bizObjectArray[0]);
      console.log('📊 上传信息详情:', { 
        userName, 
        projectName: finalProjectName, 
        pageCount: finalPageCount, 
        personnelType: finalPersonnelType, 
        date, 
        workHours, 
        weldCount: currentWeldCount,
        annotationCount: annotations.length 
      });
      
      // ⚠️ 特别检查F0000037字段（姓名字段正确编码）
      console.log('🔍 F0000037字段值:', bizObject.F0000037);

      // === 新增逻辑：查询当天是否存在该用户的记录 ===
      message.loading({ content: '正在检查当天记录...', key: 'tritiumUpload' });
      
      // 辅助函数：查询当天该用户的记录
      const queryExistingRecord = async (userValue, dateValue) => {
        // 构造Filter：仅按日期查询，前端再过滤用户
        // 理由：日期格式是标准的，而用户控件（F0000037）可能需要UserID，直接过滤可能不准确
        // 我们先拉取当天所有记录，然后在内存中匹配用户
        const filter = {
           "FromRowNum": 0,
           "RequireCount": true,
           "ReturnItems": [],
           "SortByCollection": [],
           "ToRowNum": 500,
           "Matcher": {
              "Type": "And", 
              "Matchers": [
                 {
                    "Type": "Item",
                    "Name": "F0000020",
                    "Operator": 2,
                    "Value": dateValue
                 }
              ]
           }
        };

        const result = await tritiumRequest({
            url: 'https://www.h3yun.com/OpenApi/Invoke',
            body: {
              ActionName: 'LoadBizObjects',
              SchemaCode: 'D148357st1mm2l5ga0ucn4ogzl05',
              Filter: JSON.stringify(filter),
              RequireCount: false
            }
          });
          
          // 如果查询成功，在前端进行用户过滤
          if (result.success && result.data && result.data.ReturnData && result.data.ReturnData.BizObjectArray) {
              const allRecords = result.data.ReturnData.BizObjectArray;
              console.log(`🔍 拉取到当天记录 ${allRecords.length} 条，正在前端筛选用户: ${userValue}...`);
              
              const targetRecords = allRecords.filter(record => {
                  // 尝试多种方式匹配用户
                  // 1. F0000037 字段（可能不存在或为空）
                  // 2. F0000019 字段（旧的姓名字段）
                  // 3. F0000019Object.ObjectId（人员单选的ObjectId）
                  
                  const recordUser37 = record.F0000037;
                  const recordUser19 = record.F0000019;
                  const recordUser19ObjectId = record.F0000019Object?.ObjectId;
                  
                  // 宽松匹配：userValue 可能是 GUID 或 姓名
                  let match = false;
                  
                  // 情况1: 直接匹配 F0000037
                  if (recordUser37 === userValue) match = true;
                  
                  // 情况2: 匹配 F0000019（姓名字段）
                  if (recordUser19 === userValue) match = true;
                  
                  // 情况3: 匹配 F0000019Object.ObjectId（GUID）
                  if (recordUser19ObjectId === userValue) match = true;
                  
                  // 情况4: 如果 userValue 是中文姓名，尝试模糊匹配
                  if (typeof recordUser19 === 'string' && recordUser19.includes(userValue)) match = true;
                  
                  if (match) {
                      console.log(`✅ 匹配成功: userValue=${userValue}, record.F0000019=${recordUser19}, record.F0000019Object.ObjectId=${recordUser19ObjectId}`);
                  }
                  
                  return match;
              });
              
              // 如果找到多条，返回第一条
              if (targetRecords.length > 0) {
                  console.log(`✅ 找到匹配记录:`, targetRecords[0]);
                  return {
                      success: true,
                      data: {
                          ReturnData: {
                              BizObjectArray: [targetRecords[0]]
                          }
                      }
                  };
              }
          }
          
          return { success: true, data: { ReturnData: { BizObjectArray: [] } } };
        };

        let existingRecord = null;
        try {
            const queryResult = await queryExistingRecord(submitUserName, date);
            if (queryResult.success && queryResult.data && queryResult.data.ReturnData && queryResult.data.ReturnData.BizObjectArray && queryResult.data.ReturnData.BizObjectArray.length > 0) {
                existingRecord = queryResult.data.ReturnData.BizObjectArray[0];
            }
        } catch (queryError) {
            console.warn('⚠️ 查询现有记录失败，将降级为直接创建新记录:', queryError);
        }

        // === 构造本次要上传的子表行数据 ===
        // 注意：这里需要与 bizObject 中的子表项保持一致
        const newSubtableItem = {
             F0000025: finalProjectName,  // 子表字段：项目名称
             F0000030: finalPageCount,     // 子表字段：处理张数
             F0000026: workHours,     // 子表字段：工时
             F0000036: currentWeldCount, // 子表字段：焊口数量
             F0000035: '单线图落图' // 子表字段：数据来源
        };
        const subtableCode = 'D148357F67d10547274c48d7bc977b28a4a9c6a6';

        let result;

        if (existingRecord) {
            // === 方案 B: 更新现有记录 (追加子表) ===
            message.loading({ content: '正在追加数据到现有记录...', key: 'tritiumUpload' });
            
            const bizObjectId = existingRecord.ObjectId || existingRecord.BizObjectId;
            console.log('📝 准备更新记录，BizObjectId:', bizObjectId, '现有记录:', existingRecord);
            
            // 获取现有子表数据
            let currentSubtableData = existingRecord[subtableCode] || [];
            if (!Array.isArray(currentSubtableData)) {
                currentSubtableData = [];
            }
            
            // 清洗现有数据，只保留必要的业务字段，避免携带系统字段导致更新问题
            const cleanSubtableData = currentSubtableData.map(item => ({
                F0000025: item.F0000025,
                F0000030: item.F0000030,
                F0000026: item.F0000026,
                F0000036: item.F0000036,
                F0000035: item.F0000035
            }));
            
            // 追加新数据
            const updatedSubtableData = [...cleanSubtableData, newSubtableItem];

            // 构造更新对象 - 只包含要更新的字段（子表）
            const updateBizObject = {
              [subtableCode]: updatedSubtableData
            };
            
            console.log('📤 准备调用UpdateBizObject，BizObjectId:', bizObjectId, 'updateBizObject:', JSON.stringify(updateBizObject, null, 2));

            // 调用 UpdateBizObject - BizObjectId 作为单独参数传递
            result = await tritiumRequest({
              url: 'https://www.h3yun.com/OpenApi/Invoke',
              body: {
                ActionName: 'UpdateBizObject',
                SchemaCode: 'D148357st1mm2l5ga0ucn4ogzl05',
                BizObjectId: bizObjectId,  // 单独传递 BizObjectId
                BizObject: JSON.stringify(updateBizObject),
                IsSubmit: true
              }
            });
            
        } else {
            // === 方案 A: 创建新记录 (原逻辑) ===
            message.loading({ content: '正在创建新的工作日志...', key: 'tritiumUpload' });
            
            // 调用氚云 API 上传（数据工作日志只需上传一条记录）
            result = await tritiumRequest({
              url: 'https://www.h3yun.com/OpenApi/Invoke',
              body: {
                ActionName: 'CreateBizObjects',
                SchemaCode: 'D148357st1mm2l5ga0ucn4ogzl05', // 数据工作日志表单编码
                BizObjectArray: bizObjectArray,
                IsSubmit: true
              }
            });
        }
        
        message.destroy('tritiumUpload');
        
        if (result.success) {
          const actionType = existingRecord ? '追加' : '上传';
          message.success(`成功${actionType}工作日志到氚云！\n姓名：${userName}\n项目：${projectName}\n处理张数：${pageCount}`);
          setTritiumUploadModalVisible(false);
          console.log(`✅ 工作日志${actionType}成功`);
          
          // 上传成功后，将所有未上传的标注标记为已上传
          // 如果是强制上传，则将所有标注标记为已上传
          markAnnotationDraftDirty();
          if (isForceUpload) {
             setAnnotations(prev => prev.map(ann => ({
               ...ann,
               isUploaded: true
             })));
             console.log('🔄 已将所有标注标记为"已上传"');
          } else {
             setAnnotations(prev => prev.map(ann => {
               // 只更新 isUploaded 为 false 的标注
               if (ann.isUploaded === false) {
                 return { ...ann, isUploaded: true };
               }
               return ann;
             }));
             console.log('🔄 已将新增标注标记为"已上传"');
          }
          
          // 触发保存到原文件，以持久化 isUploaded 状态
          // 注意：这会保存到PDF元数据中
          setTimeout(() => {
            handleAutoSaveToOriginalFile().catch(err => {
              console.warn('⚠️ 上传后自动保存状态失败:', err);
            });
          }, 1000);
          
        } else {
          message.error(`上传失败: ${result.error || '未知错误'}`);
          console.error('❌ 工作日志上传失败:', result.error);
        }
    } catch (error) {
      console.error('上传到氚云失败:', error);
      message.destroy('tritiumUpload');
      message.error(`上传失败: ${error.message}`);
    }
  };

  // 关联焊口表与OCR识别结果的功能 - 新逻辑：材料匹配焊口
  const associateWeldSeamWithOCR = (weldSeamData, ocrLogicalRows) => {
    if (!ocrLogicalRows || ocrLogicalRows.length === 0) {
      return [];
    }

    console.log(`🔍 开始材料匹配焊口处理: 材料${ocrLogicalRows.length}条, 焊口${weldSeamData?.length || 0}条`);

    // 新逻辑：构建焊口映射表，支持多种匹配模式
    const weldSeamMap = new Map();
    if (weldSeamData && weldSeamData.length > 0) {
      // 按页面分组处理焊口数据
      const pageGroups = {};
      weldSeamData.forEach(item => {
        const page = item['PDF页码'] || item.page || item.calculatedPage;
        if (!pageGroups[page]) {
          pageGroups[page] = [];
        }
        pageGroups[page].push(item);
      });

      // 处理每个页面的焊口数据
      Object.keys(pageGroups).forEach(page => {
        const pageWeldSeams = pageGroups[page];
        
        pageWeldSeams.forEach((item, index) => {
          const weldNumber = item['焊口号'] || item.weldNumber || item.weldSeam;
          const materialNumber = item['材料编号'] || item.materialNumber;
          
          // 兼容模式：如果有materialNumber，使用旧逻辑
          if (materialNumber) {
            const materialNumbers = [];
            if (materialNumber.includes('-')) {
              const [start, end] = materialNumber.split('-').map(num => parseInt(num.trim()));
              if (!isNaN(start) && !isNaN(end)) {
                for (let i = start; i <= end; i++) {
                  materialNumbers.push(String(i));
                }
              }
            } else if (materialNumber.includes(',')) {
              materialNumbers.push(...materialNumber.split(',').map(n => n.trim()));
            } else if (materialNumber.includes(' ')) {
              materialNumbers.push(...materialNumber.split(' ').filter(n => n.trim()).map(n => n.trim()));
            } else {
              materialNumbers.push(String(materialNumber).trim());
            }
            
            materialNumbers.forEach(num => {
              const key = `${page}_${num}`;
              weldSeamMap.set(key, {
                weldSeam: weldNumber,
                weldShape: getWeldShape(item.borderShape || ''),
                page: page,
                materialBinding: item.materialBinding || null,
                materialBindings: Array.isArray(item.materialBindings) ? item.materialBindings : (item.materialBinding ? [item.materialBinding] : [])
              });
            });
            
            console.log(`🔍 焊口 ${weldNumber} (兼容模式): 指定材料序号 [${materialNumbers.join(', ')}]`);
          } else {
            // 新逻辑：根据标注顺序自动分配序号
            const materialSequence = String(index + 1);
            const key = `${page}_${materialSequence}`;
            weldSeamMap.set(key, {
              weldSeam: weldNumber,
              weldShape: getWeldShape(item.borderShape || ''),
              page: page,
              materialBinding: item.materialBinding || null,
              materialBindings: Array.isArray(item.materialBindings) ? item.materialBindings : (item.materialBinding ? [item.materialBinding] : [])
            });
            
            console.log(`🔍 焊口 ${weldNumber} (自动匹配): 分配序号 ${materialSequence}`);
          }
        });
      });
    }

    const getBoundMaterialValue = (material, keys, fallback = '') => {
      for (const key of keys) {
        if (material && material[key] !== undefined && material[key] !== null && material[key] !== '') {
          return material[key];
        }
      }
      return fallback;
    };

    const getBoundMaterialsValue = (materials, keys, fallback = '') => {
      const values = (materials || []).map(material => getBoundMaterialValue(material, keys, '')).filter(Boolean);
      return values.length > 0 ? values.join('; ') : fallback;
    };

    // 形状映射函数
    function getWeldShape(borderShape) {
      switch (borderShape) {
        case 'circle': return 'S';  // 圆形框 -> S
        case 'split-circle': return 'S';  // 分栏圆形 -> S
        case 'diamond': return 'F';  // 菱形框 -> F
        case 'field-weld': return 'F';  // 现场焊缝 -> F
        case 'shop-weld': return 'S';  // 车间焊缝 -> S
        default: return '';
      }
    }

    // 以OCR材料数据为主体，根据计算页码和序号匹配焊口
    const associatedResults = ocrLogicalRows.map(ocrRow => {
      const ocrCalculatedPage = ocrRow[8] ? String(ocrRow[8]).trim() : '';
      const ocrSequence = ocrRow[0] ? String(ocrRow[0]).trim() : '';
      
      const matchKey = `${ocrCalculatedPage}_${ocrSequence}`;
      const matchedWeldSeam = weldSeamMap.get(matchKey);
      const boundMaterial = matchedWeldSeam?.materialBinding || null;
      const boundMaterials = Array.isArray(matchedWeldSeam?.materialBindings) && matchedWeldSeam.materialBindings.length > 0
        ? matchedWeldSeam.materialBindings
        : (boundMaterial ? [boundMaterial] : []);
      
      return {
        序号: getBoundMaterialsValue(boundMaterials, ['materialId', '序号', 'ID', 'id'], ocrRow[0] || ''),
        材料描述: getBoundMaterialsValue(boundMaterials, ['description', '材料描述', 'DESCRIPTION', 'text'], ocrRow[1] || ''),
        规格: getBoundMaterialsValue(boundMaterials, ['specification', '规格'], ocrRow[2] || ''),
        管径: getBoundMaterialsValue(boundMaterials, ['diameter', '管径', 'ND'], ''),
        接头形式: getBoundMaterialsValue(boundMaterials, ['jointType', '接头形式', 'type', '类型'], ''),
        材料代码: getBoundMaterialsValue(boundMaterials, ['materialCode', '材料代码', '材料编码', 'ITEM_CODE', 'itemCode'], ocrRow[3] || ''),
        数量: getBoundMaterialsValue(boundMaterials, ['quantity', '数量', 'QTY'], ocrRow[4] || ''),
        单位: getBoundMaterialsValue(boundMaterials, ['unit', '单位'], ocrRow[5] || ''),
        类型: getBoundMaterialsValue(boundMaterials, ['type', '类型'], ocrRow[6] || ''),
        OCR页码: ocrRow[7] || '',
        计算页码: ocrRow[8] || '',
        焊口号: matchedWeldSeam ? matchedWeldSeam.weldSeam : '',
        焊口形状: matchedWeldSeam ? matchedWeldSeam.weldShape : ''
      };
    });

    const matchedCount = associatedResults.filter(result => result.焊口号).length;
    console.log(`📊 材料匹配焊口结果: ${matchedCount}/${ocrLogicalRows.length} (${((matchedCount/ocrLogicalRows.length)*100).toFixed(1)}%)`);

    return associatedResults;
  };

  // 导出关联结果到Excel（新版本：以OCR数据为主体）
  const exportAssociatedResults = (associatedResults) => {
    if (!associatedResults || associatedResults.length === 0) {
      message.warning('没有关联结果可导出');
      return;
    }

    const workbook = XLSX.utils.book_new();
    const worksheetData = [];
    
    // 添加表头（以OCR数据为主体，焊口号作为最后一列）
    const headers = [
      '序号', '材料描述', '规格', '管径', '接头形式', '材料代码',
      '数量', '单位', '类型', 'OCR页码', '计算页码', '焊口号'
    ];
    worksheetData.push(headers);
    
    // 添加数据行
    associatedResults.forEach(result => {
      const row = [
        result.序号 || '',
        result.材料描述 || '',
        result.规格 || '',
        result.管径 || '',
        result.接头形式 || '',
        result.材料代码 || '',
        result.数量 || '',
        result.单位 || '',
        result.类型 || '',
        result.OCR页码 || '',
        result.计算页码 || '',
        result.焊口号 || ''
      ];
      worksheetData.push(row);
    });
    
    const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
    
    // 设置列宽
    const colWidths = [
      { wch: 10 }, // 序号
      { wch: 25 }, // 材料描述
      { wch: 20 }, // 规格
      { wch: 15 }, // 材料代码
      { wch: 10 }, // 数量
      { wch: 10 }, // 单位
      { wch: 12 }, // 类型
      { wch: 12 }, // OCR页码
      { wch: 12 }, // 计算页码
      { wch: 20 }  // 焊口号
    ];
    worksheet['!cols'] = colWidths;
    
    XLSX.utils.book_append_sheet(workbook, worksheet, 'OCR识别结果与焊口关联');
    
    const fileName = `OCR识别结果与焊口关联_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.xlsx`;
    XLSX.writeFile(workbook, fileName);
    
    message.success(`已导出 ${associatedResults.length} 条OCR识别结果到 ${fileName}`);
  };



  // 旧的关联逻辑（保留作为备用）
  const associateWeldSeamWithOCROld = (weldSeamData, ocrLogicalRows) => {
    if (!weldSeamData || !ocrLogicalRows || weldSeamData.length === 0 || ocrLogicalRows.length === 0) {
      return [];
    }

    // 1. 将OCR结果按第一列序号分组（每页从1开始到下一个1之前）
    const ocrPages = [];
    let currentPage = [];
    
    for (let i = 0; i < ocrLogicalRows.length; i++) {
      const row = ocrLogicalRows[i];
      const firstColumnValue = row[0] ? String(row[0]).trim() : '';
      
      // 如果是序号1且不是第一行，说明开始新的一页
      if (firstColumnValue === '1' && currentPage.length > 0) {
        ocrPages.push([...currentPage]);
        currentPage = [row];
      } else {
        currentPage.push(row);
      }
    }
    
    // 添加最后一页
    if (currentPage.length > 0) {
      ocrPages.push(currentPage);
    }

    // 2. 将焊口表按PDF页码分组
    const weldSeamByPage = {};
    weldSeamData.forEach(weldSeam => {
      const pdfPage = weldSeam['PDF页码'] || weldSeam.page;
      if (!weldSeamByPage[pdfPage]) {
        weldSeamByPage[pdfPage] = [];
      }
      weldSeamByPage[pdfPage].push(weldSeam);
    });

    // 3. 执行关联匹配
    const associatedResults = [];
    
    Object.keys(weldSeamByPage).forEach(pdfPageStr => {
      const pdfPage = parseInt(pdfPageStr);
      const weldSeamsOnPage = weldSeamByPage[pdfPageStr];
      
      // 找到对应的OCR页面（假设PDF页码与OCR页面索引对应）
      const ocrPageIndex = pdfPage - 1; // PDF页码从1开始，数组索引从0开始
      const ocrPageData = ocrPages[ocrPageIndex];
      
      if (!ocrPageData) {
        // 如果没有对应的OCR数据，仍然保留焊口表数据
        weldSeamsOnPage.forEach(weldSeam => {
          associatedResults.push({
            ...weldSeam,
            ocrData: null,
            associationStatus: 'no_ocr_data'
          });
        });
        return;
      }

      // 为每个焊口表项查找对应的OCR数据
      weldSeamsOnPage.forEach(weldSeam => {
        const materialNumber = weldSeam['材料编号'] || weldSeam.materialNumber;
        
        if (!materialNumber) {
          associatedResults.push({
            ...weldSeam,
            ocrData: null,
            associationStatus: 'no_material_number'
          });
          return;
        }

        // 在OCR数据中查找匹配的序号
        const matchedOcrRow = ocrPageData.find(ocrRow => {
          const ocrSequence = ocrRow[0] ? String(ocrRow[0]).trim() : '';
          return ocrSequence === String(materialNumber).trim();
        });

        if (matchedOcrRow) {
          associatedResults.push({
            ...weldSeam,
            ocrData: {
              序号: matchedOcrRow[0] || '',
              材料描述: matchedOcrRow[1] || '',
              规格: matchedOcrRow[2] || '',
              材料代码: matchedOcrRow[3] || '',
              数量: matchedOcrRow[4] || '',
              单位: matchedOcrRow[5] || '',
              类型: matchedOcrRow[6] || '',
              管道号: matchedOcrRow[7] || '',
              图号: matchedOcrRow[8] || '',
              页码: matchedOcrRow[9] || ''
            },
            associationStatus: 'matched'
          });
        } else {
          associatedResults.push({
            ...weldSeam,
            ocrData: null,
            associationStatus: 'no_match'
          });
        }
      });
    });

    return associatedResults;
  };





  // 计算标注大小的函数（与PDFViewer.js保持一致）
  const calculateAnnotationSize = (text, fontSize = 34, annotation = null) => { // 修改默认字体大小为34px
    text = String(text || '');
    const fixedA3Shape = isFixedA3TenMmShape(annotation?.borderShape);
    const baseFrameSize = getAnnotationFrameSize(annotation, annotationFrameSize || 56.7);

    // 计算文本的显示宽度（考虑中英文字符）
    const getTextWidth = (text, fontSize) => {
      // 中文字符宽度约为字号大小，英文字符约为字号的0.6倍
      let width = 0;
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (/[\u4e00-\u9fa5]/.test(char)) {
          // 中文字符
          width += fontSize;
        } else {
          // 英文字符和数字
          width += fontSize * 0.6;
        }
      }
      return width;
    };

    const textWidth = getTextWidth(text, fontSize);
    const textHeight = fontSize;
    const padding = 6; // 减小文本边距
    
    // 计算基于字体大小的基准尺寸（34px字体为基准，对角线约1cm）
    const baseFontSize = 34;
    const baseDiagonalLength = baseFrameSize; // 与PDFViewer保持一致，可自定义
    // 固定标注框大小，不随字体大小而改变
    const scaledDiagonalLength = baseDiagonalLength; // 固定为基准大小
    
    // 计算基于文本内容的最小尺寸需求（更保守的计算）
    const textRequiredWidth = textWidth + padding * 2;
    const textRequiredHeight = textHeight + padding * 2;
    
    // 只有当文本确实需要更大空间时才放大标注框
    // 使用更保守的计算方式，避免短文本导致标注框突然变大
    const textBasedRadius = Math.max(textRequiredWidth, textRequiredHeight) / 2;
    const textBasedDiagonalLength = textBasedRadius * 2;
    
    // 固定标注框尺寸，当文本长度大于等于2个字符时保持固定大小
     // 只有当文本长度小于2个字符且需要更大空间时才自适应放大
     const finalDiagonalLength = !fixedA3Shape && (text.length < 2 && textBasedDiagonalLength > scaledDiagonalLength)
       ? textBasedDiagonalLength 
       : scaledDiagonalLength;
    
    // 对于所有形状，外接圆直径等于对角线长度
    const circumscribedRadius = finalDiagonalLength / 2;
    
    // 圆形：半径就是外接圆半径
    const circleRadius = circumscribedRadius;
    
    // 菱形：从中心到顶点的距离等于外接圆半径
    const diamondRadius = circumscribedRadius;
    
    // 矩形：对角线长度等于finalDiagonalLength，所以半边长为对角线/2√2
    const rectangleHalfSide = finalDiagonalLength / (2 * Math.sqrt(2));

    // 长方形框：高度只随字号变化，宽度随实际文字长度自动扩展。
    // 留白保持紧凑，接近图纸中 F4 / F18 一类人工标注的效果。
    // 长方形框按实际文字宽度扩展；留出细小但足够的描边间距。
    const textRectangleFrameScale = Math.max(0.35, baseFrameSize / 56.7);
    const textRectangleWidth = Math.max(
      textWidth + 2,
      (textWidth + Math.max(2, fontSize * 0.18)) * textRectangleFrameScale
    );
    const textRectangleHeight = Math.max(
      fontSize * 1.02,
      fontSize * 1.1 * textRectangleFrameScale
    );
    
    // 水平线长度：与对角线长度相等
    const lineLength = finalDiagonalLength;
    
    return {
      circleRadius,
      diamondRadius,
      rectangleHalfSide,
      textRectangleWidth,
      textRectangleHeight,
      lineLength,
      diagonalLength: finalDiagonalLength // 用于验证
    };
  };

  // 计算引导线与标注框的最佳连接点 (与PDFViewer.js保持一致)
  const getAnnotationTextWidth = (text, fontSize) => {
    let width = 0;
    String(text || '').split('').forEach(char => {
      width += /[\u4e00-\u9fa5]/.test(char) ? fontSize : fontSize * 0.62;
    });
    return width;
  };

  const getPipeTagSize = (text, fontSize, annotation) => {
    const sizes = calculateAnnotationSize(text, fontSize, annotation);
    const base = sizes.diagonalLength || 56.7;
    const unitPerMm = base / 10;
    return {
      width: 23 * unitPerMm,
      height: 4 * unitPerMm,
      inset: Math.max(1.4, 0.45 * unitPerMm)
    };
  };

  const calculateConnectionPoint = (annotation, shapeType, shapeSize) => {
    if (!annotation.hasLeaderLine) return null;
    
    const dx = annotation.endX - annotation.startX;
    const dy = annotation.endY - annotation.startY;
    const length = Math.sqrt(dx * dx + dy * dy);
    
    if (length === 0) return { connectionX: annotation.endX, connectionY: annotation.endY };
    
    const unitX = dx / length;
    const unitY = dy / length;
    
    let connectionX, connectionY;
    
    switch (shapeType) {
      case 'circle':
      case 'split-circle':
      case 'shop-weld': // 车间焊缝使用圆形的连接逻辑
        connectionX = annotation.endX - unitX * shapeSize;
        connectionY = annotation.endY - unitY * shapeSize;
        break;
        
      case 'diamond':
      case 'field-weld': // 现场焊缝使用菱形的连接逻辑
        const vertices = [
          { x: annotation.endX, y: annotation.endY - shapeSize },
          { x: annotation.endX + shapeSize, y: annotation.endY },
          { x: annotation.endX, y: annotation.endY + shapeSize },
          { x: annotation.endX - shapeSize, y: annotation.endY }
        ];
        
        let closestVertex = vertices[0];
        let minDistance = Infinity;
        
        vertices.forEach(vertex => {
          const distanceToStart = Math.sqrt(
            Math.pow(vertex.x - annotation.startX, 2) + 
            Math.pow(vertex.y - annotation.startY, 2)
          );
          if (distanceToStart < minDistance) {
            minDistance = distanceToStart;
            closestVertex = vertex;
          }
        });
        
        connectionX = closestVertex.x;
        connectionY = closestVertex.y;
        break;
        
      case 'rectangle':
        ({ connectionX, connectionY } = getSquareLeaderConnection(annotation, shapeSize));
        break;

      case 'text-rectangle':
      case 'pipe-tag': {
        const tagWidth = shapeSize?.width || 120;
        const tagHeight = shapeSize?.height || 28;
        const angle = (Number(annotation.rotation) || 0) * Math.PI / 180;
        const toStartX = annotation.startX - annotation.endX;
        const toStartY = annotation.startY - annotation.endY;
        const localX = toStartX * Math.cos(-angle) - toStartY * Math.sin(-angle);
        const localY = toStartX * Math.sin(-angle) + toStartY * Math.cos(-angle);
        const localLength = Math.sqrt(localX * localX + localY * localY);
        if (!localLength) {
          connectionX = annotation.endX;
          connectionY = annotation.endY;
          break;
        }
        const localUnitX = localX / localLength;
        const localUnitY = localY / localLength;
        const tx = Math.abs(localUnitX) > 0.0001 ? (tagWidth / 2) / Math.abs(localUnitX) : Infinity;
        const ty = Math.abs(localUnitY) > 0.0001 ? (tagHeight / 2) / Math.abs(localUnitY) : Infinity;
        const t = Math.min(tx, ty);
        const hitX = localUnitX * t;
        const hitY = localUnitY * t;
        connectionX = annotation.endX + hitX * Math.cos(angle) - hitY * Math.sin(angle);
        connectionY = annotation.endY + hitX * Math.sin(angle) + hitY * Math.cos(angle);
        break;
      }
        
      default:
        connectionX = annotation.endX - unitX * shapeSize;
        connectionY = annotation.endY - unitY * shapeSize;
    }
    
    return { connectionX, connectionY };
  };

  // 生成带标注的PDF字节数据（供保存和导出共用）
  // includeImageAnnotations: 是否包含图像标注
  // saveMetadata: 是否保存元数据（默认true，导出PDF时应为false避免重复）
  const generateAnnotatedPDFBytes = async (includeImageAnnotations = true, saveMetadata = true, onProgress, output = 'bytes') => {
      onProgress?.({ phase: 'loading' });
      // 使用pdf-lib库处理PDF文件
      const { PDFDocument, rgb } = window.PDFLib;
      
      // 获取原始PDF文档的ArrayBuffer
      // 优先使用保存的ArrayBuffer，避免重新读取文件导致权限问题
      let arrayBuffer;
      if (pdfArrayBuffer) {
        // 优先使用保存的ArrayBuffer
        // ⚠️ 重要：创建ArrayBuffer的副本，避免detached错误
        arrayBuffer = pdfArrayBuffer.slice(0);
        console.log('✅ 使用已缓存的PDF内容（副本）');
      } else if (typeof pdfFile === 'string') {
        // 如果pdfFile是URL，需要先获取ArrayBuffer
        console.log('📥 从URL获取PDF内容');
        const response = await fetch(pdfFile);
        arrayBuffer = await response.arrayBuffer();
      } else if (pdfFile instanceof File) {
        // 如果pdfFile是File对象（云盘文件可能导致引用失效）
        console.log('📥 从File对象读取PDF内容');
        try {
          arrayBuffer = await pdfFile.arrayBuffer();
        } catch (fileReadError) {
          console.error('❌ File对象读取失败（文件引用已失效）:', fileReadError);
          throw new Error('无法读取PDF文件：文件引用已失效。这通常发生在云盘同步、文件被移动或多次保存后。请重新打开PDF文件（Ctrl+O）。');
        }
      } else if (pdfFile instanceof ArrayBuffer) {
        // 如果已经是ArrayBuffer，创建副本
        arrayBuffer = pdfFile.slice(0);
      } else {
        throw new Error('不支持的PDF文件格式');
      }
      
      // 加载原始PDF文档
      const loadOptions = { updateMetadata: false };
      if (window.PDFLib.ParseSpeeds?.Fastest) {
        loadOptions.parseSpeed = window.PDFLib.ParseSpeeds.Fastest;
      }
      let pdfDoc = await PDFDocument.load(arrayBuffer, loadOptions);
      onProgress?.({ phase: 'loaded' });
      
      // 移除签名相关内容以避免Adobe显示红叉
      try {
        // 方法1: 移除表单中的签名字段
        const form = pdfDoc.getForm();
        const fields = form.getFields();
        
        fields.forEach(field => {
          try {
            const fieldName = field.getName();
            if (field.constructor.name === 'PDFSignature' || 
                fieldName.toLowerCase().includes('signature') ||
                fieldName.toLowerCase().includes('sign')) {
              console.log('🗑️ 移除签名字段:', fieldName);
              form.removeField(field);
            }
          } catch (fieldError) {
            // 忽略单个字段处理错误
          }
        });
        
        // 方法2: 清除PDF元数据中的签名信息
        pdfDoc.setTitle(pdfDoc.getTitle() || '');
        pdfDoc.setSubject(pdfDoc.getSubject() || '');
        pdfDoc.setKeywords([]);
        
        console.log('✅ 签名相关内容清理完成');
        
      } catch (error) {
        console.log('ℹ️ 无签名内容需要清理或清理失败:', error.message);
      }
      
      const pages = pdfDoc.getPages();
      const numPages = pages.length;
      
      // 只有在需要图像标注时才进行渲染（为其他工具显示）
      if (includeImageAnnotations && annotations.length > 0) {
        // Pre-index once. Filtering the complete annotation array for every
        // PDF page became expensive on large annotated documents.
        const annotationsByPage = new Map();
        annotations.forEach(annotation => {
          const pageNumber = Number(annotation?.page);
          if (!Number.isFinite(pageNumber)) return;
          if (!annotationsByPage.has(pageNumber)) annotationsByPage.set(pageNumber, []);
          annotationsByPage.get(pageNumber).push(annotation);
        });
        const pagesWithAnnotations = new Set(annotationsByPage.keys());
        const totalExportPages = pages.filter((_, index) => pagesWithAnnotations.has(index + 1)).length;
        let completedExportPages = 0;
        onProgress?.({ phase: 'rendering', completedPages: 0, totalPages: totalExportPages });
        const canvasToPngBytes = canvas => new Promise((resolve, reject) => {
          canvas.toBlob(async blob => {
            if (!blob) {
              reject(new Error('标注PNG生成失败'));
              return;
            }
            try {
              resolve(new Uint8Array(await blob.arrayBuffer()));
            } catch (error) {
              reject(error);
            }
          }, 'image/png');
        });
        // 性能日志：只在需要时启用
        // console.log(`📊 共 ${numPages} 页，其中 ${pagesWithAnnotations.size} 页包含标注`);
        
        // 🚀 性能优化：只处理有标注的页面
        const t0 = performance.now();
        let lastMainThreadYieldAt = t0;
        for (let i = 0; i < numPages; i++) {
          const pageIndex = i;
          const pageNum = i + 1; // 页码从1开始
          
          // 跳过没有标注的页面
          if (!pagesWithAnnotations.has(pageNum)) {
            continue;
          }
          
          // 获取该页的标注
          const pageAnnotations = annotationsByPage.get(pageNum) || [];
          
          if (pageAnnotations.length > 0) {
          // 创建标注层canvas，尺寸与PDF页面完全匹配
            const page = pages[pageIndex];
            const { width: pdfWidth, height: pdfHeight } = page.getSize();
            const rawCropBox = typeof page.getCropBox === 'function' ? page.getCropBox() : null;
            const exportBox = rawCropBox && rawCropBox.width > 0 && rawCropBox.height > 0
              ? rawCropBox
              : { x: 0, y: 0, width: pdfWidth, height: pdfHeight };
            const exportWidth = exportBox.width;
            const exportHeight = exportBox.height;

            const annotCanvas = document.createElement('canvas');
            // 高分辨率Canvas：使用2倍分辨率提升图像质量
            const canvasScale = 2; // 提高Canvas分辨率
            annotCanvas.width = exportWidth * canvasScale;
            annotCanvas.height = exportHeight * canvasScale;
            const annotContext = annotCanvas.getContext('2d');
            
            // 缩放Canvas上下文以匹配高分辨率
            annotContext.scale(canvasScale, canvasScale);

            // 设置高质量渲染
            annotContext.imageSmoothingEnabled = true;
            annotContext.imageSmoothingQuality = 'high';
            annotContext.textRenderingOptimization = 'optimizeQuality';
            annotContext.lineCap = 'round';
            annotContext.lineJoin = 'round';

            // Electron环境特定优化
            const isElectron = !!(window.electronAPI);
            const fontFamily = 'sans-serif'; // 统一使用sans-serif，确保两端一致
            if (isElectron) {
              // Electron环境下的额外渲染优化
              annotContext.textRenderingOptimization = 'optimizeQuality';
              // 移除日志以提升性能
            }

            // 检测页面旋转角度
            const currentPage = pages[pageIndex];
            const rotation = currentPage.getRotation() || 0;
            const rotationDegrees = typeof rotation === 'object' ? (rotation.angle || 0) : rotation;
            // 标注层只需要页面尺寸与旋转，不需要再次用 PDF.js 解析整份原文件。
            // 这里构造与 PDF.js scale=1 viewport 等价的尺寸，保持原坐标换算不变。
            const viewport = rotationDegrees === 90 || rotationDegrees === 270
              ? { width: exportHeight, height: exportWidth }
              : { width: exportWidth, height: exportHeight };


            // 计算坐标转换
          // 标注坐标是基于显示缩放后的坐标系，需要转换到PDF原始坐标系
          // 使用固定的转换基准，确保导出结果与当前显示缩放无关
          
          // 修复：使用固定的坐标转换，与当前显示缩放无关
          // 标注坐标基于PDFViewer的显示坐标系（固定为scale * 2.0）
          // 转换到PDF原始坐标系时应使用固定的基准，而不是当前的scale
          const fixedViewerDisplayScale = 2.0; // PDFViewer的固定显示缩放基准
          
          // 修正：根据页面旋转角度正确计算坐标缩放比例
          let coordinateScaleX, coordinateScaleY;
          if (rotationDegrees === 90 || rotationDegrees === 270) {
            // 90度或270度旋转：viewport的width/height与PDF的width/height对应关系发生交换
            coordinateScaleX = exportWidth / (viewport.height * fixedViewerDisplayScale);
            coordinateScaleY = exportHeight / (viewport.width * fixedViewerDisplayScale);
          } else {
            // 0度或180度旋转：viewport的width/height与PDF的width/height正常对应
            coordinateScaleX = exportWidth / (viewport.width * fixedViewerDisplayScale);
            coordinateScaleY = exportHeight / (viewport.height * fixedViewerDisplayScale);
          }
          
          // 🚀 性能优化：移除循环中的调试日志以提升导出速度
          // 如需调试，可临时取消注释以下代码：
          // console.log(`🔍 [坐标转换] 页面${i + 1}: coordinateScaleX=${coordinateScaleX.toFixed(4)}, coordinateScaleY=${coordinateScaleY.toFixed(4)}`);
          // console.log(`📏 [页面尺寸] PDF尺寸: ${pdfWidth.toFixed(2)}×${pdfHeight.toFixed(2)}, Viewport尺寸: ${viewport.width.toFixed(2)}×${viewport.height.toFixed(2)}`);
          // console.log(`🔄 [旋转信息] 页面${i + 1} 旋转角度: ${rotationDegrees}°`);

        // Canvas文字垂直居中修正函数
        const getVerticalCenterY = (baseY, fontSize) => {
          // Canvas的 textBaseline='middle' 经常不够精确
          // 手动调整以匹配SVG的 dominantBaseline='central' 效果
          return baseY + fontSize * 0.1; // 向下微调，通常需要字体大小的10%
        };

          // 高质量文字渲染函数（支持旋转）
          const renderHighQualityText = (context, text, x, y, fontSize, color, fontFamily, rotation = 0, verticalCenterOffsetRatio = 0.1) => {
          context.save(); // 保存当前状态

          // 如果需要旋转文字
          if (rotation !== 0) {
            context.translate(x, y); // 移动到文字位置
            context.rotate(rotation * Math.PI / 180); // 旋转（角度转弧度）
            // 重置坐标，因为已经translate了
            x = 0;
            y = 0;
          }

          context.fillStyle = color;
          context.font = `500 ${fontSize}px ${fontFamily}`;
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          // 启用高质量文字渲染
          context.textRenderingOptimization = 'optimizeQuality';
          context.fontKerning = 'auto';
          context.fontVariantCaps = 'normal';
          const correctedY = y + fontSize * verticalCenterOffsetRatio;
          context.fillText(text, x, correctedY);

          context.restore(); // 恢复状态
        };

        // 管段号的双线框高度很小。编辑态 SVG 与导出 Canvas 对同一字体的字形高度
        // 并不完全一致，不能再使用固定字号和经验偏移；按 Canvas 实测边界缩放并居中。
        const renderFittedPipeTagText = (context, text, fontSize, color, fontFamily, innerWidth, innerHeight) => {
          const safeText = String(text || '');
          const maxWidth = Math.max(1, innerWidth - 1.2);
          const maxHeight = Math.max(1, innerHeight - 1.2);
          let fittedSize = fontSize;
          let metrics;

          const measure = () => {
            context.font = `500 ${fittedSize}px ${fontFamily}`;
            metrics = context.measureText(safeText);
            const ascent = Number(metrics.actualBoundingBoxAscent) || fittedSize * 0.78;
            const descent = Number(metrics.actualBoundingBoxDescent) || fittedSize * 0.22;
            return {
              width: Number(metrics.width) || 0,
              ascent,
              descent,
              height: ascent + descent
            };
          };

          let bounds = measure();
          const widthRatio = bounds.width > 0 ? maxWidth / bounds.width : 1;
          const heightRatio = bounds.height > 0 ? maxHeight / bounds.height : 1;
          const fitRatio = Math.min(1, widthRatio, heightRatio);
          if (fitRatio < 1) {
            fittedSize = Math.max(1, fittedSize * fitRatio);
            bounds = measure();
          }

          context.fillStyle = color;
          context.textAlign = 'center';
          context.textBaseline = 'alphabetic';
          // actualBoundingBox 的基线坐标：center + (ascent - descent) / 2 才是视觉居中。
          const baselineY = (bounds.ascent - bounds.descent) / 2;
          context.fillText(safeText, 0, baselineY);
        };

        const renderSplitCircleAnnotation = (context, {
          x,
          y,
          radius,
          topText,
          bottomText,
          topFontSize,
          bottomFontSize,
          color,
          fontFamily,
          rotation = 0,
          lineWidth = 2
        }) => {
          context.save();
          context.translate(x, y);
          if (rotation !== 0) {
            context.rotate(rotation * Math.PI / 180);
          }

          context.beginPath();
          context.arc(0, 0, radius, 0, 2 * Math.PI);
          context.fillStyle = 'transparent';
          context.fill();
          context.strokeStyle = color;
          context.lineWidth = lineWidth;
          context.stroke();

          context.beginPath();
          context.moveTo(-radius * 0.86, 0);
          context.lineTo(radius * 0.86, 0);
          context.stroke();

          context.fillStyle = color;
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          context.textRenderingOptimization = 'optimizeQuality';
          context.fontKerning = 'auto';
          const textOffset = radius * 0.42;

          if (topText) {
            context.font = `500 ${topFontSize}px ${fontFamily}`;
            context.fillText(topText, 0, getVerticalCenterY(-textOffset, topFontSize));
          }

          if (bottomText) {
            context.font = `500 ${bottomFontSize}px ${fontFamily}`;
            context.fillText(bottomText, 0, getVerticalCenterY(textOffset, bottomFontSize));
          }

          context.restore();
        };

        // 高质量渲染标注
            pageAnnotations.forEach((annotation, index) => {

              
              // 解析颜色
              const color = annotation.color || '#FF0000';
              
              // 处理文字缩放逻辑
              let fontSize = annotation.fontSize || 34; // 与PDFViewer.js保持一致的默认值
              let displayText = annotation.text || '';
              // 圆形和菱形标注不采用项目自定义框尺寸。标注坐标使用
              // 2x PDF 坐标系，因此这里保存的直径/对角线在整页适配到
              // A3打印后严格等于10mm。
              const annotationForSizing = isFixedA3TenMmShape(annotation.borderShape)
                ? {
                    ...annotation,
                    frameSize: getFixedA3TenMmFrameSize({ width: exportWidth, height: exportHeight })
                  }
                : annotation;
              
              // 长方形框依靠框宽适配文字，不按字符数量改变字号。
               if (annotation.borderShape !== 'text-rectangle' && displayText.length >= 2) {
                 // 根据字符数量动态调整字体大小
                 if (displayText.length === 2) {
                     fontSize = Math.max(Math.round(fontSize * 0.85), 12); // 缩小到85%，最小12px
                   } else if (displayText.length === 3) {
                     fontSize = Math.max(Math.round(fontSize * 0.70), 12); // 缩小到70%，最小12px
                 } else if (displayText.length === 4) {
                    fontSize = Math.max(Math.round(fontSize * 0.50), 12); // 缩小到50%，最小12px
                 } else if (displayText.length >= 5) {
                   fontSize = Math.max(Math.round(fontSize * 0.40), 10); // 缩小到40%，最小10px
                 }

               }
          
          // 坐标转换：将查看器坐标转换为PDF坐标
          let scaledX = annotation.startX * coordinateScaleX;
          let scaledY = annotation.startY * coordinateScaleY;
          let scaledEndX = annotation.endX * coordinateScaleX;
          let scaledEndY = annotation.endY * coordinateScaleY;

          // 处理页面旋转：根据旋转角度调整坐标
          // 注意：pdfWidth和pdfHeight是PDF页面的原始尺寸（不受旋转影响）
          if (rotationDegrees === 180) {
            // 180度旋转：坐标需要相对于页面中心进行镜像
            const centerX = exportWidth / 2;
            const centerY = exportHeight / 2;

            // 镜像变换：(x, y) -> (2*centerX - x, 2*centerY - y)
            scaledX = 2 * centerX - scaledX;
            scaledY = 2 * centerY - scaledY;
            scaledEndX = 2 * centerX - scaledEndX;
            scaledEndY = 2 * centerY - scaledEndY;

          } else if (rotationDegrees === 90) {
            // 90度顺时针旋转：(x, y) -> (y, height - x)
            // 修复：使用PDF原始高度而非宽度进行变换
            const tempX = scaledX;
            const tempEndX = scaledEndX;
            scaledX = scaledY;
            scaledY = exportHeight - tempX;
            scaledEndX = scaledEndY;
            scaledEndY = exportHeight - tempEndX;

          } else if (rotationDegrees === 270) {
            // 270度顺时针旋转（90度逆时针）：(x, y) -> (width - y, x)
            // 修复：使用PDF原始宽度进行变换
            const tempX = scaledX;
            const tempEndX = scaledEndX;
            scaledX = exportWidth - scaledY;
            scaledY = tempX;
            scaledEndX = exportWidth - scaledEndY;
            scaledEndY = tempEndX;

          }
          // 使用平均缩放比例来保持字体比例
          const avgCoordinateScale = (coordinateScaleX + coordinateScaleY) / 2;
          // 根据字符数量和字母检测确定PDF导出时的字体缩放比例
          let pdfFontScale = 1.0; // 默认不缩放
          const hasLetter = /[a-zA-Z]/.test(displayText); // 检测是否包含字母
          
          if (annotation.borderShape !== 'text-rectangle' && hasLetter) {
             // 包含字母的情况
             if (displayText.length === 2) {
               pdfFontScale = 0.92; // 2个字符且包含字母，缩小到92%
             } else if (displayText.length === 3) {
               pdfFontScale = 0.88; // 3个字符且包含字母，缩小到88%
             }
             // 4个及以上字符且包含字母，不缩放(保持pdfFontScale = 1.0)
           }
          // 不包含字母的情况保持默认不缩放(pdfFontScale = 1.0)
          // 使用平均缩放比例来保持字体比例
          const scaledFontSize = fontSize * avgCoordinateScale * pdfFontScale; // 使用处理后的fontSize和PDF缩放比例

              // 计算标注位置
              let textX, textY;
              if (annotation.hasLeaderLine) {
            textX = scaledEndX;
            textY = scaledEndY;
                
                // 使用精确的连接点计算逻辑 (与PDFViewer.js一致)
                const shapeType = annotation.borderShape;
                let shapeSizeForConnection;
                const sizes = calculateAnnotationSize(displayText, fontSize, annotationForSizing); // 使用原始fontSize计算
                switch (shapeType) {
                  case 'circle':
                  case 'split-circle':
                  case 'shop-weld':
                    shapeSizeForConnection = sizes.circleRadius; // 不应用coordinateScale
                    break;
                  case 'diamond':
                  case 'field-weld':
                    shapeSizeForConnection = sizes.diamondRadius; // 不应用coordinateScale
                    break;
                  case 'rectangle':
                    shapeSizeForConnection = sizes.rectangleHalfSide; // 与实际绘制半边长一致
                    break;
                  case 'text-rectangle':
                    shapeSizeForConnection = {
                      width: sizes.textRectangleWidth,
                      height: sizes.textRectangleHeight
                    };
                    break;
                  case 'pipe-tag':
                    shapeSizeForConnection = getPipeTagSize(displayText, fontSize, annotation);
                    break;
                  default:
                    shapeSizeForConnection = sizes.circleRadius; // 不应用coordinateScale
                }

                const connection = calculateConnectionPoint(
                  annotation, 
                  shapeType, 
                  shapeSizeForConnection
                );
                
                // 只有在成功计算出连接点时才绘制引导线
                if (connection) {
                  let scaledConnectionX = connection.connectionX * coordinateScaleX;
                  let scaledConnectionY = connection.connectionY * coordinateScaleY;

                  // 对引导线连接点也应用旋转变换（与标注点变换保持一致）
                  if (rotationDegrees === 180) {
                    const centerX = exportWidth / 2;
                    const centerY = exportHeight / 2;
                    scaledConnectionX = 2 * centerX - scaledConnectionX;
                    scaledConnectionY = 2 * centerY - scaledConnectionY;
                  } else if (rotationDegrees === 90) {
                    // 90度旋转变换：与标注点变换保持一致
                    const tempX = scaledConnectionX;
                    scaledConnectionX = scaledConnectionY;
                    scaledConnectionY = exportHeight - tempX;
                  } else if (rotationDegrees === 270) {
                    // 270度旋转变换：与标注点变换保持一致
                    const tempX = scaledConnectionX;
                    scaledConnectionX = exportWidth - scaledConnectionY;
                    scaledConnectionY = tempX;
                  }

                  // 绘制引导线
                  annotContext.beginPath();
                  annotContext.lineWidth = 2 * avgCoordinateScale;
                  annotContext.strokeStyle = color;
                  annotContext.moveTo(scaledX, scaledY);
                  annotContext.lineTo(scaledConnectionX, scaledConnectionY); // 连接到精确计算的点
                  annotContext.stroke();
                }
                
                // 绘制起点小圆点
                annotContext.beginPath();
                annotContext.arc(scaledX, scaledY, 1 * avgCoordinateScale, 0, 2 * Math.PI);
                annotContext.fillStyle = color;
                annotContext.fill();
              } else {
            textX = scaledX;
            textY = scaledY;
              }
              
          // 计算标注尺寸（统一计算，避免重复）
          const sizes = calculateAnnotationSize(displayText, fontSize, annotationForSizing);
          

          
          // 根据边框形状渲染标注
          if (annotation.borderShape === 'circle') {
            // 圆形边框
            const radius = sizes.circleRadius * avgCoordinateScale;
                
            annotContext.beginPath();
            annotContext.arc(textX, textY, radius, 0, 2 * Math.PI);
            annotContext.fillStyle = 'transparent';
            annotContext.fill();
            annotContext.strokeStyle = color;
            annotContext.lineWidth = 2 * avgCoordinateScale; // 线条粗细与PDFViewer保持一致
            annotContext.stroke();
            
            // 文本 - 使用高质量字体渲染
            renderHighQualityText(annotContext, displayText, textX, textY, scaledFontSize, color, fontFamily, -rotationDegrees);
            
          } else if (annotation.borderShape === 'split-circle') {
            const radius = sizes.circleRadius * avgCoordinateScale;
            const topText = formatSplitCircleTopText(annotation.topText, annotation.jointTypeText);
            const defaultSplitFontSize = Math.max(scaledFontSize * 0.72, 6 * avgCoordinateScale);
            const topSplitFontSize = annotation.topFontSize
              ? annotation.topFontSize * avgCoordinateScale * pdfFontScale
              : 16 * avgCoordinateScale * pdfFontScale;
            const bottomSplitFontSize = annotation.bottomFontSize
              ? annotation.bottomFontSize * avgCoordinateScale * pdfFontScale
              : defaultSplitFontSize;
            renderSplitCircleAnnotation(annotContext, {
              x: textX,
              y: textY,
              radius,
              topText,
              bottomText: displayText,
              topFontSize: topSplitFontSize,
              bottomFontSize: bottomSplitFontSize,
              color,
              fontFamily,
              rotation: -rotationDegrees,
              lineWidth: 2 * avgCoordinateScale
            });

          } else if (annotation.borderShape === 'field-weld') {
            // 现场焊缝：菱形 + 两根平行线
            const diamondRadius = sizes.diamondRadius * avgCoordinateScale;
            const diagonalLength = sizes.diagonalLength * avgCoordinateScale;
            const weldLineOffset = diagonalLength * 0.12;
            const diamondWidthAtOffset = diamondRadius - Math.abs(weldLineOffset);
            const weldLineLength = diamondWidthAtOffset * 2;
            
            // 菱形边框（菱形不需要旋转，在各个角度看起来都一样）
                   annotContext.beginPath();
            annotContext.moveTo(textX, textY - diamondRadius);
            annotContext.lineTo(textX + diamondRadius, textY);
            annotContext.lineTo(textX, textY + diamondRadius);
            annotContext.lineTo(textX - diamondRadius, textY);
                   annotContext.closePath();
                   annotContext.fillStyle = 'transparent';
                   annotContext.fill();
                   annotContext.strokeStyle = color;
            annotContext.lineWidth = 2 * avgCoordinateScale; // 线条粗细与PDFViewer保持一致
                   annotContext.stroke();
                   
            // 平行线 - 根据页面旋转调整方向
            // 计算旋转后的线条偏移坐标
            let offsetX1, offsetY1, offsetX2, offsetY2;
            let lengthX1, lengthY1, lengthX2, lengthY2;
            
            if (rotationDegrees === 0) {
              // 0度：水平平行线
              offsetX1 = 0; offsetY1 = -weldLineOffset; // 上线偏移
              offsetX2 = 0; offsetY2 = weldLineOffset;  // 下线偏移
              lengthX1 = lengthX2 = weldLineLength / 2; // 水平长度的一半
              lengthY1 = lengthY2 = 0; // 垂直长度为0
            } else if (rotationDegrees === 90) {
              // 90度：垂直平行线
              offsetX1 = weldLineOffset; offsetY1 = 0;  // 右线偏移
              offsetX2 = -weldLineOffset; offsetY2 = 0; // 左线偏移
              lengthX1 = lengthX2 = 0; // 水平长度为0
              lengthY1 = lengthY2 = weldLineLength / 2; // 垂直长度的一半
            } else if (rotationDegrees === 180) {
              // 180度：水平平行线（反向）
              offsetX1 = 0; offsetY1 = weldLineOffset;  // 下线偏移
              offsetX2 = 0; offsetY2 = -weldLineOffset; // 上线偏移
              lengthX1 = lengthX2 = weldLineLength / 2; // 水平长度的一半
              lengthY1 = lengthY2 = 0; // 垂直长度为0
            } else if (rotationDegrees === 270) {
              // 270度：垂直平行线（反向）
              offsetX1 = -weldLineOffset; offsetY1 = 0; // 左线偏移
              offsetX2 = weldLineOffset; offsetY2 = 0;  // 右线偏移
              lengthX1 = lengthX2 = 0; // 水平长度为0
              lengthY1 = lengthY2 = weldLineLength / 2; // 垂直长度的一半
            }
            
                   annotContext.beginPath();
            // 第一条平行线
            annotContext.moveTo(textX + offsetX1 - lengthX1, textY + offsetY1 - lengthY1);
            annotContext.lineTo(textX + offsetX1 + lengthX1, textY + offsetY1 + lengthY1);
            // 第二条平行线
            annotContext.moveTo(textX + offsetX2 - lengthX2, textY + offsetY2 - lengthY2);
            annotContext.lineTo(textX + offsetX2 + lengthX2, textY + offsetY2 + lengthY2);
                   annotContext.stroke();
            
            // 文本 - 使用高质量字体渲染（现场焊缝字体稍小）
            const fieldWeldFontSize = scaledFontSize * 0.9; // 现场焊缝字体缩小到90%
            // 根据页面旋转角度调整文本偏移方向
            const baseOffset = weldLineOffset * 0.6 + (11 * avgCoordinateScale);
            let finalTextX = textX;
            let finalTextY = textY;
            
            if (rotationDegrees === 0) {
              // 0度：文本在平行线上方
              finalTextY = textY - baseOffset;
            } else if (rotationDegrees === 90) {
              // 90度：文本在平行线左侧
              finalTextX = textX - baseOffset;
            } else if (rotationDegrees === 180) {
              // 180度：文本在平行线下方
              finalTextY = textY + baseOffset;
            } else if (rotationDegrees === 270) {
              // 270度：文本在平行线右侧
              finalTextX = textX + baseOffset;
            }
            
            renderHighQualityText(annotContext, displayText, finalTextX, finalTextY, fieldWeldFontSize, color, fontFamily, -rotationDegrees);
            
          } else if (annotation.borderShape === 'shop-weld') {
            // 车间焊缝：圆形 + 两根平行线
            const circleRadius = sizes.circleRadius * avgCoordinateScale;
            const diagonalLength = sizes.diagonalLength * avgCoordinateScale;
            const weldLineOffset = diagonalLength * 0.12;
            const intersectionDistance = Math.sqrt(circleRadius * circleRadius - weldLineOffset * weldLineOffset);
            const weldLineLength = intersectionDistance * 2;
            
            // 圆形边框（圆形不需要旋转）
                   annotContext.beginPath();
            annotContext.arc(textX, textY, circleRadius, 0, 2 * Math.PI);
                   annotContext.fillStyle = 'transparent';
                   annotContext.fill();
                   annotContext.strokeStyle = color;
            annotContext.lineWidth = 2 * avgCoordinateScale; // 线条粗细与PDFViewer保持一致
                   annotContext.stroke();
                   
            // 平行线 - 根据页面旋转调整方向
            // 计算旋转后的线条偏移坐标
            let offsetX1, offsetY1, offsetX2, offsetY2;
            let lengthX1, lengthY1, lengthX2, lengthY2;
            
            if (rotationDegrees === 0) {
              // 0度：水平平行线
              offsetX1 = 0; offsetY1 = -weldLineOffset; // 上线偏移
              offsetX2 = 0; offsetY2 = weldLineOffset;  // 下线偏移
              lengthX1 = lengthX2 = weldLineLength / 2; // 水平长度的一半
              lengthY1 = lengthY2 = 0; // 垂直长度为0
            } else if (rotationDegrees === 90) {
              // 90度：垂直平行线
              offsetX1 = weldLineOffset; offsetY1 = 0;  // 右线偏移
              offsetX2 = -weldLineOffset; offsetY2 = 0; // 左线偏移
              lengthX1 = lengthX2 = 0; // 水平长度为0
              lengthY1 = lengthY2 = weldLineLength / 2; // 垂直长度的一半
            } else if (rotationDegrees === 180) {
              // 180度：水平平行线（反向）
              offsetX1 = 0; offsetY1 = weldLineOffset;  // 下线偏移
              offsetX2 = 0; offsetY2 = -weldLineOffset; // 上线偏移
              lengthX1 = lengthX2 = weldLineLength / 2; // 水平长度的一半
              lengthY1 = lengthY2 = 0; // 垂直长度为0
            } else if (rotationDegrees === 270) {
              // 270度：垂直平行线（反向）
              offsetX1 = -weldLineOffset; offsetY1 = 0; // 左线偏移
              offsetX2 = weldLineOffset; offsetY2 = 0;  // 右线偏移
              lengthX1 = lengthX2 = 0; // 水平长度为0
              lengthY1 = lengthY2 = weldLineLength / 2; // 垂直长度的一半
            }
            
                   annotContext.beginPath();
            // 第一条平行线
            annotContext.moveTo(textX + offsetX1 - lengthX1, textY + offsetY1 - lengthY1);
            annotContext.lineTo(textX + offsetX1 + lengthX1, textY + offsetY1 + lengthY1);
            // 第二条平行线
            annotContext.moveTo(textX + offsetX2 - lengthX2, textY + offsetY2 - lengthY2);
            annotContext.lineTo(textX + offsetX2 + lengthX2, textY + offsetY2 + lengthY2);
                   annotContext.stroke();
            
            // 文本 - 使用高质量字体渲染（车间焊缝字体稍小）
            const shopWeldFontSize = scaledFontSize * 0.8; // 车间焊缝字体缩小到80%
            // 根据页面旋转角度调整文本偏移方向
            const baseOffset = weldLineOffset * 0.6 + (13 * avgCoordinateScale);
            let finalTextX = textX;
            let finalTextY = textY;
            
            if (rotationDegrees === 0) {
              // 0度：文本在平行线上方
              finalTextY = textY - baseOffset;
            } else if (rotationDegrees === 90) {
              // 90度：文本在平行线左侧
              finalTextX = textX - baseOffset;
            } else if (rotationDegrees === 180) {
              // 180度：文本在平行线下方
              finalTextY = textY + baseOffset;
            } else if (rotationDegrees === 270) {
              // 270度：文本在平行线右侧
              finalTextX = textX + baseOffset;
            }
            
            renderHighQualityText(annotContext, displayText, finalTextX, finalTextY, shopWeldFontSize, color, fontFamily, -rotationDegrees);
                
          } else if (annotation.borderShape === 'diamond') {
            // 菱形边框
            const diamondRadius = sizes.diamondRadius * avgCoordinateScale;
                
                annotContext.beginPath();
            annotContext.moveTo(textX, textY - diamondRadius);
            annotContext.lineTo(textX + diamondRadius, textY);
            annotContext.lineTo(textX, textY + diamondRadius);
            annotContext.lineTo(textX - diamondRadius, textY);
            annotContext.closePath();
                annotContext.fillStyle = 'transparent';
                annotContext.fill();
                annotContext.strokeStyle = color;
            annotContext.lineWidth = 2 * avgCoordinateScale; // 线条粗细与PDFViewer保持一致
                annotContext.stroke();
                
                // 文本 - 使用高质量字体渲染
                renderHighQualityText(annotContext, displayText, textX, textY, scaledFontSize, color, fontFamily, -rotationDegrees);
                
          } else if (annotation.borderShape === 'rectangle') {
            // 矩形边框
            const rectangleHalfSide = sizes.rectangleHalfSide * avgCoordinateScale;
                 
                 annotContext.beginPath();
            annotContext.rect(textX - rectangleHalfSide, textY - rectangleHalfSide, rectangleHalfSide * 2, rectangleHalfSide * 2);
                 annotContext.fillStyle = 'transparent';
                 annotContext.fill();
                 annotContext.strokeStyle = color;
            annotContext.lineWidth = 2 * avgCoordinateScale; // 线条粗细与PDFViewer保持一致
                 annotContext.stroke();
                 
            // 文本 - 使用高质量字体渲染
            renderHighQualityText(annotContext, displayText, textX, textY, scaledFontSize, color, fontFamily, -rotationDegrees);

          } else if (annotation.borderShape === 'text-rectangle') {
            const boxWidth = sizes.textRectangleWidth * avgCoordinateScale;
            const boxHeight = sizes.textRectangleHeight * avgCoordinateScale;
            // 坐标已从旋转后的查看器转换回原 PDF 坐标。长方形不是正方形，
            // 因此必须连同文字一起反向旋转页面角度；只转换中心坐标会造成 90° 偏转。
            const rectangleRotation = -rotationDegrees;
            annotContext.save();
            annotContext.translate(textX, textY);
            if (rectangleRotation !== 0) {
              annotContext.rotate(rectangleRotation * Math.PI / 180);
            }
            annotContext.beginPath();
            annotContext.rect(-boxWidth / 2, -boxHeight / 2, boxWidth, boxHeight);
            annotContext.fillStyle = 'transparent';
            annotContext.fill();
            annotContext.strokeStyle = color;
            annotContext.lineWidth = 2 * avgCoordinateScale;
            annotContext.stroke();

            renderHighQualityText(annotContext, displayText, 0, 0, scaledFontSize, color, fontFamily, 0);
            annotContext.restore();
                
          } else if (annotation.borderShape === 'pipe-tag') {
            const tag = getPipeTagSize(displayText, fontSize, annotation);
            const tagWidth = tag.width * avgCoordinateScale;
            const tagHeight = tag.height * avgCoordinateScale;
            const tagInset = tag.inset * avgCoordinateScale;
            const tagX = textX - tagWidth / 2;
            const tagY = textY - tagHeight / 2;
            const tagRotation = (Number(annotation.rotation) || 0) - rotationDegrees;
            
            annotContext.save();
            annotContext.translate(textX, textY);
            annotContext.rotate(tagRotation * Math.PI / 180);
            annotContext.beginPath();
            annotContext.rect(-tagWidth / 2, -tagHeight / 2, tagWidth, tagHeight);
            annotContext.fillStyle = 'transparent';
            annotContext.fill();
            annotContext.strokeStyle = color;
            annotContext.lineWidth = Math.max(1, 1.5 * avgCoordinateScale);
            annotContext.stroke();
            
            annotContext.beginPath();
            annotContext.rect(
              -tagWidth / 2 + tagInset,
              -tagHeight / 2 + tagInset,
              tagWidth - tagInset * 2,
              tagHeight - tagInset * 2
            );
            annotContext.strokeStyle = color;
            annotContext.lineWidth = Math.max(0.75, 0.9 * avgCoordinateScale);
            annotContext.stroke();
            
            renderFittedPipeTagText(
              annotContext,
              displayText,
              scaledFontSize,
              color,
              fontFamily,
              tagWidth - tagInset * 2,
              tagHeight - tagInset * 2
            );
            annotContext.restore();
                
              } else {
                // 普通文本标注 - 使用高质量字体渲染
                renderHighQualityText(annotContext, displayText, textX, textY, scaledFontSize, color, 'sans-serif', -rotationDegrees);
              }
          

            });
          
          // Keep the exact same lossless PNG pixels, but avoid the synchronous
          // Base64 conversion and its ~33% temporary memory overhead.
          let annotPngBytes = null;
          let annotImage = null;
          try {
            annotPngBytes = await canvasToPngBytes(annotCanvas);
            annotImage = await pdfDoc.embedPng(annotPngBytes);
          } finally {
            // embedPng decodes pixels but does not yet embed/compress them.
            // Release the Canvas before compression, then finish this image
            // below so pdfDoc.images does not retain raw pixels for every page.
            annotCanvas.width = 0;
            annotCanvas.height = 0;
            annotPngBytes = null;
          }

          await annotImage.embed();

          // 将标注图像嵌入到PDF页面
          const pdfPage = pages[pageIndex];
          
          // 修复：确保Canvas图像尺寸与PDF页面尺寸匹配
          // Canvas实际尺寸是 viewport.width * canvasScale, viewport.height * canvasScale
          // PDF页面尺寸是 width, height
          // 需要确保图像正确缩放以匹配PDF页面


          pdfPage.drawImage(annotImage, {
            x: exportBox.x,
            y: exportBox.y,
            width: exportWidth,
            height: exportHeight,
            opacity: 1
          });
          annotImage = null;
          completedExportPages += 1;
          onProgress?.({ phase: 'rendering', completedPages: completedExportPages, totalPages: totalExportPages, pageNumber: pageNum });
          // Yield by elapsed main-thread time rather than absolute PDF page
          // number. This changes scheduling only; rendered pixels stay intact.
          if (performance.now() - lastMainThreadYieldAt >= 16) {
            await new Promise(resolve => setTimeout(resolve, 0));
            lastMainThreadYieldAt = performance.now();
          }
        }
      }
        const t1 = performance.now();
        console.log(`✅ 所有标注渲染完成，总耗时: ${(t1 - t0).toFixed(2)}ms`);
    }
    
    // 将标注信息保存到PDF元数据中（根据参数决定是否保存）
    if (saveMetadata) {
      onProgress?.({ phase: 'metadata' });
      try {
        console.log('💾 正在将标注信息保存到PDF...');
        
        // 准备要保存的标注数据
        const annotationData = {
          annotations: annotations,
          timestamp: new Date().toISOString(),
          version: '1.0'
        };
        
        // 将标注数据序列化为JSON字符串
        const annotationJSON = JSON.stringify(annotationData);
        const annotationSize = new Blob([annotationJSON]).size;
        
        console.log(`📊 标注数据大小: ${(annotationSize / 1024).toFixed(2)} KB (${annotations.length}个标注)`);
        
        // 根据数据大小选择存储方式
        // Keywords字段限制较小（通常<32KB），对于大量标注使用附件方式
        const USE_ATTACHMENT_THRESHOLD = 30 * 1024; // 30KB阈值
        
        if (annotationSize > USE_ATTACHMENT_THRESHOLD) {
          // 方案B: 使用PDF附件存储（支持大数据量）
          console.log('📎 数据量较大，使用PDF附件方式存储...');
          
          try {
            // 将JSON字符串转换为Uint8Array
            const encoder = new TextEncoder();
            const jsonBytes = encoder.encode(annotationJSON);
            
            const { PDFName, PDFString, PDFDict, PDFHexString, PDFDocument: PDFDocClass } = window.PDFLib;
            
            // 🚀 性能优化：只在必要时重建PDF（删除旧附件）
            // 检查是否存在旧的 annotations.json 附件
            let needRebuild = false;
            
            // 方法1：尝试通过catalog.get()方法检测（可能失败）
            try {
              const catalog = pdfDoc.catalog;
              const namesDict = catalog.get(PDFName.of('Names'));
              if (namesDict) {
                const embeddedFilesDict = namesDict.get(PDFName.of('EmbeddedFiles'));
                if (embeddedFilesDict) {
                  const namesArray = embeddedFilesDict.get(PDFName.of('Names'));
                  if (namesArray && namesArray.length > 0) {
                    for (let i = 0; i < namesArray.length; i += 2) {
                      const fileName = namesArray[i];
                      const fileNameStr = fileName?.toString?.().replace(/[()]/g, '') || '';
                      if (fileNameStr === 'annotations.json') {
                        needRebuild = true;
                        break;
                      }
                    }
                  }
                }
              }
            } catch (e) {
              // 方法1失败，继续尝试方法2
            }
            
            // 方法2：如果方法1失败，遍历所有对象查找附件（更可靠）
            if (!needRebuild) {
              try {
                const attachmentRefs = pdfDoc.context.enumerateIndirectObjects();
                
                for (const [ref, obj] of attachmentRefs) {
                  try {
                    if (obj && obj.dict) {
                      const typeObj = obj.dict.get(PDFName.of('Type'));
                      if (typeObj?.toString() === '/Filespec') {
                        const fName = obj.dict.get(PDFName.of('F')) || obj.dict.get(PDFName.of('UF'));
                        const fileName = fName?.toString().replace(/[()]/g, '');
                        
                        if (fileName === 'annotations.json') {
                          needRebuild = true;
                          break;
                        }
                      }
                    }
                  } catch (objError) {
                    continue;
                  }
                }
              } catch (e) {
                // 方法2也失败，跳过重建
              }
            }
            
            // 如果检测到旧附件，重建PDF以清除旧数据
            if (needRebuild) {
              console.log('🔄 检测到旧附件，重建PDF以清除旧数据...');
              
              const t0 = performance.now();
              const newPdfDoc = await PDFDocClass.create();
              
              // 复制所有页面
              const pageCount = pdfDoc.getPageCount();
              const copiedPages = await newPdfDoc.copyPages(pdfDoc, Array.from({length: pageCount}, (_, i) => i));
              copiedPages.forEach(page => newPdfDoc.addPage(page));
              
              // 复制元数据
              try {
                const title = pdfDoc.getTitle();
                const author = pdfDoc.getAuthor();
                const subject = pdfDoc.getSubject();
                const creator = pdfDoc.getCreator();
                const producer = pdfDoc.getProducer();
                
                if (title) newPdfDoc.setTitle(title);
                if (author) newPdfDoc.setAuthor(author);
                if (subject) newPdfDoc.setSubject(subject);
                if (creator) newPdfDoc.setCreator(creator);
                if (producer) newPdfDoc.setProducer(producer);
              } catch (e) {
                // 忽略元数据复制错误
              }
              
              // 使用新的PDF文档
              pdfDoc = newPdfDoc;
              const t1 = performance.now();
              console.log(`✅ PDF重建完成，耗时: ${(t1 - t0).toFixed(2)}ms`);
            }
            
            // 创建嵌入文件流对象
            const fileStream = pdfDoc.context.flateStream(jsonBytes);
            const fileStreamRef = pdfDoc.context.register(fileStream);
            
            // 创建文件规范字典
            const fileSpecDict = pdfDoc.context.obj({
              Type: PDFName.of('Filespec'),
              F: PDFString.of('annotations.json'),
              UF: PDFString.of('annotations.json'),
              Desc: PDFString.of('PDF标注查看器标注数据'),
              EF: pdfDoc.context.obj({
                F: fileStreamRef
              })
            });
            
            const fileSpecRef = pdfDoc.context.register(fileSpecDict);
            
            // 创建Names数组（只包含新附件）
            const namesArray = [
              PDFString.of('annotations.json'),
              fileSpecRef
            ];
            
            // 创建EmbeddedFiles字典
            const embeddedFilesDict = pdfDoc.context.obj({
              Names: namesArray
            });
            const embeddedFilesDictRef = pdfDoc.context.register(embeddedFilesDict);
            
            // 创建Names字典
            const namesDict = pdfDoc.context.obj({
              EmbeddedFiles: embeddedFilesDictRef
            });
            const namesDictRef = pdfDoc.context.register(namesDict);
            
            // 设置到Catalog
            const catalog = pdfDoc.catalog;
            catalog.set(PDFName.of('Names'), namesDictRef);
            
            // 在Keywords中添加标记，表明使用了附件存储
            try {
              const attachmentMarker = 'ANNOTATION_DATA:PDF标注查看器:1.0:ATTACHMENT';
              let existingKeywords = null;
              try {
                existingKeywords = pdfDoc.getKeywords();
              } catch (e) {
                existingKeywords = null;
              }
              
              let newKeywords = [];
              if (existingKeywords && Array.isArray(existingKeywords)) {
                newKeywords = existingKeywords.filter(keyword => 
                  keyword && typeof keyword === 'string' && !keyword.includes('ANNOTATION_DATA:')
                );
              } else if (existingKeywords && typeof existingKeywords === 'string') {
                const keywords = existingKeywords.split(' ').filter(keyword => 
                  keyword && !keyword.includes('ANNOTATION_DATA:')
                );
                newKeywords = keywords;
              }
              
              newKeywords.push(attachmentMarker);
              pdfDoc.setKeywords(newKeywords);
            } catch (keywordError) {
              console.warn('⚠️ 设置附件标记失败，但附件已保存:', keywordError.message);
            }
            
            console.log(`✅ 已将 ${annotations.length} 个标注作为附件保存到PDF (${(annotationSize / 1024).toFixed(2)} KB)`);
            
          } catch (attachError) {
            console.error('❌ 附件保存失败，尝试使用Keywords方式:', attachError);
            throw attachError; // 抛出以进入fallback逻辑
          }
          
        } else {
          // 方案A: 使用Keywords字段存储（适合小数据量）
          console.log('📝 数据量适中，使用Keywords字段存储...');
        
        // 将标注数据保存到PDF的Keywords字段中
        // 使用格式：ANNOTATION_DATA:工具名称:版本:JSON数据
        const annotationKeyword = `ANNOTATION_DATA:PDF标注查看器:1.0:${annotationJSON}`;
        
        // 安全获取现有的keywords并保留非标注相关的内容
        let existingKeywords = null;
        try {
          existingKeywords = pdfDoc.getKeywords();
        } catch (keywordError) {
          console.warn('⚠️ 获取PDF现有Keywords失败，跳过合并:', keywordError.message);
          existingKeywords = null;
        }
        
        let newKeywords = [];
        
        if (existingKeywords && Array.isArray(existingKeywords)) {
          // 保留现有的非标注keywords，并过滤无效数据
          newKeywords = existingKeywords.filter(keyword => 
            keyword && typeof keyword === 'string' && !keyword.includes('ANNOTATION_DATA:')
          );
        } else if (existingKeywords && typeof existingKeywords === 'string') {
          // 处理字符串格式的keywords
          const keywords = existingKeywords.split(' ').filter(keyword => 
            keyword && !keyword.includes('ANNOTATION_DATA:')
          );
          newKeywords = keywords;
        }
        
        // 添加新的标注数据
        newKeywords.push(annotationKeyword);
        
        // 安全设置或更新Keywords字段
        try {
          pdfDoc.setKeywords(newKeywords);
            console.log(`✅ 已将 ${annotations.length} 个标注保存到PDF Keywords字段`);
        } catch (setKeywordError) {
          console.warn('⚠️ 设置PDF Keywords失败，尝试仅保存标注数据:', setKeywordError.message);
          // 如果设置失败，尝试只设置我们的标注数据
          try {
            pdfDoc.setKeywords([annotationKeyword]);
              console.log(`✅ 已将 ${annotations.length} 个标注保存到PDF Keywords字段（覆盖模式）`);
          } catch (finalError) {
              console.warn('⚠️ PDF Keywords保存失败，尝试使用附件方式...');
              throw finalError; // 抛出错误以便尝试附件方式
            }
          }
        }
        
      } catch (metadataError) {
        console.error('❌ 保存标注数据失败:', metadataError);
        
        // 最后的fallback：尝试使用附件方式（如果之前未尝试）
        try {
          const annotationData = {
            annotations: annotations,
            timestamp: new Date().toISOString(),
            version: '1.0'
          };
          const annotationJSON = JSON.stringify(annotationData);
          const encoder = new TextEncoder();
          const jsonBytes = encoder.encode(annotationJSON);
          
          // 使用低级API创建附件
          const { PDFName, PDFString } = window.PDFLib;
          const fileStream = pdfDoc.context.flateStream(jsonBytes);
          const fileStreamRef = pdfDoc.context.register(fileStream);
          
          const fileSpecDict = pdfDoc.context.obj({
            Type: PDFName.of('Filespec'),
            F: PDFString.of('annotations.json'),
            UF: PDFString.of('annotations.json'),
            Desc: PDFString.of('PDF标注查看器标注数据（fallback）'),
            EF: pdfDoc.context.obj({
              F: fileStreamRef
            })
          });
          
          const fileSpecRef = pdfDoc.context.register(fileSpecDict);
          const catalog = pdfDoc.catalog;
          let namesDict = catalog.get(PDFName.of('Names'));
          
          if (!namesDict) {
            namesDict = pdfDoc.context.obj({});
            catalog.set(PDFName.of('Names'), namesDict);
          }
          
          let embeddedFilesDict = namesDict.get(PDFName.of('EmbeddedFiles'));
          if (!embeddedFilesDict) {
            embeddedFilesDict = pdfDoc.context.obj({});
            namesDict.set(PDFName.of('EmbeddedFiles'), embeddedFilesDict);
          }
          
          let namesArray = embeddedFilesDict.get(PDFName.of('Names'));
          if (!namesArray) {
            namesArray = [];
          }
          
          // 将数组转换为可操作的格式
          const existingArray = Array.isArray(namesArray) ? [...namesArray] : [];
          
          // 删除旧的annotations.json附件（如果存在）
          const filteredArray = [];
          for (let i = 0; i < existingArray.length; i += 2) {
            const fileName = existingArray[i];
            const fileRef = existingArray[i + 1];
            const fileNameStr = fileName?.toString?.().replace(/[()]/g, '') || '';
            
            if (fileNameStr !== 'annotations.json') {
              filteredArray.push(fileName);
              filteredArray.push(fileRef);
            }
          }
          
          // 添加新的附件
          filteredArray.push(PDFString.of('annotations.json'));
          filteredArray.push(fileSpecRef);
          
          // 创建完全新的Embedded Files字典
          const newEmbeddedFilesDict = pdfDoc.context.obj({
            Names: filteredArray
          });
          const newEmbeddedFilesDictRef = pdfDoc.context.register(newEmbeddedFilesDict);
          
          // 创建完全新的Names字典
          const newNamesDict = pdfDoc.context.obj({
            EmbeddedFiles: newEmbeddedFilesDictRef
          });
          const newNamesDictRef = pdfDoc.context.register(newNamesDict);
          
          // 替换Catalog中的整个Names字典
          catalog.set(PDFName.of('Names'), newNamesDictRef);
          
          console.log('✅ 已创建并替换完整的Names字典');
          
          console.log('✅ 使用附件方式保存成功（fallback模式）');
        } catch (fallbackError) {
          console.error('❌ 所有保存方式均失败:', fallbackError);
          message.error('标注数据保存失败，但PDF文件仍会生成');
        }
      }
    } else {
      console.log('ℹ️ 跳过元数据保存（导出PDF模式）');
    }
      
    // 生成并返回PDF字节数据
    onProgress?.({ phase: 'serializing' });
    if (onProgress) await new Promise(resolve => setTimeout(resolve, 0));
    const { bytes: pdfBytes, blob: pdfBlob, diagnostics } = await savePdfWithTimeBudget(pdfDoc, {
      pdfLib: window.PDFLib,
      output,
      timeBudgetMs: includeImageAnnotations ? 16 : 12,
      chunkSizeBytes: includeImageAnnotations ? 8 * 1024 * 1024 : 4 * 1024 * 1024,
      onProgress: detail => onProgress?.({ phase: 'serializing', ...detail }),
    });
    const serializedPageCount = pdfDoc.getPageCount();
    const generatedOutput = pdfBlob || pdfBytes;
    const serializationLog = { ...diagnostics, pages: serializedPageCount, kind: includeImageAnnotations ? 'annotated' : 'editable' };
    window.__lastPdfSerializationTiming = serializationLog;
    console.info('[PDF封装耗时]', serializationLog);

    // Serialization has fully materialized the returned Uint8Array/Blob. Break
    // the large pdf-lib object graph now instead of waiting for a later V8 GC.
    // This does not alter the generated bytes or the download layout.
    let releasedIndirectObjects = 0;
    try {
      const indirectObjects = pdfDoc?.context?.indirectObjects;
      releasedIndirectObjects = Number(indirectObjects?.size || 0);
      if (Array.isArray(pages)) pages.length = 0;
      ['fonts', 'images', 'embeddedPages', 'embeddedFiles', 'javaScripts'].forEach(key => {
        if (Array.isArray(pdfDoc?.[key])) pdfDoc[key].length = 0;
      });
      indirectObjects?.clear?.();
    } catch (releaseError) {
      console.debug('[PDF导出内存释放] pdf-lib 对象释放延后:', releaseError?.message || releaseError);
    }
    pdfDoc = null;
    arrayBuffer = null;
    window.__lastPdfExportDocumentRelease = {
      releasedAt: new Date().toISOString(),
      kind: includeImageAnnotations ? 'annotated' : 'editable',
      pages: serializedPageCount,
      releasedIndirectObjects,
      blobAssemblyMode: diagnostics?.blobAssemblyMode || 'not-applicable'
    };
    // Give V8 one task boundary to reclaim the source copy and pdf-lib graph
    // before App starts the next export variant.
    await new Promise(resolve => setTimeout(resolve, 0));
    
    onProgress?.({ phase: 'generated' });
    return generatedOutput;
  };

  const decodePdfAttachmentStream = async (stream) => {
    if (!stream) return null;
    if (typeof stream.decode === 'function') {
      try {
        return stream.decode();
      } catch (error) {
        console.warn('PDF附件decode失败，尝试其他方式:', error.message);
      }
    }

    const contents = stream.contents || (typeof stream.getContents === 'function' ? stream.getContents() : null);
    if (!contents) return null;

    try {
      const { PDFName } = window.PDFLib;
      const filter = stream.dict?.get(PDFName.of('Filter'));
      if (filter?.toString?.().includes('FlateDecode') && window.pako) {
        return window.pako.inflate(contents);
      }
    } catch (error) {
      console.warn('PDF附件解压判断失败:', error.message);
    }

    return contents;
  };

  const readEditablePdfAnnotations = async (pdfDoc) => {
    const { PDFName } = window.PDFLib;
    const getPdfArrayLength = array => (
      Array.isArray(array) ? array.length : Number(array?.size?.() || 0)
    );
    const getPdfArrayItem = (array, index) => (
      Array.isArray(array) ? array[index] : array?.get?.(index)
    );

    const readFileSpec = async (fileSpecObj) => {
      if (!fileSpecObj) return null;
      const dict = fileSpecObj.dict || fileSpecObj;
      const getValue = name => {
        try {
          return typeof dict.get === 'function' ? dict.get(PDFName.of(name)) : null;
        } catch {
          return null;
        }
      };

      const fName = getValue('F') || getValue('UF');
      const fileName = fName?.toString?.().replace(/[()]/g, '');
      if (fileName !== 'annotations.json') return null;

      const efDictRef = getValue('EF');
      const efDict = efDictRef ? pdfDoc.context.lookup(efDictRef) || efDictRef : null;
      const embeddedFileRef = efDict?.get?.(PDFName.of('F'));
      if (!embeddedFileRef) return null;

      const embeddedFileStream = pdfDoc.context.lookup(embeddedFileRef);
      const bytes = await decodePdfAttachmentStream(embeddedFileStream);
      if (!bytes) return null;

      const jsonString = new TextDecoder().decode(bytes);
      return JSON.parse(jsonString);
    };

    try {
      const catalog = pdfDoc.catalog;
      const namesDictRef = catalog.get(PDFName.of('Names'));
      const namesDict = namesDictRef ? pdfDoc.context.lookup(namesDictRef) || namesDictRef : null;
      const embeddedFilesDictRef = namesDict?.get?.(PDFName.of('EmbeddedFiles'));
      const embeddedFilesDict = embeddedFilesDictRef ? pdfDoc.context.lookup(embeddedFilesDictRef) || embeddedFilesDictRef : null;
      const namesArray = embeddedFilesDict?.get?.(PDFName.of('Names'));

      if (namesArray) {
        const namesLength = getPdfArrayLength(namesArray);
        for (let i = 0; i < namesLength; i += 2) {
          const fileRef = getPdfArrayItem(namesArray, i + 1);
          const fileSpecObj = fileRef ? pdfDoc.context.lookup(fileRef) : null;
          const data = await readFileSpec(fileSpecObj);
          if (data?.annotations) return data;
        }
      }
    } catch (error) {
      console.warn('通过Names读取可编辑标注失败:', error.message);
    }

    try {
      const objects = pdfDoc.context.enumerateIndirectObjects();
      for (const [, obj] of objects) {
        const typeObj = obj?.dict?.get?.(PDFName.of('Type'));
        if (typeObj?.toString?.() !== '/Filespec') continue;
        const data = await readFileSpec(obj);
        if (data?.annotations) return data;
      }
    } catch (error) {
      console.warn('遍历PDF对象读取可编辑标注失败:', error.message);
    }

    try {
      const keywords = pdfDoc.getKeywords();
      const keywordString = Array.isArray(keywords) ? keywords.join(' ') : (keywords || '');
      const match = keywordString.match(/ANNOTATION_DATA:([^:]+):([^:]+):(.+)/);
      if (match && match[1] === 'PDF标注查看器' && match[3] !== 'ATTACHMENT') {
        return JSON.parse(match[3]);
      }
    } catch (error) {
      console.warn('从Keywords读取可编辑标注失败:', error.message);
    }

    return { annotations: [], version: '1.0' };
  };

  const writeEditablePdfAnnotations = async (pdfDoc, annotationData) => {
    const { PDFName, PDFString } = window.PDFLib;
    const annotationJSON = JSON.stringify(annotationData);
    const jsonBytes = new TextEncoder().encode(annotationJSON);

    const fileStream = pdfDoc.context.flateStream(jsonBytes);
    const fileStreamRef = pdfDoc.context.register(fileStream);
    const fileSpecDict = pdfDoc.context.obj({
      Type: PDFName.of('Filespec'),
      F: PDFString.of('annotations.json'),
      UF: PDFString.of('annotations.json'),
      Desc: PDFString.of('PDF标注查看器标注数据'),
      EF: pdfDoc.context.obj({
        F: fileStreamRef
      })
    });
    const fileSpecRef = pdfDoc.context.register(fileSpecDict);
    const embeddedFilesDict = pdfDoc.context.obj({
      Names: [
        PDFString.of('annotations.json'),
        fileSpecRef
      ]
    });
    const embeddedFilesDictRef = pdfDoc.context.register(embeddedFilesDict);
    const namesDict = pdfDoc.context.obj({
      EmbeddedFiles: embeddedFilesDictRef
    });
    const namesDictRef = pdfDoc.context.register(namesDict);
    pdfDoc.catalog.set(PDFName.of('Names'), namesDictRef);

    try {
      pdfDoc.setKeywords(['ANNOTATION_DATA:PDF标注查看器:1.0:ATTACHMENT']);
    } catch (error) {
      console.warn('设置合并PDF附件标记失败:', error.message);
    }
  };

  const handleMergeEditablePDF = useCallback(() => {
    setEditableMergeFiles([]);
    setEditableMergeVisible(true);
  }, []);

  const handleMergeEditablePdfFiles = useCallback((event) => {
    const files = Array.from(event.target.files || []).filter(file => /\.pdf$/i.test(file.name));
    setEditableMergeFiles(files);
  }, []);

  const handleRunEditablePdfMerge = useCallback(async () => {
    if (editableMergeFiles.length < 2) {
      message.warning('请至少选择2个可编辑版PDF');
      return;
    }

    setEditableMergeLoading(true);
    message.loading({ content: '正在合并可编辑版PDF...', key: 'mergeEditablePdf' });

    try {
      const { PDFDocument } = window.PDFLib;
      const mergedDoc = await PDFDocument.create();
      const mergedAnnotations = [];
      const summary = [];
      let pageOffset = 0;

      for (const file of editableMergeFiles) {
        const arrayBuffer = await file.arrayBuffer();
        const sourceDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
        const pageCount = sourceDoc.getPageCount();
        const annotationData = await readEditablePdfAnnotations(sourceDoc);
        const sourceAnnotations = Array.isArray(annotationData.annotations) ? annotationData.annotations : [];

        const copiedPages = await mergedDoc.copyPages(sourceDoc, Array.from({ length: pageCount }, (_, index) => index));
        copiedPages.forEach(page => mergedDoc.addPage(page));

        sourceAnnotations.forEach((annotation, index) => {
          const originalPage = Number(annotation.page || 1);
          mergedAnnotations.push({
            ...annotation,
            id: `merged-${Date.now()}-${pageOffset}-${index}-${annotation.id || ''}`,
            page: originalPage + pageOffset,
            sourceFileName: file.name
          });
        });

        summary.push({
          name: file.name,
          pageCount,
          annotationCount: sourceAnnotations.length
        });
        pageOffset += pageCount;
      }

      await writeEditablePdfAnnotations(mergedDoc, {
        annotations: mergedAnnotations,
        timestamp: new Date().toISOString(),
        version: '1.0',
        mergedFrom: summary
      });

      const pdfBytes = await mergedDoc.save({
        useObjectStreams: false,
        updateFieldAppearances: false
      });

      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:T]/g, '').slice(0, 14);
      link.href = URL.createObjectURL(blob);
      link.download = `合并可编辑版-${timestamp}.pdf`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 100);

      message.success({
        content: `合并完成：${editableMergeFiles.length} 个PDF，${pageOffset} 页，${mergedAnnotations.length} 个可编辑标注`,
        key: 'mergeEditablePdf',
        duration: 5
      });
      setEditableMergeVisible(false);
    } catch (error) {
      console.error('合并可编辑版PDF失败:', error);
      message.error({ content: `合并失败: ${error.message}`, key: 'mergeEditablePdf' });
    } finally {
      setEditableMergeLoading(false);
    }
  }, [editableMergeFiles]);

  const handleSplitEditablePDF = useCallback(() => {
    setEditableSplitFile(null);
    setEditableSplitMode('ranges');
    setEditableSplitRanges('');
    setEditableSplitVisible(true);
  }, []);

  const handleSplitEditablePdfFile = useCallback((event) => {
    const file = Array.from(event.target.files || []).find(item => /\.pdf$/i.test(item.name));
    setEditableSplitFile(file || null);
  }, []);

  const parseEditableSplitRanges = useCallback((text, pageCount) => {
    const segments = String(text || '')
      .split(/[,，;\n]+/)
      .map(item => item.trim())
      .filter(Boolean);

    if (segments.length === 0) {
      throw new Error('请填写页码范围，例如：1-5,6-10,11');
    }

    return segments.map(segment => {
      const match = segment.match(/^(\d+)(?:\s*[-~到]\s*(\d+))?$/);
      if (!match) {
        throw new Error(`页码范围格式不正确：${segment}`);
      }
      const start = Number(match[1]);
      const end = Number(match[2] || match[1]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start || end > pageCount) {
        throw new Error(`页码范围超出PDF页数：${segment}`);
      }
      return {
        label: start === end ? `${start}` : `${start}-${end}`,
        start,
        end
      };
    });
  }, []);

  const downloadEditablePdfBlob = useCallback((bytes, fileName) => {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 100);
  }, []);

  const handleRunEditablePdfSplit = useCallback(async () => {
    if (!editableSplitFile) {
      message.warning('请选择一份可编辑版PDF');
      return;
    }

    setEditableSplitLoading(true);
    message.loading({ content: '正在拆分可编辑版PDF...', key: 'splitEditablePdf' });

    try {
      const { PDFDocument } = window.PDFLib;
      const arrayBuffer = await editableSplitFile.arrayBuffer();
      const sourceDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
      const pageCount = sourceDoc.getPageCount();
      const annotationData = await readEditablePdfAnnotations(sourceDoc);
      const sourceAnnotations = Array.isArray(annotationData.annotations) ? annotationData.annotations : [];
      const ranges = editableSplitMode === 'single'
        ? Array.from({ length: pageCount }, (_, index) => ({ label: `${index + 1}`, start: index + 1, end: index + 1 }))
        : parseEditableSplitRanges(editableSplitRanges, pageCount);
      const baseName = editableSplitFile.name.replace(/\.pdf$/i, '') || '可编辑版PDF';
      let outputCount = 0;
      let annotationCount = 0;

      for (const range of ranges) {
        const splitDoc = await PDFDocument.create();
        const pageIndexes = Array.from(
          { length: range.end - range.start + 1 },
          (_, index) => range.start - 1 + index
        );
        const copiedPages = await splitDoc.copyPages(sourceDoc, pageIndexes);
        copiedPages.forEach(page => splitDoc.addPage(page));

        const splitAnnotations = sourceAnnotations
          .filter(annotation => {
            const page = Number(annotation.page || 1);
            return page >= range.start && page <= range.end;
          })
          .map((annotation, index) => ({
            ...annotation,
            id: `split-${Date.now()}-${range.start}-${index}-${annotation.id || ''}`,
            page: Number(annotation.page || 1) - range.start + 1,
            sourceFileName: editableSplitFile.name,
            sourcePage: Number(annotation.page || 1)
          }));

        annotationCount += splitAnnotations.length;
        await writeEditablePdfAnnotations(splitDoc, {
          annotations: splitAnnotations,
          timestamp: new Date().toISOString(),
          version: '1.0',
          splitFrom: {
            name: editableSplitFile.name,
            pageRange: range.label,
            sourcePageCount: pageCount
          }
        });

        const pdfBytes = await splitDoc.save({
          useObjectStreams: false,
          updateFieldAppearances: false
        });
        downloadEditablePdfBlob(pdfBytes, `${baseName}-第${range.label}页-可编辑版.pdf`);
        outputCount += 1;
      }

      message.success({
        content: `拆分完成：导出 ${outputCount} 份PDF，保留 ${annotationCount} 个可编辑标注`,
        key: 'splitEditablePdf',
        duration: 5
      });
      setEditableSplitVisible(false);
    } catch (error) {
      console.error('拆分可编辑版PDF失败:', error);
      message.error({ content: `拆分失败: ${error.message}`, key: 'splitEditablePdf' });
    } finally {
      setEditableSplitLoading(false);
    }
  }, [editableSplitFile, editableSplitMode, editableSplitRanges, parseEditableSplitRanges, downloadEditablePdfBlob]);

  const getSavedTrainingPipelineNumbersByPage = useCallback(() => {
    const result = {};
    const pages = Array.from(new Set((annotations || [])
      .map(annotation => Number(annotation?.page || 1))
      .filter(Number.isFinite)));
    pages.forEach(page => {
      const pageData = pageCache.getPageData(page) ||
        pageRecognitionData?.[page]?.data || pageRecognitionData?.[page] || {};
      const rawPipeline = pageData?.pipelineNumber || pageData?.pipeline?.text ||
        pageData?.pipeline ||
        pageData?.materials?.find(item => item?.pipelineNumber)?.pipelineNumber || '';
      if (!rawPipeline || typeof rawPipeline === 'object') return;
      result[page] = {
        pipelineNumber: rawPipeline,
        pipelineNumberRaw: pageData?.pipelineNumberRaw || rawPipeline,
        pipelineNumberSource: pageData?.pipelineNumberSource || (
          pageData?.pipelineSource ? 'inferred' : 'business_data'
        ),
        pipelineSource: pageData?.pipelineSource || ''
      };
    });
    return result;
  }, [annotations, pageCache, pageRecognitionData]);

  const handleConfirmWeldAiTrainingSample = useCallback(() => {
    if (!pdfFile || !pdfDocumentForBatchSizing) {
      message.warning('请先打开PDF并等待页面加载完成');
      return;
    }
    if (!annotations.length) {
      message.warning('当前没有可确认的焊口标注');
      return;
    }
    const pipelineNumberByPage = getSavedTrainingPipelineNumbersByPage();
    const trainingSummary = summarizeConfirmedWeldLabels(annotations, { pipelineNumberByPage });
    if (!trainingSummary.validCount) {
      message.warning('没有可提交的有效引线焊点；请确认焊口标注带有连接管道的引线');
      return;
    }
    const rejectedPages = Array.from(new Set(trainingSummary.rejected.map(item => item.page))).sort((a, b) => a - b);
    const project = getCurrentProjectContext();
    const isShenyuan = usesPageScopedMaterials(project) || /申远/i.test(String(pdfFileName || pdfFile?.name || ''));
    Modal.confirm({
      title: '确认提交焊点训练样本',
      width: 560,
      content: (
        <div>
          <p>训练位置取引线远离标注圈、连接管道的一端，不读取标注圈位置。</p>
          <p>
            本次可提交 {trainingSummary.validCount} 个引线焊点：编号 {trainingSummary.numberedCount} 个，
            接头形式 {trainingSummary.jointTypeCount} 个，管线号 {trainingSummary.pipelineCount} 个，
            四要素齐全 {trainingSummary.fullyQualifiedCount} 个。
          </p>
          {trainingSummary.pipelineCount < trainingSummary.validCount && (
            <p style={{ color: '#fa8c16' }}>
              有 {trainingSummary.validCount - trainingSummary.pipelineCount} 个焊点缺少可确认管线号
              {trainingSummary.missingPipelinePages.length
                ? `（页码：${trainingSummary.missingPipelinePages.join('、')}）`
                : ''}；这些标签不会猜测管线号，请先在右侧标注信息中补充后再提交。
            </p>
          )}
          {trainingSummary.rejected.length > 0 && (
            <p style={{ color: '#fa8c16' }}>
              另有 {trainingSummary.rejected.length} 个标注因无引线或端点不明确而跳过
              {rejectedPages.length ? `（页码：${rejectedPages.join('、')}）` : ''}。
            </p>
          )}
          <p>首次验收请先“导出训练包”，抽查 audit 目录中的20页端点图。</p>
          <p>只有本次点击确认的数据会进入训练样本；草稿、普通保存和导出不会自动提交。</p>
          {!isShenyuan && (
            <p style={{ color: '#fa8c16' }}>当前文件将按当前项目名称归档为通用训练样本，请确认图纸类型。</p>
          )}
        </div>
      ),
      okText: '确认并提交',
      cancelText: '取消',
      onOk: async () => {
        setWeldAiSampleSubmitting(true);
        message.loading({ content: '正在准备并提交焊点训练样本...', key: 'weldAiSample', duration: 0 });
        try {
          const result = await weldAiService.submitConfirmedAnnotations({
            pdfDocument: pdfDocumentForBatchSizing,
            pdfFile,
            annotations,
            pipelineNumberByPage,
            projectName: project.projectName,
            onProgress: (current, total, step) => message.loading({
              content: `${step}（${current}/${total}）`,
              key: 'weldAiSample',
              duration: 0
            })
          });
          if (result.queued > 0) {
            const firstReason = result.queueReasons?.[0]?.reason || '远端未确认接收';
            const content = result.uploaded > 0
              ? `远端仅接收 ${result.uploaded} 页；其余 ${result.queued} 页仅保存到本机待传队列：${firstReason}`
              : `远端未接收样本。${result.queued} 页仅保存到本机待传队列：${firstReason}`;
            console.warn('[WeldAI] 本次训练样本未完全上传', {
              uploaded: result.uploaded,
              queued: result.queued,
              queueReasons: result.queueReasons || []
            });
            message.warning({
              content,
              key: 'weldAiSample',
              duration: 10
            });
          } else {
            message.success({
              content: `训练样本已上传：${result.pages}页、${result.labels}个焊点；编号${result.numberedLabels}个、接头${result.jointTypeLabels}个、管线号${result.pipelineLabels}个、四要素齐全${result.fullyQualifiedLabels}个`,
              key: 'weldAiSample',
              duration: 6
            });
          }
        } catch (error) {
          console.error('确认焊点训练样本失败', error);
          if (error.sampleState === 'accepted') {
            message.warning({
              content: `远端已接收样本，但仍在保存；回执已保留，稍后会继续查询：${error.message}`,
              key: 'weldAiSample',
              duration: 10
            });
          } else if (error.sampleState === 'pending_local') {
            message.warning({
              content: `上传未完成，样本已保存在本机等待重试：${error.message}`,
              key: 'weldAiSample',
              duration: 10
            });
          } else {
            message.error({
              content: `训练样本确认失败：${error.message}`,
              key: 'weldAiSample',
              duration: 8
            });
          }
        } finally {
          setWeldAiSampleSubmitting(false);
        }
      }
    });
  }, [
    annotations,
    getSavedTrainingPipelineNumbersByPage,
    getCurrentProjectContext,
    pdfDocumentForBatchSizing,
    pdfFile,
    pdfFileName
  ]);

  const handleExportWeldAiTrainingSample = useCallback(async () => {
    if (!pdfFile || !pdfDocumentForBatchSizing) {
      message.warning('请先打开PDF并等待页面加载完成');
      return;
    }
    if (!annotations.length) {
      message.warning('当前没有可导出的焊口标注');
      return;
    }
    setWeldAiSampleExporting(true);
    message.loading({ content: '正在准备焊点训练包...', key: 'weldAiExport', duration: 0 });
    try {
      const project = getCurrentProjectContext();
      const pipelineNumberByPage = getSavedTrainingPipelineNumbersByPage();
      const result = await weldAiService.exportConfirmedAnnotations({
        pdfDocument: pdfDocumentForBatchSizing,
        pdfFile,
        annotations,
        pipelineNumberByPage,
        projectName: project.projectName,
        onProgress: (current, total, step) => message.loading({
          content: `${step}（${current}/${total}）`,
          key: 'weldAiExport',
          duration: 0
        })
      });
      const baseName = String(pdfFileName || pdfFile?.name || '焊点训练样本').replace(/\.pdf$/i, '');
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${baseName}-焊点AI训练包.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      message.success({
        content: `训练包已导出：${result.pages}页、${result.labels}个焊点；编号${result.numberedLabels}个、接头${result.jointTypeLabels}个、管线号${result.pipelineLabels}个、四要素齐全${result.fullyQualifiedLabels}个，含${result.auditPages || 0}页审计图`,
        key: 'weldAiExport',
        duration: 5
      });
    } catch (error) {
      console.error('导出焊点训练包失败', error);
      message.error({ content: `训练包导出失败：${error.message}`, key: 'weldAiExport' });
    } finally {
      setWeldAiSampleExporting(false);
    }
  }, [annotations, getCurrentProjectContext, getSavedTrainingPipelineNumbersByPage, pdfDocumentForBatchSizing, pdfFile, pdfFileName]);

  // 导出带标注的PDF功能
  const handleExportPDF = async (requestedMode = 'both') => {
    const exportMode = requestedMode === 'editable' ? 'editable' : 'both';
    const includeAnnotatedVersion = exportMode === 'both';
    if (window.__pdfExportInProgress) {
      message.info('PDF 正在导出，请等待当前任务完成');
      return;
    }
    if (!pdfFile) {
      message.warning('请先打开PDF文件');
      return;
    }

    if (annotations.length === 0) {
      message.warning('没有标注数据可导出');
      return;
    }

    window.__pdfExportInProgress = true;
    window.__lastPdfExportSelection = {
      mode: exportMode,
      startedAt: new Date().toISOString(),
      sourceBytes: Number(pdfFile?.size || pdfArrayBuffer?.byteLength || 0),
      pages: Number(totalPages || 0),
      annotations: annotations.length
    };
    window.dispatchEvent(new CustomEvent('pdf-export-state', { detail: { active: true } }));
    publishPdfExportProgress({
      start: true,
      percent: 0,
      status: includeAnnotatedVersion ? '正在准备导出可编辑版与标注版 PDF' : '正在准备导出可编辑版 PDF'
    });
    const exportReporter = kind => detail => {
      window.__lastPdfExportStage = { ...detail, kind, time: new Date().toISOString() };
      publishPdfExportProgress(getPdfExportProgress({ ...detail, kind }));
    };
    try {
      const t0 = performance.now();
      if (!isElectron()) {
        markAnnotationDraftDirty();
        await flushAnnotationDraft({ emergency: true });
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      
      // 生成基础文件名
      let baseFileName = pdfFileName || '标注文档';
      
      // 生成时间戳（格式：YYYYMMDD-HHMMSS）
      const now = new Date();
      const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
      
      // 🚀 性能优化：先生成可编辑版（更快，因为不需要渲染Canvas）
      console.log('📎 开始生成可编辑版PDF...');
      const t1 = performance.now();
      let editablePdfBytes = await generateAnnotatedPDFBytes(false, true, exportReporter('editable'));
      const t2 = performance.now();
      console.log(`✅ 可编辑版PDF生成完成，耗时: ${(t2 - t1).toFixed(2)}ms`);
      
      let editableBlob = new Blob([editablePdfBytes], { type: 'application/pdf' });
      
      // 下载可编辑版PDF
      const editableLink = document.createElement('a');
      const editableUrl = URL.createObjectURL(editableBlob);
      editableLink.href = editableUrl;
      editableLink.download = `${baseFileName}-可编辑版-${timestamp}.pdf`;
      editableLink.click();
      
      // Wait for the browser to accept the download, then remove every strong
      // reference before starting the much heavier annotated export.
      await new Promise(resolve => setTimeout(resolve, 150));
      setTimeout(() => URL.revokeObjectURL(editableUrl), 60000);
      editableLink.remove();
      editablePdfBytes = null;
      editableBlob = null;
      await new Promise(resolve => setTimeout(resolve, 0));

      if (!includeAnnotatedVersion) {
        const t3 = performance.now();
        console.log(`🎉 可编辑版PDF导出完成，总耗时: ${(t3 - t0).toFixed(2)}ms`);
        if (latestCloudAnnotationDraftRef.current) persistCloudAnnotationDraft(latestCloudAnnotationDraftRef.current);
        logLayoutQualityFinalization('pdf_export');
        logAnnotationSnapshot('pdf_export');
        publishPdfExportProgress({
          percent: 100,
          done: true,
          status: '可编辑版 PDF 已生成并交给浏览器下载，请查看浏览器下载列表。'
        });
        message.success({
          content: '已生成可编辑版并发起下载，请检查下载列表；恢复草稿已保留。',
          key: 'exportPdf',
          duration: 5
        });
        return;
      }
      
      // 第一份：生成标注版PDF（包含图像标注，但不保存元数据以避免重复）
      console.log('📄 开始生成标注版PDF...');
      
      const t3 = performance.now();
      let annotatedOutput = await generateAnnotatedPDFBytes(true, false, exportReporter('annotated'), 'blob');
      const t4 = performance.now();
      console.log(`✅ 标注版PDF生成完成，耗时: ${(t4 - t3).toFixed(2)}ms`);
      
      let annotatedBlob = annotatedOutput instanceof Blob
        ? annotatedOutput : new Blob([annotatedOutput], { type: 'application/pdf' });
      annotatedOutput = null;
      
      // 下载标注版PDF
      const annotatedLink = document.createElement('a');
      annotatedLink.href = URL.createObjectURL(annotatedBlob);
      annotatedBlob = null;
      annotatedLink.download = `${baseFileName}-标注版-${timestamp}.pdf`;
      
      // 延迟一下，避免两个下载同时触发
      publishPdfExportProgress({ percent: 99, status: '正在交给浏览器下载' });
      await new Promise(resolve => setTimeout(resolve, 100));
      annotatedLink.click();
      setTimeout(() => {
        URL.revokeObjectURL(annotatedLink.href);
        annotatedLink.remove();
      }, 60000);
      
      const t5 = performance.now();
      console.log(`🎉 所有PDF导出完成，总耗时: ${(t5 - t0).toFixed(2)}ms`);
      
      if (latestCloudAnnotationDraftRef.current) persistCloudAnnotationDraft(latestCloudAnnotationDraftRef.current);
      logLayoutQualityFinalization('pdf_export');
      logAnnotationSnapshot('pdf_export');
      publishPdfExportProgress({ percent: 100, done: true, status: '两份 PDF 已生成并交给浏览器下载，请查看浏览器下载列表。' });
      message.success({ 
        content: '已生成标注版和可编辑版并发起下载，请检查下载列表；恢复草稿已保留。',
        key: 'exportPdf',
        duration: 5
      });
    } catch (error) {
      console.error('导出PDF失败:', error);
      window.__lastPdfExportFailure = {
        ...window.__lastPdfExportStage,
        message: error.message,
        stack: error.stack,
        time: new Date().toISOString(),
      };
      console.error('[PDF导出失败阶段]', window.__lastPdfExportFailure);
      publishPdfExportProgress({ error: true, status: `导出失败：${error.message}` });
      message.error({ content: `导出PDF失败: ${error.message}`, key: 'exportPdf' });
    } finally {
      window.__pdfExportInProgress = false;
      window.dispatchEvent(new CustomEvent('pdf-export-state', { detail: { active: false } }));
    }
  };

  useEffect(() => {
    const localHost = ['127.0.0.1', 'localhost'].includes(window.location.hostname);
    const enabled = new URLSearchParams(window.location.search).get('codex-annotation-stress') === '1';
    if (!localHost || !enabled) return undefined;

    window.__luotuAnnotationStressApi = {
      addAnnotation: annotation => handleAnnotationAdd(annotation),
      goToPage: page => handlePageChange(Math.max(1, Math.min(Number(totalPages) || 1, Number(page) || 1))),
      flushDraft: options => flushAnnotationDraft(options),
      exportBoth: () => handleExportPDF('both'),
      getState: () => {
        const currentAnnotations = annotationsRef.current || [];
        return {
          annotations: currentAnnotations.length,
          annotatedPages: new Set(currentAnnotations.map(item => Number(item?.page)).filter(Boolean)).size,
          annotationJsonBytes: new Blob([JSON.stringify(currentAnnotations)]).size,
          history: undoRedoSystem.getHistoryInfo(),
          newlyAddedAnnotations: newlyAddedAnnotations.size,
          recognitionCache: pageCache.getStats(),
          lastLocalDraftSave: window.__luotuLastLocalDraftSave || null,
          localDraftSaveHistory: window.__luotuLocalDraftSaveHistory || [],
          currentPage: Number(currentPageForDraftRef.current) || 1,
          totalPages: Number(totalPages) || 0
        };
      },
      getPageAnnotationCount: page => (annotationsRef.current || [])
        .reduce((count, item) => count + (Number(item?.page) === Number(page) ? 1 : 0), 0),
      beginRecognitionStress: () => pageCache.enableBatchMode(Number(currentPageForDraftRef.current) || 1),
      seedRecognitionPage: (page, detectionCount = 80, materialCount = 20) => {
        const pageNum = Number(page) || 1;
        const detections = Array.from({ length: Number(detectionCount) || 0 }, (_, index) => ({
          id: `stress-detection-${pageNum}-${index}`,
          text: `OCR-${pageNum}-${index}-PIPE-WELD-MATERIAL`,
          confidence: 0.91,
          bbox: [index * 3, index * 2, index * 3 + 80, index * 2 + 24],
          points: [[index, index], [index + 80, index], [index + 80, index + 24], [index, index + 24]]
        }));
        const materials = Array.from({ length: Number(materialCount) || 0 }, (_, index) => ({
          materialId: `${pageNum}-${index}`,
          description: `STRESS MATERIAL DESCRIPTION PAGE ${pageNum} ITEM ${index}`,
          specification: `A106-B-${index % 8}`,
          materialCode: `CODE-${pageNum}-${index}`,
          quantity: String((index % 5) + 1),
          pipelineNumber: `PIPE-${String(pageNum).padStart(4, '0')}`,
          sourcePage: pageNum,
          rawLogicalRow: [`${index + 1}`, 'PIPE', 'A106-B', `CODE-${pageNum}-${index}`, '1']
        }));
        updatePageRecognitionData(pageNum, {
          drawingNumber: `DRAWING-${String(pageNum).padStart(4, '0')}`,
          pipelineNumber: `PIPE-${String(pageNum).padStart(4, '0')}`,
          pageNumber: String(pageNum),
          detections,
          materials,
          rawLogicalRows: materials.map(item => item.rawLogicalRow),
          scaffolds: materials.slice(0, 8).map((item, index) => ({
            id: `S-${pageNum}-${index}`,
            text: `SUPPORT-${index}`,
            sourcePage: pageNum
          }))
        }, true);
        updatePageRecognitionStatus(pageNum, 'completed', true);
      },
      finishRecognitionStress: page => {
        pageCache.cleanup(Number(page) || Number(totalPages) || 1);
        pageCache.disableBatchMode();
        return pageCache.getStats();
      },
      getRecognitionStressState: () => ({
        ...pageCache.getStats(),
        fullDataJsonBytes: new Blob([JSON.stringify(pageCache.dataStore || {})]).size,
        lightDataJsonBytes: new Blob([JSON.stringify(pageCache.lightDataStore || {})]).size,
        statusJsonBytes: new Blob([JSON.stringify(pageCache.statusStore || {})]).size
      })
    };
    return () => {
      delete window.__luotuAnnotationStressApi;
    };
  }, [
    flushAnnotationDraft,
    handleAnnotationAdd,
    newlyAddedAnnotations.size,
    pageCache,
    totalPages,
    undoRedoSystem,
    updatePageRecognitionData,
    updatePageRecognitionStatus
  ]);

  // Web端缩放样式
  const webZoomStyle = !isElectron() && webZoomFactor !== 1.0 ? {
    transform: `scale(${webZoomFactor})`,
    transformOrigin: 'top left',
    width: `${100 / webZoomFactor}%`,
    height: `${100 / webZoomFactor}%`
  } : {};
  const hasPdfOpen = Boolean(pdfFile);
  const showWelcomeDragOverlay = dragHintMode === 'welcome';
  const showReplaceDragHint = dragHintMode === 'replace';
  const selectedWeldAnnotationsForToolbar = useMemo(() => {
    const ids = selectedAnnotationIds.length > 0
      ? selectedAnnotationIds
      : [selectedAnnotation].filter(Boolean);
    if (!ids.length) return [];
    const idSet = new Set(ids);
    return annotations.filter(annotation => (
      idSet.has(annotation.id) &&
      annotation.remark !== '管段号'
    ));
  }, [annotations, selectedAnnotation, selectedAnnotationIds]);

  const selectedAnnotationFontTools = useMemo(() => {
    if (!selectedWeldAnnotationsForToolbar.length) {
      return { visible: false };
    }

    const hasSplit = selectedWeldAnnotationsForToolbar.some(annotation => annotation.borderShape === 'split-circle');
    const hasRegular = selectedWeldAnnotationsForToolbar.some(annotation => annotation.borderShape !== 'split-circle');
    const getCommonValue = (field) => {
      const values = selectedWeldAnnotationsForToolbar
        .map(annotation => annotation[field])
        .filter(value => value !== undefined && value !== null);
      if (!values.length) return undefined;
      return values.every(value => value === values[0]) ? values[0] : undefined;
    };

    return {
      visible: true,
      count: selectedWeldAnnotationsForToolbar.length,
      mixedType: hasSplit && hasRegular,
      type: hasSplit && !hasRegular ? 'split-circle' : 'regular',
      fontSize: getCommonValue('fontSize'),
      topFontSize: getCommonValue('topFontSize'),
      bottomFontSize: getCommonValue('bottomFontSize')
    };
  }, [selectedWeldAnnotationsForToolbar]);

  const handleSelectedAnnotationFontChange = useCallback((field, value) => {
    if (!field || value === undefined || value === null || !selectedWeldAnnotationsForToolbar.length) return;

    const hasSplit = selectedWeldAnnotationsForToolbar.some(annotation => annotation.borderShape === 'split-circle');
    const hasRegular = selectedWeldAnnotationsForToolbar.some(annotation => annotation.borderShape !== 'split-circle');
    if (hasSplit && hasRegular) {
      message.warning('普通标注和分栏圆形标注不能混合批量修改字体');
      return;
    }

    const updatesById = {};
    selectedWeldAnnotationsForToolbar.forEach(annotation => {
      if (annotation.borderShape === 'split-circle') {
        if (field !== 'topFontSize' && field !== 'bottomFontSize') return;
        updatesById[annotation.id] = { [field]: value };
      } else {
        if (field !== 'fontSize') return;
        updatesById[annotation.id] = { fontSize: value };
      }
    });

    if (Object.keys(updatesById).length === 0) return;
    handleBatchAnnotationUpdates(updatesById, `批量修改标注字体 (${Object.keys(updatesById).length}个)`);
  }, [handleBatchAnnotationUpdates, selectedWeldAnnotationsForToolbar]);

  return (
    <AppContainer
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      style={webZoomStyle}
    >
        <Toolbar
          currentPage={currentPage}
          totalPages={totalPages}
          scale={scale}
          onPageChange={handlePageChange}
          onScaleChange={handleScaleChange}
          onFileSelect={handleOpenPDFClick}

          onSearch={handleSearch}
          onSearchNext={handleSearchNext}
          onSearchPrev={handleSearchPrev}
          searchText={searchText}
          searchResults={searchResults}
          currentSearchIndex={currentSearchIndex}
          annotationMode={annotationMode}
          onToggleAnnotationMode={handleToggleAnnotationMode}
          // 移除不需要的标注工具相关props
          annotationColor={annotationColor}
          onAnnotationColorChange={setAnnotationColor}
          annotationFontSize={annotationFontSize}
          onAnnotationFontSizeChange={setAnnotationFontSize}
          annotationTopFontSize={annotationTopFontSize}
          onAnnotationTopFontSizeChange={setAnnotationTopFontSize}
          annotationBottomFontSize={annotationBottomFontSize}
          onAnnotationBottomFontSizeChange={setAnnotationBottomFontSize}
          annotationFrameSize={annotationFrameSize}
          onAnnotationFrameSizeChange={setAnnotationFrameSize}
          annotationBorderShape={annotationBorderShape}
          onAnnotationBorderShapeChange={handleAnnotationBorderShapeChange}
          annotationPipeTagRotation={annotationPipeTagRotation}
          onAnnotationPipeTagRotationChange={setAnnotationPipeTagRotation}
          annotationPipeTagZeroPadCount={annotationPipeTagZeroPadCount}
          onAnnotationPipeTagZeroPadCountChange={handleAnnotationPipeTagZeroPadCountChange}
          selectedAnnotationFontTools={selectedAnnotationFontTools}
          onSelectedAnnotationFontChange={handleSelectedAnnotationFontChange}
          onToggleRulesPanel={() => setRulesVisible(visible => !visible)}
          rulesPanelVisible={rulesVisible}
          onQuickSave={handleQuickSave}
          onPrint={handlePrint}
          onUndo={handleUndo}
          onRedo={handleRedo}
          canUndo={undoRedoSystem.canUndo}
          canRedo={undoRedoSystem.canRedo}
          onTogglePipeSegmentMode={handleTogglePipeSegmentMode}
          pipeSegmentMode={pipeSegmentMode}
          pipeSegmentStartLetter={pipeSegmentStartLetter}
          onPipeSegmentStartLetterChange={handlePipeSegmentStartLetterChange}
          pipeSegmentFontSize={pipeSegmentFontSize}
          onPipeSegmentFontSizeChange={handlePipeSegmentFontSizeChange}
          onResetPipeSegmentCounter={handleResetPipeSegmentCounterUI}
          onExportExcel={handleExportExcel}
          onExportPDF={handleExportPDF}
          onConfirmWeldAiTrainingSample={handleConfirmWeldAiTrainingSample}
          onExportWeldAiTrainingSample={handleExportWeldAiTrainingSample}
          weldAiSampleSubmitting={weldAiSampleSubmitting}
          weldAiSampleExporting={weldAiSampleExporting}
          onMergeEditablePDF={handleMergeEditablePDF}
          onSplitEditablePDF={handleSplitEditablePDF}
          templateUploaded={templateUploaded}
          pdfFile={pdfFile}
          ocrContext={ocrContext}
          enableMaterialEncoding={enableMaterialEncoding}
          onToggleMaterialEncoding={handleToggleMaterialEncoding}
          scaffoldTemplateUploaded={scaffoldTemplateUploaded}
          mixedTemplateUploaded={mixedTemplateUploaded}
          onUploadTritium={handleUploadTritium}
          // OCR服务状态相关
          ocrServerStatus={ocrServerStatus}
          mineruServerStatus={mineruServerStatus}
          onRestartOCRServer={handleRestartOCRServer}
          // 区域删除相关
          areaDeleteMode={areaDeleteMode}
          areaDeleteType={areaDeleteType}
          onToggleAreaDeleteMode={handleToggleAreaDeleteMode}
          // Web端缩放
          webZoomFactor={webZoomFactor}
          onWebZoomChange={handleWebZoomChange}
          canvasPerformanceMode={canvasPerformanceMode}
          onCanvasPerformanceModeChange={handleCanvasPerformanceModeChange}
          weldAdjustmentAvailable={weldAdjustmentToolbarState.available}
          weldAdjustmentMode={weldAdjustmentToolbarState.mode}
          onWeldAdjustmentAction={(key) => weldAdjustmentToolbarState.handleAction?.({ key })}
        />
        {!isElectron() && hasPdfOpen && cloudAnnotationDraftStatus !== 'idle' && (
          <CloudDraftStatusBadge $status={cloudAnnotationDraftStatus}>
            {cloudAnnotationDraftStatus === 'saving'
              ? '云端草稿保存中'
              : cloudAnnotationDraftStatus === 'error'
                ? '云端草稿保存失败'
                : '云端草稿已保存'}
          </CloudDraftStatusBadge>
        )}
        <ContentContainer>
          
          {/* 左侧统计面板 */}
          <StatsPanel 
            visible={true}
            stats={weldStats}
            debugButtonsRef={debugButtonsContainerRef}
            onUploadClick={handleH3yunUpload}
          />

          <MainContent>
            {!hasPdfOpen ? (
              // 没有打开PDF时显示欢迎屏幕
              <WelcomeScreen onFileSelect={handleOpenPDFClick} />
            ) : (
              // 已打开PDF时显示PDF查看器
              <PDFViewer
                key={forceUpdateKey}  // 添加key确保重新渲染
                file={pdfFile}
                pdfFilePath={pdfFilePath}
                currentPage={currentPage}
                scale={scale}
                canvasPerformanceMode={canvasPerformanceMode}
                viewMode={viewMode}
                onPageChange={handlePageChange}
                onScaleChange={handleScaleChange}
                onTotalPagesChange={setTotalPages}
                onPageSizeChange={setPageSize}
                onPdfDocumentChange={setPdfDocumentForBatchSizing}
                searchText={searchText}
                searchResults={searchResults}
                currentSearchIndex={currentSearchIndex}
                annotationMode={annotationMode}
                annotations={annotations}
                annotationPageIndex={annotationPageIndex}
                batchSequenceState={batchSequenceDraftState}
                onBatchSequenceStateChange={handleBatchSequenceStateChange}
                annotationColor={annotationColor}
                annotationFontSize={annotationFontSize}
                annotationTopFontSize={annotationTopFontSize}
                annotationBottomFontSize={annotationBottomFontSize}
                annotationFrameSize={annotationFrameSize}
                annotationBorderShape={annotationBorderShape}
                annotationPipeTagRotation={annotationPipeTagRotation}
                annotationPipeTagZeroPadCount={annotationPipeTagZeroPadCount}
                activeAnnotationRule={effectiveActiveAnnotationRule}
                annotationRules={annotationRules}
                onAnnotationAdd={handleAnnotationAddWithRule}
                onAnnotationUpdate={handleAnnotationUpdate}
                onAnnotationMoveCommit={handleAnnotationMoveCommit}
                onBatchAnnotationUpdates={handleBatchAnnotationUpdates}
                onAnnotationDelete={handleAnnotationDelete}
                onAddScaffoldAnnotation={handleAddScaffoldAnnotation}
                onBatchAddScaffoldAnnotations={handleBatchAddScaffoldAnnotations}
                onBatchAddAnnotations={handleBatchAddAnnotations}
                onApplyWeldAdjustment={handleApplyWeldAdjustment}
                selectedAnnotation={selectedAnnotation}
                selectedAnnotationIds={selectedAnnotationIds}
                onAnnotationClick={handleAnnotationClick}
                onAnnotationSelectionChange={handleAnnotationSelectionChange}
                onAnnotationEdit={handleAnnotationDirectEdit}
                pageRecognitionData={pageRecognitionData}
                onPageTextDetectionsChange={handlePageTextDetectionsChange}
                onMaterialRowsChange={handleMaterialRowsChange}
                materialRows={materialBindingRows}
                materialScope={usesPageScopedMaterials(getCurrentProjectContext()) ? 'page' : 'pipeline'}
                projectName={getCurrentProjectContext().projectName}
                onExecuteUndoableCommand={undoRedoSystem.executeCommand}
                recognitionCache={pageCache}
                pipeSegmentMode={pipeSegmentMode}
                pipeSegmentCounter={pipeSegmentCounter}
                onPipeSegmentCounterUpdate={setPipeSegmentCounter}
                pipeSegmentStartLetter={pipeSegmentStartLetter}
                pipeSegmentFontSize={pipeSegmentFontSize}
                generatePipeSegmentLetter={generatePipeSegmentLetter}
                rulesPanelVisible={rulesVisible}
                areaDeleteMode={areaDeleteMode}
                onAreaDelete={handleAreaDelete}
                onPdfPointerPositionChange={handlePdfPointerPositionChange}
                debugButtonsContainerRef={debugButtonsContainerRef}
                onWeldAdjustmentStateChange={setWeldAdjustmentToolbarState}
              />
            )}

            <ReplaceDragFrame $show={showReplaceDragHint} />
            <ReplaceDragBadge $show={showReplaceDragHint}>
              松开以替换当前 PDF
            </ReplaceDragBadge>
          </MainContent>
          
          <RulesPanelErrorBoundary
            resetKey={rulesVisible}
            onError={() => {
              setRulesVisible(false);
              message.error('右侧标注管理栏出现异常，已自动收起，落图内容未受影响');
            }}
          >
            <AnnotationRulesPanel
              visible={rulesVisible}
              rules={annotationRules}
              activeRule={activeAnnotationRule}
              onRulesChange={setAnnotationRules}
              onActiveRuleChange={setActiveAnnotationRule}
              continuousNumberingEnabled={continuousRuleNumberingEnabled}
              continuousNumber={continuousRuleNumber}
              onContinuousNumberingChange={handleContinuousRuleNumberingChange}
              onContinuousNumberChange={setContinuousRuleNumber}
              onWeldingAnnotate={handleWeldingAnnotate}
              annotationMode={annotationMode}
              annotations={annotations}
              currentPageAnnotations={currentPageAnnotations}
              currentPageAnnotationRevision={currentPageAnnotationRevision}
              onAnnotationClick={handleAnnotationClick}
              onAnnotationUpdate={handleAnnotationUpdate}
              onBatchAnnotationUpdates={handleBatchAnnotationUpdates}
              onAnnotationDelete={handleAnnotationDelete}
              onClearAllAnnotations={handleClearAllAnnotations}
              selectedAnnotation={selectedAnnotation}
              selectedAnnotationIds={selectedAnnotationIds}
              onAnnotationSelectionChange={handleAnnotationSelectionChange}
              onExecuteUndoableCommand={undoRedoSystem.executeCommand}
              onToggle={() => setRulesVisible(visible => !visible)}
              onAnnotationEditCallback={(handler) => {
                annotationEditHandlerRef.current = handler;
              }}
              materialRows={materialBindingRows}
              currentPage={currentPage}
              pdfDocument={pdfDocumentForBatchSizing}
            />
          </RulesPanelErrorBoundary>
        </ContentContainer>
        
        {/* OCR进度弹窗 */}
        <OCRProgressModal
          visible={progressModalVisible}
          onCancel={() => setProgressModalVisible(false)}
        />

        {/* 可视化识别结果面板 */}
        <VisualizationPanel
          visible={visualizationPanelVisible}
          recognitionData={recognitionData}
          recognitionStatus={recognitionStatus}
          onClose={() => {
            setVisualizationPanelVisible(false);
            // 关闭面板时不清除识别数据，保持页面状态
          }}
          onClearAll={handleClearAllRecognitionData}
          onClearCurrent={handleClearCurrentRecognitionData}
          onDataChange={handleRecognitionDataChange}
          currentPage={currentPage}
        />

        {/* OCR结果表格 */}
        <PdfExportProgress />
        <OCRResultsTable
          visible={ocrResultsVisible}
          onCancel={() => setOcrResultsVisible(false)}
          results={currentOcrResults}
          title="OCR识别结果与焊口关联"
          onExport={handleExportOcrResults}
          onAssociate={handleOcrAssociation}
          isScaffoldMode={scaffoldTemplateUploaded && isScaffoldTemplate(currentTemplate)}
        />

        {/* 拖拽提示遮罩 */}
        <DragOverlay $show={showWelcomeDragOverlay}>
          <DragOverlayText>
            📄 拖放PDF文件到此处打开
          </DragOverlayText>
        </DragOverlay>

        {h3ProjectSelectorVisible && (
          <Modal
            title="选择氚云项目"
            open={h3ProjectSelectorVisible}
            onOk={handleConfirmH3ProjectSelection}
            onCancel={handleCancelH3ProjectSelection}
            okText="确认并打开PDF"
            cancelText="取消"
            confirmLoading={h3ProjectsLoading}
            destroyOnClose
            width={520}
          >
            <div style={{ lineHeight: 1.8 }}>
              <p>请先选择项目，再继续打开PDF。</p>
              <select
                value={selectedH3ProjectValue}
                onChange={event => {
                  setSelectedH3ProjectValue(event.target.value);
                  if (event.target.value) {
                    setManualH3ProjectName('');
                  }
                }}
                disabled={h3ProjectsLoading}
                style={{
                  width: '100%',
                  height: 34,
                  padding: '4px 8px',
                  border: '1px solid #d9d9d9',
                  borderRadius: 6,
                  background: h3ProjectsLoading ? '#f5f5f5' : '#fff'
                }}
              >
                <option value="">
                  {h3ProjectsLoading
                    ? '加载中...'
                    : (manualH3ProjectName.trim() && filteredH3ProjectOptions.length === 0 ? '未匹配到项目，可手动输入' : '请选择项目')}
                </option>
                {filteredH3ProjectOptions.map(project => (
                  <option key={project.value} value={project.value}>
                    {project.name}
                  </option>
                ))}
              </select>
              <Input
                value={manualH3ProjectName}
                onChange={event => {
                  setManualH3ProjectName(event.target.value);
                  if (event.target.value.trim()) {
                    setSelectedH3ProjectValue('');
                  }
                }}
                placeholder="输入项目关键字联想筛选；下拉框没有时可手动输入"
                style={{ marginTop: 10 }}
              />
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#8c8c8c', fontSize: 12 }}>
                  {h3ProjectsLoading ? '正在加载项目...' : `匹配 ${filteredH3ProjectOptions.length} / ${h3ProjectOptions.length} 个项目`}
                </span>
                <Button type="link" size="small" onClick={loadH3ProjectOptions} style={{ padding: 0 }}>
                  刷新项目
                </Button>
              </div>
            </div>
          </Modal>
        )}
        
        {/* 氚云上传信息Modal - 数据工作日志 */}
        <Modal
          title="上传工作日志"
          open={tritiumUploadModalVisible}
          onOk={() => tritiumUploadForm.submit()}
          onCancel={() => setTritiumUploadModalVisible(false)}
          okText="确认上传"
          cancelText="取消"
          width={500}
        >
          <Form
            form={tritiumUploadForm}
            layout="vertical"
            onFinish={handleTritiumUploadSubmit}
          >
            <Form.Item
              label="姓名"
              name="userName"
              rules={[{ required: true, message: '请输入姓名' }]}
              extra="填写数据处理人员的姓名"
            >
              <Input placeholder="请输入您的姓名" />
            </Form.Item>

            <Form.Item
              label="人员类型"
              name="personnelType"
              initialValue="数据组成员"
            >
              <Input placeholder="请输入人员类型" />
            </Form.Item>
            
            <Form.Item
              label="时间"
              name="date"
              initialValue={new Date().toISOString().split('T')[0]}
              rules={[{ required: true, message: '请输入日期' }]}
              extra="请确认当前日期"
            >
              <Input placeholder="YYYY-MM-DD" />
            </Form.Item>
            
            <Form.Item
              label="项目名称"
              name="projectName"
              extra="填写项目或任务的名称"
            >
              <Input placeholder="请输入项目名称" />
            </Form.Item>
            
            <Form.Item
              label="处理张数"
              name="pageCount"
              extra="填写本次处理的PDF页数"
            >
              <InputNumber 
                min={1} 
                style={{ width: '100%' }}
                placeholder="请输入处理的页数" 
              />
            </Form.Item>
            
            <Form.Item
              label="工时 (小时)"
              name="workHours"
              rules={[{ required: true, message: '请输入工时' }]}
              extra="填写本次工作花费的时间"
            >
              <InputNumber 
                min={0} 
                step={0.5}
                style={{ width: '100%' }}
                placeholder="请输入工时" 
              />
            </Form.Item>

            <Form.Item
              label="焊口数量"
              name="weldCount"
              initialValue={annotations.length}
              extra="当前标注的焊口总数（可修改）"
            >
              <InputNumber 
                min={0}
                style={{ width: '100%' }}
                placeholder="请输入焊口数量" 
              />
            </Form.Item>
            
            <div style={{ marginTop: 16, padding: 12, background: '#e6f7ff', borderRadius: 4, border: '1px solid #91d5ff' }}>
              <div style={{ marginBottom: 8, color: '#1890ff' }}>
                <span style={{ fontWeight: 'bold' }}>📊 本次工作统计：</span>
              </div>
              <div style={{ lineHeight: '1.8' }}>
                <div>✓ 待上传焊口：<strong>{uploadStats.weldCount}</strong> 条</div>
                <div>✓ 涉及页数：<strong>{uploadStats.pageCount}</strong> 页</div>
                <div>✓ 文件名称：<strong>{pdfFileName || '未命名'}</strong></div>
              </div>
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #91d5ff', fontSize: '12px', color: '#666' }}>
                💡 提示：上传后将在氚云"数据工作日志"中创建一条记录
              </div>
            </div>
          </Form>
        </Modal>

        <Modal
          title="合并可编辑版PDF"
          open={editableMergeVisible}
          onOk={handleRunEditablePdfMerge}
          onCancel={() => setEditableMergeVisible(false)}
          okText="开始合并"
          cancelText="取消"
          confirmLoading={editableMergeLoading}
          width={640}
        >
          <div style={{ lineHeight: 1.8 }}>
            <p>请选择两份或多份由本工具导出的“可编辑版PDF”。系统会按选择顺序合并页面，并把每份PDF内的可编辑标注重新写入合并后的文件。</p>
            <input
              type="file"
              accept="application/pdf,.pdf"
              multiple
              onChange={handleMergeEditablePdfFiles}
              style={{ margin: '8px 0 12px' }}
            />
            {editableMergeFiles.length > 0 && (
              <div style={{ padding: 12, background: '#fafafa', border: '1px solid #eee', borderRadius: 4 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>合并顺序：</div>
                {editableMergeFiles.map((file, index) => (
                  <div key={`${file.name}-${file.size}-${index}`}>
                    {index + 1}. {file.name}
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 12, color: '#666', fontSize: 13 }}>
              注意：外部平台合并PDF通常会丢失可编辑标注附件；使用此功能合并后，标注页码会自动偏移并继续可编辑。
            </div>
          </div>
        </Modal>

        <Modal
          title="拆分可编辑版PDF"
          open={editableSplitVisible}
          onOk={handleRunEditablePdfSplit}
          onCancel={() => setEditableSplitVisible(false)}
          okText="开始拆分"
          cancelText="取消"
          confirmLoading={editableSplitLoading}
          width={640}
        >
          <div style={{ lineHeight: 1.8 }}>
            <p>请选择一份由本工具导出的“可编辑版PDF”。系统会拆分页面，并把对应页码内的可编辑标注重新写入拆分后的文件。</p>
            <input
              type="file"
              accept="application/pdf,.pdf"
              onChange={handleSplitEditablePdfFile}
              style={{ margin: '8px 0 12px' }}
            />
            {editableSplitFile && (
              <div style={{ padding: 12, background: '#fafafa', border: '1px solid #eee', borderRadius: 4, marginBottom: 12 }}>
                已选择：{editableSplitFile.name}
              </div>
            )}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>拆分方式：</div>
              <select
                value={editableSplitMode}
                onChange={event => setEditableSplitMode(event.target.value)}
                style={{ width: '100%', height: 34, border: '1px solid #d9d9d9', borderRadius: 4, padding: '0 8px' }}
              >
                <option value="ranges">按页码范围拆分</option>
                <option value="single">每页拆成一份</option>
              </select>
            </div>
            {editableSplitMode === 'ranges' && (
              <div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>页码范围：</div>
                <Input.TextArea
                  value={editableSplitRanges}
                  onChange={event => setEditableSplitRanges(event.target.value)}
                  placeholder="例如：1-5,6-10,11"
                  autoSize={{ minRows: 2, maxRows: 4 }}
                />
              </div>
            )}
            <div style={{ marginTop: 12, color: '#666', fontSize: 13 }}>
              注意：拆分后的PDF会重新计算标注页码。例如原第6页拆成新文件后，会变成新文件第1页，并继续可编辑。
            </div>
          </div>
        </Modal>

        {/* 氚云上传弹窗 */}
        <H3yunUploadModal
          visible={h3yunUploadVisible}
          onClose={() => setH3yunUploadVisible(false)}
          stats={weldStats}
          annotations={annotations}
          pdfFileName={pdfFileName}
        />
        </AppContainer>
  );
}

// 主App组件，提供OCR Context
function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <OCRProvider>
        <AppContent />
      </OCRProvider>
    </ConfigProvider>
  );
}

export default App;

