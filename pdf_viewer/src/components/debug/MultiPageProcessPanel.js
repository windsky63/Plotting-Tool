/**
 * 多页处理面板组件
 * 提供分步骤的多页处理流程：选择页码 → 矢量提取 → 文字识别 → 焊点识别 → 批量编号
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import * as XLSX from 'xlsx';
import {
  InputNumber,
  Button,
  Space,
  Steps,
  Progress,
  Alert,
  Table,
  Tag,
  message,
  Row,
  Col,
  Divider,
  Modal,
  Select,
  Input,
  Switch
} from 'antd';
import {
  FileSearchOutlined,
  FontSizeOutlined,
  FireOutlined,
  NumberOutlined,
  LoadingOutlined,
  ApartmentOutlined,
  DownloadOutlined,
  CheckCircleOutlined,
  UploadOutlined,
  DeleteOutlined,
  TableOutlined
} from '@ant-design/icons';
import multiPageBatchService from '../../services/multiPageBatchService';
import ocrService from '../../services/ocrService';
import weldAiService from '../../services/weldAiService';
import { useBookmarkLogger } from '../../hooks/useBookmarkLogger';
import {
  getPipelineStatsSummary,
  detectPipelineReferenceSheet,
  detectPipelineReferenceColumns,
  buildPipelineReferenceSummary,
  sanitizeRecognizedPipelineNumber
} from '../../utils/pipelineDetectionUtils';
import {
  buildJointTypeConfirmationsByPipeline,
  resolveBatchSplitUpperContent
} from '../../utils/batchAnnotationContentUtils';
import {
  planStraightPipeAutoWelds,
  resolveStraightPipeMaterialPlan
} from '../../utils/straightPipeAutoWeldUtils';
import {
  parseWeldNumberRanges,
  splitWeldNumberRangeTokens
} from '../../utils/weldNumberRangeUtils';

const { Step } = Steps;

const saveSpecialBlockRecognitionLog = async payload => {
  try {
    const response = await fetch('/api/processing-logs/special-block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  } catch (error) {
    console.warn('特殊块识别日志保存失败:', error?.message || error);
  }
};

const BATCH_BORDER_OPTIONS = [
  { value: 'none', label: '无边框' },
  { value: 'circle', label: '圆形' },
  { value: 'split-circle', label: '分栏圆形' },
  { value: 'diamond', label: '矩形' },
  { value: 'pipe-tag', label: '管段框' },
  { value: 'field-weld', label: '现场焊缝' },
  { value: 'shop-weld', label: '车间焊缝' }
];

const MATERIAL_FIELD_SOURCE_OPTIONS = [
  { value: 'manual', label: '手工输入' },
  { value: 'material', label: '从材料表提取' }
];

const BatchAnnotationPreview = ({ borderShape, upperText, weldText, color = '#ff4d4f' }) => {
  const shape = borderShape || 'circle';
  const isDiamond = shape === 'diamond' || shape === 'field-weld' || shape === 'shop-weld';
  const isPipeTag = shape === 'pipe-tag';
  const isSplit = shape === 'split-circle';
  const showCircle = shape === 'circle' || isSplit;

  return (
    <svg width="100%" height="116" viewBox="0 0 260 116" role="img" aria-label="批量标注样式预览">
      <line x1="24" y1="85" x2="101" y2="58" stroke={color} strokeWidth="2" />
      <circle cx="24" cy="85" r="2" fill={color} />
      {showCircle && <circle cx="145" cy="58" r="40" fill="white" stroke={color} strokeWidth="2" />}
      {isSplit && <line x1="111" y1="58" x2="179" y2="58" stroke={color} strokeWidth="2" />}
      {isDiamond && (
        <polygon points="145,18 185,58 145,98 105,58" fill="white" stroke={color} strokeWidth="2" />
      )}
      {isPipeTag && <rect x="99" y="33" width="92" height="50" rx="4" fill="white" stroke={color} strokeWidth="2" />}
      {shape === 'none' && <rect x="103" y="38" width="84" height="40" fill="white" stroke="#f0f0f0" strokeDasharray="4 4" />}
      {shape === 'field-weld' && <line x1="119" y1="32" x2="171" y2="84" stroke={color} strokeWidth="2" />}
      {shape === 'shop-weld' && <line x1="119" y1="84" x2="171" y2="32" stroke={color} strokeWidth="2" />}
      {isSplit ? (
        <>
          <text x="145" y="47" textAnchor="middle" fontSize="13" fill={color}>{upperText || ' '}</text>
          <text x="145" y="77" textAnchor="middle" fontSize="16" fontWeight="600" fill={color}>{weldText}</text>
        </>
      ) : (
        <text x="145" y="64" textAnchor="middle" fontSize="16" fontWeight="600" fill={color}>{weldText}</text>
      )}
      <text x="205" y="106" textAnchor="middle" fontSize="11" fill="#999">示意预览</text>
    </svg>
  );
};

const getComparisonTagColor = compareStatus => {
  switch (compareStatus) {
    case 'matched':
      return 'success';
    case 'count_mismatch':
      return 'error';
    case 'missing_in_pdf':
      return 'volcano';
    case 'missing_in_excel':
      return 'warning';
    case 'unresolved_pipeline':
      return 'magenta';
    default:
      return 'default';
  }
};

const getStatsRowClassName = record => {
  if (record.compareStatus) {
    if (record.compareStatus === 'matched') return 'pipeline-row-success';
    if (record.compareStatus === 'missing_in_excel') return 'pipeline-row-warning';
    return 'pipeline-row-error';
  }

  if (record.status === '未识别' || record.status === '未识别/空白页') return 'pipeline-row-error';
  if (record.status === '已匹配') return 'pipeline-row-success';
  if (record.status === '部分未识别') return 'pipeline-row-warning';
  return '';
};

const formatWarningDescription = warnings => {
  const visibleWarnings = (warnings || []).slice(0, 3).map(item => item.message);
  const extraCount = Math.max((warnings || []).length - visibleWarnings.length, 0);
  const suffix = extraCount > 0 ? `；其余 ${extraCount} 条请在导入后复核` : '';
  return `${visibleWarnings.join('；')}${suffix}`;
};

export const MultiPageProcessPanel = ({
  visible,
  pdfDocument,
  pdfPath,
  pdfFile,
  totalPages,
  scale,
  annotationRule,
  annotationRules = [],
  pipelineAreaTemplate,
  pipeClassAreaTemplate = null,
  pageNumberAreaTemplate = null,
  onAnnotationsGenerated,
  onVectorsExtracted,
  onTextsDetected,
  onWeldsDetected,
  onShowNumberPreview,
  onStartSegmentCorrection,
  onRestoreAutoOrder,
  onPipelineComparisonReady,
  materialAreaTemplate = null,
  weldRecognitionAreaTemplate = null,
  materialSplitLines = [],
  materialRows = [],
  projectName = ''
}) => {
  const { startLogging, logPage, endLogging } = useBookmarkLogger();
  const excelInputRef = useRef(null);
  const hasInitializedRef = useRef(false);
  const restoredPanelSessionRef = useRef('');
  const totalPagesRef = useRef(totalPages || 1);
  const resetPanelStateRef = useRef(null);
  const materialRecognitionRunRef = useRef({ id: 0, running: false });
  const recognitionTimingActiveRef = useRef(false);

  const [startPage, setStartPage] = useState(1);
  const [endPage, setEndPage] = useState(totalPages || 1);
  const [startNumber, setStartNumber] = useState(1);
  const [selectedRuleId, setSelectedRuleId] = useState(annotationRule?.id || '');
  const [batchBorderShape, setBatchBorderShape] = useState(annotationRule?.borderShape || 'circle');
  const [diameterSource, setDiameterSource] = useState('material');
  const [manualDiameter, setManualDiameter] = useState('');
  const [jointTypeSource, setJointTypeSource] = useState('material');
  const [manualJointType, setManualJointType] = useState(annotationRule?.jointTypeText || '');
  const [batchRemark, setBatchRemark] = useState(annotationRule?.remark || '');
  const [diameterConfirmationsByPage, setDiameterConfirmationsByPage] = useState({});
  const [diameterRangesByPage, setDiameterRangesByPage] = useState({});
  const [savedDiameterRangeOptions, setSavedDiameterRangeOptions] = useState([]);
  const [jointTypeConfirmationsByPage, setJointTypeConfirmationsByPage] = useState({});
  const [pipeClassConfirmationsByPage, setPipeClassConfirmationsByPage] = useState({});
  const [diameterConfirmationVisible, setDiameterConfirmationVisible] = useState(false);
  const [straightPipeAutoWeldEnabled, setStraightPipeAutoWeldEnabled] = useState(false);
  const [straightPipeAutoWeldSummary, setStraightPipeAutoWeldSummary] = useState([]);
  const [straightPipeQuantityConfirmationsByPage, setStraightPipeQuantityConfirmationsByPage] = useState({});

  const [currentStep, setCurrentStep] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, step: '' });

  const [vectorsResult, setVectorsResult] = useState(null);
  const [textsResult, setTextsResult] = useState(null);
  const [weldsResult, setWeldsResult] = useState(null);
  const [specialWeldNotices, setSpecialWeldNotices] = useState({});
  const [specialRecognitionRunning, setSpecialRecognitionRunning] = useState(false);
  const [specialRecognitionCompleted, setSpecialRecognitionCompleted] = useState(false);
  const [pipelinesResult, setPipelinesResult] = useState(null);
  const [numbersResult, setNumbersResult] = useState(null);
  const [pipelineStatsResult, setPipelineStatsResult] = useState([]);
  const [pipelineComparisonResult, setPipelineComparisonResult] = useState(null);
  const [materialRecognizing, setMaterialRecognizing] = useState(false);
  const [recognizedMaterialPages, setRecognizedMaterialPages] = useState({});
  const pdfDisplayName = String(pdfFile?.name || pdfPath || '');
  // Keep remote AI opt-in until the production model is deployed and
  // validated. Existing rule-based weld recognition remains the default.
  const [aiWeldEnabled, setAiWeldEnabled] = useState(false);
  const [aiWeldRecognitionMode, setAiWeldRecognitionMode] = useState('assist');
  // Fitting inference is also opt-in while its project-specific rules are
  // still being validated. Weld recognition works independently of it.
  const [fittingRecognitionEnabled, setFittingRecognitionEnabled] = useState(false);
  const [aiWeldStatus, setAiWeldStatus] = useState({ state: 'idle', message: '' });
  const [weldReviewVersion, setWeldReviewVersion] = useState(0);
  const aiDirectWeldMode = aiWeldEnabled && aiWeldRecognitionMode === 'direct';

  // Recognition occupies the operator even when no continuous clicking is
  // required. Count only recognition work here; vector extraction, numbering,
  // annotation generation and merely keeping the panel open are excluded.
  useEffect(() => {
    const stagedRecognitionRunning = processing && (
      currentStep === 2 || currentStep === 3 || currentStep === 4
    );
    const recognitionActive = Boolean(
      stagedRecognitionRunning || materialRecognizing || specialRecognitionRunning
    );
    if (recognitionTimingActiveRef.current === recognitionActive) return;
    recognitionTimingActiveRef.current = recognitionActive;
    window.dispatchEvent(new CustomEvent('multi-page-recognition-timing', {
      detail: { active: recognitionActive, timestamp: Date.now() }
    }));
  }, [
    processing,
    currentStep,
    materialRecognizing,
    specialRecognitionRunning
  ]);

  useEffect(() => () => {
    if (!recognitionTimingActiveRef.current) return;
    recognitionTimingActiveRef.current = false;
    window.dispatchEvent(new CustomEvent('multi-page-recognition-timing', {
      detail: { active: false, timestamp: Date.now() }
    }));
  }, []);

  const specialWeldNoticeRows = useMemo(() => {
    const pagesByType = new Map();
    const addPage = (key, label, page, detail = '') => {
      if (!pagesByType.has(key)) pagesByType.set(key, { key, label, detail, pages: new Set() });
      pagesByType.get(key).pages.add(Number(page));
    };
    Object.entries(specialWeldNotices || {}).forEach(([page, notices]) => {
      (notices || []).forEach(notice => {
        if (notice.type === 'static-grounding') {
          addPage(
            'static-grounding',
            '静电接地',
            page,
            '至少识别到 SEG-PIP；人工添加时使用 E1、E2、E3……'
          );
          return;
        }
        if (notice.type === 'positioning-block') {
          addPage(
            'positioning-block',
            '定位块',
            page,
            '仅根据下半部分 JPLATE 判定'
          );
          return;
        }
        const pageTextResult = textsResult?.[page]
          || textsResult?.[String(page)]
          || multiPageBatchService.pageTextDetections?.[page]
          || multiPageBatchService.pageTextDetections?.[String(page)]
          || {};
        const pipelineNumber = String(
          pageTextResult.pipelineNumber || pageTextResult.pipeline_number || ''
        ).trim();
        const pipelineKey = pipelineNumber.replace(/\s+/g, '').toUpperCase();
        addPage(
          pipelineKey ? `support-pipeline-${pipelineKey}` : `support-pipeline-unknown-${page}`,
          pipelineNumber ? `焊接支架 · 管线号 ${pipelineNumber}` : '焊接支架 · 管线号未识别',
          page,
          pipelineNumber ? '同管线号的支架焊口连续使用 601、602、603……' : '请先确认管线号，以判断支架焊口是否需要从 601 重新开始'
        );
      });
    });
    return Array.from(pagesByType.values()).map(item => ({
      ...item,
      pages: Array.from(item.pages).sort((a, b) => a - b)
    }));
  }, [specialWeldNotices, textsResult]);

  const pipeClassReviewPages = useMemo(() => {
    if (!pipeClassAreaTemplate || !textsResult) return [];
    const items = [];
    for (let page = Number(startPage); page <= Number(endPage); page += 1) {
      const pageResult = textsResult?.[page] || textsResult?.[String(page)] || {};
      const recognizedValue = String(pageResult?.pipeClass || pageResult?.pipelineClass || '').trim();
      if (!recognizedValue) {
        items.push({
          page,
          value: String(pipeClassConfirmationsByPage[page] || '').trim()
        });
      }
    }
    return items;
  }, [endPage, pipeClassAreaTemplate, pipeClassConfirmationsByPage, startPage, textsResult]);

  const unresolvedPipeClassPages = useMemo(
    () => pipeClassReviewPages.filter(item => !item.value),
    [pipeClassReviewPages]
  );

  const weldReviewRows = useMemo(() => Object.entries(
    multiPageBatchService.getWeldReviewCandidates() || {}
  ).flatMap(([page, candidates]) => (candidates || []).map((candidate, index) => ({
    ...candidate,
    key: multiPageBatchService.getWeldReviewCandidateId(candidate, Number(page), index),
    page: Number(page),
    sourceLabel: candidate?.reviewSource === 'ai' ? '远端AI' : '现有规则',
    reasonLabel: candidate?.reviewReason === 'ai_only' ? '仅AI识别' : '管线连接置信度较低'
  }))), [weldReviewVersion, weldsResult]);

  const [referenceSummary, setReferenceSummary] = useState(null);
  const [excelImportWarnings, setExcelImportWarnings] = useState([]);
  const [showNumberPreview, setShowNumberPreview] = useState(false);
  const [segmentCorrectionActive, setSegmentCorrectionActive] = useState(false);

  const [manualMappingVisible, setManualMappingVisible] = useState(false);
  const [pendingWorkbookSheets, setPendingWorkbookSheets] = useState([]);
  const [pendingWorkbookFileName, setPendingWorkbookFileName] = useState('');
  const [manualSheetName, setManualSheetName] = useState('');
  const [manualPipelineColumnIndex, setManualPipelineColumnIndex] = useState(undefined);
  const [manualCountColumnIndex, setManualCountColumnIndex] = useState(undefined);

  const availableAnnotationRules = useMemo(() => {
    const rules = Array.isArray(annotationRules) ? [...annotationRules] : [];
    if (annotationRule?.id && !rules.some(rule => rule.id === annotationRule.id)) {
      rules.unshift(annotationRule);
    }
    return rules;
  }, [annotationRules, annotationRule]);

  const selectedAnnotationRule = useMemo(
    () => availableAnnotationRules.find(rule => rule.id === selectedRuleId) || annotationRule || null,
    [availableAnnotationRules, selectedRuleId, annotationRule]
  );

  useEffect(() => {
    const selectedStillExists = availableAnnotationRules.some(rule => rule.id === selectedRuleId);
    if (!selectedStillExists) {
      const fallbackRule = annotationRule || availableAnnotationRules[0];
      if (!fallbackRule) return;
      setSelectedRuleId(fallbackRule.id);
      setBatchBorderShape(fallbackRule.borderShape || 'circle');
      setBatchRemark(fallbackRule.remark || '');
    }
  }, [selectedRuleId, annotationRule, availableAnnotationRules]);

  const handleBatchRuleChange = useCallback((ruleId) => {
    setSelectedRuleId(ruleId);
  }, []);

  const materialRowsByPage = useMemo(() => {
    const grouped = {};
    (Array.isArray(materialRows) ? materialRows : []).forEach((row) => {
      const page = Number(row?.sourcePage || row?.calculatedPage || row?.ocrPage || row?.page);
      if (!Number.isFinite(page) || page < 1) return;
      if (!grouped[page]) grouped[page] = [];
      grouped[page].push(row);
    });
    Object.entries(recognizedMaterialPages || {}).forEach(([page, pageData]) => {
      const rows = Array.isArray(pageData?.materials) ? pageData.materials : [];
      if (rows.length > 0) grouped[page] = rows;
    });
    return grouped;
  }, [materialRows, recognizedMaterialPages]);

  const straightPipeQuantityReviewPages = useMemo(() => {
    if (!straightPipeAutoWeldEnabled) return [];
    const items = [];
    for (let page = Number(startPage); page <= Number(endPage); page += 1) {
      const rows = materialRowsByPage?.[page] || materialRowsByPage?.[String(page)] || [];
      const plan = resolveStraightPipeMaterialPlan(rows);
      if (plan.reason !== '直管 QTY 不是可用的长度') continue;
      items.push({
        page,
        value: String(straightPipeQuantityConfirmationsByPage[page] || '').trim(),
        rawValues: Array.isArray(plan.rawQuantityValues) ? plan.rawQuantityValues.filter(Boolean) : [],
        sources: Array.isArray(plan.quantitySources) ? plan.quantitySources : []
      });
    }
    return items;
  }, [
    endPage,
    materialRowsByPage,
    startPage,
    straightPipeAutoWeldEnabled,
    straightPipeQuantityConfirmationsByPage
  ]);

  const unresolvedStraightPipeQuantityPages = useMemo(
    () => straightPipeQuantityReviewPages.filter(item => !item.value),
    [straightPipeQuantityReviewPages]
  );

  const jointTypeSupplementalTextByPage = useMemo(() => {
    const mapped = {};
    Object.entries(recognizedMaterialPages || {}).forEach(([page, pageData]) => {
      const sourceRows = Array.isArray(pageData?.sourceLogicalRows) ? pageData.sourceLogicalRows : [];
      if (sourceRows.length > 0) mapped[page] = JSON.stringify(sourceRows);
    });
    return mapped;
  }, [recognizedMaterialPages]);

  const pipelineNumberByPage = useMemo(() => {
    const mapped = {};
    let lastPipelineNumber = '';
    for (let page = Number(startPage); page <= Number(endPage); page += 1) {
      const pageRows = materialRowsByPage?.[page] || materialRowsByPage?.[String(page)] || [];
      const rowPipeline = pageRows.find(row => (
        row?.pipelineNumber || row?.lineNumber || row?.rawMaterial?.pipelineNumber
      ));
      const explicitPipelineNumber = String(
        textsResult?.[page]?.pipelineNumber ||
        textsResult?.[String(page)]?.pipelineNumber ||
        recognizedMaterialPages?.[page]?.pipelineNumber ||
        recognizedMaterialPages?.[String(page)]?.pipelineNumber ||
        rowPipeline?.pipelineNumber ||
        rowPipeline?.lineNumber ||
        rowPipeline?.rawMaterial?.pipelineNumber ||
        ''
      ).trim();
      if (explicitPipelineNumber) lastPipelineNumber = explicitPipelineNumber;
      // Keep the same fallback used by cross-page numbering: a page with a
      // missing OCR line number continues the last explicit line until a new
      // line number is recognized.
      mapped[page] = explicitPipelineNumber || lastPipelineNumber;
    }
    return mapped;
  }, [
    endPage,
    materialRowsByPage,
    recognizedMaterialPages,
    startPage,
    textsResult
  ]);

  const materialJointTypeByPage = useMemo(() => {
    const mapped = {};
    for (let page = Number(startPage); page <= Number(endPage); page += 1) {
      const resolved = resolveBatchSplitUpperContent({
        pageNum: page,
        pipelineNumber: pipelineNumberByPage[page] || '',
        batchContent: {
          jointTypeSource: 'material',
          materialRowsByPage,
          jointTypeSupplementalTextByPage
        }
      });
      if (resolved.materialJointType) mapped[page] = resolved.materialJointType;
    }
    return mapped;
  }, [
    endPage,
    jointTypeSupplementalTextByPage,
    materialRowsByPage,
    pipelineNumberByPage,
    startPage
  ]);

  const effectiveJointTypeConfirmationsByPage = useMemo(() => (
    buildJointTypeConfirmationsByPipeline({
      pages: Array.from(
        { length: Math.max(0, Number(endPage) - Number(startPage) + 1) },
        (_, index) => Number(startPage) + index
      ),
      pipelineNumberByPage,
      materialJointTypeByPage,
      manualJointTypeByPage: jointTypeConfirmationsByPage
    })
  ), [
    endPage,
    jointTypeConfirmationsByPage,
    materialJointTypeByPage,
    pipelineNumberByPage,
    startPage
  ]);

  const ambiguousDiameterPages = useMemo(() => {
    if (diameterSource !== 'material' || batchBorderShape !== 'split-circle') return [];
    const items = [];
    for (let page = Number(startPage); page <= Number(endPage); page += 1) {
      const resolved = resolveBatchSplitUpperContent({
        pageNum: page,
        batchContent: {
          diameterSource,
          materialRowsByPage,
          diameterConfirmationsByPage
        }
      });
      if (resolved.diameterAmbiguous) {
        items.push({
          page,
          candidates: resolved.diameterCandidates,
          candidateCounts: resolved.diameterCandidateCounts,
          defaultDiameter: resolved.materialDiameter,
          confirmed: resolved.diameterConfirmed
        });
      }
    }
    return items;
  }, [
    diameterSource,
    batchBorderShape,
    startPage,
    endPage,
    materialRowsByPage,
    diameterConfirmationsByPage
  ]);

  const unresolvedDiameterPages = useMemo(
    () => ambiguousDiameterPages.filter(item => !item.confirmed),
    [ambiguousDiameterPages]
  );

  const invalidDiameterRangePages = useMemo(() => ambiguousDiameterPages.flatMap(item => {
    const pageRanges = diameterRangesByPage[item.page] || {};
    return item.candidates
      .map(diameter => ({
        page: item.page,
        diameter,
        parsed: parseWeldNumberRanges(pageRanges[diameter])
      }))
      .filter(entry => !entry.parsed.valid);
  }), [ambiguousDiameterPages, diameterRangesByPage]);

  const diameterRangeOptions = useMemo(() => {
    const mappedValues = Object.values(diameterRangesByPage).flatMap(pageRanges => (
      Object.values(pageRanges || {}).flatMap(splitWeldNumberRangeTokens)
    ));
    return Array.from(new Set([...savedDiameterRangeOptions, ...mappedValues]))
      .map(value => ({ value, label: value }));
  }, [diameterRangesByPage, savedDiameterRangeOptions]);

  const jointTypeReviewPages = useMemo(() => {
    if (jointTypeSource !== 'material' || batchBorderShape !== 'split-circle') return [];
    const items = [];
    for (let page = Number(startPage); page <= Number(endPage); page += 1) {
      const hasPageRecognitionResult = Object.prototype.hasOwnProperty.call(recognizedMaterialPages || {}, page) ||
        Object.prototype.hasOwnProperty.call(recognizedMaterialPages || {}, String(page)) ||
        (materialRowsByPage?.[page]?.length || materialRowsByPage?.[String(page)]?.length);
      if (!hasPageRecognitionResult) continue;
      const resolved = resolveBatchSplitUpperContent({
        pageNum: page,
        batchContent: {
          jointTypeSource: 'material',
          materialRowsByPage,
          jointTypeSupplementalTextByPage,
          jointTypeConfirmationsByPage: effectiveJointTypeConfirmationsByPage
        }
      });
      if (!resolved.materialJointType) {
        items.push({
          page,
          value: resolved.pageManualJointType || '',
          resolved: !!resolved.jointType,
          materialRows: resolved.pageMaterialRows,
          attempts: Number(recognizedMaterialPages?.[page]?.materialRecognitionAttempts || 1)
        });
      }
    }
    return items;
  }, [
    jointTypeSource,
    batchBorderShape,
    startPage,
    endPage,
    materialRowsByPage,
    jointTypeSupplementalTextByPage,
    effectiveJointTypeConfirmationsByPage,
    recognizedMaterialPages
  ]);

  const unresolvedJointTypePages = useMemo(
    () => jointTypeReviewPages.filter(item => !item.resolved),
    [jointTypeReviewPages]
  );

  const batchRule = useMemo(() => ({
    ...(selectedAnnotationRule || {}),
    borderShape: batchBorderShape,
    remark: batchRemark,
    batchContent: {
      diameterSource,
      manualDiameter,
      jointTypeSource,
      manualJointType,
      jointTypeConfirmationsByPage: effectiveJointTypeConfirmationsByPage,
      jointTypeSupplementalTextByPage,
      materialRowsByPage,
      diameterConfirmationsByPage,
      diameterRangesByPage,
      remark: batchRemark
    }
  }), [
    selectedAnnotationRule,
    batchBorderShape,
    batchRemark,
    diameterSource,
    manualDiameter,
    jointTypeSource,
    manualJointType,
    effectiveJointTypeConfirmationsByPage,
    jointTypeSupplementalTextByPage,
    materialRowsByPage,
    diameterConfirmationsByPage,
    diameterRangesByPage
  ]);

  // Range mappings remain editable during number preview/correction. Keep the
  // pending production rule synchronized so final annotation generation always
  // uses the latest diameter-to-number-range mapping.
  useEffect(() => {
    if (!numbersResult) return;
    multiPageBatchService.setPendingBatchAnnotationRule(batchRule);
  }, [batchRule, numbersResult]);

  const previewWeldText = useMemo(
    () => `${selectedAnnotationRule?.prefix || ''}${startNumber || 1}${selectedAnnotationRule?.suffix || ''}`,
    [selectedAnnotationRule, startNumber]
  );

  const materialPreviewUpperText = useMemo(() => {
    const resolved = resolveBatchSplitUpperContent({
      batchContent: batchRule.batchContent,
      pageNum: startPage
    });
    return `${resolved.diameter || ''}${resolved.jointType ? `"${resolved.jointType}` : ''}`;
  }, [batchRule, startPage]);

  const getPdfBaseName = useCallback(() => {
    const fileName = pdfFile?.name || (typeof pdfPath === 'string' ? pdfPath.split(/[/\\]/).pop() : '') || 'document';
    return fileName.replace(/\.pdf$/i, '');
  }, [pdfFile, pdfPath]);

  const pdfSessionKey = useMemo(() => {
    if (typeof pdfPath === 'string' && pdfPath) {
      return `path:${pdfPath}`;
    }

    if (pdfFile) {
      return `file:${pdfFile.name || ''}:${pdfFile.size || 0}:${pdfFile.lastModified || 0}:${pdfFile.type || ''}`;
    }

    return 'document:unknown';
  }, [pdfPath, pdfFile?.name, pdfFile?.size, pdfFile?.lastModified, pdfFile?.type]);

  const syncPipelineComparisonState = useCallback(() => {
    const comparison = multiPageBatchService.getPipelineComparison();
    setPipelineComparisonResult(comparison);
    if (onPipelineComparisonReady) {
      onPipelineComparisonReady(comparison);
    }
    return comparison;
  }, [onPipelineComparisonReady]);

  const applyReferenceSummary = useCallback((summary, sourceMessage) => {
    multiPageBatchService.setPipelineReferenceData(summary);
    setReferenceSummary(summary);
    setExcelImportWarnings(summary?.warnings || []);
    const comparison = syncPipelineComparisonState();
    const warningText = summary.warningCount > 0 ? `，已跳过 ${summary.warningCount} 条异常行` : '';
    message.success(
      sourceMessage || `Excel 基准已导入：${summary.itemCount} 条管线${warningText}`
    );
    return comparison;
  }, [syncPipelineComparisonState]);

  const restorePanelStateFromService = useCallback(() => {
    const referenceData = multiPageBatchService.getPipelineReferenceData();
    const pipelineStats = multiPageBatchService.getPipelineStats();
    const comparison = multiPageBatchService.getPipelineComparison();
    const allWelds = multiPageBatchService.getAllWelds();
    const status = multiPageBatchService.getStatus();
    const retainedVectors = multiPageBatchService.pageVectors || {};
    const retainedTexts = multiPageBatchService.pageTextDetections || {};
    const hasCompletedTextDetection = Object.values(retainedTexts).some(result => (
      result && Object.prototype.hasOwnProperty.call(result, 'detections')
    ));
    const retainedWelds = multiPageBatchService.pageWelds || {};
    const retainedPipelines = multiPageBatchService.pagePipelines || {};
    const stepMap = {
      vectors: 1,
      ocr: 2,
      welds: 3,
      fittings: 3,
      pipelines: 4,
      numbering: 5
    };

    setReferenceSummary(referenceData);
    setExcelImportWarnings(referenceData?.warnings || []);
    setPipelineStatsResult(pipelineStats);
    setPipelineComparisonResult(comparison);
    setNumbersResult(allWelds?.length ? allWelds : null);
    setVectorsResult(Object.keys(retainedVectors).length ? { ...retainedVectors } : null);
    setTextsResult(Object.keys(retainedTexts).length
      ? { ...retainedTexts }
      : null);
    setWeldsResult(Object.keys(retainedWelds).length ? { ...retainedWelds } : null);
    setWeldReviewVersion(version => version + 1);
    setPipelinesResult(Object.keys(retainedPipelines).length ? { ...retainedPipelines } : null);
    setSpecialWeldNotices({ ...multiPageBatchService.getSpecialWeldNotices() });
    setSpecialRecognitionCompleted(
      Object.keys(multiPageBatchService.pageSupportMaterialTextDetections || {}).length > 0 ||
      Object.keys(multiPageBatchService.pageSpecialWeldTextDetections || {}).length > 0
    );
    setProcessing(!!status?.isProcessing);
    const highestRecoverableStep = allWelds?.length > 0 || pipelineStats.length > 0
      ? 5
      : Object.keys(retainedPipelines).length > 0
        ? 4
        : Object.keys(retainedWelds).length > 0
          ? 3
          : hasCompletedTextDetection
            ? 2
            : Object.keys(retainedVectors).length > 0
              ? 1
              : 0;
    const reportedStep = status?.currentStep ? (stepMap[status.currentStep] || 0) : highestRecoverableStep;
    setCurrentStep(Math.min(reportedStep, highestRecoverableStep));
    setProgress(status?.progress || { current: 0, total: 0, step: '' });

    if (onPipelineComparisonReady) {
      onPipelineComparisonReady(comparison);
    }
  }, [onPipelineComparisonReady]);

  const resetPanelState = useCallback(({ silent = false } = {}) => {
    materialRecognitionRunRef.current = {
      id: materialRecognitionRunRef.current.id + 1,
      running: false
    };
    setCurrentStep(0);
    setProgress({ current: 0, total: 0, step: '' });
    setVectorsResult(null);
    setTextsResult(null);
    setWeldsResult(null);
    setAiWeldStatus({ state: 'idle', message: '' });
    setWeldReviewVersion(version => version + 1);
    setSpecialWeldNotices({});
    setSpecialRecognitionRunning(false);
    setSpecialRecognitionCompleted(false);
    setPipelinesResult(null);
    setNumbersResult(null);
    setPipelineStatsResult([]);
    setPipelineComparisonResult(null);
    setRecognizedMaterialPages({});
    setReferenceSummary(null);
    setExcelImportWarnings([]);
    setShowNumberPreview(false);
    setSegmentCorrectionActive(false);
    setPendingWorkbookSheets([]);
    setPendingWorkbookFileName('');
    setManualMappingVisible(false);
    setManualSheetName('');
    setManualPipelineColumnIndex(undefined);
    setManualCountColumnIndex(undefined);
    setDiameterConfirmationsByPage({});
    setDiameterRangesByPage({});
    setSavedDiameterRangeOptions([]);
    setJointTypeConfirmationsByPage({});
    setPipeClassConfirmationsByPage({});
    setDiameterConfirmationVisible(false);
    setStraightPipeAutoWeldEnabled(false);
    setStraightPipeAutoWeldSummary([]);
    setStraightPipeQuantityConfirmationsByPage({});
    setStartPage(1);
    setEndPage(totalPagesRef.current || 1);
    setStartNumber(1);
    setProcessing(false);

    if (excelInputRef.current) {
      excelInputRef.current.value = '';
    }

    if (onShowNumberPreview) {
      onShowNumberPreview(false, []);
    }
    if (onPipelineComparisonReady) {
      onPipelineComparisonReady(null);
    }

    multiPageBatchService.reset();

    if (!silent) {
      message.info('已重置，可以重新开始');
    }
  }, [onPipelineComparisonReady, onShowNumberPreview]);

  const resetNumberingState = useCallback(() => {
    const retainedPageWelds = multiPageBatchService.resetNumberingState();
    setWeldsResult(Object.keys(retainedPageWelds || {}).length > 0
      ? { ...retainedPageWelds }
      : weldsResult);
    setNumbersResult(null);
    setPipelineStatsResult([]);
    setPipelineComparisonResult(null);
    setProgress({ current: 0, total: 0, step: '' });
    setShowNumberPreview(false);
    setSegmentCorrectionActive(false);
    setDiameterConfirmationVisible(false);
    setStraightPipeAutoWeldSummary([]);
    setProcessing(false);

    const nextStep = pipelinesResult
      ? 4
      : weldsResult
        ? 3
        : textsResult
          ? 2
          : vectorsResult
            ? 1
            : 0;
    setCurrentStep(nextStep);

    onShowNumberPreview?.(false, []);
    onPipelineComparisonReady?.(null);
    message.info('已保留识别结果，可重新生成智能编号');
  }, [
    onPipelineComparisonReady,
    onShowNumberPreview,
    pipelinesResult,
    textsResult,
    vectorsResult,
    weldsResult
  ]);

  const confirmFullReset = useCallback(() => {
    Modal.confirm({
      title: '全部重置',
      content: '将清除本次多页处理的矢量、文字、材料表、焊点、编号及所有人工确认结果，是否继续？',
      okText: '全部重置',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => resetPanelState()
    });
  }, [resetPanelState]);

  useEffect(() => {
    resetPanelStateRef.current = resetPanelState;
  }, [resetPanelState]);

  useEffect(() => {
    totalPagesRef.current = totalPages || 1;
    if (totalPages) {
      setEndPage(totalPages);
    }
  }, [totalPages]);

  useEffect(() => {
    if (currentStep === 0) {
      setAiWeldEnabled(false);
      setFittingRecognitionEnabled(false);
    }
  }, [currentStep, pdfDisplayName]);

  useEffect(() => {
    multiPageBatchService.setCallbacks({
      onProgress: (current, total, step) => {
        setProgress({ current, total, step });
      },
      onStepChange: (step) => {
        const stepMap = {
          vectors: 1,
          ocr: 2,
          welds: 3,
          fittings: 3,
          pipelines: 4,
          numbering: 5
        };
        setCurrentStep(stepMap[step] || 0);
      },
      onError: (err, page) => {
        message.error(`处理错误${page ? ` (第${page}页)` : ''}: ${err.message}`);
      }
    });
  }, []);

  useEffect(() => {
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true;
      return;
    }

    restoredPanelSessionRef.current = '';
    resetPanelStateRef.current?.({ silent: true });
  }, [pdfSessionKey]);

  useEffect(() => {
    if (!visible || restoredPanelSessionRef.current === pdfSessionKey) {
      return;
    }

    restorePanelStateFromService();
    restoredPanelSessionRef.current = pdfSessionKey;
  }, [pdfSessionKey, visible, restorePanelStateFromService]);

  useEffect(() => {
    if (!manualMappingVisible || pendingWorkbookSheets.length === 0) {
      return;
    }

    const activeSheetName = manualSheetName || pendingWorkbookSheets[0]?.name || '';
    const activeSheet = pendingWorkbookSheets.find(sheet => sheet.name === activeSheetName) || pendingWorkbookSheets[0];
    if (!activeSheet) {
      return;
    }

    const columnMatch = detectPipelineReferenceColumns(activeSheet.rows?.[0] || []);
    setManualSheetName(activeSheet.name || '');
    setManualPipelineColumnIndex(columnMatch.pipelineColumnIndex ?? undefined);
    setManualCountColumnIndex(columnMatch.countColumnIndex ?? undefined);
  }, [manualMappingVisible, pendingWorkbookSheets, manualSheetName]);

  const handleExtractVectors = useCallback(async () => {
    if (!pdfDocument) {
      message.error('PDF文档未加载');
      return;
    }

    if (startPage > endPage) {
      message.error('起始页码不能大于结束页码');
      return;
    }

    setProcessing(true);
    setCurrentStep(1);

    try {
      if (aiDirectWeldMode) {
        for (let page = Number(startPage); page <= Number(endPage); page += 1) {
          multiPageBatchService.pageVectors[page] = [];
          delete multiPageBatchService.pageRecognizers?.[page];
        }
        setVectorsResult({});
        message.info('AI直识别模式：已跳过整页矢量提取，将由远端AI直接识别焊点');
        return;
      }
      const result = await multiPageBatchService.extractVectorsFromPages(
        pdfDocument,
        startPage,
        endPage
      );

      setVectorsResult(result);
      if (onVectorsExtracted) {
        onVectorsExtracted(result);
      }

      const totalVectors = Object.values(result).reduce((sum, vectors) => sum + vectors.length, 0);
      message.success(`矢量提取完成! 共 ${totalVectors} 个矢量元素`);
    } catch (error) {
      message.error(`矢量提取失败: ${error.message}`);
      setCurrentStep(0);
    } finally {
      setProcessing(false);
    }
  }, [pdfDocument, startPage, endPage, onVectorsExtracted, aiDirectWeldMode]);

  const handleDetectTexts = useCallback(async () => {
    if (!pdfPath && !pdfFile) {
      message.error('PDF文件未提供');
      return;
    }

    if (!vectorsResult) {
      message.warning('请先执行矢量提取');
      return;
    }

    setProcessing(true);
    setCurrentStep(2);

    try {
      const result = await multiPageBatchService.detectTextFromPages(
        pdfFile || pdfPath,
        startPage,
        endPage,
        (pipelineAreaTemplate || pipeClassAreaTemplate) ? {
          ...(pipelineAreaTemplate ? { pipelineArea: pipelineAreaTemplate } : {}),
          ...(pipeClassAreaTemplate ? { pipeClassArea: pipeClassAreaTemplate } : {})
        } : null
      );

      setTextsResult(result);
      if (onTextsDetected) {
        onTextsDetected(result);
      }

      const totalTexts = Object.values(result).reduce((sum, data) => sum + (data.detections?.length || 0), 0);
      const matchedPages = Object.values(result).filter(data => data?.pipelineStatus === 'matched').length;
      const unresolvedPages = Object.values(result).filter(data => data?.pipelineStatus !== 'matched').length;
      const mineruPages = Object.values(result).filter(data => data?.pipelineEngine === 'mineru').length;
      const fallbackPages = Object.values(result).filter(data => data?.pipelineFallbackUsed).length;
      const pipeClassPages = Object.values(result).filter(data => data?.pipeClass).length;
      message.success(`文字识别完成! 共 ${totalTexts} 个文字区域，${matchedPages} 页识别到管线号，${pipeClassPages} 页识别到管道等级，${unresolvedPages} 页管线号未识别，MinerU ${mineruPages} 页，回退 ${fallbackPages} 页`);
    } catch (error) {
      message.error(`文字识别失败: ${error.message}`);
      setCurrentStep(1);
    } finally {
      setProcessing(false);
    }
  }, [pdfPath, pdfFile, vectorsResult, startPage, endPage, pipelineAreaTemplate, pipeClassAreaTemplate, onTextsDetected]);

  const handleSpecialWeldRecognition = useCallback(async () => {
    if (!pdfPath && !pdfFile) {
      message.error('PDF文件未提供');
      return;
    }
    if (!weldRecognitionAreaTemplate) {
      message.warning('请先设置焊点区域');
      return;
    }

    setSpecialRecognitionRunning(true);
    setProcessing(true);
    const recognitionStartedAt = Date.now();

    try {
      const reusableMaterialResults = {};
      for (let page = Number(startPage); page <= Number(endPage); page += 1) {
        const recognizedPage = recognizedMaterialPages?.[page]
          || recognizedMaterialPages?.[String(page)];
        if (recognizedPage) {
          reusableMaterialResults[page] = recognizedPage;
          continue;
        }
        const savedRows = materialRowsByPage?.[page] || materialRowsByPage?.[String(page)] || [];
        if (savedRows.length > 0) reusableMaterialResults[page] = { materials: savedRows };
      }
      multiPageBatchService.detectSupportNoticesFromMaterialResults(
        reusableMaterialResults,
        startPage,
        endPage
      );
      const result = await multiPageBatchService.detectStaticGroundingNoticesFromArea(
        pdfPath || pdfFile,
        startPage,
        endPage,
        weldRecognitionAreaTemplate,
        pdfDocument
      );

      setSpecialWeldNotices(result);
      setSpecialRecognitionCompleted(true);
      const groundingPages = Object.values(result).filter(items => (
        (items || []).some(item => item.type === 'static-grounding')
      )).length;
      const positioningPages = Object.values(result).filter(items => (
        (items || []).some(item => item.type === 'positioning-block')
      )).length;
      const supportPages = Object.values(result).filter(items => (
        (items || []).some(item => item.type === 'welded-support')
      )).length;
      const pageDetails = [];
      for (let page = Number(startPage); page <= Number(endPage); page += 1) {
        const notices = result?.[page] || result?.[String(page)] || [];
        const textResult = multiPageBatchService.pageSpecialWeldTextDetections?.[page]
          || multiPageBatchService.pageSpecialWeldTextDetections?.[String(page)]
          || {};
        pageDetails.push({
          page,
          noticeTypes: notices.map(item => item.type),
          labels: notices.map(item => item.label).filter(Boolean),
          source: textResult.source || '',
          matchedTexts: (textResult.detections || []).map(item => String(item?.text || '')).filter(Boolean),
          rawTexts: Array.isArray(textResult.rawTexts) ? textResult.rawTexts : [],
          rawContent: String(textResult.rawContent || '')
        });
      }
      await saveSpecialBlockRecognitionLog({
        timestamp: new Date().toISOString(),
        status: 'success',
        pdfFileName: pdfFile?.name || (typeof pdfPath === 'string' ? pdfPath.split(/[/\\]/).pop() : ''),
        startPage: Number(startPage),
        endPage: Number(endPage),
        durationMs: Date.now() - recognitionStartedAt,
        supportPages,
        groundingPages,
        positioningPages,
        pageDetails
      });
      message.success(`特殊块识别完成：焊接支架 ${supportPages} 页；静电接地 ${groundingPages} 页；定位块 ${positioningPages} 页`);
    } catch (error) {
      await saveSpecialBlockRecognitionLog({
        timestamp: new Date().toISOString(),
        status: 'error',
        pdfFileName: pdfFile?.name || (typeof pdfPath === 'string' ? pdfPath.split(/[/\\]/).pop() : ''),
        startPage: Number(startPage),
        endPage: Number(endPage),
        durationMs: Date.now() - recognitionStartedAt,
        error: error?.message || String(error)
      });
      message.error(`特殊块识别失败: ${error.message}`);
    } finally {
      setSpecialRecognitionRunning(false);
      setProcessing(false);
    }
  }, [
    pdfPath,
    pdfFile,
    pdfDocument,
    startPage,
    endPage,
    weldRecognitionAreaTemplate,
    recognizedMaterialPages,
    materialRowsByPage
  ]);

  const handleDetectWelds = useCallback(async () => {
    if (!aiDirectWeldMode && !vectorsResult) {
      message.warning('请先执行矢量提取');
      return;
    }

    setProcessing(true);
    setCurrentStep(3);

    try {
      multiPageBatchService.weldRecognitionArea = weldRecognitionAreaTemplate || null;
      if (!aiDirectWeldMode) {
        await multiPageBatchService.detectWeldsFromPages(
          startPage,
          endPage,
          true,
          weldRecognitionAreaTemplate
        );
      }

      if (aiWeldEnabled) {
        setAiWeldStatus({
          state: 'running',
          message: aiDirectWeldMode ? '正在连接远端焊点AI进行直识别' : '正在连接远端焊点AI并进行辅助识别'
        });
        try {
          const aiResult = await weldAiService.detectPages({
            pdfDocument,
            startPage,
            endPage,
            area: weldRecognitionAreaTemplate,
            pdfFile: pdfFile || pdfPath,
            projectName,
            onProgress: (current, total, step) => setProgress({ current, total, step })
          });
          if (aiResult.available) {
            const merged = aiDirectWeldMode
              ? multiPageBatchService.replaceWeldsWithAiDetections(aiResult.pages, startPage, endPage)
              : multiPageBatchService.mergeAiWeldDetections(aiResult.pages, startPage, endPage);
            const diagnostics = Object.values(merged.diagnostics || {});
            const matched = diagnostics.reduce((sum, item) => sum + Number(item?.matchedCount || 0), 0);
            const aiOnly = diagnostics.reduce((sum, item) => sum + Number(item?.aiOnlyCount || 0), 0);
            const accepted = diagnostics.reduce((sum, item) => sum + Number(item?.acceptedCount || 0), 0);
            setAiWeldStatus({
              state: 'completed',
              message: aiDirectWeldMode
                ? `远端AI直识别已完成：采用 ${accepted} 个焊点；已跳过矢量、规则和管件识别，模型 ${aiResult.modelVersion || '未标记版本'}`
                : `远端AI已完成：与规则一致 ${matched} 个，待人工确认 ${aiOnly} 个，模型 ${aiResult.modelVersion || '未标记版本'}`
            });
          } else {
            if (aiDirectWeldMode) throw new Error(aiResult.health?.message || '远端模型尚未准备好');
            setAiWeldStatus({
              state: 'unavailable',
              message: `${aiResult.health?.message || '远端模型尚未准备好'}；本次已仅使用现有规则识别`
            });
          }
        } catch (aiError) {
          if (aiDirectWeldMode) throw aiError;
          console.warn('远端焊点AI辅助识别失败，继续使用现有规则', aiError);
          setAiWeldStatus({
            state: 'unavailable',
            message: `${aiError.message || '远端AI识别失败'}；本次已仅使用现有规则识别`
          });
        }
      } else {
        setAiWeldStatus({ state: 'disabled', message: '本次未启用远端焊点AI，使用现有规则识别' });
      }
      // Reuse the same page vectors and weld snapshot so multi-page preview and
      // final generation receive identical fitting-to-weld relationships.
      // When disabled, explicitly clear this range to avoid displaying results
      // retained from an earlier run with fitting recognition enabled.
      let fittingsByPage = {};
      if (fittingRecognitionEnabled && !aiDirectWeldMode) {
        fittingsByPage = await multiPageBatchService.detectFittingsFromPages(
          startPage,
          endPage,
          weldRecognitionAreaTemplate,
          materialRowsByPage
        );
      } else {
        for (let pageNum = Number(startPage); pageNum <= Number(endPage); pageNum += 1) {
          multiPageBatchService.pageFittings[pageNum] = [];
        }
      }
      setCurrentStep(3);
      const detectedNotices = multiPageBatchService.getSpecialWeldNotices();
      const resultWithSupports = { ...multiPageBatchService.pageWelds };

      setWeldsResult(resultWithSupports);
      setWeldReviewVersion(version => version + 1);
      if (onWeldsDetected) {
        onWeldsDetected(resultWithSupports);
      }

      const allDetectedWelds = Object.values(resultWithSupports).flat();
      const totalWelds = allDetectedWelds.length;
      const fittingSummary = Object.values(fittingsByPage || {}).flat().reduce((summary, fitting) => {
        if (fitting?.branchOutlet) summary.branchOutlets += 1;
        else if (fitting?.type === 'tee-fitting') summary.tees += 1;
        else if (fitting?.type === 'valve-fitting') summary.valves += 1;
        else summary.elbows += 1;
        return summary;
      }, { elbows: 0, tees: 0, branchOutlets: 0, valves: 0 });
      const noticePageCount = Object.keys(detectedNotices || {}).length;
      message.success(
        (fittingRecognitionEnabled
          ? `焊点及管件识别完成：${totalWelds} 个焊点，` +
            `${fittingSummary.elbows} 个弯头、${fittingSummary.tees} 个三通、` +
            `${fittingSummary.branchOutlets} 个支管台、${fittingSummary.valves} 个阀门`
          : `焊点识别完成：${totalWelds} 个焊点（管件辅助识别未开启）`) +
        (noticePageCount > 0 ? `，${noticePageCount} 页有特殊焊点声明` : '')
      );
      const reviewByPage = multiPageBatchService.getWeldReviewCandidates();
      const reviewCount = Object.values(reviewByPage || {}).reduce(
        (sum, candidates) => sum + (Array.isArray(candidates) ? candidates.length : 0),
        0
      );
      if (reviewCount > 0) {
        const reviewPages = Object.entries(reviewByPage)
          .filter(([, candidates]) => Array.isArray(candidates) && candidates.length > 0)
          .map(([page, candidates]) => `第${page}页 ${candidates.length}个`)
          .join('、');
        message.warning(`另有 ${reviewCount} 个低置信度候选未自动采用：${reviewPages}`);
      }
    } catch (error) {
      message.error(`焊点识别失败: ${error.message}`);
      setCurrentStep(2);
    } finally {
      setProcessing(false);
    }
  }, [
    vectorsResult,
    startPage,
    endPage,
    weldRecognitionAreaTemplate,
    materialRowsByPage,
    onWeldsDetected,
    aiWeldEnabled,
    aiDirectWeldMode,
    fittingRecognitionEnabled,
    pdfDocument,
    pdfFile,
    pdfPath
  ]);

  const refreshAcceptedWelds = useCallback((page, nextWelds) => {
    const nextResult = {
      ...(multiPageBatchService.pageWelds || {}),
      [page]: nextWelds
    };
    setWeldsResult(nextResult);
    setWeldReviewVersion(version => version + 1);
    onWeldsDetected?.(nextResult);
  }, [onWeldsDetected]);

  const handleAcceptWeldReview = useCallback(record => {
    const nextWelds = multiPageBatchService.acceptWeldReviewCandidate(record.page, record.key);
    refreshAcceptedWelds(record.page, nextWelds);
    message.success(`已采用第${record.page}页候选焊点`);
  }, [refreshAcceptedWelds]);

  const handleRejectWeldReview = useCallback(record => {
    multiPageBatchService.rejectWeldReviewCandidate(record.page, record.key);
    setWeldReviewVersion(version => version + 1);
    message.info(`已忽略第${record.page}页候选焊点`);
  }, []);

  const handleRecognizeMaterials = useCallback(async () => {
    if (materialRecognitionRunRef.current.running) {
      message.info('材料表识别正在进行，请勿重复启动');
      return;
    }
    if (!pdfPath && !pdfFile) {
      message.error('PDF文件未提供');
      return;
    }
    if (!materialAreaTemplate) {
      message.warning('请先框选材料表区域');
      return;
    }

    const stepBeforeMaterialRecognition = currentStep;
    const materialRunId = materialRecognitionRunRef.current.id + 1;
    materialRecognitionRunRef.current = { id: materialRunId, running: true };
    setMaterialRecognizing(true);
    setProcessing(true);
    setCurrentStep(1);
    setStraightPipeQuantityConfirmationsByPage({});

    try {
      const pdfSource = pdfFile || pdfPath;
      const materialTemplate = {
        materialArea: materialAreaTemplate,
        ...(pipelineAreaTemplate ? { pipelineArea: pipelineAreaTemplate } : {}),
        ...(pipeClassAreaTemplate ? { pipeClassArea: pipeClassAreaTemplate } : {}),
        ...(pageNumberAreaTemplate ? { pageNumberArea: pageNumberAreaTemplate } : {}),
        columns: materialSplitLines || [],
        dividers: materialSplitLines || []
      };

      const pageResults = {};
      for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
        pageResults[pageNum] = {
          materials: [],
          rawLogicalRows: [],
          sourcePage: pageNum,
          fromMinerU: true,
          materialBatchRange: { startPage, endPage }
        };
      }

      const extractCell = (rowObj, idx) => {
        const key = `column${idx}`;
        const cell = rowObj?.[key];
        if (cell && typeof cell === 'object') return cell.text || '';
        return cell || '';
      };

      const isSixColumnMaterialRow = (row) => (
        Array.isArray(row) &&
        row.length >= 6 &&
        /管|弯头|弯管|三通|法兰|垫片|阀|螺栓|支架|PIPE|ELBOW|TEE|FLANGE|GASKET|VALVE|BOLT|SUPPORT/i.test(String(row[4] || ''))
      );

      const buildMaterialFromRawRow = (row, rowIndex, pageNum) => {
        const sixColumnLayout = isSixColumnMaterialRow(row);
        return {
          materialId: row?.[0],
          description: sixColumnLayout ? row?.[4] : row?.[1],
          specification: row?.[2],
          materialCode: sixColumnLayout ? row?.[1] : row?.[3],
          quantity: sixColumnLayout ? row?.[5] : row?.[4],
          pipelineNumber: sanitizeRecognizedPipelineNumber(
            sixColumnLayout ? (row?.[6] || '') : (row?.[5] || row?.[7] || '')
          ),
          drawingNumber: sixColumnLayout ? (row?.[7] || '') : (row?.[6] || row?.[8] || ''),
          ocrPage: sixColumnLayout ? (row?.[8] || '') : (row?.[7] || row?.[9] || ''),
          calculatedPage: pageNum,
          sourcePage: pageNum,
          key: `${pageNum}-${rowIndex}-${row?.[0] || rowIndex + 1}`,
          rawLogicalRow: row
        };
      };

      const applyMinerUResultToPage = (result, targetPage) => {
        const pageObjects = Array.isArray(result?.logical_rows) ? result.logical_rows : [];
        const pageResult = pageResults[targetPage] || {
          materials: [],
          rawLogicalRows: [],
          sourcePage: targetPage,
          fromMinerU: true,
          materialBatchRange: { startPage, endPage }
        };

        if (pageObjects.length > 0 && !Array.isArray(pageObjects[0]) && (pageObjects[0]?.material || pageObjects[0]?.pipeline || pageObjects[0]?.pageNumber)) {
          const pageObj = pageObjects[0];

          const rawPipelineText = String(pageObj?.pipeline?.text || '').trim();
          const pipelineText = sanitizeRecognizedPipelineNumber(rawPipelineText);
          const drawingText = pageObj?.drawingNumber?.text || '';
          const pageText = pageObj?.pageNumber?.text || '';
          const pipeClassText = sanitizeRecognizedPipelineNumber(
            pageObj?.pipeClass?.text || pageObj?.pipelineClass?.text
          );
          const materials = Array.isArray(pageObj?.material) ? pageObj.material : [];
          pageResult.pipelineNumber = pipelineText;
          if (rawPipelineText && !pipelineText) {
            pageResult.rejectedPipelineNumber = rawPipelineText;
            pageResult.pipelineStatus = 'unresolved';
            pageResult.pipelineSource = 'rejected-lone-one';
          }
          pageResult.drawingNumber = drawingText;
          pageResult.pageNumber = pageText;
          pageResult.pipeClass = pipeClassText;
          pageResult.pipelineClass = pipeClassText;

          pageResult.materials = materials.map((rowObj, rowIndex) => {
            const maxColumn = Math.max(
              5,
              ...Object.keys(rowObj || {})
                .map(key => /^column(\d+)$/.exec(key))
                .filter(Boolean)
                .map(match => Number(match[1]))
            );
            const rawRow = Array.from({ length: maxColumn }, (_, index) => extractCell(rowObj, index + 1));
            const mapped = buildMaterialFromRawRow(rawRow, rowIndex, targetPage);
            return {
              ...mapped,
              pipelineNumber: pipelineText,
              drawingNumber: drawingText,
              ocrPage: pageText,
              calculatedPage: targetPage,
              sourcePage: targetPage,
              key: `${targetPage}-${rowIndex}-${rawRow[0] || rowIndex + 1}`,
              rawMaterial: rowObj,
              rawLogicalRow: rawRow
            };
          });
          pageResult.rawLogicalRows = pageResult.materials.map(item => item.rawLogicalRow);
          pageResults[targetPage] = pageResult;
          return;
        }

        const rows = pageObjects.filter(Array.isArray);
        pageResult.rawLogicalRows = rows;
        pageResult.materials = rows.map((row, rowIndex) => buildMaterialFromRawRow(row, rowIndex, targetPage));
        pageResult.pipelineNumber = sanitizeRecognizedPipelineNumber(
          pageResult.materials.find(item => item.pipelineNumber)?.pipelineNumber
        );
        pageResults[targetPage] = pageResult;
      };

      const pageCount = Math.max(1, endPage - startPage + 1);
      for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
        const pageIndex = pageNum - startPage;
        setProgress({
          current: pageIndex,
          total: pageCount,
          step: `材料表识别中：第 ${pageNum} 页`
        });

        const result = await ocrService.runBatchOCRMinerU({
          pdfFile: pdfSource,
          pdfFileName: pdfFile?.name || (typeof pdfPath === 'string' ? pdfPath.split(/[/\\]/).pop() : ''),
          template: materialTemplate,
          pages: { type: 'custom', pages: [pageNum] },
          _suppressMinerUExcelDownload: true
        }, (progressData) => {
          const percent = Math.max(0, Math.min(100, Number(progressData?.progress) || 0));
          setProgress({
            current: pageIndex + percent / 100,
            total: pageCount,
            step: progressData?.status || `材料表识别中：第 ${pageNum} 页`
          });
        });

        applyMinerUResultToPage(result, pageNum);
        pageResults[pageNum].sourceLogicalRows = Array.isArray(result?.sourceLogicalRows)
          ? result.sourceLogicalRows
          : [];
        const firstPageResult = pageResults[pageNum];
        const firstRows = Array.isArray(firstPageResult?.materials) ? firstPageResult.materials : [];
        const firstResolution = resolveBatchSplitUpperContent({
          pageNum,
          batchContent: {
            jointTypeSource: 'material',
            materialRowsByPage: { [pageNum]: firstRows },
            jointTypeSupplementalTextByPage: {
              [pageNum]: JSON.stringify(firstPageResult.sourceLogicalRows || [])
            }
          }
        });
        const firstPipePlan = resolveStraightPipeMaterialPlan(firstRows);
        const firstQuantityMissing = firstPipePlan.reason === '直管 QTY 不是可用的长度';

        if (!firstResolution.materialJointType || firstQuantityMissing) {
          const missingLabels = [
            !firstResolution.materialJointType ? '接头形式' : '',
            firstQuantityMissing ? '直管QTY' : ''
          ].filter(Boolean).join('和');
          setProgress({
            current: pageIndex + 0.5,
            total: pageCount,
            step: `第 ${pageNum} 页未读取到${missingLabels}，正在自动重试材料表识别`
          });
          const retryResult = await ocrService.runBatchOCRMinerU({
            pdfFile: pdfSource,
            pdfFileName: pdfFile?.name || (typeof pdfPath === 'string' ? pdfPath.split(/[/\\]/).pop() : ''),
            template: materialTemplate,
            pages: { type: 'custom', pages: [pageNum] },
            _suppressMinerUExcelDownload: true
          });
          pageResults[pageNum] = {
            materials: [],
            rawLogicalRows: [],
            sourcePage: pageNum,
            fromMinerU: true,
            materialBatchRange: { startPage, endPage }
          };
          applyMinerUResultToPage(retryResult, pageNum);
          pageResults[pageNum].sourceLogicalRows = Array.isArray(retryResult?.sourceLogicalRows)
            ? retryResult.sourceLogicalRows
            : [];
          const retryPageResult = pageResults[pageNum];
          const retryRows = Array.isArray(retryPageResult?.materials) ? retryPageResult.materials : [];
          const retryResolution = resolveBatchSplitUpperContent({
            pageNum,
            batchContent: {
              jointTypeSource: 'material',
              materialRowsByPage: { [pageNum]: retryRows },
              jointTypeSupplementalTextByPage: {
                [pageNum]: JSON.stringify(retryPageResult.sourceLogicalRows || [])
              }
            }
          });
          const retryPipePlan = resolveStraightPipeMaterialPlan(retryRows);
          const quantityQualityScore = plan => (
            plan.reason === '直管 QTY 不是可用的长度' || plan.reason === '未找到直管材料行'
              ? 0
              : 20000
          );
          const firstScore = (firstResolution.materialJointType ? 10000 : 0) +
            quantityQualityScore(firstPipePlan) + firstRows.length;
          const retryScore = (retryResolution.materialJointType ? 10000 : 0) +
            quantityQualityScore(retryPipePlan) + retryRows.length;
          pageResults[pageNum] = retryScore >= firstScore ? retryPageResult : firstPageResult;
          pageResults[pageNum].materialRecognitionAttempts = 2;
          pageResults[pageNum].materialRecognitionRetried = true;
          pageResults[pageNum].straightPipeQuantityStatus = (
            resolveStraightPipeMaterialPlan(pageResults[pageNum].materials).reason === '直管 QTY 不是可用的长度'
          ) ? 'unresolved' : 'resolved';
        } else {
          pageResults[pageNum].materialRecognitionAttempts = 1;
          pageResults[pageNum].materialRecognitionRetried = false;
          pageResults[pageNum].straightPipeQuantityStatus = 'resolved';
        }

        const selectedPageResult = pageResults[pageNum];
        const selectedRawPipeline = String(selectedPageResult.pipelineNumber || '').trim();
        selectedPageResult.pipelineNumber = sanitizeRecognizedPipelineNumber(selectedRawPipeline);
        if (selectedRawPipeline && !selectedPageResult.pipelineNumber) {
          selectedPageResult.rejectedPipelineNumber = selectedRawPipeline;
          selectedPageResult.pipelineStatus = 'unresolved';
          selectedPageResult.pipelineSource = 'rejected-numeric-only';
        }
        const needsPipeline = !String(selectedPageResult.pipelineNumber || '').trim() && !!pipelineAreaTemplate;
        const rawSelectedPipeClass = String(
          selectedPageResult.pipeClass || selectedPageResult.pipelineClass || ''
        ).trim();
        const selectedPipeClass = sanitizeRecognizedPipelineNumber(rawSelectedPipeClass);
        selectedPageResult.pipeClass = selectedPipeClass;
        selectedPageResult.pipelineClass = selectedPipeClass;
        if (rawSelectedPipeClass && !selectedPipeClass) {
          selectedPageResult.rejectedPipeClass = rawSelectedPipeClass;
          selectedPageResult.pipeClassStatus = 'unresolved';
          selectedPageResult.pipeClassSource = 'rejected-numeric-only';
        }
        const needsPipeClass = !selectedPipeClass && !!pipeClassAreaTemplate;
        const needsPageNumber = !String(selectedPageResult.pageNumber || '').trim() && !!pageNumberAreaTemplate;
        if (needsPipeline || needsPipeClass || needsPageNumber) {
          setProgress({
            current: pageIndex + 0.85,
            total: pageCount,
            step: `第 ${pageNum} 页正在补充管线号、管道等级和页码字段`
          });
          try {
            const [fieldResult, pipeClassAreaResult] = await Promise.all([
              (needsPipeline || needsPageNumber)
                ? ocrService.recognizeSinglePage(pdfSource, {
                    materialArea: null,
                    ...(needsPipeline ? { pipelineArea: pipelineAreaTemplate } : {}),
                    ...(needsPageNumber ? { pageNumberArea: pageNumberAreaTemplate } : {}),
                    columns: []
                  }, pageNum)
                : Promise.resolve(null),
              needsPipeClass
                ? ocrService.extractPipelineWithOcrArea(pdfSource, pageNum, pipeClassAreaTemplate)
                : Promise.resolve(null)
            ]);
            if (needsPipeline) {
              const rawFieldPipeline = String(fieldResult?.pipelineNumber || '').trim();
              selectedPageResult.pipelineNumber = sanitizeRecognizedPipelineNumber(rawFieldPipeline);
              if (rawFieldPipeline && !selectedPageResult.pipelineNumber) {
                selectedPageResult.rejectedPipelineNumber = rawFieldPipeline;
                selectedPageResult.pipelineStatus = 'unresolved';
                selectedPageResult.pipelineSource = 'rejected-numeric-only';
              }
            }
            if (needsPipeClass) {
              const rawPipeClass = String(pipeClassAreaResult?.pipelineNumber || '')
                .replace(/^(?:管道等级|PIPE\s*CLASS)\s*[:：]?\s*/i, '')
                .replace(/[\r\n]+/g, ' ')
                .trim();
              const pipeClass = sanitizeRecognizedPipelineNumber(rawPipeClass);
              selectedPageResult.pipeClass = pipeClass;
              selectedPageResult.pipelineClass = pipeClass;
              if (rawPipeClass && !pipeClass) {
                selectedPageResult.rejectedPipeClass = rawPipeClass;
              }
              selectedPageResult.pipeClassSource = pipeClass
                ? 'paddleocr-pipe-class-area'
                : 'unresolved';
            }
            if (needsPageNumber) {
              selectedPageResult.pageNumber = String(fieldResult?.pageNumber || '').trim();
            }
            selectedPageResult.fieldRecognitionSource = 'material-pass-supplement';
          } catch (fieldError) {
            console.warn(`第 ${pageNum} 页材料识别字段补充失败:`, fieldError);
            selectedPageResult.fieldRecognitionError = fieldError.message || String(fieldError);
          }
        }
      }

      // Fill only bounded missing runs. Both reliable neighbours must agree,
      // otherwise the page may sit at a real pipeline boundary and remains for
      // manual confirmation.
      const orderedMaterialPages = Object.keys(pageResults)
        .map(Number)
        .filter(Number.isFinite)
        .sort((left, right) => left - right);
      let missingRunStart = 0;
      while (missingRunStart < orderedMaterialPages.length) {
        const currentPage = orderedMaterialPages[missingRunStart];
        if (sanitizeRecognizedPipelineNumber(pageResults[currentPage]?.pipelineNumber)) {
          missingRunStart += 1;
          continue;
        }
        let missingRunEnd = missingRunStart;
        while (
          missingRunEnd + 1 < orderedMaterialPages.length &&
          !sanitizeRecognizedPipelineNumber(pageResults[orderedMaterialPages[missingRunEnd + 1]]?.pipelineNumber)
        ) {
          missingRunEnd += 1;
        }
        const previousPage = missingRunStart > 0 ? orderedMaterialPages[missingRunStart - 1] : null;
        const nextPage = missingRunEnd + 1 < orderedMaterialPages.length
          ? orderedMaterialPages[missingRunEnd + 1]
          : null;
        const previousPipeline = previousPage === null
          ? ''
          : sanitizeRecognizedPipelineNumber(pageResults[previousPage]?.pipelineNumber);
        const nextPipeline = nextPage === null
          ? ''
          : sanitizeRecognizedPipelineNumber(pageResults[nextPage]?.pipelineNumber);
        if (
          previousPipeline &&
          nextPipeline &&
          previousPipeline.replace(/\s+/g, '').toUpperCase() === nextPipeline.replace(/\s+/g, '').toUpperCase()
        ) {
          for (let index = missingRunStart; index <= missingRunEnd; index += 1) {
            const pageResult = pageResults[orderedMaterialPages[index]];
            pageResult.pipelineNumber = previousPipeline;
            pageResult.pipelineStatus = 'matched';
            pageResult.pipelineConfidence = 0.8;
            pageResult.pipelineSource = 'same-pipeline-bounded-neighbours';
          }
        }
        missingRunStart = missingRunEnd + 1;
      }

      // A pipe class is a pipeline-level property. OCR can miss a small field
      // on an individual page, so reuse an unambiguous value from another page
      // with the same pipeline number. Generic material-table headings are not
      // valid pipeline identities and are deliberately excluded.
      const normalizePipelineKey = value => String(value || '').replace(/\s+/g, '').toUpperCase();
      const pipeClassVotesByPipeline = new Map();
      Object.values(pageResults).forEach(pageResult => {
        const pipelineKey = normalizePipelineKey(pageResult?.pipelineNumber);
        const pipeClass = sanitizeRecognizedPipelineNumber(
          pageResult?.pipeClass || pageResult?.pipelineClass
        );
        if (!pipelineKey || /^(?:MATERIAL-?LIST|PIPE|LINE(?:NO)?)$/.test(pipelineKey) || !pipeClass) return;
        if (!pipeClassVotesByPipeline.has(pipelineKey)) {
          pipeClassVotesByPipeline.set(pipelineKey, new Map());
        }
        const votes = pipeClassVotesByPipeline.get(pipelineKey);
        votes.set(pipeClass, (votes.get(pipeClass) || 0) + 1);
      });

      const resolvedPipeClassByPipeline = new Map();
      pipeClassVotesByPipeline.forEach((votes, pipelineKey) => {
        const ranked = Array.from(votes.entries()).sort((left, right) => right[1] - left[1]);
        if (ranked.length === 1 || ranked[0][1] > ranked[1][1]) {
          resolvedPipeClassByPipeline.set(pipelineKey, ranked[0][0]);
        }
      });

      Object.values(pageResults).forEach(pageResult => {
        if (String(pageResult?.pipeClass || pageResult?.pipelineClass || '').trim()) return;
        const pipelineKey = normalizePipelineKey(pageResult?.pipelineNumber);
        const sharedPipeClass = resolvedPipeClassByPipeline.get(pipelineKey);
        if (!sharedPipeClass) return;
        pageResult.pipeClass = sharedPipeClass;
        pageResult.pipelineClass = sharedPipeClass;
        pageResult.pipeClassStatus = 'matched';
        pageResult.pipeClassSource = 'same-pipeline-material-recognition';
      });

      const totalRows = Object.values(pageResults).reduce((sum, pageData) => {
        const count = Array.isArray(pageData?.materials) && pageData.materials.length > 0
          ? pageData.materials.length
          : Array.isArray(pageData?.rawLogicalRows) ? pageData.rawLogicalRows.length : 0;
        return sum + count;
      }, 0);

      if (materialRecognitionRunRef.current.id !== materialRunId) return;
      setRecognizedMaterialPages(pageResults);
      const noticesWithSupports = multiPageBatchService.detectSupportNoticesFromMaterialResults(
        pageResults,
        startPage,
        endPage
      );
      setSpecialWeldNotices(noticesWithSupports);

      window.dispatchEvent(new CustomEvent('ocr-batch-completed', {
        detail: {
          success: true,
          mode: 'material',
          fileName: pdfFile?.name || (typeof pdfPath === 'string' ? pdfPath.split(/[/\\]/).pop() : ''),
          startPage,
          endPage,
          totalRows,
          pageResults
        }
      }));

      const reusableTextResults = {};
      Object.entries(pageResults).forEach(([pageNum, pageResult]) => {
        const existing = multiPageBatchService.pageTextDetections[pageNum] || {};
        const pipelineNumber = sanitizeRecognizedPipelineNumber(pageResult?.pipelineNumber);
        const existingPipelineNumber = sanitizeRecognizedPipelineNumber(existing?.pipelineNumber);
        const resolvedPipelineNumber = pipelineNumber || existingPipelineNumber;
        const pipeClass = sanitizeRecognizedPipelineNumber(
          pageResult?.pipeClass || pageResult?.pipelineClass
        );
        const existingPipeClass = sanitizeRecognizedPipelineNumber(
          existing?.pipeClass || existing?.pipelineClass
        );
        const resolvedPipeClass = pipeClass || existingPipeClass;
        const merged = {
          ...existing,
          pipelineNumber: resolvedPipelineNumber,
          pipelineStatus: resolvedPipelineNumber ? 'matched' : 'unresolved',
          pipelineConfidence: pipelineNumber ? 1 : (resolvedPipelineNumber ? existing.pipelineConfidence || 0.8 : 0),
          pipelineSource: pipelineNumber
            ? 'material-recognition'
            : resolvedPipelineNumber ? existing.pipelineSource || 'text-recognition' : 'unresolved',
          pipelineEngine: pipelineNumber ? 'mineru' : (existing.pipelineEngine || 'paddleocr'),
          pipeClass: resolvedPipeClass,
          pipelineClass: resolvedPipeClass,
          pipeClassStatus: resolvedPipeClass ? 'matched' : 'unresolved',
          pipeClassSource: pipeClass
            ? 'material-recognition'
            : resolvedPipeClass ? existing.pipeClassSource || 'text-recognition' : 'unresolved',
          ...(pageResult?.pageNumber ? { pageNumber: pageResult.pageNumber } : {})
        };
        multiPageBatchService.pageTextDetections[pageNum] = merged;
        reusableTextResults[pageNum] = merged;
      });
      setTextsResult(prev => ({ ...(prev || {}), ...reusableTextResults }));

      const supportPages = Object.values(noticesWithSupports).filter(items => (
        (items || []).some(item => item.type === 'welded-support')
      )).length;
      message.success(`材料表自动识别完成! 共 ${totalRows} 行数据，识别到支架 ${supportPages} 页`);
    } catch (error) {
      console.error('材料表自动识别失败:', error);
      message.error(`材料表自动识别失败: ${error.message}`);
    } finally {
      if (materialRecognitionRunRef.current.id === materialRunId) {
        materialRecognitionRunRef.current.running = false;
        setMaterialRecognizing(false);
        setProcessing(false);
        setCurrentStep(stepBeforeMaterialRecognition);
      }
    }
  }, [
    pdfPath,
    pdfFile,
    startPage,
    endPage,
    materialAreaTemplate,
    materialSplitLines,
    pipelineAreaTemplate,
    pipeClassAreaTemplate,
    pageNumberAreaTemplate,
    currentStep
  ]);

  useEffect(() => {
    const handleExternalMaterialRecognize = () => {
      handleRecognizeMaterials();
    };

    window.addEventListener('multi-page-material-recognize', handleExternalMaterialRecognize);
    return () => window.removeEventListener('multi-page-material-recognize', handleExternalMaterialRecognize);
  }, [handleRecognizeMaterials]);

  const handleDetectPipelines = useCallback(async () => {
    if (!weldsResult) {
      message.warning('请先执行焊点识别');
      return;
    }

    setProcessing(true);
    setCurrentStep(4);

    try {
      const result = await multiPageBatchService.detectPipelinesFromPages(
        startPage,
        endPage
      );

      setPipelinesResult(result);
      message.success('管道识别已跳过 (临时禁用)，将使用空间顺序进行编号');
    } catch (error) {
      message.error(`管道识别失败: ${error.message}`);
      setCurrentStep(3);
    } finally {
      setProcessing(false);
    }
  }, [weldsResult, startPage, endPage]);

  const handleGenerateNumbers = useCallback(async () => {
    if (!pipelinesResult) {
      message.warning('请先执行管道识别');
      return;
    }
    if (unresolvedDiameterPages.length > 0) {
      setDiameterConfirmationVisible(true);
      message.warning(`检测到 ${unresolvedDiameterPages.length} 页含多种 PIPE/FITTINGS 规格，请先人工确认寸径`);
      return;
    }
    if (invalidDiameterRangePages.length > 0) {
      setDiameterConfirmationVisible(true);
      message.warning('寸径对应的焊口号范围格式不正确，请先修改');
      return;
    }

    if (unresolvedJointTypePages.length > 0) {
      message.warning(`仍有 ${unresolvedJointTypePages.length} 页未识别接头形式，请先在“接头类型”下方逐页填写`);
      return;
    }

    if (unresolvedPipeClassPages.length > 0) {
      message.warning(
        `仍有 ${unresolvedPipeClassPages.length} 页未识别管道等级；将继续智能编号，对应焊口表字段暂时留空`,
        4
      );
    }

    setProcessing(true);
    setCurrentStep(5);

    try {
      console.log('🚀 开始生成编号流程...');

      const manualPipeClassUpdates = {};
      Object.entries(pipeClassConfirmationsByPage).forEach(([page, value]) => {
        const normalizedValue = String(value || '').trim();
        if (!normalizedValue) return;
        const existing = multiPageBatchService.pageTextDetections?.[page] || {};
        multiPageBatchService.pageTextDetections[page] = {
          ...existing,
          pipeClass: normalizedValue,
          pipelineClass: normalizedValue,
          pipeClassStatus: 'manual'
        };
        manualPipeClassUpdates[page] = multiPageBatchService.pageTextDetections[page];
      });
      if (Object.keys(manualPipeClassUpdates).length > 0) {
        setTextsResult(prev => ({ ...(prev || {}), ...manualPipeClassUpdates }));
        onTextsDetected?.(manualPipeClassUpdates);
      }

      let pdfName = 'unknown.pdf';
      const actualPdfFile = pdfFile;
      if (pdfFile && pdfFile.name) {
        pdfName = pdfFile.name;
      } else if (pdfPath && typeof pdfPath === 'string') {
        pdfName = pdfPath.split(/[/\\]/).pop();
      }

      const sessionId = await startLogging(pdfName, 'weld_numbering', pdfPath, actualPdfFile);
      if (!sessionId) {
        console.warn('⚠️ 日志记录启动失败，但继续执行编号');
      }

      let autoWeldSummary = [];
      if (straightPipeAutoWeldEnabled) {
        for (let page = Number(startPage); page <= Number(endPage); page += 1) {
          const baseWelds = multiPageBatchService.getPageWelds(page)
            .filter(weld => weld.isAutoPipeLengthInserted !== true);
          const pageVectors = vectorsResult?.[page] || vectorsResult?.[String(page)] ||
            multiPageBatchService.pageVectors?.[page] || [];
          const pageMaterialRows = materialRowsByPage?.[page] || materialRowsByPage?.[String(page)] || [];
          const result = planStraightPipeAutoWelds({
            pageNum: page,
            materialRows: pageMaterialRows,
            manualQuantity: straightPipeQuantityConfirmationsByPage[page] || '',
            vectors: pageVectors,
            existingWelds: baseWelds,
            area: weldRecognitionAreaTemplate,
            pageInfo: multiPageBatchService.getPageInfo(page, pageVectors)
          });
          multiPageBatchService.setPageWelds(
            page,
            result.status === 'applied' ? result.welds : baseWelds
          );
          autoWeldSummary.push(result);
          logPage(page, {
            straightPipeAutoWeld: {
              status: result.status,
              reason: result.reason || '',
              addedCount: result.addedWelds?.length || 0,
              material: result.material || null,
              geometry: result.geometry || null
            }
          }, result.status === 'skipped' ? 'warning' : 'success');
        }
        setWeldsResult({ ...multiPageBatchService.pageWelds });
      } else {
        // Re-running numbering with the option disabled must remove points that were
        // inserted by an earlier preview, while preserving all recognized/manual welds.
        for (let page = Number(startPage); page <= Number(endPage); page += 1) {
          const retained = multiPageBatchService.getPageWelds(page)
            .filter(weld => weld.isAutoPipeLengthInserted !== true);
          multiPageBatchService.setPageWelds(page, retained);
        }
      }
      setStraightPipeAutoWeldSummary(autoWeldSummary);

      const allWelds = multiPageBatchService.generateWeldNumbers(
        startPage,
        endPage,
        startNumber,
        batchRule?.prefix || '',
        batchRule?.suffix || ''
      );

      setNumbersResult(allWelds);
      multiPageBatchService.setPendingBatchAnnotationRule(batchRule);
      const stats = multiPageBatchService.getPipelineStats();
      const comparison = syncPipelineComparisonState();
      setPipelineStatsResult(stats);

      const weldsByPage = {};
      allWelds.forEach(weld => {
        const page = weld.pageNum || weld.page || 1;
        if (!weldsByPage[page]) {
          weldsByPage[page] = [];
        }
        weldsByPage[page].push(weld);
      });

      for (let page = startPage; page <= endPage; page++) {
        logPage(page, { welds: weldsByPage[page] || [] }, 'success');
      }

      setShowNumberPreview(true);
      if (onShowNumberPreview) {
        onShowNumberPreview(true, allWelds, { startPage, endPage });
      }

      const pipelineSummary = getPipelineStatsSummary(stats);
      const comparisonSummary = comparison?.summary || null;
      const compareText = comparisonSummary
        ? `，对账异常 ${comparisonSummary.abnormalCount} 条`
        : '';
      message.success(
        `编号生成完成! 共 ${allWelds.length} 个焊点，${pipelineSummary.totalGroups} 组管线核对结果已生成${compareText}，请确认自动顺序或使用多段起止修正。`,
        2
      );

      await endLogging();
    } catch (error) {
      console.error('❌ 编号生成失败:', error);
      message.error(`编号生成失败: ${error.message}`);
      setCurrentStep(4);
      setShowNumberPreview(false);

      try {
        await endLogging();
      } catch (endLoggingError) {
        console.error('结束日志记录失败:', endLoggingError);
      }
    } finally {
      setProcessing(false);
    }
  }, [
    pipelinesResult,
    startPage,
    endPage,
    startNumber,
    batchRule,
    onShowNumberPreview,
    onTextsDetected,
    pdfPath,
    pdfFile,
    startLogging,
    logPage,
    endLogging,
    syncPipelineComparisonState,
    unresolvedDiameterPages,
    invalidDiameterRangePages,
    unresolvedJointTypePages,
    unresolvedPipeClassPages,
    unresolvedStraightPipeQuantityPages,
    pipeClassConfirmationsByPage,
    straightPipeAutoWeldEnabled,
    straightPipeQuantityConfirmationsByPage,
    vectorsResult,
    materialRowsByPage,
    weldRecognitionAreaTemplate
  ]);

  const handleExportPipelineStats = useCallback(() => {
    const stats = multiPageBatchService.getPipelineStats();
    const comparison = multiPageBatchService.getPipelineComparison();
    if ((!stats || stats.length === 0) && !comparison) {
      message.warning('暂无可导出的管线核对数据');
      return;
    }

    const fileBaseName = getPdfBaseName();
    const result = multiPageBatchService.exportPipelineStatsCSV(fileBaseName);
    message.success(`已导出${comparison ? '管线对账' : '管线核对'} CSV: ${result.fileName}`);
  }, [getPdfBaseName]);

  const handleConfirmAnnotations = useCallback(() => {
    if (!numbersResult || numbersResult.length === 0) {
      message.warning('没有编号数据');
      return;
    }

    try {
      if (segmentCorrectionActive) {
        message.warning('当前正在修正编号，请使用右上角“生成可编辑标注”；如需原自动顺序，请先恢复自动顺序');
        return;
      }
      const annotations = multiPageBatchService.convertWeldsToAnnotations(
        scale,
        batchRule,
        'KEEP_ORDER',
        null,
        {
          weldRecognitionArea: weldRecognitionAreaTemplate,
          pageVectors: vectorsResult,
          pageTextDetections: textsResult
        }
      );
      if (onAnnotationsGenerated) {
        onAnnotationsGenerated(annotations);
      }

      setShowNumberPreview(false);
      setSegmentCorrectionActive(false);
      if (onShowNumberPreview) {
        // 保留本次编号焊点，便于生成后随时重新进入补点/顺序调整。
        onShowNumberPreview(false, numbersResult);
      }

      message.success(`已生成 ${annotations.length} 个标注 (主管优先)`);
    } catch (error) {
      console.error('❌ 生成标注失败:', error);
      message.error(`生成标注失败: ${error.message}`);
    }
  }, [
    numbersResult,
    scale,
    batchRule,
    weldRecognitionAreaTemplate,
    vectorsResult,
    textsResult,
    segmentCorrectionActive,
    onAnnotationsGenerated,
    onShowNumberPreview,
    onRestoreAutoOrder
  ]);

  const handleStartSegmentCorrection = useCallback(() => {
    if (!numbersResult?.length) {
      message.warning('请先生成自动编号顺序');
      return;
    }
    setSegmentCorrectionActive(true);
    onStartSegmentCorrection?.(numbersResult);
  }, [numbersResult, onStartSegmentCorrection]);

  const handleRestoreAutoOrder = useCallback(() => {
    setSegmentCorrectionActive(false);
    onRestoreAutoOrder?.(numbersResult || []);
  }, [numbersResult, onRestoreAutoOrder]);

  useEffect(() => {
    const handleApplied = () => {
      setSegmentCorrectionActive(false);
      setShowNumberPreview(false);
      setNumbersResult(null);
    };
    window.addEventListener('multi-page-segment-correction-applied', handleApplied);
    return () => window.removeEventListener('multi-page-segment-correction-applied', handleApplied);
  }, []);

  const openExcelFilePicker = useCallback(() => {
    excelInputRef.current?.click();
  }, []);

  const handleExcelImport = useCallback(async event => {
    const target = event.target;
    const file = target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheets = workbook.SheetNames.map(sheetName => ({
        name: sheetName,
        rows: XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
          header: 1,
          defval: '',
          raw: false
        })
      }));

      if (sheets.length === 0) {
        message.error('Excel 文件中没有可用工作表');
        return;
      }

      const autoMatchedSheet = detectPipelineReferenceSheet(sheets);
      if (autoMatchedSheet) {
        const summary = buildPipelineReferenceSummary(autoMatchedSheet.rows, {
          sheetName: autoMatchedSheet.sheetName,
          sourceFileName: file.name,
          pipelineColumnIndex: autoMatchedSheet.pipelineColumnIndex,
          countColumnIndex: autoMatchedSheet.countColumnIndex
        });
        applyReferenceSummary(summary);
        return;
      }

      setPendingWorkbookSheets(sheets);
      setPendingWorkbookFileName(file.name);
      setManualSheetName(sheets[0]?.name || '');
      setManualMappingVisible(true);
      message.warning('未能自动识别 Excel 列，请手动选择工作表和列');
    } catch (error) {
      console.error('❌ Excel 导入失败:', error);
      message.error(`Excel 导入失败: ${error.message}`);
    } finally {
      target.value = '';
    }
  }, [applyReferenceSummary]);

  const handleManualMappingConfirm = useCallback(() => {
    const activeSheet = pendingWorkbookSheets.find(sheet => sheet.name === manualSheetName) || pendingWorkbookSheets[0];
    if (!activeSheet) {
      message.error('请选择有效的工作表');
      return;
    }

    if (!Number.isInteger(manualPipelineColumnIndex) || !Number.isInteger(manualCountColumnIndex)) {
      message.error('请选择管线列和数量列');
      return;
    }

    if (manualPipelineColumnIndex === manualCountColumnIndex) {
      message.error('管线列和数量列不能相同');
      return;
    }

    try {
      const summary = buildPipelineReferenceSummary(activeSheet.rows, {
        sheetName: activeSheet.name,
        sourceFileName: pendingWorkbookFileName,
        pipelineColumnIndex: manualPipelineColumnIndex,
        countColumnIndex: manualCountColumnIndex
      });

      applyReferenceSummary(summary, `Excel 基准已导入：${summary.itemCount} 条管线`);
      setManualMappingVisible(false);
      setPendingWorkbookSheets([]);
      setPendingWorkbookFileName('');
    } catch (error) {
      message.error(error.message || 'Excel 列映射解析失败');
    }
  }, [
    pendingWorkbookSheets,
    manualSheetName,
    manualPipelineColumnIndex,
    manualCountColumnIndex,
    pendingWorkbookFileName,
    applyReferenceSummary
  ]);

  const currentManualSheet = pendingWorkbookSheets.find(sheet => sheet.name === manualSheetName) || pendingWorkbookSheets[0];
  const currentManualHeaders = (currentManualSheet?.rows?.[0] || []).map((value, index) => ({
    label: String(value ?? '').trim() || `第 ${index + 1} 列`,
    value: index
  }));

  const pipelineStatsSummary = getPipelineStatsSummary(pipelineStatsResult);
  const comparisonSummary = pipelineComparisonResult?.summary || null;
  const comparisonEnabled = !!referenceSummary;
  const hasStatsTable = comparisonEnabled
    ? !!pipelineComparisonResult && pipelineComparisonResult.items.length > 0
    : pipelineStatsResult.length > 0;
  const tableData = comparisonEnabled
    ? (pipelineComparisonResult?.items || [])
    : pipelineStatsResult;

  const tableColumns = comparisonEnabled
    ? [
        {
          title: '管线号',
          dataIndex: 'pipelineNumber',
          key: 'pipelineNumber',
          width: 160,
          render: value => (
            <span style={{ color: value ? '#1890ff' : '#ff4d4f', fontWeight: value ? 600 : 500 }}>
              {value || '未识别'}
            </span>
          )
        },
        {
          title: '页码',
          dataIndex: 'pagesText',
          key: 'pagesText',
          render: value => value && value !== '-'
            ? value.split(/[,，\s]+/).filter(Boolean).map(page => (
                <Tag key={page} color="geekblue" style={{ marginBottom: 2, fontSize: 12 }}>{page}</Tag>
              ))
            : <span style={{ color: '#bbb' }}>—</span>
        },
        {
          title: '已识别焊点数量',
          dataIndex: 'actualWeldCount',
          key: 'actualWeldCount',
          width: 120,
          align: 'center',
          render: value => <span style={{ fontWeight: 700, color: value > 0 ? '#1890ff' : '#888' }}>{value ?? 0}</span>
        },
        {
          title: '差值',
          dataIndex: 'delta',
          key: 'delta',
          width: 86,
          align: 'center',
          render: value => {
            if (value === null || value === undefined) {
              return <span style={{ color: '#bbb' }}>—</span>;
            }

            const color = value === 0 ? '#52c41a' : '#ff4d4f';
            return <span style={{ fontWeight: 700, color }}>{value > 0 ? `+${value}` : value}</span>;
          }
        },
        {
          title: '对账状态',
          dataIndex: 'compareStatus',
          key: 'compareStatus',
          width: 110,
          render: (_, record) => <Tag color={getComparisonTagColor(record.compareStatus)}>{record.compareStatusText}</Tag>
        },
        {
          title: '异常说明',
          dataIndex: 'message',
          key: 'message',
          render: value => value || <span style={{ color: '#bbb' }}>—</span>
        }
      ]
    : [
        {
          title: '管线号',
          dataIndex: 'pipelineNumber',
          key: 'pipelineNumber',
          width: 160,
          render: (value, record) => {
            const label = value || (record.weldCount > 0 ? '未识别' : '未识别/空白页');
            const isUnresolved = !value;
            return (
              <span style={{ color: isUnresolved ? '#ff4d4f' : '#1890ff', fontWeight: isUnresolved ? 'normal' : 600 }}>
                {label}
              </span>
            );
          }
        },
        {
          title: '页码',
          dataIndex: 'pagesText',
          key: 'pagesText',
          render: value => {
            if (!value || value === '-') return <span style={{ color: '#bbb' }}>—</span>;
            return value.split(/[,，\s]+/).filter(Boolean).map(page => (
              <Tag key={page} color="geekblue" style={{ marginBottom: 2, fontSize: 12 }}>{page}</Tag>
            ));
          }
        },
        {
          title: '焊点数',
          dataIndex: 'weldCount',
          key: 'weldCount',
          width: 80,
          align: 'center',
          render: value => (
            <span style={{ fontWeight: 700, fontSize: 15, color: value > 0 ? '#1890ff' : '#bbb' }}>
              {value ?? 0}
            </span>
          )
        },
        {
          title: '编号范围',
          dataIndex: 'numberRangeText',
          key: 'numberRangeText',
          render: value => value || <span style={{ color: '#bbb' }}>—</span>
        },
        {
          title: '候选数',
          dataIndex: 'candidateCount',
          key: 'candidateCount',
          width: 72,
          align: 'center',
          render: value => <span style={{ color: '#888' }}>{value ?? '—'}</span>
        },
        {
          title: '来源',
          dataIndex: 'engineText',
          key: 'engineText',
          width: 130,
          render: (_, record) => {
            if (record.engineText === 'mineru') {
              return <Tag color="blue">MinerU</Tag>;
            }
            if (record.engineText === 'paddleocr') {
              return record.fallbackPages?.length > 0
                ? <Tag color="orange">PaddleOCR 回退</Tag>
                : <Tag color="cyan">PaddleOCR</Tag>;
            }
            const text = record.sourceText || record.engineText;
            return text ? <Tag>{text}</Tag> : <span style={{ color: '#bbb' }}>—</span>;
          }
        },
        {
          title: '异常页',
          dataIndex: 'unresolvedPagesText',
          key: 'unresolvedPagesText',
          render: value => value
            ? <span style={{ color: '#fa8c16' }}>{value}</span>
            : <span style={{ color: '#bbb' }}>—</span>
        },
        {
          title: '状态',
          dataIndex: 'status',
          key: 'status',
          width: 110,
          render: value => {
            let color = 'default';
            if (value === '已匹配') color = 'success';
            if (value === '部分未识别') color = 'warning';
            if (value === '未识别' || value === '未识别/空白页') color = 'error';
            if (value === '空白页') color = 'blue';
            return <Tag color={color}>{value}</Tag>;
          }
        }
      ];

  return (
    <div style={{ width: '100%' }}>
      <style>{`
        .pipeline-row-error td { background: #fff1f0 !important; }
        .pipeline-row-success td { background: #f6ffed !important; }
        .pipeline-row-warning td { background: #fffbe6 !important; }
      `}</style>

      <input
        ref={excelInputRef}
        type="file"
        accept=".xlsx,.xls"
        style={{ display: 'none' }}
        onChange={handleExcelImport}
      />

      <Alert
        message="分步骤处理流程"
        description="矢量提取 → 文字识别 → 焊点识别 → 智能编号（按空间顺序）"
        type="info"
        showIcon
        closable={false}
        style={{ marginBottom: 16 }}
      />

      <Alert
        style={{ marginBottom: 16 }}
        type={specialWeldNoticeRows.length > 0 ? 'warning' : 'info'}
        showIcon
        message="支架 / 静电接地 / 定位块识别声明（仅提示，不会自动添加）"
        description={specialWeldNoticeRows.length > 0 ? (
          <div>
            <div style={{ color: '#666', marginBottom: 4 }}>
              本次检查范围：第 {startPage}—{endPage} 页
            </div>
            {specialWeldNoticeRows.map(row => (
              <div key={row.key} style={{ marginTop: 4 }}>
                <strong>{row.label}</strong>：第 {row.pages.join('、')} 页
                {row.detail ? <span style={{ color: '#8c6d1f' }}>（{row.detail}）</span> : null}
              </div>
            ))}
          </div>
        ) : specialRecognitionCompleted
          ? `已检查第 ${startPage}—${endPage} 页，本次未识别到焊接支架、静电接地或定位块文案。`
          : '支架和 JPLATE 会在材料表自动识别完成后直接从保存结果中提取；点击“特殊块识别”只检查焊点区域内的 SEG-PIP。'}
      />

      <div style={{ marginBottom: 10, padding: '10px 12px', border: '1px solid #ffe7ba', borderRadius: 8, background: '#fffaf0' }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <div>
            <strong>管件辅助识别</strong>
            <div style={{ color: '#666', fontSize: 12, marginTop: 2 }}>
              开启后，在焊点识别完成后继续识别弯头、三通、支管台和阀门；默认关闭。
            </div>
          </div>
          <Switch
            checked={fittingRecognitionEnabled}
            onChange={setFittingRecognitionEnabled}
            disabled={processing || currentStep > 2}
            checkedChildren="开启"
            unCheckedChildren="关闭"
          />
        </Space>
      </div>

      <div style={{ marginBottom: 16, padding: '10px 12px', border: '1px solid #d9e8ff', borderRadius: 8, background: '#f7fbff' }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <div>
            <strong>远端AI焊点辅助（申远试运行）</strong>
            <div style={{ color: '#666', fontSize: 12, marginTop: 2 }}>
              可选“辅助校正”或“AI直识别”。直识别不跑整页矢量、规则焊点和管件识别，直接采用远端AI结果。
            </div>
          </div>
          <Switch
            checked={aiWeldEnabled}
            onChange={setAiWeldEnabled}
            disabled={processing || currentStep > 2}
            checkedChildren="开启"
            unCheckedChildren="关闭"
          />
        </Space>
        {aiWeldEnabled && (
          <Select
            size="small"
            value={aiWeldRecognitionMode}
            disabled={processing || currentStep > 0}
            style={{ width: '100%', marginTop: 8 }}
            onChange={value => {
              setAiWeldRecognitionMode(value);
              if (value === 'direct') setFittingRecognitionEnabled(false);
            }}
            options={[
              { value: 'assist', label: '辅助校正：规则＋矢量＋远端AI（原有方式）' },
              { value: 'direct', label: 'AI直识别：跳过整页矢量与管件识别' }
            ]}
          />
        )}
        {aiWeldStatus.state !== 'idle' && (
          <Alert
            style={{ marginTop: 8 }}
            showIcon
            type={aiWeldStatus.state === 'completed'
              ? 'success'
              : aiWeldStatus.state === 'unavailable'
                ? 'warning'
                : 'info'}
            message={aiWeldStatus.message}
          />
        )}
      </div>

      {weldReviewRows.length > 0 && (
        <div style={{ marginBottom: 16, padding: 12, border: '1px solid #ffd591', borderRadius: 8, background: '#fffbe6' }}>
          <div style={{ marginBottom: 8 }}>
            <strong>待人工确认焊点：{weldReviewRows.length} 个</strong>
            <span style={{ marginLeft: 8, color: '#8c6d1f', fontSize: 12 }}>
              接受后才参与智能编号；拒绝只移除候选，不会删除现有规则焊点。
            </span>
          </div>
          <Table
            size="small"
            rowKey="key"
            dataSource={weldReviewRows}
            pagination={{ pageSize: 8, size: 'small', showSizeChanger: false }}
            columns={[
              { title: '页码', dataIndex: 'page', width: 62 },
              { title: '来源', dataIndex: 'sourceLabel', width: 86 },
              { title: '原因', dataIndex: 'reasonLabel', width: 135 },
              {
                title: '置信度',
                width: 80,
                render: (_, record) => Number.isFinite(Number(record.aiConfidence ?? record.confidence))
                  ? `${Math.round(Number(record.aiConfidence ?? record.confidence) * 100)}%`
                  : '—'
              },
              {
                title: '焊点位置',
                render: (_, record) => record.center
                  ? `${Number(record.center.x).toFixed(1)}, ${Number(record.center.y).toFixed(1)}`
                  : '—'
              },
              {
                title: '操作',
                width: 142,
                render: (_, record) => (
                  <Space size={4}>
                    <Button size="small" type="primary" onClick={() => handleAcceptWeldReview(record)}>接受</Button>
                    <Button size="small" danger onClick={() => handleRejectWeldReview(record)}>拒绝</Button>
                  </Space>
                )
              }
            ]}
          />
        </div>
      )}

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={14}>
          <div style={{ padding: '12px 16px', background: '#fafafa', borderRadius: 8, border: '1px solid #f0f0f0' }}>
            <div style={{ marginBottom: 12 }}>
              <span style={{ fontSize: 12, color: '#666', marginRight: 8 }}>页面范围:</span>
              <InputNumber
                min={1}
                max={totalPages}
                value={startPage}
                onChange={setStartPage}
                disabled={currentStep > 0}
                style={{ width: 64 }}
              />
              <span style={{ margin: '0 6px', color: '#999' }}>—</span>
              <InputNumber
                min={1}
                max={totalPages}
                value={endPage}
                onChange={setEndPage}
                disabled={currentStep > 0}
                style={{ width: 64 }}
              />
              <span style={{ marginLeft: 8, fontSize: 12, color: '#aaa' }}>共 {totalPages} 页</span>
            </div>

            <div style={{ marginBottom: 16 }}>
              <span style={{ fontSize: 12, color: '#666', marginRight: 8 }}>起始编号:</span>
              <InputNumber
                min={1}
                value={startNumber}
                onChange={setStartNumber}
                disabled={processing}
                style={{ width: 80 }}
              />
            </div>

            <div style={{ marginBottom: 16, padding: 12, borderRadius: 8, background: '#fff', border: '1px solid #d9d9d9' }}>
              <div style={{ marginBottom: 10, fontSize: 13, fontWeight: 600 }}>批量标注配置</div>
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <div>
                  <div style={{ marginBottom: 4, fontSize: 12, color: '#666' }}>标注规则</div>
                  <Select
                    value={selectedRuleId || undefined}
                    onChange={handleBatchRuleChange}
                    options={availableAnnotationRules.map(rule => ({
                      value: rule.id,
                      label: `${rule.name || '未命名规则'}（${rule.prefix || ''}序号${rule.suffix || ''}）`
                    }))}
                    placeholder={availableAnnotationRules.length ? '选择已有规则' : '暂无标注规则'}
                    disabled={processing || availableAnnotationRules.length === 0}
                    style={{ width: '100%' }}
                  />
                </div>

                <div>
                  <div style={{ marginBottom: 4, fontSize: 12, color: '#666' }}>标注类型</div>
                  <Select
                    value={batchBorderShape}
                    onChange={setBatchBorderShape}
                    options={BATCH_BORDER_OPTIONS}
                    disabled={processing}
                    style={{ width: '100%' }}
                  />
                </div>

                <div style={{
                  padding: 10,
                  border: '1px solid #e8e8e8',
                  borderRadius: 6,
                  background: batchBorderShape === 'split-circle' ? '#fafcff' : '#fafafa',
                  opacity: batchBorderShape === 'split-circle' ? 1 : 0.62
                }}>
                  <div style={{ marginBottom: 8, fontSize: 12, fontWeight: 600, color: '#444' }}>
                    分栏圆形上半内容：寸径 + 接头类型
                  </div>

                  <div style={{ marginBottom: 9 }}>
                    <div style={{ marginBottom: 4, fontSize: 12, color: '#666' }}>寸径</div>
                    <Space.Compact style={{ width: '100%' }}>
                      <Select
                        value={diameterSource}
                        onChange={setDiameterSource}
                        options={MATERIAL_FIELD_SOURCE_OPTIONS}
                        disabled={processing || batchBorderShape !== 'split-circle'}
                        style={{ width: 132 }}
                      />
                      <Input
                        value={manualDiameter}
                        onChange={event => setManualDiameter(event.target.value)}
                        placeholder={diameterSource === 'material' ? '提取失败时使用，例如 18' : '例如 18'}
                        disabled={processing || batchBorderShape !== 'split-circle'}
                        maxLength={12}
                      />
                    </Space.Compact>
                  </div>

                  <div>
                    <div style={{ marginBottom: 4, fontSize: 12, color: '#666' }}>接头类型</div>
                    <Space.Compact style={{ width: '100%' }}>
                      <Select
                        value={jointTypeSource}
                        onChange={setJointTypeSource}
                        options={MATERIAL_FIELD_SOURCE_OPTIONS}
                        disabled={processing || batchBorderShape !== 'split-circle'}
                        style={{ width: 132 }}
                      />
                      <Input
                        value={manualJointType}
                        onChange={event => setManualJointType(event.target.value.toUpperCase())}
                        placeholder={jointTypeSource === 'material' ? '提取失败时使用，例如 BW' : '例如 BW、RR、OL'}
                        disabled={processing || batchBorderShape !== 'split-circle'}
                        maxLength={12}
                      />
                    </Space.Compact>
                  </div>

                  <div style={{ marginTop: 7, fontSize: 11, color: '#888', lineHeight: 1.5 }}>
                    材料表模式按当前页、当前管线提取；SIZE(MM) 按 DN/寸径对照表转换，
                    接头类型从材料描述中识别 BW、RR、OL 等，并按管线号自动同步。提取失败时使用右侧手工值。
                  </div>
                  {jointTypeReviewPages.length > 0 && (
                    <Alert
                      type={unresolvedJointTypePages.length > 0 ? 'error' : 'success'}
                      showIcon
                      style={{ marginTop: 10 }}
                      message={unresolvedJointTypePages.length > 0
                        ? `${unresolvedJointTypePages.length} 页仍未识别出接头形式`
                        : '未识别页面的接头形式已人工补全'}
                      description={(
                        <div>
                          <div style={{ marginBottom: 8 }}>
                            以下页面自动重试后仍无结果，请分别填写；填写值只作用于对应页面。
                          </div>
                          <Space direction="vertical" size={6} style={{ width: '100%' }}>
                            {jointTypeReviewPages.map(item => (
                              <div
                                key={item.page}
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: '72px 72px 1fr',
                                  alignItems: 'center',
                                  gap: 8
                                }}
                              >
                                <strong>第 {item.page} 页</strong>
                                <Tag color={item.resolved ? 'success' : 'error'} style={{ margin: 0, textAlign: 'center' }}>
                                  {item.resolved ? '已填写' : '未识别'}
                                </Tag>
                                <Input
                                  value={item.value || ''}
                                  onChange={event => setJointTypeConfirmationsByPage(prev => ({
                                    ...prev,
                                    [item.page]: event.target.value.toUpperCase().trim()
                                  }))}
                                  placeholder="例如 BW、RR、OL"
                                  maxLength={12}
                                  disabled={processing || batchBorderShape !== 'split-circle'}
                                />
                              </div>
                            ))}
                          </Space>
                        </div>
                      )}
                    />
                  )}
                  {ambiguousDiameterPages.length > 0 && (
                    <Alert
                      type={unresolvedDiameterPages.length > 0 ? 'warning' : 'success'}
                      showIcon
                      style={{ marginTop: 10 }}
                      message={
                        unresolvedDiameterPages.length > 0
                          ? `${unresolvedDiameterPages.length} 页检测到多种 PIPE/FITTINGS 规格`
                          : '多规格 PIPE/FITTINGS 寸径已确认'
                      }
                      description={(
                        <div>
                          <div style={{ marginBottom: 6 }}>
                            多规格页不会再自动采用出现次数最多的寸径。
                          </div>
                          <Button size="small" onClick={() => setDiameterConfirmationVisible(true)}>
                            确认各页寸径
                          </Button>
                        </div>
                      )}
                    />
                  )}
                </div>

                {pipeClassReviewPages.length > 0 && (
                  <Alert
                    type={unresolvedPipeClassPages.length > 0 ? 'error' : 'success'}
                    showIcon
                    message={unresolvedPipeClassPages.length > 0
                      ? `${unresolvedPipeClassPages.length} 页仍未识别出管道等级（不影响智能编号）`
                      : '未识别页面的管道等级已人工补全'}
                    description={(
                      <Space direction="vertical" size={6} style={{ width: '100%' }}>
                        {pipeClassReviewPages.map(item => (
                          <div
                            key={item.page}
                            style={{ display: 'grid', gridTemplateColumns: '72px 72px 1fr', alignItems: 'center', gap: 8 }}
                          >
                            <strong>第 {item.page} 页</strong>
                            <Tag color={item.value ? 'success' : 'error'} style={{ margin: 0, textAlign: 'center' }}>
                              {item.value ? '已填写' : '未识别'}
                            </Tag>
                            <Input
                              value={pipeClassConfirmationsByPage[item.page] || ''}
                              onChange={event => setPipeClassConfirmationsByPage(prev => ({
                                ...prev,
                                [item.page]: event.target.value.trim()
                              }))}
                              placeholder="填写该页管道等级"
                              maxLength={40}
                              disabled={currentStep > 4}
                            />
                          </div>
                        ))}
                      </Space>
                    )}
                  />
                )}

                <div>
                  <div style={{ marginBottom: 4, fontSize: 12, color: '#666' }}>标注意见/备注</div>
                  <Input
                    value={batchRemark}
                    onChange={event => setBatchRemark(event.target.value)}
                    placeholder="可留空，不影响焊口号"
                    disabled={processing}
                    maxLength={120}
                  />
                </div>

                <div style={{ padding: 10, borderRadius: 6, background: '#f6ffed', border: '1px solid #b7eb8f' }}>
                  <Space align="start">
                    <Switch
                      size="small"
                      checked={straightPipeAutoWeldEnabled}
                      onChange={setStraightPipeAutoWeldEnabled}
                      disabled={processing || currentStep > 4}
                    />
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#389e0d' }}>
                        单方向直管按材料长度自动补焊口
                      </div>
                      <div style={{ marginTop: 3, fontSize: 11, color: '#777', lineHeight: 1.5 }}>
                        默认关闭。读取每页直管 QTY，并按碳钢/不锈钢及寸径对应的参考管长计算；
                        仅在确认只有一根、一个方向的直管时均匀补点，不明确的页面会跳过并提示人工处理。
                      </div>
                    </div>
                  </Space>
                  {straightPipeAutoWeldEnabled && straightPipeQuantityReviewPages.length > 0 && (
                    <Alert
                      style={{ marginTop: 10 }}
                      type={unresolvedStraightPipeQuantityPages.length > 0 ? 'warning' : 'success'}
                      showIcon
                      message={unresolvedStraightPipeQuantityPages.length > 0
                        ? `${unresolvedStraightPipeQuantityPages.length} 页未识别直管 QTY（可选填）`
                        : '缺失的直管 QTY 已全部填写'}
                      description={(
                        <Space direction="vertical" size={6} style={{ width: '100%' }}>
                          {straightPipeQuantityReviewPages.map(item => (
                            <div
                              key={item.page}
                              style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
                            >
                              <span style={{ minWidth: 54 }}>第 {item.page} 页</span>
                              <InputNumber
                                min={0.001}
                                precision={3}
                                style={{ width: 180 }}
                                value={straightPipeQuantityConfirmationsByPage[item.page] || null}
                                onChange={value => setStraightPipeQuantityConfirmationsByPage(prev => ({
                                  ...prev,
                                  [item.page]: value === null ? '' : String(value)
                                }))}
                                addonAfter="M"
                                placeholder="选填直管总长度"
                                disabled={processing || currentStep > 4}
                              />
                              <span style={{ fontSize: 11, color: '#8c8c8c' }}>
                                {item.rawValues.length > 0
                                  ? `识别原值：${item.rawValues.join(' + ')}`
                                  : '未找到可用长度；不填写则仅跳过该页直管补点，不影响智能编号'}
                              </span>
                            </div>
                          ))}
                        </Space>
                      )}
                    />
                  )}
                </div>
              </Space>
            </div>

            <div style={{ marginBottom: 16, padding: '12px', borderRadius: 8, background: '#fff', border: '1px dashed #d9d9d9' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#262626' }}>Excel 基准对账</div>
                <Space size={8} wrap>
                  <Button
                    icon={<UploadOutlined />}
                    onClick={openExcelFilePicker}
                    disabled={processing}
                  >
                    导入 Excel
                  </Button>
                  {referenceSummary && (
                    <Button
                      icon={<DeleteOutlined />}
                      onClick={() => {
                        setReferenceSummary(null);
                        setExcelImportWarnings([]);
                        setPipelineComparisonResult(null);
                        multiPageBatchService.clearPipelineReferenceData();
                        if (onPipelineComparisonReady) {
                          onPipelineComparisonReady(null);
                        }
                        message.info('已清除 Excel 基准数据');
                      }}
                      disabled={processing}
                    >
                      清除基准
                    </Button>
                  )}
                </Space>
              </div>

              {referenceSummary ? (
                <Alert
                  type="success"
                  showIcon
                  message={`已导入 ${referenceSummary.sourceFileName || 'Excel 基准文件'}`}
                  description={`工作表：${referenceSummary.sheetName || '未命名'}；管线 ${referenceSummary.itemCount} 条；有效行 ${referenceSummary.importedRows} 条`}
                />
              ) : (
                <Alert
                  type="warning"
                  showIcon
                  message="未导入 Excel 基准"
                  description="支持自动识别“管线号 + 焊缝数量”列；编号完成后会自动与当前批量处理识别出的焊点数量做严格对账。"
                />
              )}

              {excelImportWarnings.length > 0 && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginTop: 10 }}
                  message={`导入时发现 ${excelImportWarnings.length} 条异常行`}
                  description={formatWarningDescription(excelImportWarnings)}
                />
              )}
            </div>

            <Steps current={currentStep} size="small" status={processing ? 'process' : 'wait'}>
              <Step title="矢量" icon={currentStep === 1 && processing ? <LoadingOutlined /> : <FileSearchOutlined />} />
              <Step title="文字" icon={currentStep === 2 && processing ? <LoadingOutlined /> : <FontSizeOutlined />} />
              <Step title="焊点" icon={currentStep === 3 && processing ? <LoadingOutlined /> : <FireOutlined />} />
              <Step title="管道" icon={currentStep === 4 && processing ? <LoadingOutlined /> : <ApartmentOutlined />} description="跳过" />
              <Step title="编号" icon={currentStep === 5 && processing ? <LoadingOutlined /> : <NumberOutlined />} />
            </Steps>

            {processing && (
              <div style={{ marginTop: 12 }}>
                <div style={{ marginBottom: 4, color: '#666', fontSize: 12 }}>{progress.step}</div>
                <Progress
                  percent={Math.round((progress.current / progress.total) * 100) || 0}
                  status="active"
                  strokeColor={{ '0%': '#108ee9', '100%': '#87d068' }}
                  size="small"
                />
                <div style={{ marginTop: 2, fontSize: 11, color: '#999' }}>
                  {progress.current} / {progress.total}
                </div>
              </div>
            )}
          </div>
        </Col>

        <Col span={10}>
          <div style={{ marginBottom: 12, padding: '8px 10px', background: '#fff', border: '1px solid #f0f0f0', borderRadius: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#595959' }}>标注实时预览</div>
            <BatchAnnotationPreview
              borderShape={batchBorderShape}
              upperText={materialPreviewUpperText}
              weldText={previewWeldText}
              color={String(selectedAnnotationRule?.color || '#ff0000').toLowerCase() === '#ff4d4f'
                ? '#ff0000'
                : selectedAnnotationRule?.color}
            />
            <div style={{ fontSize: 11, color: '#999', lineHeight: 1.5 }}>
              焊口号仍按多页编号结果生成；这里只配置样式和其他位置内容。
            </div>
          </div>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Button
              icon={materialRecognizing ? <LoadingOutlined /> : <TableOutlined />}
              onClick={handleRecognizeMaterials}
              loading={materialRecognizing}
              disabled={materialRecognizing || processing || !pdfDocument}
              block
            >
              材料表自动识别
            </Button>
            <Button
              icon={specialRecognitionRunning ? <LoadingOutlined /> : <FontSizeOutlined />}
              onClick={handleSpecialWeldRecognition}
              loading={specialRecognitionRunning}
              disabled={processing || !pdfDocument || (!pdfPath && !pdfFile) || !weldRecognitionAreaTemplate}
              block
            >
              特殊块识别
            </Button>
            <Button
              type={currentStep === 0 ? 'primary' : 'default'}
              icon={currentStep > 0 ? <CheckCircleOutlined /> : <FileSearchOutlined />}
              onClick={handleExtractVectors}
              loading={processing && currentStep === 1}
              disabled={processing || currentStep > 1 || !pdfDocument}
              block
            >
              {currentStep === 0
                ? (aiDirectWeldMode ? '1. 跳过矢量提取' : '1. 提取矢量')
                : (aiDirectWeldMode ? '已跳过矢量提取' : '矢量已提取')}
            </Button>
            <Button
              type={currentStep === 1 ? 'primary' : 'default'}
              icon={currentStep > 1 ? <CheckCircleOutlined /> : <FontSizeOutlined />}
              onClick={handleDetectTexts}
              loading={processing && currentStep === 2}
              disabled={processing || currentStep !== 1 || (!vectorsResult && !aiDirectWeldMode)}
              block
            >
              {currentStep < 2 ? '2. 识别文字' : '文字已识别'}
            </Button>
            <Button
              type={currentStep === 2 ? 'primary' : 'default'}
              icon={currentStep > 2 ? <CheckCircleOutlined /> : <FireOutlined />}
              onClick={handleDetectWelds}
              loading={processing && currentStep === 3}
              disabled={processing || currentStep !== 2 || (!vectorsResult && !aiDirectWeldMode)}
              block
            >
              {currentStep < 3 ? '3. 识别焊点' : '焊点已识别'}
            </Button>
            <Button
              type={currentStep === 3 ? 'primary' : 'default'}
              icon={currentStep > 3 ? <CheckCircleOutlined /> : <ApartmentOutlined />}
              onClick={handleDetectPipelines}
              loading={processing && currentStep === 4}
              disabled={processing || currentStep !== 3 || !weldsResult}
              block
            >
              {currentStep < 4 ? '4. 跳过管道识别' : '管道识别跳过'}
            </Button>
            <Button
              type={currentStep === 4 ? 'primary' : 'default'}
              icon={currentStep > 4 ? <CheckCircleOutlined /> : <NumberOutlined />}
              onClick={handleGenerateNumbers}
              loading={processing && currentStep === 5}
              disabled={processing || currentStep !== 4 || !pipelinesResult}
              block
            >
              {currentStep < 5 ? '5. 智能编号' : '编号已生成'}
            </Button>
            {currentStep > 0 && (
              <Space.Compact block>
                <Button
                  onClick={resetNumberingState}
                  disabled={processing || currentStep < 4}
                  style={{ width: '50%' }}
                >
                  重置编号 / 预览
                </Button>
                <Button
                  danger
                  onClick={confirmFullReset}
                  disabled={processing}
                  style={{ width: '50%' }}
                >
                  全部重置
                </Button>
              </Space.Compact>
            )}
          </Space>
        </Col>
      </Row>

      {straightPipeAutoWeldSummary.length > 0 && (
        <Alert
          style={{ marginBottom: 12 }}
          type={straightPipeAutoWeldSummary.some(item => item.status === 'skipped') ? 'warning' : 'success'}
          showIcon
          message={`直管长度补点：已添加 ${straightPipeAutoWeldSummary.reduce((sum, item) => sum + (item.addedWelds?.length || 0), 0)} 个焊口`}
          description={(
            <div>
              {straightPipeAutoWeldSummary.map(item => (
                <div key={item.pageNum}>
                  第 {item.pageNum} 页：{item.status === 'applied'
                    ? `添加 ${item.addedWelds.length} 个（QTY ${item.material.totalLengthM}m / 参考 ${item.material.referenceLengthM}m）`
                    : item.status === 'unchanged'
                      ? item.reason
                      : `未自动处理：${item.reason}`}
                </div>
              ))}
            </div>
          )}
        />
      )}

      {showNumberPreview && numbersResult && (
        <Alert
          message={segmentCorrectionActive ? '正在使用多段起止修正顺序' : '请确认自动编号顺序'}
          description={(
            <div>
              <div style={{ marginBottom: 10 }}>
                {segmentCorrectionActive
                  ? '补点或顺序修正结果请从右上角“生成可编辑标注”生成。'
                  : `已生成 ${numbersResult.length} 个焊点编号。正常时直接采用自动顺序；仅在局部顺序错误时进入多段起止修正。`}
              </div>
              <Space wrap>
                {!segmentCorrectionActive && (
                  <Button type="primary" size="small" onClick={handleConfirmAnnotations}>
                    使用自动顺序生成
                  </Button>
                )}
                <Button size="small" onClick={handleStartSegmentCorrection}>
                  用多段起止修正
                </Button>
                {segmentCorrectionActive && (
                  <Button size="small" onClick={handleRestoreAutoOrder}>
                    清除修正，恢复自动顺序
                  </Button>
                )}
              </Space>
            </div>
          )}
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      {referenceSummary && !pipelineComparisonResult && pipelineStatsResult.length === 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Excel 基准已就绪"
          description="继续执行多页编号后，将自动生成严格对账结果，并在异常页显示红框与异常卡片。"
        />
      )}

      {hasStatsTable && (
        <>
          <Divider style={{ margin: '8px 0 16px' }}>
            {comparisonEnabled ? '管线焊点数量对账结果' : '管线号核对汇总'}
          </Divider>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, display: 'flex', gap: 8 }}>
              {comparisonEnabled && comparisonSummary ? (
                <>
                  <div style={{ flex: 1, padding: '10px 14px', background: '#f6ffed', borderRadius: 8, border: '1px solid #b7eb8f', textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: '#52c41a', marginBottom: 4 }}>正常</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#52c41a', lineHeight: 1 }}>{comparisonSummary.matchedCount}</div>
                  </div>
                  <div style={{ flex: 1, padding: '10px 14px', background: '#fff1f0', borderRadius: 8, border: '1px solid #ffa39e', textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: '#ff4d4f', marginBottom: 4 }}>数量不一致</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#ff4d4f', lineHeight: 1 }}>{comparisonSummary.countMismatchCount}</div>
                  </div>
                  <div style={{ flex: 1, padding: '10px 14px', background: '#fffbe6', borderRadius: 8, border: '1px solid #ffe58f', textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: '#d48806', marginBottom: 4 }}>Excel缺失</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#d48806', lineHeight: 1 }}>{comparisonSummary.missingInExcelCount}</div>
                  </div>
                  <div style={{ flex: 1, padding: '10px 14px', background: '#fff0f6', borderRadius: 8, border: '1px solid #ffadd2', textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: '#c41d7f', marginBottom: 4 }}>未识别页</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#c41d7f', lineHeight: 1 }}>{comparisonSummary.unresolvedCount}</div>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ flex: 1, padding: '10px 14px', background: '#e6f7ff', borderRadius: 8, border: '1px solid #91d5ff', textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: '#1890ff', marginBottom: 4 }}>总组数</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#1890ff', lineHeight: 1 }}>{pipelineStatsSummary.totalGroups}</div>
                  </div>
                  <div style={{ flex: 1, padding: '10px 14px', background: '#f6ffed', borderRadius: 8, border: '1px solid #b7eb8f', textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: '#52c41a', marginBottom: 4 }}>已匹配</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#52c41a', lineHeight: 1 }}>{pipelineStatsSummary.matchedGroups}</div>
                  </div>
                  <div style={{ flex: 1, padding: '10px 14px', background: '#fff1f0', borderRadius: 8, border: '1px solid #ffa39e', textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: '#ff4d4f', marginBottom: 4 }}>未识别</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#ff4d4f', lineHeight: 1 }}>{pipelineStatsSummary.unresolvedGroups}</div>
                  </div>
                  <div style={{ flex: 1, padding: '10px 14px', background: '#fff7e6', borderRadius: 8, border: '1px solid #ffd591', textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: '#fa8c16', marginBottom: 4 }}>总焊点</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#fa8c16', lineHeight: 1 }}>{pipelineStatsSummary.totalWelds}</div>
                  </div>
                </>
              )}
            </div>
            <Button
              type="primary"
              ghost
              icon={<DownloadOutlined />}
              onClick={handleExportPipelineStats}
              disabled={processing}
              style={{ height: 56, minWidth: 120 }}
            >
              {comparisonEnabled ? '导出对账 CSV' : '导出 CSV'}
            </Button>
          </div>

          <Table
            size="small"
            rowKey={record => record.key}
            columns={tableColumns}
            dataSource={tableData}
            pagination={{ pageSize: 20, size: 'small', showTotal: total => `共 ${total} 条` }}
            rowClassName={getStatsRowClassName}
            scroll={{ x: 'max-content' }}
          />
        </>
      )}

      <Modal
        title="确认多规格 PIPE/FITTINGS 寸径"
        open={diameterConfirmationVisible}
        onOk={() => {
          if (invalidDiameterRangePages.length > 0) {
            message.warning('焊口号范围格式不正确，请使用 1-20,67-70 这样的格式');
            return;
          }
          if (unresolvedDiameterPages.length > 0) {
            message.warning('请确认每个多规格页；无法统一判断时选择“逐焊点人工填写”');
            return;
          }
          setDiameterConfirmationVisible(false);
        }}
        onCancel={() => setDiameterConfirmationVisible(false)}
        okText="确认"
        cancelText="稍后处理"
        width={620}
        destroyOnClose={false}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="同一页检测到两种或以上 PIPE/FITTINGS 规格"
          description="优先使用材料表中的 PIPE 主规格；同时保留 FITTINGS 中扫描到的全部寸径。可为其他寸径指定一个或多个焊口号范围，未命中范围的焊口继续使用默认寸径。"
        />
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {ambiguousDiameterPages.map(item => (
            <div
              key={item.page}
              style={{
                display: 'grid',
                gridTemplateColumns: '90px 1fr',
                alignItems: 'center',
                gap: 12
              }}
            >
              <strong>第 {item.page} 页</strong>
              <Select
                value={diameterConfirmationsByPage[item.page] || item.defaultDiameter}
                onChange={value => setDiameterConfirmationsByPage(prev => ({
                  ...prev,
                  [item.page]: value
                }))}
                placeholder={`候选：${item.candidates.map(value => `${value}"`).join(' / ')}`}
                options={[
                  ...item.candidates.map(value => ({
                    value,
                    label: `${value}"（本页统一使用）`
                  })),
                  {
                    value: '__MANUAL_PER_WELD__',
                    label: '不统一填写，逐焊点人工确认'
                  }
                ]}
                style={{ width: '100%' }}
              />
              <div style={{ gridColumn: '1 / -1', marginTop: 8, padding: 8, background: '#fafafa', borderRadius: 4 }}>
                <div style={{ marginBottom: 6, fontSize: 12, color: '#666' }}>
                  按焊口号范围指定寸径（未命中范围时使用上方默认寸径）
                </div>
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  {item.candidateCounts.map(candidate => {
                    const rangeText = diameterRangesByPage[item.page]?.[candidate.value] || '';
                    const rangeValues = splitWeldNumberRangeTokens(rangeText);
                    const parsedRange = parseWeldNumberRanges(rangeText);
                    return (
                      <Space.Compact key={candidate.value} style={{ width: '100%' }}>
                        <Button disabled style={{ width: 118 }}>
                          {candidate.value}&quot;（{candidate.count}行）
                        </Button>
                        <Select
                          mode="tags"
                          value={rangeValues}
                          options={diameterRangeOptions}
                          onChange={values => {
                            const normalizedValues = values.map(value => String(value).trim()).filter(Boolean);
                            setDiameterRangesByPage(prev => ({
                              ...prev,
                              [item.page]: {
                                ...(prev[item.page] || {}),
                                [candidate.value]: normalizedValues.join(',')
                              }
                            }));
                            setSavedDiameterRangeOptions(previous => Array.from(new Set([
                              ...previous,
                              ...normalizedValues
                            ])));
                          }}
                          placeholder="选择或新增范围；可多选"
                          status={parsedRange.valid ? undefined : 'error'}
                          disabled={processing}
                          allowClear
                          style={{ flex: 1 }}
                        />
                      </Space.Compact>
                    );
                  })}
                </Space>
              </div>
            </div>
          ))}
        </Space>
      </Modal>

      <Modal
        title="手动选择 Excel 列映射"
        open={manualMappingVisible}
        onOk={handleManualMappingConfirm}
        onCancel={() => setManualMappingVisible(false)}
        okText="确认导入"
        cancelText="取消"
        destroyOnClose={false}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="未能自动识别列"
          description={`文件 ${pendingWorkbookFileName || ''} 中没有找到标准表头，请手动选择工作表、管线列和焊缝数量列。`}
        />

        <div style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 6, color: '#666' }}>工作表</div>
          <Select
            value={manualSheetName || undefined}
            onChange={value => setManualSheetName(value)}
            options={pendingWorkbookSheets.map(sheet => ({ label: sheet.name, value: sheet.name }))}
            style={{ width: '100%' }}
            placeholder="请选择工作表"
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 6, color: '#666' }}>管线列</div>
          <Select
            value={manualPipelineColumnIndex}
            onChange={value => setManualPipelineColumnIndex(value)}
            options={currentManualHeaders}
            style={{ width: '100%' }}
            placeholder="请选择管线列"
          />
        </div>

        <div>
          <div style={{ marginBottom: 6, color: '#666' }}>焊缝数量列</div>
          <Select
            value={manualCountColumnIndex}
            onChange={value => setManualCountColumnIndex(value)}
            options={currentManualHeaders}
            style={{ width: '100%' }}
            placeholder="请选择焊缝数量列"
          />
        </div>
      </Modal>
    </div>
  );
};

export default MultiPageProcessPanel;
