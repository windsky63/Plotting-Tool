import React, { useState, useEffect, useCallback, useRef } from 'react';
import styled from 'styled-components';
import {
  Card,
  Form,
  Input,
  InputNumber,
  Button,
  Select,
  Space,
  Divider,
  List,
  Typography,
  Popconfirm,
  message,
  Tag,
  Collapse,
  Table,
  Tooltip,
  Modal,
  Switch,
  Dropdown // 新增 Dropdown
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  SettingOutlined,
  NumberOutlined,
  FileTextOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  ClearOutlined,
  DownOutlined // 新增图标
} from '@ant-design/icons';
import { getMaterialQuotaState, getMaterialUsageCounts } from '../utils/materialQuotaUtils';
import { collectBatchMaterialCandidates } from '../utils/batchMaterialCandidateUtils';
import { isFixedA3TenMmShape, scaleAnnotationValue } from '../utils/pageAnnotationScale';
import {
  buildWeldNumberRangeTokens,
  parseWeldNumberRanges,
  weldNumberInRanges,
  getAnnotationWeldNumber,
  splitWeldNumberRangeTokens
} from '../utils/weldNumberRangeUtils';
import { getStoredWeldDisplayAffixes, getWeldDisplayAffixes } from '../utils/weldDisplayNumberUtils';
import { selectPanelTextAnnotations } from '../utils/annotationPanelSelectors';

const { Title, Text } = Typography;
const { Option } = Select;
const { TextArea } = Input;
const { Panel } = Collapse;

const MAX_BOUND_MATERIALS_PER_WELD = 2;

// Only numbered weld annotations participate in the weld-number sequence.
// Pipe tags, plain text and rectangular frames may also contain digits, but
// must never acquire weld-number metadata merely because they are edited here.
const isWeldNumberAnnotation = annotation => (
  ['circle', 'split-circle', 'field-weld', 'shop-weld'].includes(annotation?.borderShape) &&
  annotation?.isScaffoldAnnotation !== true &&
  annotation?.isWeldedSupport !== true
);

const getAnnotationWeldNumberParts = annotation => {
  const structuredNumber = annotation?.weldNumber ?? annotation?.weldData?.weldNumber ?? annotation?.number;
  const storedAffixes = getStoredWeldDisplayAffixes(annotation);
  if (storedAffixes && Number.isFinite(Number(structuredNumber))) {
    return {
      prefix: storedAffixes.prefix,
      number: Number(structuredNumber),
      suffix: storedAffixes.suffix
    };
  }
  const affixes = getWeldDisplayAffixes(annotation?.text, structuredNumber);
  const number = Number.isFinite(Number(structuredNumber))
    ? Number(structuredNumber)
    : (affixes ? Number(String(annotation?.text || '').match(/\d+/)?.[0]) : null);
  const resolvedAffixes = getWeldDisplayAffixes(annotation?.text, number);
  return {
    prefix: resolvedAffixes?.prefix ?? annotation?.prefix ?? '',
    number: Number.isFinite(number) ? number : '',
    suffix: resolvedAffixes?.suffix ?? annotation?.suffix ?? ''
  };
};

const normalizeMaterialText = (value) => String(value ?? '').trim();

const normalizeRuleEditorValue = (value) => {
  if (Array.isArray(value)) return value.join(' | ');
  if (value && typeof value === 'object') return Object.keys(value).join(' | ');
  return String(value ?? '');
};

const estimateRuleEditorWidth = (value, minimumWidth) => {
  const text = normalizeRuleEditorValue(value);
  const textWidth = Array.from(text).reduce(
    (width, character) => width + (/[\u0000-\u00ff]/.test(character) ? 10 : 18),
    0
  );
  return Math.max(minimumWidth, textWidth + 54);
};

const getMaterialAutoRecognitionType = (material) => {
  const text = [
    material?.description,
    material?.type,
    material?.jointType,
    material?.rawMaterial?.DESCRIPTION,
    material?.rawMaterial?.['材料描述']
  ].map(value => String(value || '').normalize('NFKC').toUpperCase()).join(' ');

  if (/三通|\bTEE\b/.test(text)) return { text: '三通', color: '#722ed1', bg: '#f9f0ff' };
  if (/弯头|弯管|\bELBOW\b/.test(text)) return { text: '弯头', color: '#08979c', bg: '#e6fffb' };
  return { text: '手动', color: '#8c8c8c', bg: '#f5f5f5' };
};

const getDisplayMaterialAutoRecognitionType = (material) => {
  const text = [
    material?.description,
    material?.type,
    material?.category,
    material?.jointType,
    material?.rawMaterial?.DESCRIPTION,
    material?.rawMaterial?.['材料描述']
  ].map(value => String(value || '').normalize('NFKC').toUpperCase()).join(' ');

  if (/三通|\bTEE\b/.test(text)) return { text: '三通', color: '#722ed1', bg: '#f9f0ff' };
  if (/弯头|弯管|\bELBOW\b/.test(text)) return { text: '弯头', color: '#08979c', bg: '#e6fffb' };
  if (
    !/法兰|\bFLANGE\b|垫片|\bGASKET\b|阀|\bVALVE\b|螺栓|\bBOLT\b|支架|\bSUPPORT\b/.test(text) &&
    /管子|管材|钢管|无缝钢管|焊管|\bPIPE\b|\bSMLS\b|\bERW\b/.test(text)
  ) {
    return { text: '管子', color: '#237804', bg: '#f6ffed' };
  }
  return { text: '手动', color: '#8c8c8c', bg: '#f5f5f5' };
};

const renderMaterialOptionLabel = (label, material) => {
  const type = getDisplayMaterialAutoRecognitionType(material);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
      <span
        style={{
          flex: '0 0 auto',
          minWidth: 34,
          padding: '1px 5px',
          borderRadius: 4,
          fontSize: 11,
          lineHeight: '16px',
          color: type.color,
          background: type.bg,
          border: `1px solid ${type.color}`
        }}
      >
        {type.text}
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </span>
  );
};

const normalizeDnSourceText = (value) => normalizeMaterialText(value)
  .replace(/[×＊*脳]/g, 'x')
  .replace(/Φ|桅/gi, 'DN')
  .replace(/\s+/g, ' ')
  .toUpperCase();

const getMaterialPrimaryDnSources = (material) => {
  const structuredSources = [
    material?.diameter,
    material?.ND,
    material?.DN,
    material?.['管径'],
    material?.rawMaterial?.diameter,
    material?.rawMaterial?.ND,
    material?.rawMaterial?.DN,
    material?.rawMaterial?.['管径']
  ].map(normalizeDnSourceText).filter(Boolean);

  if (structuredSources.length > 0) {
    return structuredSources;
  }

  const displaySources = [
    material?.label,
    material?.displayText,
    material?.text
  ].map(normalizeMaterialText).filter(Boolean);

  const leftSegments = displaySources
    .map(text => normalizeDnSourceText(text.split('|')[0]))
    .filter(Boolean);

  if (leftSegments.length > 0) {
    return leftSegments;
  }

  const specification = normalizeDnSourceText(material?.specification || material?.rawMaterial?.specification || '');
  if (/^(?:DN|NPS)?\s*\d+(?:\.\d+)?(?:\s*x\s*\d+(?:\.\d+)?)?$/.test(specification)) {
    return [specification];
  }

  return [];
};

const getMaterialDnTokens = (material) => {
  const candidates = getMaterialPrimaryDnSources(material); /*
    material?.diameter,
    material?.ND,
    material?.DN,
    material?.specification,
    material?.['规格'],
    material?.description,
    material?.['材料描述'],
    material?.rawMaterial?.ND,
    material?.rawMaterial?.DN,
    material?.rawMaterial?.['规格'],
    material?.rawMaterial?.DESCRIPTION
  ].map(normalizeMaterialText).filter(Boolean); */

  const tokens = new Set();
  candidates.forEach((text) => {
    const normalized = text
      .replace(/[×＊*]/g, 'x')
      .replace(/Φ/gi, 'DN')
      .toUpperCase();
    const matches = normalized.match(/(?:DN|NPS)?\s*(\d+(?:\.\d+)?)/g) || [];
    matches.forEach((match) => {
      const numberMatch = match.match(/\d+(?:\.\d+)?/);
      if (numberMatch) {
        const numberText = numberMatch[0].replace(/\.0+$/, '');
        tokens.add(numberText);
      }
    });
  });
  return Array.from(tokens);
};

const hasCompatibleDn = (material, requiredTokens) => {
  if (!requiredTokens || requiredTokens.length === 0) return true;
  const tokens = getMaterialDnTokens(material);
  if (tokens.length === 0) return true;
  return tokens.some(token => requiredTokens.includes(token));
};

const PanelContainer = styled.div`
  position: fixed;
  right: 0;
  top: var(--toolbar-height, 64px);
  bottom: 0;
  width: ${props => props.$width}px;
  background: white;
  border-left: 1px solid #e8e8e8;
  box-shadow: -2px 0 8px rgba(0, 0, 0, 0.1);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  transform: ${props => props.$visible ? 'translateX(0)' : 'translateX(100%)'};
  transition: transform 0.3s ease-in-out;
`;

const ResizeHandle = styled.div`
  position: fixed;
  right: ${props => props.$visible ? `${props.$width - 12}px` : '0px'};
  top: var(--toolbar-height, 64px);
  width: 12px;
  height: calc(100% - var(--toolbar-height, 64px));
  background: ${props => props.$visible ? '#f5f5f5' : '#d9d9d9'};
  border-right: 2px solid ${props => props.$visible ? '#d9d9d9' : '#bfbfbf'};
  cursor: col-resize;
  z-index: 1001;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: ${props => props.$isResizing ? 'none' : 'all 0.3s ease-in-out'};
  border-radius: ${props => props.$visible ? '0' : '4px 0 0 4px'};
  
  &::before {
    content: '◀';
    font-size: 12px;
    color: ${props => props.$visible ? '#999' : '#666'};
    transform: ${props => props.$visible ? 'rotate(0deg)' : 'rotate(180deg)'};
    transition: transform 0.3s ease;
  }
  
  &:hover {
    background: #e6f7ff;
    border-right-color: #1890ff;
    
    &::before {
      color: #1890ff;
    }
  }
  
  &:active {
    background: #bae7ff;
    border-right-color: #0050b3;
    
    &::before {
      color: #0050b3;
    }
  }
`;

const PanelHeader = styled.div`
  padding: 8px 12px;
  background: white;
  border-bottom: 1px solid #e8e8e8;
  text-align: center;
  flex-shrink: 0;
`;

// 上半部分：规则定义区域 - 为规则编辑保留更大的工作区
const RuleDefinitionSection = styled.div`
  flex: 0 0 64%;
  background: white;
  border-bottom: 1px solid #e8e8e8;
  padding: 14px 16px;
  overflow-y: auto;
  font-size: 16px !important;
`;

// 下半部分：标注信息区域 - 增加高度占比
const AnnotationInfoSection = styled.div`
  flex: 1;
  background: #f8f8f8;
  padding: 12px;
  overflow: hidden; /* 禁止外层滚动 */
  display: flex;
  flex-direction: column;
`;

// 标注信息标题栏 - 固定不滚动
const AnnotationInfoHeader = styled.div`
  flex-shrink: 0;
  margin-bottom: 16px;
  background: #f8f8f8;
  z-index: 5;
`;

// 标注信息表格容器 - 可滚动
const AnnotationTableContainer = styled.div`
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  min-height: 0; /* 关键：允许flex子元素收缩 */
  padding-bottom: 12px;
`;

const RulePreview = styled.div`
  background: #f0f0f0;
  padding: 6px 8px;
  border-radius: 4px;
  margin: 6px 0;
  font-family: monospace;
  font-size: 12px;
  border: 1px solid #d9d9d9;
  text-align: center;
  font-weight: bold;
`;

const WeldingButton = styled(Button)`
  width: 100%;
  height: 32px;
  margin-top: 8px;
  background: linear-gradient(45deg, #ff7f50, #ff6b47);
  border: none;
  color: white;
  font-weight: bold;
  
  &:hover {
    background: linear-gradient(45deg, #ff6b47, #ff5722) !important;
    color: white !important;
  }
  
  &:active {
    background: linear-gradient(45deg, #ff5722, #e64a19) !important;
  }
`;

const StyledTable = styled(Table)`
  .ant-table {
    font-size: 16px !important;
  }
  
  .ant-table-thead > tr > th {
    background: #fafafa;
    font-weight: bold;
    font-size: 14px !important;
    padding: 12px 8px !important;
    text-align: center;
    line-height: 1.5;
    position: sticky !important;
    top: 0 !important;
    z-index: 10 !important;
  }
  
  .ant-table-tbody > tr > td {
    padding: 12px 8px !important;
    text-align: center;
    cursor: pointer;
    line-height: 1.5;
    font-size: 15px !important;
  }
  
  .ant-table-tbody > tr:hover > td {
    background: #e6f7ff;
  }

  .ant-table-small {
    border: 1px solid #f0f0f0;
  }

  .ant-table-small .ant-table-thead > tr > th {
    padding: 12px 8px !important;
    font-size: 14px !important;
    position: sticky !important;
    top: 0 !important;
    z-index: 10 !important;
  }

  .ant-table-small .ant-table-tbody > tr > td {
    padding: 12px 8px !important;
    font-size: 15px !important;
  }
  
  /* 输入框字体大小调整 - 增强优先级 */
  .ant-input {
    font-size: 15px !important;
    height: 36px !important;
    padding: 8px 12px !important;
    line-height: 1.5 !important;
  }
  
  .ant-input-number {
    font-size: 15px !important;
    height: 36px !important;
    
    .ant-input-number-input {
      font-size: 15px !important;
      height: 34px !important;
      line-height: 1.5 !important;
    }
    
    .ant-input-number-handler-wrap {
      height: 34px !important;
    }
  }
  
  .ant-select {
    font-size: 15px !important;
    min-height: 36px !important;
    
    .ant-select-selector {
      font-size: 15px !important;
      min-height: 36px !important;
      padding: 6px 12px !important;
      line-height: 1.5 !important;
    }
    
    .ant-select-selection-item {
      font-size: 15px !important;
      line-height: 24px !important;
    }
    
    .ant-select-selection-placeholder {
      font-size: 15px !important;
      line-height: 24px !important;
    }
  }
  
  /* 按钮字体大小 */
  .ant-btn {
    font-size: 14px !important;
    height: 32px !important;
    padding: 6px 12px !important;
    line-height: 1.4 !important;
  }
  
  /* 文本内容 */
  span {
    font-size: 15px !important;
  }

  /* 选中行的高亮样式 - 简约设计 */
  .ant-table-tbody > tr.annotation-row-selected > td {
    background-color: rgba(24, 144, 255, 0.08) !important;
    border-left: 4px solid #1890ff !important;
    box-shadow: 0 0 0 1px rgba(24, 144, 255, 0.2) !important;
  }
`;

const RuleEditorTable = styled(StyledTable)`
  .ant-table {
    font-size: 18px !important;
  }

  .ant-table-thead > tr > th,
  .ant-table-small .ant-table-thead > tr > th {
    padding: 16px 12px !important;
    font-size: 17px !important;
    line-height: 1.6 !important;
  }

  .ant-table-tbody > tr > td,
  .ant-table-small .ant-table-tbody > tr > td {
    padding: 16px 12px !important;
    font-size: 17px !important;
    line-height: 1.65 !important;
  }

  .ant-input {
    height: 44px !important;
    padding: 9px 12px !important;
    font-size: 17px !important;
  }

  .ant-input-number {
    height: 44px !important;
    font-size: 17px !important;

    .ant-input-number-input {
      height: 42px !important;
      font-size: 17px !important;
    }
  }

  .ant-select {
    min-height: 44px !important;

    .ant-select-selector {
      min-height: 44px !important;
      padding: 7px 12px !important;
      font-size: 17px !important;
    }

    .ant-select-selection-item,
    .ant-select-selection-placeholder {
      font-size: 17px !important;
      line-height: 28px !important;
    }
  }

  .ant-btn {
    min-width: 38px;
    height: 38px !important;
    padding: 7px 12px !important;
    font-size: 16px !important;
  }

  span {
    font-size: 17px !important;
  }
`;

const AnnotationRulesPanel = ({
  visible,
  rules,
  activeRule,
  onRulesChange,
  onActiveRuleChange,
  continuousNumberingEnabled = false,
  continuousNumber = 1,
  onContinuousNumberingChange,
  onContinuousNumberChange,
  onWeldingAnnotate,
  annotationMode,
  annotations,
  currentPageAnnotations = [],
  currentPageAnnotationRevision = 0,
  onAnnotationClick,
  onAnnotationUpdate,
  onBatchAnnotationUpdates,
  onAnnotationDelete,
  onClearAllAnnotations, // 添加批量删除回调
  selectedAnnotation,
  selectedAnnotationIds = [],
  onAnnotationSelectionChange,
  onToggle,
  onAnnotationEditCallback // 暴露 handleEditAnnotation 给父组件
, ...panelProps }) => {
  // 🔍 性能监控：记录组件渲染开始时间
  const renderStartTime = performance.now();
  
  // ⚡ 性能优化：面板不可见时直接返回 null，避免渲染2300行的复杂组件
  // ❌ 修正：不能提前返回，否则违反 Hook 规则，且会导致 Modal 无法显示、编辑 Handler 无法注册
  // UI 部分已经通过 {visible && ...} 进行条件渲染，Hooks 必须始终执行
  /* 
  if (!visible) {
    return null;
  }
  */

  const [form] = Form.useForm();
  const [editingRule, setEditingRule] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const [panelWidth, setPanelWidth] = useState(() => {
    const availableWidth = typeof window === 'undefined' ? 960 : window.innerWidth - 60;
    return Math.max(600, Math.min(960, availableWidth));
  });
  const [isResizing, setIsResizing] = useState(false);
  const [batchRegularFontSize, setBatchRegularFontSize] = useState(34);
  const [batchTopFontSize, setBatchTopFontSize] = useState(16);
  const [batchBottomFontSize, setBatchBottomFontSize] = useState(34);
  const [batchAllPagesFontApplying, setBatchAllPagesFontApplying] = useState(false);
  const [batchDiameterText, setBatchDiameterText] = useState('');
  const [batchJointTypeText, setBatchJointTypeText] = useState('');
  const [batchDiameterRangeText, setBatchDiameterRangeText] = useState('');
  const [savedBatchDiameterRanges, setSavedBatchDiameterRanges] = useState([]);
  const [weldRangeAutoPending, setWeldRangeAutoPending] = useState(false);
  
  // 添加缺失的状态变量
  const [editingRuleData, setEditingRuleData] = useState({});
  const [newRuleData, setNewRuleData] = useState({
    name: '',
    prefix: '',
    suffix: '',
    jointTypeText: '',
    startNumber: 1,           // 起始序号默认为1，可以设置为空
    increment: 1,             // 递增默认为1
    remark: '',
    attributes: []
  });
  
  // 添加编辑标注的状态
  const [editingAnnotation, setEditingAnnotation] = useState(null);
  const [editAnnotationForm] = Form.useForm();
  const watchedMaterialBindingKeys = Form.useWatch('materialBindingKey', editAnnotationForm) || [];
  const watchedBorderShape = Form.useWatch('borderShape', editAnnotationForm);
  
  // 添加表格引用，用于滚动定位
  const annotationTableRef = useRef(null);
  
  // 添加拖拽相关状态
  const [modalPosition, setModalPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const modalRef = useRef(null);
  const lastProcessedAnnotation = useRef(null);
  const selectedAnnotationEditTimerRef = useRef(null);
  const suppressSelectedEditUntilRef = useRef(0);

  const selectedAnnotationIdSet = React.useMemo(
    () => new Set((selectedAnnotationIds || []).filter(Boolean)),
    [selectedAnnotationIds]
  );
  const getRuleEditorColumnWidth = useCallback((field, minimumWidth, placeholder = '') => {
    // 仅在新建/编辑过程中临时撑宽；保存或取消后恢复原固定列宽。
    const values = [placeholder];
    if (isCreating) values.push(newRuleData?.[field]);
    if (editingRule) {
      const originalRule = rules.find(rule => rule.id === editingRule);
      values.push(editingRuleData?.[field] ?? originalRule?.[field]);
    }
    return values.reduce(
      (width, value) => Math.max(width, estimateRuleEditorWidth(value, minimumWidth)),
      minimumWidth
    );
  }, [rules, isCreating, newRuleData, editingRule, editingRuleData]);
  const getMaterialBindings = useCallback((annotation) => {
    if (Array.isArray(annotation?.materialBindings)) {
      return annotation.materialBindings.filter(Boolean);
    }
    return annotation?.materialBinding ? [annotation.materialBinding] : [];
  }, []);

  const materialOptions = React.useMemo(() => {
    const rows = Array.isArray(panelProps.materialRows)
      ? panelProps.materialRows
      : [];
    const usageCounts = getMaterialUsageCounts(annotations, editingAnnotation?.id);
    const existingBindings = getMaterialBindings(editingAnnotation);
    const existingKeys = new Set(existingBindings.map(material => material?.key).filter(Boolean));
    const selectedKeys = new Set(
      (Array.isArray(watchedMaterialBindingKeys) ? watchedMaterialBindingKeys : [watchedMaterialBindingKeys])
        .filter(Boolean)
    );
    const selectedMaterials = rows
      .filter(row => selectedKeys.has(row.key))
      .concat(existingBindings.filter(row => row?.key && selectedKeys.has(row.key)));
    const requiredDnTokens = Array.from(new Set(
      selectedMaterials.flatMap(getMaterialDnTokens)
    ));

    const options = rows.map((row, index) => {
      const quotaState = getMaterialQuotaState(row, usageCounts);
      if (quotaState.exhausted && !existingKeys.has(row.key)) return null;
      if (!selectedKeys.has(row.key) && !hasCompatibleDn(row, requiredDnTokens)) return null;
      const labelParts = [
        row.materialId || index + 1,
        row.diameter || row.specification,
        row.description
      ].filter(Boolean);
      if (Number.isFinite(quotaState.quota)) {
        labelParts.push(`剩余 ${quotaState.remaining}/${quotaState.quota}`);
      }

      return {
        value: row.key || `${row.sourcePage || ''}-${index}`,
        label: labelParts.join(' | '),
        displayLabel: renderMaterialOptionLabel(labelParts.join(' | '), row),
        row,
        disabled: selectedKeys.size >= MAX_BOUND_MATERIALS_PER_WELD && !selectedKeys.has(row.key)
      };
    }).filter(Boolean);

    existingBindings.forEach((boundMaterial) => {
      if (boundMaterial?.key && !options.some(option => option.value === boundMaterial.key)) {
        const labelParts = [
          boundMaterial.materialId,
          boundMaterial.diameter || boundMaterial.specification,
          boundMaterial.description
        ].filter(Boolean);
        options.unshift({
          value: boundMaterial.key,
          label: `${labelParts.join(' | ')}（已绑定）`,
          row: boundMaterial
        });
      }
    });

    return options;
  }, [panelProps.materialRows, annotations, editingAnnotation, getMaterialBindings, watchedMaterialBindingKeys]);

  useEffect(() => {
    const selectedKeys = (Array.isArray(watchedMaterialBindingKeys) ? watchedMaterialBindingKeys : [watchedMaterialBindingKeys])
      .filter(Boolean);
    if (selectedKeys.length <= 1) return;

    const rows = Array.isArray(panelProps.materialRows) ? panelProps.materialRows : [];
    const existingBindings = getMaterialBindings(editingAnnotation);
    const findMaterial = (key) => rows.find(row => row.key === key) || existingBindings.find(row => row?.key === key);

    const firstMaterial = findMaterial(selectedKeys[0]);
    const requiredDnTokens = getMaterialDnTokens(firstMaterial);
    if (requiredDnTokens.length === 0) return;

    const nextKeys = selectedKeys.filter((key, index) => {
      if (index === 0) return true;
      const material = findMaterial(key);
      return hasCompatibleDn(material, requiredDnTokens);
    });

    if (nextKeys.length !== selectedKeys.length) {
      editAnnotationForm.setFieldsValue({ materialBindingKey: nextKeys });
      message.warning('已移除与已选材料 DN 不匹配的材料');
    }
  }, [watchedMaterialBindingKeys, panelProps.materialRows, editingAnnotation, getMaterialBindings, editAnnotationForm]);
  
  // 处理编辑标注 - 使用 useCallback 避免重复渲染
  const handleEditAnnotation = useCallback((annotation) => {
    console.log('🎯 handleEditAnnotation被调用:', annotation);
    if (annotation?.id) {
      lastProcessedAnnotation.current = annotation.id;
    }
    if (selectedAnnotationEditTimerRef.current) {
      clearTimeout(selectedAnnotationEditTimerRef.current);
      selectedAnnotationEditTimerRef.current = null;
    }
    
    // ✅ 关键修复：直接使用传入的annotation对象，因为它来自渲染层，包含最新的位置
    console.log('✅ 设置editingAnnotation状态');
    setEditingAnnotation(annotation);
  }, []);

  // 监听 editingAnnotation 变化，自动填充表单
  useEffect(() => {
    if (editingAnnotation) {
      console.log('📝 监测到 editingAnnotation 变化，开始填充表单:', editingAnnotation);
      const baseFontSize = editingAnnotation.fontSize || 14;
      const defaultSplitFontSize = Math.max(baseFontSize * 0.72, 10);

      const existingMaterialBindings = getMaterialBindings(editingAnnotation);
      const rule = rules.find(r => r.id === editingAnnotation.ruleId);
      let rawJointTypeText = editingAnnotation.jointTypeText || '';
      let rawTopText = editingAnnotation.topText || '';
      if (editingAnnotation.borderShape === 'split-circle') {
        const topDisplayText = String(editingAnnotation.topText || '');
        if (topDisplayText.startsWith('"')) {
          const withoutQuote = topDisplayText.slice(1);
          if (rawJointTypeText && withoutQuote.startsWith(rawJointTypeText)) {
            rawTopText = withoutQuote.slice(rawJointTypeText.length);
          } else if (!rawJointTypeText) {
            const match = withoutQuote.match(/^([A-Za-z]+)(.*)$/);
            if (match) {
              rawJointTypeText = match[1];
              rawTopText = match[2] || '';
            } else {
              rawTopText = withoutQuote;
            }
          }
        }
      }
      
      // 直接设置完整的焊口号，不再拆分
      const formValues = {
        text: editingAnnotation.text || '',
        topText: rawTopText,
        jointTypeText: rawJointTypeText,
        materialNumber: editingAnnotation.materialNumber || '',
        materialBindingKey: existingMaterialBindings.map(item => item?.key).filter(Boolean),
        attributes: rule?.attributes || [],
        remark: editingAnnotation.remark || '',
        color: editingAnnotation.color || '#000000',
        fontSize: baseFontSize,
        topFontSize: editingAnnotation.topFontSize || 16,
        bottomFontSize: editingAnnotation.bottomFontSize || defaultSplitFontSize,
        borderShape: editingAnnotation.borderShape || 'none',
        rotation: editingAnnotation.rotation ?? 0
      };
      
      console.log('📝 设置表单值:', formValues);
      editAnnotationForm.setFieldsValue(formValues);
    }
  }, [editingAnnotation, rules, editAnnotationForm, panelProps.currentPage, getMaterialBindings]);
  
  // 暴露 handleEditAnnotation 给父组件（用于PDF双击直接编辑）
  useEffect(() => {
    if (onAnnotationEditCallback) {
      onAnnotationEditCallback(handleEditAnnotation);
    }
  }, [handleEditAnnotation, onAnnotationEditCallback]);
  
  // 记录指定标注行的选中状态；编辑只由双击或编辑按钮触发
  const scrollToAnnotation = useCallback((annotationId) => {
    if (!annotationId) return;
    
    console.log('🎯 处理标注选中:', annotationId);
    lastProcessedAnnotation.current = annotationId;
  }, []);
  
  // 监听selectedAnnotation变化，自动滚动到对应行
  useEffect(() => {
    if (selectedAnnotationEditTimerRef.current) {
      clearTimeout(selectedAnnotationEditTimerRef.current);
      selectedAnnotationEditTimerRef.current = null;
    }

    if (selectedAnnotation && selectedAnnotation !== lastProcessedAnnotation.current) {
      if (Date.now() < suppressSelectedEditUntilRef.current) {
        return undefined;
      }

      // 单击只负责选中，不自动打开编辑窗口
      console.log('🔔 selectedAnnotation变化，准备更新选中状态:', selectedAnnotation);
      lastProcessedAnnotation.current = selectedAnnotation;
      
      selectedAnnotationEditTimerRef.current = setTimeout(() => {
        selectedAnnotationEditTimerRef.current = null;
        if (Date.now() < suppressSelectedEditUntilRef.current) {
          return;
        }
        scrollToAnnotation(selectedAnnotation);
      }, 150); // 稍微增加延迟时间
    }
    
    // 当 selectedAnnotation 变为 null 时，重置追踪
    if (!selectedAnnotation) {
      lastProcessedAnnotation.current = null;
    }

    return () => {
      if (selectedAnnotationEditTimerRef.current) {
        clearTimeout(selectedAnnotationEditTimerRef.current);
        selectedAnnotationEditTimerRef.current = null;
      }
    };
  }, [selectedAnnotation, scrollToAnnotation]);


  // 保存标注编辑
  const handleSaveAnnotationEdit = () => {
    console.log('🔵 ========== 开始保存标注编辑 ==========');
    console.log('🔵 当前editingAnnotation:', editingAnnotation);
    console.log('🔵 editingAnnotation的位置:', {
      id: editingAnnotation?.id,
      startX: editingAnnotation?.startX,
      startY: editingAnnotation?.startY,
      endX: editingAnnotation?.endX,
      endY: editingAnnotation?.endY
    });
    
    // ✅ 关键修复：直接使用editingAnnotation的位置，不要从annotations数组重新获取
    // 因为editingAnnotation在handleEditAnnotation时已经捕获了最新的位置（来自渲染层）
    console.log('✅ 直接使用editingAnnotation的位置（已包含最新位置）');
    suppressSelectedEditUntilRef.current = Date.now() + 600;
    if (editingAnnotation?.id) {
      lastProcessedAnnotation.current = editingAnnotation.id;
    }
    if (selectedAnnotationEditTimerRef.current) {
      clearTimeout(selectedAnnotationEditTimerRef.current);
      selectedAnnotationEditTimerRef.current = null;
    }
    
    editAnnotationForm.validateFields().then(values => {
      const selectedMaterialKeys = Array.isArray(values.materialBindingKey)
        ? values.materialBindingKey
        : (values.materialBindingKey ? [values.materialBindingKey] : []);
      const existingMaterialBindings = getMaterialBindings(editingAnnotation);
      const selectedMaterials = selectedMaterialKeys.map((key) => {
        const optionMaterial = materialOptions.find(option => option.value === key)?.row;
        const existingMaterial = existingMaterialBindings.find(item => item?.key === key);
        return optionMaterial || existingMaterial || null;
      }).filter(Boolean).map(material => ({ ...material }));
      const nextMaterialBinding = selectedMaterials[0] || null;
      const materialNumbers = selectedMaterials.map(material => material.materialId).filter(Boolean);
      const isSplitCircle = (values.borderShape || editingAnnotation?.borderShape) === 'split-circle';
      const jointTypeText = String(values.jointTypeText || '').trim();
      const nextTopText = isSplitCircle ? String(values.topText || '').trim() : '';
      const nextAnnotationText = values.text || '';
      console.log('🔵 表单验证通过，获取到的values:', values);
      
      // 准备更新的数据 - 直接使用完整的焊口号
      // ⚠️ 关键修复：明确保留当前位置信息，避免被重置
      const nextBorderShape = values.borderShape || 'none';
      const updates = {
        text: nextAnnotationText,
        topText: nextTopText,
        jointTypeText: isSplitCircle ? jointTypeText : '',
        ruleTopText: '',
        materialNumber: materialNumbers.length > 0 ? materialNumbers.join(', ') : (values.materialNumber || ''),
        materialBinding: nextMaterialBinding,
        materialBindings: selectedMaterials,
        materialBindingPage: nextMaterialBinding?.sourcePage || editingAnnotation?.materialBindingPage || '',
        color: values.color || '#000000',
        fontSize: values.fontSize || 14,
        topFontSize: isSplitCircle ? (values.topFontSize || 16) : (values.topFontSize || values.fontSize || 14),
        bottomFontSize: values.bottomFontSize || values.fontSize || 14,
        frameSize: editingAnnotation?.frameSize ?? 56.7,
        frameSizeMode: editingAnnotation?.frameSizeMode,
        borderShape: nextBorderShape,
        rotation: (values.borderShape || editingAnnotation?.borderShape) === 'pipe-tag'
          ? (Number(values.rotation) || 0)
          : undefined,
        remark: values.remark || '',
        // 如果有属性字段，也更新属性
        ...(values.attributes ? { attributes: values.attributes } : {}),
        // 🔧 明确保留位置信息（直接使用editingAnnotation的位置）
        startX: editingAnnotation?.startX,
        startY: editingAnnotation?.startY,
        endX: editingAnnotation?.endX,
        endY: editingAnnotation?.endY,
        hasLeaderLine: editingAnnotation?.hasLeaderLine
      };
      
      console.log('🔵 准备发送的updates（包含完整位置信息）:', updates);
      console.log('🔵 更新的标注ID:', editingAnnotation.id);
      console.log('🔵 ========================================');
      
      if (onAnnotationUpdate) {
        onAnnotationUpdate(editingAnnotation.id, updates);
      }
      
      setEditingAnnotation(null);
      editAnnotationForm.resetFields();
      message.success('标注已更新');
    }).catch(error => {
      console.error('❌ 表单验证失败:', error);
    });
  };

  // 取消编辑标注
  const handleCancelAnnotationEdit = () => {
    console.log('🚫 取消编辑标注');
    setEditingAnnotation(null);
    editAnnotationForm.resetFields();
    // 重置模态框位置
    setModalPosition({ x: 0, y: 0 });
  };

  // Modal拖拽相关事件处理
  const handleModalMouseDown = (e) => {
    // 只在标题栏区域允许拖拽
    if (e.target.closest('.ant-modal-header')) {
      setIsDragging(true);
      setDragStart({
        x: e.clientX - modalPosition.x,
        y: e.clientY - modalPosition.y
      });
    }
  };

  const handleModalMouseMove = useCallback((e) => {
    if (isDragging) {
      const newX = e.clientX - dragStart.x;
      const newY = e.clientY - dragStart.y;
      
      // 更宽松的拖拽范围限制，允许编辑框部分移出屏幕
      const modalWidth = 500;
      const modalHeight = 400; // 预估Modal高度
      const minVisibleWidth = 100; // 至少保持100px可见宽度
      const minVisibleHeight = 50; // 至少保持50px可见高度
      
      // 计算允许的拖拽范围
      const minX = -(modalWidth - minVisibleWidth); // 允许大部分移出左边
      const maxX = window.innerWidth - minVisibleWidth; // 允许大部分移出右边
      const minY = -30; // 允许标题栏稍微移出顶部
      const maxY = window.innerHeight - minVisibleHeight; // 保持底部可见
      
      setModalPosition({
        x: Math.max(minX, Math.min(newX, maxX)),
        y: Math.max(minY, Math.min(newY, maxY))
      });
    }
  }, [isDragging, dragStart]);

  const handleModalMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // 添加Modal拖拽的全局鼠标事件监听
  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleModalMouseMove);
      document.addEventListener('mouseup', handleModalMouseUp);
      
      return () => {
        document.removeEventListener('mousemove', handleModalMouseMove);
        document.removeEventListener('mouseup', handleModalMouseUp);
      };
    }
  }, [isDragging, handleModalMouseMove, handleModalMouseUp]);

  // 删除标注
  const handleDeleteAnnotation = useCallback((annotationId) => {
    if (onAnnotationDelete) {
      onAnnotationDelete(annotationId);
      message.success('标注已删除');
    }
  }, [onAnnotationDelete]);

  // 处理ResizeHandle的鼠标按下事件
  const [mouseDownPos, setMouseDownPos] = useState(null);
  const [dragStarted, setDragStarted] = useState(false);
  const resizeHandleRef = useRef(null); // 添加ResizeHandle的引用
  
  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    setMouseDownPos({ x: e.clientX, y: e.clientY });
    setDragStarted(false);
  }, []);
  
  // 添加节流引用
  const throttleRef = useRef(null);
  
  const handleMouseMove = useCallback((e) => {
    if (!mouseDownPos) return;
    
    // 计算鼠标移动距离
    const deltaX = Math.abs(e.clientX - mouseDownPos.x);
    const deltaY = Math.abs(e.clientY - mouseDownPos.y);
    const dragThreshold = 2; // 减少拖拽阈值，提高响应性
    
    // 如果移动距离超过阈值，开始拖拽
    if (!dragStarted && (deltaX > dragThreshold || deltaY > dragThreshold)) {
      setDragStarted(true);
      setIsResizing(true);
    }
    
    // 只有在拖拽状态下才调整宽度
    if (dragStarted && isResizing) {
      // 清除之前的节流
      if (throttleRef.current) {
        cancelAnimationFrame(throttleRef.current);
      }
      
      // 使用requestAnimationFrame节流优化性能
      throttleRef.current = requestAnimationFrame(() => {
        const newWidth = window.innerWidth - e.clientX;
        const minWidth = 560;
        const maxWidth = Math.min(1280, window.innerWidth - 60);
        
        setPanelWidth(Math.max(minWidth, Math.min(maxWidth, newWidth)));
        throttleRef.current = null;
      });
    }
  }, [mouseDownPos, dragStarted, isResizing]);
  
  const handleMouseUp = useCallback((e) => {
    // 只有在ResizeHandle区域内的点击才切换面板状态
    // 检查鼠标松开的位置是否在ResizeHandle内
    if (mouseDownPos && !dragStarted) {
      // 检查鼠标是否在ResizeHandle区域内
      if (resizeHandleRef.current) {
        const rect = resizeHandleRef.current.getBoundingClientRect();
        const isInHandle = e.clientX >= rect.left && e.clientX <= rect.right &&
                           e.clientY >= rect.top && e.clientY <= rect.bottom;
        
        // 只有在ResizeHandle内点击才触发toggle
        if (isInHandle && onToggle) {
          onToggle();
        }
      }
    }
    
    // 重置状态
    setIsResizing(false);
    setMouseDownPos(null);
    setDragStarted(false);
  }, [mouseDownPos, dragStarted, onToggle]);
  
  useEffect(() => {
    if (mouseDownPos) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      
      // 只有在拖拽状态下才改变光标和禁用选择
      if (isResizing) {
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }
    } else {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // 清理节流
      if (throttleRef.current) {
        cancelAnimationFrame(throttleRef.current);
        throttleRef.current = null;
      }
    };
  }, [mouseDownPos, isResizing, handleMouseMove, handleMouseUp]);

  // 默认规则模板
  const defaultRuleTemplates = [
    {
      id: 'weld-joint',
      name: '焊接接头',
      prefix: 'WJ',
      suffix: '',
      startNumber: 1,
      increment: 1,
      remark: '焊接接头标注',
      attributes: ['材质', '规格', '焊接方法']
    },
    {
      id: 'pipe-weld',
      name: '管道焊口',
      prefix: 'PW',
      suffix: '',
      startNumber: 1,
      increment: 1,
      remark: '管道焊口标注',
      attributes: ['管径', '壁厚', '材质']
    },
    {
      id: 'flange-weld',
      name: '法兰焊口',
      prefix: 'FW',
      suffix: '',
      startNumber: 1,
      increment: 1,
      remark: '法兰焊口标注',
      attributes: ['法兰规格', '密封面', '螺栓规格']
    }
  ];

  // 生成预览文本
  const generatePreview = (rule) => {
    if (!rule) return '';
    // 如果startNumber和currentNumber都是undefined或null，则不显示数字
    const currentNum = rule.currentNumber !== undefined && rule.currentNumber !== null 
      ? rule.currentNumber 
      : rule.startNumber;
    // 检查是否为 null、undefined 或者不是有效数字
    if (currentNum === undefined || currentNum === null || currentNum === '') {
      return `${rule.prefix || ''}${rule.suffix || ''}`;
    }
    return `${rule.prefix || ''}${String(currentNum)}${rule.suffix || ''}`;
  };

  // 创建新规则
  const handleCreateRule = () => {
    setIsCreating(true);
    setEditingRule(null);
    setNewRuleData({
      name: '',
      prefix: '',
      suffix: '',
      startNumber: 1,           // 起始序号默认为1，可以设置为空
      increment: 1,             // 递增默认为1
      remark: '',
      attributes: []
    });
  };

  // 编辑规则
  const handleEditRule = (rule) => {
    setEditingRule(rule.id);
    setIsCreating(false);
    // 确保attributes是数组格式
    const ruleToEdit = {
      ...rule,
      attributes: Array.isArray(rule.attributes) ? rule.attributes : []
    };
    setEditingRuleData(ruleToEdit);
  };

  // 处理表格单元格的值变化
  const handleFieldChange = (field, value) => {
    console.log('handleFieldChange called:', { field, value, isCreating, editingRule });
    
    // 如果是attributes字段，需要转换格式
    let processedValue = value;
    if (field === 'attributes' && Array.isArray(value)) {
      // 将数组转换为对象格式，默认值为空字符串
      processedValue = {};
      value.forEach(attr => {
        processedValue[attr] = '';
      });
    }
    
    if (isCreating) {
      setNewRuleData(prev => {
        const newData = {
          ...prev,
          [field]: processedValue
        };
        console.log('Updated newRuleData:', newData);
        return newData;
      });
    } else if (editingRule) {
      setEditingRuleData(prev => {
        const newData = {
          ...prev,
          [field]: processedValue
        };
        console.log('Updated editingRuleData:', newData);
        return newData;
      });
    }
  };

  // 保存规则
  const handleSaveRule = async () => {
    try {
      let ruleData;
      
      if (isCreating) {
        // 验证新建规则数据 - 只要填写任意一项就可以保存（包括起始序号为0或递增为0）
        const hasAnyField = newRuleData.name || newRuleData.prefix || newRuleData.suffix || newRuleData.jointTypeText ||
                            newRuleData.remark || newRuleData.startNumber !== undefined || 
                            newRuleData.increment !== undefined;
        if (!hasAnyField) {
          message.error('请至少填写一项内容');
          return;
        }
        ruleData = newRuleData;
      } else if (editingRule) {
        // 验证编辑规则数据 - 只要填写任意一项就可以保存（包括起始序号为0或递增为0）
        const hasAnyField = editingRuleData.name || editingRuleData.prefix || editingRuleData.suffix || editingRuleData.jointTypeText ||
                            editingRuleData.remark || editingRuleData.startNumber !== undefined || 
                            editingRuleData.increment !== undefined;
        if (!hasAnyField) {
          message.error('请至少填写一项内容');
          return;
        }
        ruleData = editingRuleData;
      }

      // 获取原始规则以保留currentNumber
      const originalRule = editingRule ? rules.find(r => r.id === editingRule) : null;
      
      // 确保startNumber和increment有默认值
      // null 表示用户清空了输入框，应该保持为 null
      const startNumber = ruleData.startNumber !== undefined && ruleData.startNumber !== null 
        ? ruleData.startNumber 
        : (ruleData.startNumber === null ? null : (originalRule?.startNumber ?? null));
      const increment = ruleData.increment !== undefined && ruleData.increment !== null
        ? ruleData.increment 
        : (ruleData.increment === null ? null : (originalRule?.increment ?? 1));
      
      const newRule = {
        ...ruleData,
        startNumber,
        increment,
        id: editingRule || `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        // 修复：编辑规则时保留现有的currentNumber，除非startNumber发生了变化
        // 如果startNumber变化，说明用户想重置序号，才更新currentNumber
        currentNumber: editingRule 
          ? (originalRule && originalRule.startNumber === startNumber 
              ? originalRule.currentNumber  // 保持原有的currentNumber
              : startNumber)                 // startNumber变化时重置currentNumber
          : startNumber,                     // 新建规则使用startNumber
        createdAt: editingRule ? originalRule?.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      let updatedRules;
      if (editingRule) {
        updatedRules = rules.map(r => r.id === editingRule ? newRule : r);
      } else {
        updatedRules = [...rules, newRule];
      }

      onRulesChange(updatedRules);
      
      // 如果编辑的是当前激活的规则，需要更新激活规则
      if (editingRule && activeRule?.id === editingRule) {
        onActiveRuleChange(newRule);
      }
      
      // 如果是新建规则，自动选择新建的规则
      if (!editingRule) {
        onActiveRuleChange(newRule);
      }
      
      setEditingRule(null);
      setIsCreating(false);
      setNewRuleData({
        name: '',
        prefix: '',
        suffix: '',
        jointTypeText: '',
        startNumber: 1,           // 起始序号默认为1，可以设置为空
        increment: 1,             // 递增默认为1
        remark: '',
        attributes: []
      });
      setEditingRuleData({});
      message.success(editingRule ? '规则更新成功' : '规则创建成功');
    } catch (error) {
      console.error('保存规则失败:', error);
      message.error('保存失败，请检查输入信息');
    }
  };

  // 删除规则
  const handleDeleteRule = (ruleId) => {
    const updatedRules = rules.filter(r => r.id !== ruleId);
    onRulesChange(updatedRules);
    if (activeRule?.id === ruleId) {
      onActiveRuleChange(null);
    }
    message.success('规则删除成功');
  };

  // 使用模板创建规则
  const handleUseTemplate = (template) => {
    const newRule = {
      ...template,
      id: `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      currentNumber: template.startNumber,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    const updatedRules = [...rules, newRule];
    onRulesChange(updatedRules);
    
    // 自动选择新建的模板规则
    onActiveRuleChange(newRule);
    
    message.success(`已添加模板规则：${template.name}`);
  };

  // 按操作范围删除标注信息
  const handleClearAllAnnotations = (options = {}) => {
    if (!annotations || annotations.length === 0) {
      message.warning('没有标注信息可删除');
      return;
    }

    const targetAnnotations = options.scope === 'all'
      ? annotations
      : annotations.filter(annotation => annotation.page === panelProps.currentPage);
    const annotationCount = targetAnnotations.length;
    if (annotationCount === 0) {
      message.warning('当前页没有标注信息');
      return;
    }
    
    // 优先使用专门的批量删除回调（如果提供）
    if (onClearAllAnnotations) {
      onClearAllAnnotations(options); // 传递选项参数
      if (options.keepBox) {
        message.success(`已清除焊口号，保留 ${annotationCount} 个焊口框`);
      } else {
        message.success(`已成功删除 ${annotationCount} 个标注信息`);
      }
      return;
    }
    
    // 备用方案：逐个删除时使用延迟来避免状态竞争
    setTimeout(() => {
      // 仅删除所选范围内的标注
      const allAnnotationIds = targetAnnotations.map(ann => ann.id);
      
      // 逐个调用删除函数，但使用最新的ID列表
      allAnnotationIds.forEach((id, index) => {
        setTimeout(() => {
          if (onAnnotationDelete) {
            onAnnotationDelete(id);
          }
        }, index * 10); // 每个删除操作间10ms延迟
      });
      
      // 在所有删除操作完成后显示成功消息
      setTimeout(() => {
        message.success(`已成功删除 ${annotationCount} 个标注信息`);
      }, allAnnotationIds.length * 10 + 100);
    }, 0);
  };

  // 清除所有历史数据
  const handleClearAllData = () => {
    // 清除localStorage中的规则数据
    localStorage.removeItem('annotationRules');
    localStorage.removeItem('activeAnnotationRule');
    
    // 重置状态
    onRulesChange([]);
    onActiveRuleChange(null);
    
    // 所有历史数据已清除
  };

  const applyRuleNumberSnapshot = useCallback((nextRules, activeRuleId) => {
    onRulesChange(nextRules);
    if (!activeRuleId) return;
    const nextActiveRule = nextRules.find(item => item.id === activeRuleId);
    if (nextActiveRule) onActiveRuleChange(nextActiveRule);
  }, [onRulesChange, onActiveRuleChange]);

  // 重置规则序号，并纳入全局撤销/重做历史。
  const handleResetRuleNumber = useCallback((rule) => {
    if (!rule || !rule.id) {
      console.error('无效的规则对象:', rule);
      message.error('重置失败：无效的规则');
      return;
    }

    console.log('重置前完整规则对象:', rule);
    console.log('重置规则:', rule.name || '未命名规则', '当前序号:', rule.currentNumber, '→ 起始序号:', rule.startNumber);
    
    const resetRule = {
      ...rule,
      currentNumber: rule.startNumber,
      lastUsed: new Date().toISOString(),
      resetHistory: [
        ...(rule.resetHistory || []),
        {
          type: 'number_reset',
          timestamp: new Date().toISOString(),
          operator: 'user',
          from: rule.currentNumber || rule.startNumber,
          to: rule.startNumber
        }
      ]
    };

    console.log('重置后规则对象:', resetRule);

    const previousRules = rules.map(item => ({ ...item }));
    const updatedRules = rules.map(r => 
      r.id === rule.id ? resetRule : r
    );
    const activeRuleId = activeRule?.id;
    const execute = () => applyRuleNumberSnapshot(updatedRules, activeRuleId);
    const undo = () => applyRuleNumberSnapshot(previousRules, activeRuleId);

    if (typeof panelProps.onExecuteUndoableCommand === 'function') {
      panelProps.onExecuteUndoableCommand({
        description: `重置焊点编号：${rule.name || rule.prefix || '未命名规则'}`,
        execute,
        undo
      });
    } else {
      execute();
    }

    const ruleName = rule.name || rule.prefix || '未命名规则';
    message.success(`规则 "${ruleName}" 的序号已重置为 ${rule.startNumber}`);
  }, [activeRule?.id, applyRuleNumberSnapshot, panelProps.onExecuteUndoableCommand, rules]);

  // Alt+R：重置当前激活规则的焊点编号。输入控件中不响应。
  useEffect(() => {
    const handleResetNumberShortcut = (event) => {
      const target = event.target;
      const isEditing = target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      );
      if (isEditing || event.ctrlKey || event.shiftKey || !event.altKey) return;
      if (event.key.toLowerCase() !== 'r' && event.code !== 'KeyR') return;
      event.preventDefault();
      if (!activeRule) {
        message.info('请先选择一个标注规则');
        return;
      }
      handleResetRuleNumber(activeRule);
    };
    document.addEventListener('keydown', handleResetNumberShortcut);
    return () => document.removeEventListener('keydown', handleResetNumberShortcut);
  }, [activeRule, handleResetRuleNumber]);

  // 批量重置所有规则
  const handleBatchResetRules = () => {
    Modal.confirm({
      title: '批量重置确认',
      content: (
        <div>
          <p>⚠️ 此操作将重置所有规则的序号到起始值</p>
          <p>确定要继续吗？重置后可使用 Ctrl+Z 撤销。</p>
        </div>
      ),
      okText: '确定重置',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => {
        const updatedRules = rules.map(rule => ({
          ...rule,
          currentNumber: rule.startNumber,
          lastUsed: new Date().toISOString(),
          resetHistory: [
            ...(rule.resetHistory || []),
            {
              type: 'batch_reset',
              timestamp: new Date().toISOString(),
              operator: 'user'
            }
          ]
        }));
        
        const previousRules = rules.map(rule => ({ ...rule }));
        const activeRuleId = activeRule?.id;
        const execute = () => applyRuleNumberSnapshot(updatedRules, activeRuleId);
        const undo = () => applyRuleNumberSnapshot(previousRules, activeRuleId);

        if (typeof panelProps.onExecuteUndoableCommand === 'function') {
          panelProps.onExecuteUndoableCommand({
            description: '批量重置焊点编号',
            execute,
            undo
          });
        } else {
          execute();
        }
        
        message.success(`已成功重置 ${rules.length} 个规则的序号`);
      }
    });
  };

  // 取消编辑
  const handleCancel = () => {
    setEditingRule(null);
    setIsCreating(false);
    setNewRuleData({
      name: '焊口规则',
      prefix: 'WJ',
      suffix: '',
      startNumber: 1,
      increment: 1,
      remark: '焊接接头',
      attributes: []
    });
    setEditingRuleData({});
  };

  // 筛选文字标注和支架标注
  // ⚡ 性能优化：使用 useMemo 缓存过滤结果
  const textAnnotations = React.useMemo(() => {
    if (!visible) return [];
    return selectPanelTextAnnotations(currentPageAnnotations);
  }, [currentPageAnnotations, currentPageAnnotationRevision, visible]);
  
  // ⚡ 性能优化：使用 useMemo 缓存表格数据映射结果
  const annotationTableData = React.useMemo(() => {
    return textAnnotations.map((annotation, index) => {
      return {
        key: `${annotation.id}_${index}`, // 使用id和index组合确保唯一性
        index: index + 1,
        text: annotation.text || `标注${index + 1}`,
        topText: annotation.topText || '',
        jointTypeText: annotation.jointTypeText || '',
        materialNumber: annotation.materialNumber || '', // 添加材料编号字段
        ruleName: annotation.ruleName || (annotation.isScaffoldAnnotation ? '支架标注' : '-'),
        pipelineNumber: annotation.pipelineNumber || '',
        page: annotation.page || 1,
        timestamp: annotation.timestamp ? new Date(annotation.timestamp).toLocaleTimeString() : '-',
        color: annotation.color || '#000000',
        remark: annotation.remark || annotation.ruleRemark || 
                (annotation.isScaffoldAnnotation ? `原编号: ${annotation.scaffoldNumber}` : ''),
        annotation: annotation
      };
    });
  }, [textAnnotations]);
  const annotationTableScroll = React.useMemo(() => ({ x: 1600 }), []);

  const batchFontTargets = React.useMemo(() => {
    const selectedOnPage = textAnnotations.filter(annotation => selectedAnnotationIdSet.has(annotation.id));
    return selectedOnPage.length > 0 ? selectedOnPage : textAnnotations;
  }, [selectedAnnotationIdSet, textAnnotations]);

  const batchCircleFrameTargets = React.useMemo(() => (
    !visible ? [] : (Array.isArray(annotations) ? annotations : []).filter(annotation => (
      annotation.borderShape === 'circle' ||
      annotation.borderShape === 'split-circle' ||
      annotation.borderShape === 'diamond'
    ))
  ), [annotations, visible]);

  const currentPageSplitCircleWelds = React.useMemo(() => (
    textAnnotations.filter(annotation => (
      annotation.borderShape === 'split-circle' &&
      annotation.isScaffoldAnnotation !== true &&
      annotation.isWeldedSupport !== true
    ))
  ), [textAnnotations]);

  const splitCircleTargets = React.useMemo(() => {
    const selected = currentPageSplitCircleWelds.filter(annotation => selectedAnnotationIdSet.has(annotation.id));
    return selected.length > 0 ? selected : currentPageSplitCircleWelds;
  }, [currentPageSplitCircleWelds, selectedAnnotationIdSet]);

  const weldRangeAnnotationSignature = React.useMemo(() => (
    currentPageSplitCircleWelds
      .map(annotation => [
        annotation.id,
        annotation.text,
        annotation.weldNumber,
        annotation.weldData?.weldNumber
      ].join(':'))
      .sort()
      .join('|')
  ), [currentPageSplitCircleWelds]);

  const detectedWeldNumberRangeTokens = React.useMemo(() => {
    const visibleNumbers = currentPageSplitCircleWelds
      .map(annotation => {
        // Numberless annotations keep their internal numbering metadata, so
        // require a visible number before including them in the range.
        if (!/\d/.test(String(annotation?.text || ''))) return NaN;
        return getAnnotationWeldNumber(annotation);
      })
      .filter(Number.isFinite);
    return buildWeldNumberRangeTokens(visibleNumbers);
  }, [currentPageSplitCircleWelds]);
  const detectedWeldNumberRangeText = detectedWeldNumberRangeTokens.join(',');

  useEffect(() => {
    if (!weldRangeAnnotationSignature) {
      setBatchDiameterRangeText('');
      setWeldRangeAutoPending(false);
      return undefined;
    }
    setWeldRangeAutoPending(true);
    const timer = setTimeout(() => {
      setBatchDiameterRangeText(detectedWeldNumberRangeText);
      const detectedTokens = splitWeldNumberRangeTokens(detectedWeldNumberRangeText);
      setSavedBatchDiameterRanges(previous => Array.from(new Set([
        ...previous,
        ...detectedTokens
      ])));
      setWeldRangeAutoPending(false);
    }, 5000);
    return () => clearTimeout(timer);
  }, [
    detectedWeldNumberRangeText,
    panelProps.currentPage,
    weldRangeAnnotationSignature
  ]);

  const splitCircleMajority = React.useMemo(() => {
    const mostFrequent = field => {
      const counts = new Map();
      textAnnotations
        .filter(annotation => annotation.borderShape === 'split-circle')
        .map(annotation => String(annotation[field] || '').trim())
        .filter(Boolean)
        .forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
      return Array.from(counts.entries())
        .sort((left, right) => right[1] - left[1])[0]?.[0] || '';
    };
    return {
      diameter: mostFrequent('topText'),
      jointType: mostFrequent('jointTypeText')
    };
  }, [textAnnotations]);

  const batchMaterialCandidates = React.useMemo(
    () => collectBatchMaterialCandidates(panelProps.materialRows),
    [panelProps.materialRows]
  );
  const batchDiameterOptions = React.useMemo(
    () => batchMaterialCandidates.diameters.map(item => ({
      value: item.value,
      label: `${item.value}（材料表 ${item.count} 项）`
    })),
    [batchMaterialCandidates.diameters]
  );
  const batchJointTypeOptions = React.useMemo(
    () => batchMaterialCandidates.jointTypes.map(item => ({
      value: item.value,
      label: `${item.value}（材料表 ${item.count} 项）`
    })),
    [batchMaterialCandidates.jointTypes]
  );
  const batchDiameterRangeValues = React.useMemo(
    () => splitWeldNumberRangeTokens(batchDiameterRangeText),
    [batchDiameterRangeText]
  );
  const batchDiameterRangeOptions = React.useMemo(
    () => Array.from(new Set([...savedBatchDiameterRanges, ...batchDiameterRangeValues]))
      .map(value => ({ value, label: value })),
    [savedBatchDiameterRanges, batchDiameterRangeValues]
  );
  useEffect(() => {
    setBatchDiameterText(batchMaterialCandidates.diameters[0]?.value || splitCircleMajority.diameter);
    setBatchDiameterRangeText('');
  }, [
    panelProps.currentPage,
    splitCircleMajority.diameter,
    batchMaterialCandidates.diameters
  ]);
  useEffect(() => {
    setBatchJointTypeText(batchMaterialCandidates.jointTypes[0]?.value || splitCircleMajority.jointType);
  }, [
    panelProps.currentPage,
    splitCircleMajority.jointType,
    batchMaterialCandidates.jointTypes
  ]);

  const applyBatchSplitCircleContent = useCallback(() => {
    if (!splitCircleTargets.length || !onBatchAnnotationUpdates) return;
    const diameter = String(batchDiameterText || '').trim();
    const parsedRanges = parseWeldNumberRanges(batchDiameterRangeText);
    if (!parsedRanges.valid) {
      message.warning(`焊口号范围格式不正确：${parsedRanges.invalidParts.join('、')}`);
      return;
    }
    const hasSelectedTargets = splitCircleTargets.some(annotation => selectedAnnotationIdSet.has(annotation.id));
    if (
      batchMaterialCandidates.diameters.length > 1 &&
      !hasSelectedTargets &&
      parsedRanges.ranges.length === 0
    ) {
      message.warning('当前页存在多种管子寸径，请先填写焊口号范围，或选中需要修改的焊口');
      return;
    }
    const effectiveTargets = parsedRanges.ranges.length > 0
      ? splitCircleTargets.filter(annotation => (
        weldNumberInRanges(getAnnotationWeldNumber(annotation), parsedRanges.ranges)
      ))
      : splitCircleTargets;
    if (effectiveTargets.length === 0) {
      message.warning('指定范围内没有找到当前页焊口');
      return;
    }
    const updatesById = {};
    effectiveTargets.forEach(annotation => {
      updatesById[annotation.id] = {
        topText: diameter
      };
    });
    onBatchAnnotationUpdates(
      updatesById,
      `批量修改当前页寸径 (${effectiveTargets.length}个${batchDiameterRangeText ? `，范围 ${batchDiameterRangeText}` : ''})`
    );
  }, [
    batchDiameterText,
    batchDiameterRangeText,
    batchMaterialCandidates.diameters.length,
    onBatchAnnotationUpdates,
    selectedAnnotationIdSet,
    splitCircleTargets,
    textAnnotations
  ]);

  const applyBatchJointType = useCallback(() => {
    if (!splitCircleTargets.length || !onBatchAnnotationUpdates) return;
    const jointType = String(batchJointTypeText || '').trim();
    if (!jointType) {
      message.warning('请选择或填写接头类型');
      return;
    }
    const updatesById = {};
    splitCircleTargets.forEach(annotation => {
      updatesById[annotation.id] = { jointTypeText: jointType };
    });
    onBatchAnnotationUpdates(
      updatesById,
      `批量填入当前页接头类型 ${jointType}（${splitCircleTargets.length}个）`
    );
  }, [batchJointTypeText, onBatchAnnotationUpdates, splitCircleTargets]);

  const applyBatchFontSizes = useCallback(() => {
    if (!batchFontTargets.length || !onBatchAnnotationUpdates) return;
    const updatesById = {};
    batchFontTargets.forEach(annotation => {
      updatesById[annotation.id] = annotation.borderShape === 'split-circle'
        ? { topFontSize: batchTopFontSize, bottomFontSize: batchBottomFontSize }
        : { fontSize: batchRegularFontSize };
    });
    onBatchAnnotationUpdates(
      updatesById,
      `批量修改当前页标注字体 (${batchFontTargets.length}个)`
    );
  }, [
    batchBottomFontSize,
    batchFontTargets,
    batchRegularFontSize,
    batchTopFontSize,
    onBatchAnnotationUpdates
  ]);

  const applyBatchAllPagesFontSizes = useCallback(async () => {
    if (!batchCircleFrameTargets.length || !onBatchAnnotationUpdates) return;
    const regularSize = Number(batchRegularFontSize);
    const topSize = Number(batchTopFontSize);
    const bottomSize = Number(batchBottomFontSize);
    if (
      !Number.isFinite(regularSize) || regularSize <= 0 ||
      !Number.isFinite(topSize) || topSize <= 0 ||
      !Number.isFinite(bottomSize) || bottomSize <= 0
    ) {
      message.warning('请输入有效的所有页字体大小');
      return;
    }
    const pdfDocument = panelProps.pdfDocument;
    if (!pdfDocument?.getPage) {
      message.error('PDF页面尺寸尚未加载，请重新打开PDF后再试');
      return;
    }

    setBatchAllPagesFontApplying(true);
    try {
      const pageNumbers = Array.from(new Set(
        batchCircleFrameTargets
          .map(annotation => Number(annotation.page || 1))
          .filter(page => Number.isFinite(page) && page > 0)
      ));
      const pageSizes = new Map();
      let nextPageIndex = 0;
      const workerCount = Math.min(6, pageNumbers.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (nextPageIndex < pageNumbers.length) {
          const pageIndex = nextPageIndex;
          nextPageIndex += 1;
          const pageNumber = pageNumbers[pageIndex];
          const pdfPage = await pdfDocument.getPage(pageNumber);
          const viewport = pdfPage.getViewport({ scale: 1 });
          pageSizes.set(pageNumber, { width: viewport.width, height: viewport.height });
        }
      });
      await Promise.all(workers);

      const updatesById = {};
      batchCircleFrameTargets.forEach(annotation => {
        const pageNumber = Number(annotation.page || 1);
        const pageSize = pageSizes.get(pageNumber);
        if (annotation.borderShape === 'split-circle') {
          updatesById[annotation.id] = {
            topFontSize: scaleAnnotationValue(topSize, pageSize, topSize),
            bottomFontSize: scaleAnnotationValue(bottomSize, pageSize, bottomSize)
          };
        } else {
          updatesById[annotation.id] = {
            fontSize: scaleAnnotationValue(regularSize, pageSize, regularSize)
          };
        }
      });
      onBatchAnnotationUpdates(
        updatesById,
        `按A3比例批量修改所有页标注字体 (${batchCircleFrameTargets.length}个)`
      );
    } catch (error) {
      message.error(`读取PDF页面尺寸失败：${error.message}`);
    } finally {
      setBatchAllPagesFontApplying(false);
    }
  }, [
    batchBottomFontSize,
    batchCircleFrameTargets,
    batchRegularFontSize,
    batchTopFontSize,
    onBatchAnnotationUpdates,
    panelProps.pdfDocument
  ]);

  const commitInlineAnnotationField = useCallback((annotation, field, value) => {
    if (!annotation?.id || !onAnnotationUpdate) return;
    const previousValue = annotation[field];
    if (String(previousValue ?? '') === String(value ?? '')) return;
    if (field === 'text' && isWeldNumberAnnotation(annotation)) {
      const parts = getAnnotationWeldNumberParts({ ...annotation, text: value });
      const nextText = String(value ?? '');
      const nextNumber = parts.number === '' ? annotation.weldNumber : parts.number;
      onAnnotationUpdate(annotation.id, {
        text: nextText,
        displayNumber: nextText,
        weldNumber: nextNumber,
        number: nextNumber,
        prefix: parts.prefix,
        suffix: parts.suffix,
        numberingAffixKey: JSON.stringify([parts.prefix, parts.suffix]),
        weldData: {
          ...(annotation.weldData || {}),
          weldNumber: nextNumber,
          displayNumber: nextText,
          prefix: parts.prefix,
          suffix: parts.suffix,
          numberingAffixKey: JSON.stringify([parts.prefix, parts.suffix])
        }
      });
      return;
    }
    if (field === 'pipelineNumber') {
      const pipelineNumberRaw = String(value ?? '').trim();
      onAnnotationUpdate(annotation.id, {
        pipelineNumber: pipelineNumberRaw,
        pipelineNumberRaw,
        pipelineNumberSource: 'user_confirmed',
        ...(annotation.weldData ? {
          weldData: {
            ...annotation.weldData,
            pipelineNumber: pipelineNumberRaw,
            pipelineNumberRaw,
            pipelineNumberSource: 'user_confirmed'
          }
        } : {})
      });
      return;
    }
    onAnnotationUpdate(annotation.id, { [field]: value });
  }, [onAnnotationUpdate]);

  const commitInlineWeldNumberPart = useCallback((annotation, field, value) => {
    if (!annotation?.id || !onAnnotationUpdate || !isWeldNumberAnnotation(annotation)) return;
    const parts = getAnnotationWeldNumberParts(annotation);
    const nextParts = {
      ...parts,
      [field]: field === 'number' ? String(value ?? '').trim() : String(value ?? '')
    };
    if (field === 'number' && !/^\d+$/.test(nextParts.number)) {
      message.warning('焊口号请输入整数');
      return;
    }
    const nextNumber = Number(nextParts.number);
    const nextText = `${nextParts.prefix}${nextNumber}${nextParts.suffix}`;
    const numberingAffixKey = JSON.stringify([nextParts.prefix, nextParts.suffix]);
    onAnnotationUpdate(annotation.id, {
      text: nextText,
      displayNumber: nextText,
      weldNumber: nextNumber,
      number: nextNumber,
      prefix: nextParts.prefix,
      suffix: nextParts.suffix,
      numberingAffixKey,
      weldData: {
        ...(annotation.weldData || {}),
        weldNumber: nextNumber,
        displayNumber: nextText,
        prefix: nextParts.prefix,
        suffix: nextParts.suffix,
        numberingAffixKey
      }
    });
  }, [onAnnotationUpdate]);

  const commitInlineMaterialBindings = useCallback((annotation, keys) => {
    if (!annotation?.id || !onAnnotationUpdate) return;
    const selectedKeys = Array.isArray(keys) ? keys : [];
    const rows = Array.isArray(panelProps.materialRows) ? panelProps.materialRows : [];
    const existing = getMaterialBindings(annotation);
    const selected = selectedKeys
      .map(key => rows.find(row => row.key === key) || existing.find(row => row?.key === key))
      .filter(Boolean)
      .slice(0, MAX_BOUND_MATERIALS_PER_WELD)
      .map(row => ({ ...row }));
    onAnnotationUpdate(annotation.id, {
      materialBinding: selected[0] || null,
      materialBindings: selected,
      materialNumber: selected.map(row => row.materialId).filter(Boolean).join(', '),
      materialBindingPage: selected[0]?.sourcePage || ''
    });
  }, [getMaterialBindings, onAnnotationUpdate, panelProps.materialRows]);

  const pageFieldPresence = React.useMemo(() => {
    const has = field => textAnnotations.some(annotation => (
      annotation[field] !== undefined &&
      annotation[field] !== null &&
      annotation[field] !== ''
    ));
    return {
      splitCircle: textAnnotations.some(annotation => annotation.borderShape === 'split-circle'),
      material: has('materialNumber') ||
        textAnnotations.some(annotation => getMaterialBindings(annotation).length > 0),
      materialBinding: (Array.isArray(panelProps.materialRows) && panelProps.materialRows.length > 0) ||
        textAnnotations.some(annotation => getMaterialBindings(annotation).length > 0),
      pipelineNumber: has('pipelineNumber'),
      remark: has('remark') || has('ruleRemark'),
      rule: has('ruleId') || has('ruleName'),
      fontSize: has('fontSize'),
      borderShape: has('borderShape'),
      color: has('color'),
      rotation: textAnnotations.some(annotation => annotation.borderShape === 'pipe-tag'),
      attributes: textAnnotations.some(annotation => Array.isArray(annotation.attributes) && annotation.attributes.length > 0)
    };
  }, [textAnnotations, getMaterialBindings, panelProps.materialRows]);

  const inlineInput = useCallback((annotation, field, placeholder = '') => (
    <Input
      key={`${annotation.id}-${field}-${annotation[field] ?? ''}`}
      size="small"
      defaultValue={annotation[field] ?? ''}
      placeholder={placeholder}
      onClick={event => event.stopPropagation()}
      onBlur={event => commitInlineAnnotationField(annotation, field, event.target.value)}
      onPressEnter={event => event.currentTarget.blur()}
      style={{ minWidth: 88 }}
    />
  ), [commitInlineAnnotationField]);

  // ⚡ 性能优化：使用 useMemo 缓存表格列定义，避免每次渲染都创建新的 render 函数
  const annotationColumns = React.useMemo(() => {
    const columns = [{
      title: '序号',
      dataIndex: 'index',
      key: 'index',
      width: 58,
      align: 'center',
      render: (index) => (
        <span style={{ fontSize: '13px', fontWeight: 'bold' }}>{index}</span>
      )
    },
    {
      title: '焊口号',
      dataIndex: 'text',
      key: 'text',
      width: 130,
      render: (_, record) => inlineInput(record.annotation, 'text', '焊口号')
    }];

    // Keep affixes visible and editable as first-class metadata.  The
    // adjustment engine uses this pair as part of its sequence key, so F12-A
    // and E12-A are separate sequences even when they share a pipeline.
    if (textAnnotations.some(isWeldNumberAnnotation)) {
      columns.push(
        {
          title: '前缀',
          key: 'weldPrefix',
          width: 92,
          render: (_, record) => isWeldNumberAnnotation(record.annotation) ? (
            <Input
              size="small"
              value={getAnnotationWeldNumberParts(record.annotation).prefix}
              placeholder="无"
              onClick={event => event.stopPropagation()}
              onBlur={event => commitInlineWeldNumberPart(record.annotation, 'prefix', event.target.value)}
              onPressEnter={event => event.currentTarget.blur()}
            />
          ) : null
        },
        {
          title: '编号',
          key: 'weldNumber',
          width: 120,
          render: (_, record) => isWeldNumberAnnotation(record.annotation) ? (
            <InputNumber
              size="small"
              min={0}
              precision={0}
              value={getAnnotationWeldNumberParts(record.annotation).number || undefined}
              onClick={event => event.stopPropagation()}
              onChange={value => {
                if (value !== null && value !== undefined) {
                  commitInlineWeldNumberPart(record.annotation, 'number', value);
                }
              }}
              style={{ width: '100%' }}
            />
          ) : null
        },
        {
          title: '后缀',
          key: 'weldSuffix',
          width: 92,
          render: (_, record) => isWeldNumberAnnotation(record.annotation) ? (
            <Input
              size="small"
              value={getAnnotationWeldNumberParts(record.annotation).suffix}
              placeholder="无"
              onClick={event => event.stopPropagation()}
              onBlur={event => commitInlineWeldNumberPart(record.annotation, 'suffix', event.target.value)}
              onPressEnter={event => event.currentTarget.blur()}
            />
          ) : null
        }
      );
    }

    if (pageFieldPresence.splitCircle) {
      columns.push(
        {
          title: '寸径',
          key: 'topText',
          width: 105,
          render: (_, record) => record.annotation.borderShape === 'split-circle'
            ? inlineInput(record.annotation, 'topText', '待确认')
            : null
        },
        {
          title: '接头类型',
          key: 'jointTypeText',
          width: 110,
          render: (_, record) => record.annotation.borderShape === 'split-circle'
            ? inlineInput(record.annotation, 'jointTypeText', '例如 BW')
            : null
        }
      );
    }

    if (pageFieldPresence.material) {
      columns.push({
        title: '材料编号',
        key: 'materialNumber',
        width: 125,
        render: (_, record) => inlineInput(record.annotation, 'materialNumber')
      });
    }

    if (pageFieldPresence.materialBinding) {
      columns.push({
        title: '绑定材料',
        key: 'materialBindings',
        width: 210,
        render: (_, record) => {
          const bindings = getMaterialBindings(record.annotation);
          const rows = Array.isArray(panelProps.materialRows) ? panelProps.materialRows : [];
          const options = [...rows, ...bindings.filter(binding => (
            binding?.key && !rows.some(row => row.key === binding.key)
          ))];
          return (
            <Select
              mode="multiple"
              size="small"
              maxTagCount={1}
              value={bindings.map(binding => binding?.key).filter(Boolean)}
              onClick={event => event.stopPropagation()}
              onChange={keys => commitInlineMaterialBindings(record.annotation, keys)}
              options={options.map((row, index) => ({
                value: row.key || `${row.sourcePage || ''}-${index}`,
                label: [row.materialId, row.diameter || row.specification, row.description].filter(Boolean).join(' | ')
              }))}
              style={{ width: '100%' }}
              placeholder="选择材料"
            />
          );
        }
      });
    }

    if (pageFieldPresence.pipelineNumber) {
      columns.push({
        title: '管线号',
        key: 'pipelineNumber',
        width: 160,
        render: (_, record) => inlineInput(record.annotation, 'pipelineNumber')
      });
    }

    if (pageFieldPresence.remark) {
      columns.push({
        title: '备注',
        key: 'remark',
        width: 150,
        render: (_, record) => inlineInput(record.annotation, 'remark')
      });
    }

    if (pageFieldPresence.rule) {
      columns.push({
        title: '规则',
        key: 'ruleId',
        width: 135,
        render: (_, record) => (
          <Select
            size="small"
            value={record.annotation.ruleId || undefined}
            onClick={event => event.stopPropagation()}
            onChange={ruleId => {
              const rule = rules.find(item => item.id === ruleId);
              onAnnotationUpdate?.(record.annotation.id, {
                ruleId,
                ruleName: rule?.name || ''
              });
            }}
            options={rules.map(rule => ({ value: rule.id, label: rule.name }))}
            style={{ width: '100%' }}
            allowClear
          />
        )
      });
    }

    if (pageFieldPresence.fontSize) {
      columns.push({
        title: '字体',
        key: 'fontSize',
        width: pageFieldPresence.splitCircle ? 185 : 90,
        render: (_, record) => {
          const annotation = record.annotation;
          if (annotation.borderShape === 'split-circle') {
            return (
              <Space.Compact>
                <InputNumber
                  size="small"
                  value={annotation.topFontSize || 16}
                  onClick={event => event.stopPropagation()}
                  onChange={value => commitInlineAnnotationField(annotation, 'topFontSize', value)}
                  addonBefore="上"
                  style={{ width: 88 }}
                />
                <InputNumber
                  size="small"
                  value={annotation.bottomFontSize || annotation.fontSize}
                  onClick={event => event.stopPropagation()}
                  onChange={value => commitInlineAnnotationField(annotation, 'bottomFontSize', value)}
                  addonBefore="下"
                  style={{ width: 88 }}
                />
              </Space.Compact>
            );
          }
          return (
            <InputNumber
              size="small"
              value={annotation.fontSize}
              onClick={event => event.stopPropagation()}
              onChange={value => commitInlineAnnotationField(annotation, 'fontSize', value)}
              style={{ width: 75 }}
            />
          );
        }
      });
    }

    if (pageFieldPresence.borderShape) {
      columns.push({
        title: '标注类型',
        key: 'borderShape',
        width: 125,
        render: (_, record) => (
          <Select
            size="small"
            value={record.annotation.borderShape}
            onClick={event => event.stopPropagation()}
            onChange={value => commitInlineAnnotationField(record.annotation, 'borderShape', value)}
            options={[
              { value: 'circle', label: '圆形' },
              { value: 'split-circle', label: '分栏圆形' },
              { value: 'diamond', label: '矩形' },
              { value: 'text-rectangle', label: '长方形框' },
              { value: 'pipe-tag', label: '管段框' },
              { value: 'field-weld', label: '现场焊缝' },
              { value: 'shop-weld', label: '车间焊缝' }
            ]}
            style={{ width: '100%' }}
          />
        )
      });
    }

    if (pageFieldPresence.rotation) {
      columns.push({
        title: '角度',
        key: 'rotation',
        width: 85,
        render: (_, record) => record.annotation.borderShape === 'pipe-tag' ? (
          <InputNumber
            size="small"
            min={-180}
            max={180}
            value={record.annotation.rotation || 0}
            onClick={event => event.stopPropagation()}
            onChange={value => commitInlineAnnotationField(record.annotation, 'rotation', value)}
            style={{ width: 75 }}
          />
        ) : null
      });
    }

    if (pageFieldPresence.color) {
      columns.push({
        title: '颜色',
        key: 'color',
        width: 70,
        render: (_, record) => (
          <Input
            type="color"
            value={record.annotation.color || '#000000'}
            onClick={event => event.stopPropagation()}
            onChange={event => commitInlineAnnotationField(record.annotation, 'color', event.target.value)}
            style={{ width: 48, padding: 2 }}
          />
        )
      });
    }

    if (pageFieldPresence.attributes) {
      columns.push({
        title: '属性',
        key: 'attributes',
        width: 160,
        render: (_, record) => (
          <Select
            mode="tags"
            size="small"
            value={record.annotation.attributes || []}
            onClick={event => event.stopPropagation()}
            onChange={value => onAnnotationUpdate?.(record.annotation.id, { attributes: value })}
            style={{ width: '100%' }}
          />
        )
      });
    }

    columns.push({
      title: '操作',
      key: 'action',
      width: 84,
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="编辑标注">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                handleEditAnnotation(record.annotation);
              }}
              style={{ fontSize: '10px' }}
            />
          </Tooltip>
          <Tooltip title="删除标注">
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteAnnotation(record.annotation.id);
              }}
              style={{ fontSize: '10px' }}
            />
          </Tooltip>
        </Space>
      )
    });
    return columns;
  }, [
    commitInlineAnnotationField,
    commitInlineWeldNumberPart,
    commitInlineMaterialBindings,
    getMaterialBindings,
    handleEditAnnotation,
    handleDeleteAnnotation,
    inlineInput,
    onAnnotationUpdate,
    pageFieldPresence,
    panelProps.materialRows,
    rules,
    textAnnotations
  ]);

  // 准备规则表格数据
  const tableData = [
    ...rules.map((rule, index) => ({
      key: `${rule.id}_${index}`,
      id: rule.id,
      name: rule.name,
      prefix: rule.prefix,
      suffix: rule.suffix || '',
      jointTypeText: rule.jointTypeText || '',
      startNumber: rule.startNumber,
      increment: rule.increment,
      remark: rule.remark || '',
      isActive: activeRule?.id === rule.id,
      isEditing: editingRule === rule.id,
      isNew: false
    })),
    // 如果正在创建新规则，添加一个空行
    ...(isCreating ? [{
      key: 'new_rule_row', // 使用稳定的key避免焦点丢失
      id: 'new',
      name: newRuleData.name,
      prefix: newRuleData.prefix,
      suffix: newRuleData.suffix,
      jointTypeText: newRuleData.jointTypeText,
      startNumber: newRuleData.startNumber,
      increment: newRuleData.increment,
      remark: newRuleData.remark,
      isActive: false,
      isEditing: false,
      isNew: true
    }] : [])
  ];

  // 规则表格列定义
  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: '20%',
      render: (text, record) => {
        if (record.isNew) {
          return (
            <Input
              size="small"
              placeholder="规则名称"
              value={newRuleData.name}
              onChange={(e) => handleFieldChange('name', e.target.value)}
              style={{ fontSize: '10px' }}
            />
          );
        }
        if (record.isEditing) {
          return (
            <Input
              size="small"
              placeholder="规则名称"
              value={editingRuleData.name ?? text}
              onChange={(e) => handleFieldChange('name', e.target.value)}
              style={{ fontSize: '10px' }}
            />
          );
        }
        return (
          <span 
            style={{ 
              fontWeight: record.isActive ? 'bold' : 'normal',
              color: record.isActive ? '#1890ff' : '#000',
              fontSize: '11px'
            }}
          >
            {text}
          </span>
        );
      }
    },
    {
      title: '前缀',
      dataIndex: 'prefix',
      key: 'prefix',
      width: '12%',
      render: (text, record) => {
        if (record.isNew) {
          return (
            <Input
              size="small"
              placeholder="WJ"
              value={newRuleData.prefix}
              onChange={(e) => handleFieldChange('prefix', e.target.value)}
              style={{ fontSize: '10px' }}
            />
          );
        }
        if (record.isEditing) {
          return (
            <Input
              size="small"
              placeholder="WJ"
              value={editingRuleData.prefix ?? ''}
              onChange={(e) => handleFieldChange('prefix', e.target.value)}
              style={{ fontSize: '10px' }}
            />
          );
        }
        return <span style={{ fontWeight: 'bold', color: '#1890ff', fontSize: '11px' }}>{text}</span>;
      }
    },
    {
      title: '后缀',
      dataIndex: 'suffix',
      key: 'suffix',
      width: '12%',
      render: (text, record) => {
        if (record.isNew) {
          return (
            <Input
              size="small"
              placeholder="-A"
              value={newRuleData.suffix}
              onChange={(e) => handleFieldChange('suffix', e.target.value)}
              style={{ fontSize: '10px' }}
            />
          );
        }
        if (record.isEditing) {
          return (
            <Input
              size="small"
              placeholder="-A"
              value={editingRuleData.suffix ?? ''}
              onChange={(e) => handleFieldChange('suffix', e.target.value)}
              style={{ fontSize: '10px' }}
            />
          );
        }
        return <span style={{ fontWeight: 'bold', color: '#fa8c16', fontSize: '11px' }}>{text}</span>;
      }
    },
    {
      title: '接头类型',
      dataIndex: 'jointTypeText',
      key: 'jointTypeText',
      width: '12%',
      render: (text, record) => {
        if (record.isNew) {
          return (
            <Input
              size="small"
              placeholder="F"
              value={newRuleData.jointTypeText}
              onChange={(e) => handleFieldChange('jointTypeText', e.target.value)}
              style={{ fontSize: '10px' }}
            />
          );
        }
        if (record.isEditing) {
          return (
            <Input
              size="small"
              placeholder="F"
              value={editingRuleData.jointTypeText ?? ''}
              onChange={(e) => handleFieldChange('jointTypeText', e.target.value)}
              style={{ fontSize: '10px' }}
            />
          );
        }
        return <span style={{ fontWeight: 'bold', color: '#722ed1', fontSize: '11px' }}>{text || '-'}</span>;
      }
    },
    {
      title: '起始',
      dataIndex: 'startNumber',
      key: 'startNumber',
      width: '12%',
      render: (text, record) => {
        if (record.isNew) {
          return (
            <InputNumber
              size="small"
              min={1}
              value={newRuleData.startNumber}
              onChange={(value) => handleFieldChange('startNumber', value)}
              style={{ width: '100%', fontSize: '10px' }}
              placeholder="无"
              controls={false}
            />
          );
        }
        if (record.isEditing) {
          return (
            <InputNumber
              size="small"
              min={1}
              value={editingRuleData.startNumber}
              onChange={(value) => handleFieldChange('startNumber', value)}
              style={{ width: '100%', fontSize: '10px' }}
              placeholder="无"
              controls={false}
            />
          );
        }
        return <span style={{ fontWeight: 'bold', color: '#52c41a', fontSize: '11px' }}>{text || '无'}</span>;
      }
    },
    {
      title: '递增',
      dataIndex: 'increment',
      key: 'increment',
      width: '10%',
      render: (text, record) => {
        if (record.isNew) {
          return (
            <InputNumber
              size="small"
              min={0}
              value={newRuleData.increment}
              onChange={(value) => handleFieldChange('increment', value)}
              style={{ width: '100%', fontSize: '10px' }}
              controls={false}
            />
          );
        }
        if (record.isEditing) {
          return (
            <InputNumber
              size="small"
              min={0}
              value={editingRuleData.increment}
              onChange={(value) => handleFieldChange('increment', value)}
              style={{ width: '100%', fontSize: '10px' }}
              controls={false}
            />
          );
        }
        return <span style={{ color: '#666', fontSize: '11px' }}>{text}</span>;
      }
    },
    {
      title: '备注',
      dataIndex: 'remark',
      key: 'remark',
      width: '15%',
      ellipsis: true,
      render: (text, record) => {
        if (record.isNew) {
          return (
            <Select
              size="small"
              placeholder="选择备注"
              value={newRuleData.remark}
              onChange={(value) => handleFieldChange('remark', value)}
              style={{ fontSize: '12px', minHeight: '28px', width: '100%' }}
              styles={{ popup: { root: { fontSize: '12px' } } }}
            >
              <Option value="焊接支架" style={{ fontSize: '12px', lineHeight: '20px', padding: '4px 8px' }}>
                焊接支架
              </Option>
            </Select>
          );
        }
        if (record.isEditing) {
          return (
            <Select
              size="small"
              placeholder="选择备注"
              value={editingRuleData.remark ?? text}
              onChange={(value) => handleFieldChange('remark', value)}
              style={{ fontSize: '12px', minHeight: '28px', width: '100%' }}
              styles={{ popup: { root: { fontSize: '12px' } } }}
            >
              <Option value="焊接支架" style={{ fontSize: '12px', lineHeight: '20px', padding: '4px 8px' }}>
                焊接支架
              </Option>
            </Select>
          );
        }
        return (
          <span style={{ color: '#666', fontSize: '10px' }} title={text}>
            {text.length > 12 ? `${text.substring(0, 12)}...` : text}
          </span>
        );
      }
    },
    {
      title: '操作',
      key: 'actions',
      width: '19%',
      render: (_, record) => {
        if (record.isNew) {
          return (
            <Space size="small">
              <Button
                type="primary"
                size="small"
                onClick={handleSaveRule}
                style={{ fontSize: '10px' }}
              >
                保存
              </Button>
              <Button
                size="small"
                onClick={handleCancel}
                style={{ fontSize: '10px' }}
              >
                取消
              </Button>
            </Space>
          );
        }

        if (record.isEditing) {
          return (
            <Space size="small">
              <Button
                type="primary"
                size="small"
                onClick={handleSaveRule}
                style={{ fontSize: '10px' }}
              >
                保存
              </Button>
              <Button
                size="small"
                onClick={handleCancel}
                style={{ fontSize: '10px' }}
              >
                取消
              </Button>
            </Space>
          );
        }

        return (
          <Space size="small">
            <Tooltip title="编辑">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={() => handleEditRule(record)}
                style={{ fontSize: '10px' }}
              />
            </Tooltip>
            <Popconfirm
              title="确定删除此规则？"
              onConfirm={() => handleDeleteRule(record.id)}
              okText="确定"
              cancelText="取消"
            >
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                style={{ fontSize: '10px' }}
              />
            </Popconfirm>
            <Tooltip title="重置规则设置">
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => handleResetRuleNumber(rules.find(r => r.id === record.id))}
                style={{ fontSize: '10px' }}
              />
            </Tooltip>
          </Space>
        );
      }
    }
  ];

  const isEditingSplitCircle = (watchedBorderShape || editingAnnotation?.borderShape) === 'split-circle';
  const isEditingPipeTag = (watchedBorderShape || editingAnnotation?.borderShape) === 'pipe-tag';

  return (
    <>
      <ResizeHandle ref={resizeHandleRef} $visible={visible} $width={panelWidth} $isResizing={isResizing} onMouseDown={handleMouseDown} />

      <Modal
        title={
          <div
            style={{
              cursor: 'move',
              userSelect: 'none',
              padding: '0 8px'
            }}
          >
            编辑标注
          </div>
        }
        open={!!editingAnnotation}
        onCancel={handleCancelAnnotationEdit}
        width={isEditingSplitCircle ? 760 : 640}
        mask={false}
        footer={null}
        style={{
          transform: `translate(${modalPosition.x}px, ${modalPosition.y}px)`,
          transition: isDragging ? 'none' : 'transform 0.2s ease-out'
        }}
        modalRender={(modal) => (
          <div
            ref={modalRef}
            onMouseDown={handleModalMouseDown}
            style={{
              cursor: isDragging ? 'move' : 'default',
            }}
          >
            {modal}
          </div>
        )}
      >
        <Form
          form={editAnnotationForm}
          layout="horizontal"
          labelCol={{ span: 5 }}
          wrapperCol={{ span: 19 }}
        >
          <div style={{
            marginBottom: 16,
            padding: '14px 16px',
            border: '1px solid #f0f0f0',
            borderRadius: 8,
            background: '#fafafa'
          }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: isEditingSplitCircle ? '1.05fr 1fr 0.82fr' : '1fr',
              columnGap: 14,
              rowGap: 10,
              alignItems: 'start'
            }}>
              <Form.Item
                label={<span style={{ fontWeight: 600, fontSize: 14 }}>{isEditingSplitCircle ? '下半标注（焊口号）' : '标注内容'}</span>}
                name="text"
                rules={[{ required: true, message: isEditingSplitCircle ? '请输入下半标注' : '请输入标注内容' }]}
                style={{ marginBottom: 0 }}
                labelCol={{ span: isEditingSplitCircle ? 24 : 4 }}
                wrapperCol={{ span: isEditingSplitCircle ? 24 : 20 }}
              >
                <Input
                  placeholder={isEditingSplitCircle ? '例如：WU6' : '例如：WJ-01'}
                  autoFocus
                  onPressEnter={handleSaveAnnotationEdit}
                  style={{
                    fontSize: '18px',
                    fontWeight: '600',
                    height: '44px'
                  }}
                />
              </Form.Item>

              {isEditingSplitCircle && (
                <Form.Item
                  label={<span style={{ fontWeight: 600, fontSize: 14 }}>上半标注（寸径）</span>}
                  name="topText"
                  style={{ marginBottom: 0 }}
                  labelCol={{ span: 24 }}
                  wrapperCol={{ span: 24 }}
                >
                  <Input
                    placeholder="例如：22 / 25"
                    onPressEnter={handleSaveAnnotationEdit}
                    style={{
                      fontSize: '16px',
                      height: '44px'
                    }}
                  />
                </Form.Item>
              )}

              {isEditingSplitCircle && (
                <Form.Item
                  label={<span style={{ fontWeight: 600, fontSize: 14 }}>接头类型</span>}
                  name="jointTypeText"
                  style={{ marginBottom: 0 }}
                  labelCol={{ span: 24 }}
                  wrapperCol={{ span: 24 }}
                >
                  <Input
                    placeholder="例如：F"
                    onPressEnter={handleSaveAnnotationEdit}
                    style={{
                      fontSize: '16px',
                      height: '44px'
                    }}
                  />
                </Form.Item>
              )}
            </div>

            {isEditingSplitCircle && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
                上半显示规则：上半标注 + 英文引号 + 接头类型，例如 22 和 F 显示为 22"F。
              </div>
            )}

            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: 12
            }}>
              <span style={{ fontSize: 12, color: '#999' }}>按 Enter 键快速保存</span>
              <Space>
                <Button
                  type="primary"
                  size="large"
                  onClick={handleSaveAnnotationEdit}
                  style={{
                    height: '44px',
                    minWidth: '80px',
                    fontWeight: '600',
                    fontSize: '15px'
                  }}
                >
                  保存
                </Button>
                <Button
                  type="primary"
                  danger
                  size="large"
                  onClick={() => {
                    if (editingAnnotation && onAnnotationDelete) {
                      onAnnotationDelete(editingAnnotation.id);
                      handleCancelAnnotationEdit();
                    }
                  }}
                  style={{
                    height: '44px',
                    minWidth: '80px',
                    fontWeight: '600',
                    fontSize: '15px'
                  }}
                >
                  删除
                </Button>
              </Space>
            </div>
          </div>
          <div style={{ height: '1px', background: '#f0f0f0', margin: '16px 0' }} />
          
          {/* 材料编号 */}
          <Form.Item
            label="材料编号"
            name="materialNumber"
          >
            <Input placeholder="例如：M001" />
          </Form.Item>

          <Form.Item
            label="绑定材料行"
            name="materialBindingKey"
          >
            <Select
              mode="multiple"
              showSearch
              allowClear
              maxTagCount="responsive"
              placeholder={materialOptions.length > 0 ? '选择材料表行（可多选）' : '请先识别材料表'}
              optionFilterProp="children"
              disabled={materialOptions.length === 0}
              onChange={(values) => {
                const nextValues = Array.isArray(values) ? values : [];
                if (nextValues.length > MAX_BOUND_MATERIALS_PER_WELD) {
                  editAnnotationForm.setFieldsValue({
                    materialBindingKey: nextValues.slice(0, MAX_BOUND_MATERIALS_PER_WELD)
                  });
                  message.warning(`一个焊口最多绑定 ${MAX_BOUND_MATERIALS_PER_WELD} 条材料`);
                }
              }}
            >
              {materialOptions.map(option => (
                <Option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.displayLabel || option.label}
                </Option>
              ))}
            </Select>
          </Form.Item>
          
          {/* 备注 */}
          <Form.Item
            label="备注"
            name="remark"
          >
            <Select placeholder="选择备注" allowClear>
              <Option value="焊接支架">焊接支架</Option>
            </Select>
          </Form.Item>
          
          <div style={{ height: '1px', background: '#f0f0f0', margin: '12px 0' }} />
          
          {/* 颜色 */}
          <Form.Item
            label="颜色"
            name="color"
          >
            <Input type="color" style={{ width: '120px', height: '36px', cursor: 'pointer' }} />
          </Form.Item>
          
          {!isEditingSplitCircle ? (
            <Form.Item
              label="字体大小"
              name="fontSize"
            >
              <Select style={{ width: '120px' }}>
                {[8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 40, 44, 48, 52, 56, 60, 72].map(size => (
                  <Select.Option key={size} value={size}>{size}</Select.Option>
                ))}
              </Select>
            </Form.Item>
          ) : (
            <div style={{
              margin: '0 0 16px 0',
              padding: '12px 16px',
              border: '1px solid #f0f0f0',
              borderRadius: 8,
              background: '#fafafa'
            }}>
              <div style={{ fontWeight: 600, marginBottom: 10, color: '#262626' }}>
                分栏字体大小
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 12
              }}>
                <Form.Item
                  label="上半"
                  name="topFontSize"
                  style={{ marginBottom: 0 }}
                  labelCol={{ span: 8 }}
                  wrapperCol={{ span: 16 }}
                >
                  <Select style={{ width: '100%' }}>
                    {[8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 40, 44, 48, 52, 56, 60, 72].map(size => (
                      <Select.Option key={size} value={size}>{size}</Select.Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label="下半"
                  name="bottomFontSize"
                  style={{ marginBottom: 0 }}
                  labelCol={{ span: 8 }}
                  wrapperCol={{ span: 16 }}
                >
                  <Select style={{ width: '100%' }}>
                    {[8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 40, 44, 48, 52, 56, 60, 72].map(size => (
                      <Select.Option key={size} value={size}>{size}</Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </div>
            </div>
          )}

          {/* 边框样式 */}
          <Form.Item
            label="边框样式"
            name="borderShape"
          >
            <Select style={{ width: '180px' }} placeholder="选择样式">
              <Select.Option value="none">无边框</Select.Option>
              <Select.Option value="diamond">矩形</Select.Option>
              <Select.Option value="circle">圆形</Select.Option>
              <Select.Option value="split-circle">分栏圆形</Select.Option>
              <Select.Option value="text-rectangle">长方形框</Select.Option>
              <Select.Option value="pipe-tag">管段框</Select.Option>
              <Select.Option value="field-weld">现场焊缝</Select.Option>
              <Select.Option value="shop-weld">车间焊缝</Select.Option>
            </Select>
          </Form.Item>

          {isEditingPipeTag && (
            <Form.Item
              label="旋转角度"
              name="rotation"
            >
              <InputNumber
                min={-180}
                max={180}
                step={5}
                precision={0}
                style={{ width: '120px' }}
                addonAfter="°"
              />
            </Form.Item>
          )}
          
          <div style={{ height: '1px', background: '#f0f0f0', margin: '12px 0' }} />
          
          {/* 属性标签 */}
          <Form.Item
            label={<span style={{ color: '#999' }}>属性标签</span>}
            name="attributes"
          >
            <Select
              mode="tags"
              placeholder="添加属性标签（可选）"
              options={[
                { value: '材质', label: '材质' },
                { value: '规格', label: '规格' },
                { value: '焊接方法', label: '焊接方法' },
                { value: '管径', label: '管径' },
                { value: '壁厚', label: '壁厚' }
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      {visible && (
        <PanelContainer $width={panelWidth} $visible={visible}>
      <PanelHeader>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Title level={4} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <SettingOutlined />
            标注管理
          </Title>
        </div>
      </PanelHeader>

      {/* 上半部分：规则定义区域 */}
      <RuleDefinitionSection>
        <Title level={5} style={{ margin: '0 0 16px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <SettingOutlined />
          标注规则定义
        </Title>

        <Card size="small" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <Text strong>跨规则连续编号（可选）</Text>
              <div style={{ color: '#666', marginTop: 4 }}>
                切换规则时只改变标注样式和前后缀，焊口数字继续递增
              </div>
            </div>
            <Switch
              checked={continuousNumberingEnabled}
              onChange={onContinuousNumberingChange}
              checkedChildren="连续"
              unCheckedChildren="原规则"
            />
          </div>
          {continuousNumberingEnabled && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
              <Text>下一个焊口数字：</Text>
              <InputNumber
                min={0}
                precision={0}
                value={continuousNumber}
                onChange={(value) => {
                  if (value !== null && value !== undefined) {
                    onContinuousNumberChange?.(value);
                  }
                }}
                style={{ width: 140 }}
              />
            </div>
          )}
        </Card>

        {/* 当前激活规则 */}
        {activeRule && (
          <Card size="small" style={{ marginBottom: 16 }} title="当前规则">
            <div>
              <Text strong>{activeRule.name}</Text>
              <RulePreview>{generatePreview({
                ...activeRule,
                currentNumber: continuousNumberingEnabled ? continuousNumber : activeRule.currentNumber
              })}</RulePreview>
              <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>
                下一个编号：{generatePreview({
                  ...activeRule,
                  currentNumber: continuousNumberingEnabled
                    ? continuousNumber + 1
                    : (activeRule.currentNumber || activeRule.startNumber) + activeRule.increment
                })}
              </div>
              {activeRule.remark && (
                <div style={{ fontSize: '12px', color: '#999', marginBottom: '8px' }}>
                  备注：{activeRule.remark}
                </div>
              )}
            </div>
            
            <WeldingButton
              icon={<NumberOutlined />}
              onClick={onWeldingAnnotate}
              disabled={!annotationMode}
            >
              焊口标注 ({generatePreview({
                ...activeRule,
                currentNumber: continuousNumberingEnabled ? continuousNumber : activeRule.currentNumber
              })})
            </WeldingButton>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => handleResetRuleNumber(activeRule)}
              style={{ width: '100%', marginTop: 8 }}
            >
              重置当前规则编号（Alt+R）
            </Button>
            {!annotationMode && (
              <Text type="secondary" style={{ fontSize: '12px', display: 'block', textAlign: 'center', marginTop: '4px' }}>
                请先启用标注模式
              </Text>
            )}
          </Card>
        )}

        {/* 规则列表 - 改为表格形式 */}
        <Card 
          size="small" 
          title="规则列表" 
          extra={
            <Space>
            <Button 
              type="primary" 
              size="small" 
              icon={<PlusOutlined />}
              onClick={handleCreateRule}
            >
              新建
            </Button>
              {rules.length > 0 && (
                <Tooltip title="批量重置所有规则序号">
                  <Button
                    type="text"
                    size="small"
                    icon={<ReloadOutlined />}
                    onClick={handleBatchResetRules}
                    style={{ fontSize: '11px' }}
                  >
                    批量重置
                  </Button>
                </Tooltip>
              )}
              <Popconfirm
                title="确定要清除所有历史数据吗？"
                onConfirm={handleClearAllData}
                okText="确定"
                cancelText="取消"
              >
                <Button
                  type="text"
                  size="small"
                  icon={<ClearOutlined />}
                  style={{ fontSize: '11px' }}
                >
                  清除历史
                </Button>
              </Popconfirm>
            </Space>
          }
          style={{ marginBottom: 16 }}
        >
          {rules.length === 0 && !isCreating && !editingRule ? (
            <div style={{ textAlign: 'center', color: '#999', padding: '20px' }}>
              暂无规则，请点击"新建"创建规则
            </div>
          ) : (
            <RuleEditorTable
              dataSource={[
                ...rules.map((rule, index) => ({
                  key: `${rule.id}_detail_${index}`,
                  id: rule.id,
                  name: rule.name,
                  prefix: rule.prefix,
                  suffix: rule.suffix || '',
                  jointTypeText: rule.jointTypeText || '',
                  startNumber: rule.startNumber,
                  increment: rule.increment,
                  remark: rule.remark || '',
                  attributes: rule.attributes ? (Array.isArray(rule.attributes) ? rule.attributes.join(' | ') : Object.entries(rule.attributes).map(([k,v]) => `${k}:${v}`).join(' | ')) : '-',
                  isActive: activeRule?.id === rule.id,
                  isEditing: editingRule === rule.id,
                  isNew: false
                })),
                // 如果正在创建新规则，添加一个空行
                ...(isCreating ? [{
                  key: 'new_detail_rule_row', // 使用稳定的key避免焦点丢失
                  id: 'new',
                  name: newRuleData.name,
                  prefix: newRuleData.prefix,
                  suffix: newRuleData.suffix,
                  jointTypeText: newRuleData.jointTypeText,
                  startNumber: newRuleData.startNumber,
                  increment: newRuleData.increment,
                  remark: newRuleData.remark,
                  attributes: newRuleData.attributes ? Object.entries(newRuleData.attributes).map(([k,v]) => `${k}:${v}`).join(' | ') : '-',
                  isActive: false,
                  isEditing: false,
                  isNew: true
                }] : [])
              ]}
              columns={[
                {
                  title: '规则名称',
                  dataIndex: 'name',
                  key: 'name',
                  width: getRuleEditorColumnWidth('name', 150, '规则名称'),
                  render: (text, record) => {
                    if (record.isNew) {
                      return (
                        <Input
                          size="small"
                          placeholder="规则名称"
                          value={newRuleData.name}
                          onChange={(e) => handleFieldChange('name', e.target.value)}
                          style={{ fontSize: '10px' }}
                        />
                      );
                    }
                    if (record.isEditing) {
                      return (
                        <Input
                          size="small"
                          placeholder="规则名称"
                          value={editingRuleData.name ?? text}
                          onChange={(e) => handleFieldChange('name', e.target.value)}
                          style={{ fontSize: '10px' }}
                        />
                      );
                    }
                    return (
                      <span 
                        style={{ 
                          fontWeight: record.isActive ? 'bold' : 'normal',
                          color: record.isActive ? '#1890ff' : '#000',
                          fontSize: '11px'
                        }}
                      >
                        {text}
                      </span>
                    );
                  }
                },
                {
                  title: '前缀',
                  dataIndex: 'prefix',
                  key: 'prefix',
                  width: getRuleEditorColumnWidth('prefix', 80, 'WJ'),
                  render: (text, record) => {
                    if (record.isNew) {
                      return (
                        <Input
                          size="small"
                          placeholder="WJ"
                          value={newRuleData.prefix}
                          onChange={(e) => handleFieldChange('prefix', e.target.value)}
                          style={{ fontSize: '10px' }}
                        />
                      );
                    }
                    if (record.isEditing) {
                      return (
                        <Input
                          size="small"
                          placeholder="WJ"
                          value={editingRuleData.prefix ?? text}
                          onChange={(e) => handleFieldChange('prefix', e.target.value)}
                          style={{ fontSize: '10px' }}
                        />
                      );
                    }
                    return <span style={{ fontWeight: 'bold', color: '#1890ff', fontSize: '11px' }}>{text}</span>;
                  }
                },
                {
                  title: '后缀',
                  dataIndex: 'suffix',
                  key: 'suffix',
                  width: getRuleEditorColumnWidth('suffix', 80, '-A'),
                  render: (text, record) => {
                    if (record.isNew) {
                      return (
                        <Input
                          size="small"
                          placeholder="-A"
                          value={newRuleData.suffix}
                          onChange={(e) => handleFieldChange('suffix', e.target.value)}
                          style={{ fontSize: '10px' }}
                        />
                      );
                    }
                    if (record.isEditing) {
                      return (
                        <Input
                          size="small"
                          placeholder="-A"
                          value={editingRuleData.suffix ?? text}
                          onChange={(e) => handleFieldChange('suffix', e.target.value)}
                          style={{ fontSize: '10px' }}
                        />
                      );
                    }
                    return <span style={{ fontWeight: 'bold', color: '#fa8c16', fontSize: '11px' }}>{text}</span>;
                  }
                },
                {
                  title: '接头类型',
                  dataIndex: 'jointTypeText',
                  key: 'jointTypeText',
                  width: getRuleEditorColumnWidth('jointTypeText', 110, 'F'),
                  render: (text, record) => {
                    if (record.isNew) {
                      return (
                        <Input
                          size="small"
                          placeholder="F"
                          value={newRuleData.jointTypeText}
                          onChange={(e) => handleFieldChange('jointTypeText', e.target.value)}
                          style={{ fontSize: '10px' }}
                        />
                      );
                    }
                    if (record.isEditing) {
                      return (
                        <Input
                          size="small"
                          placeholder="F"
                          value={editingRuleData.jointTypeText ?? ''}
                          onChange={(e) => handleFieldChange('jointTypeText', e.target.value)}
                          style={{ fontSize: '10px' }}
                        />
                      );
                    }
                    return <span style={{ fontWeight: 'bold', color: '#722ed1', fontSize: '11px' }}>{text || '-'}</span>;
                  }
                },
                {
                  title: '起始序号',
                  dataIndex: 'startNumber',
                  key: 'startNumber',
                  width: getRuleEditorColumnWidth('startNumber', 110, '起始序号'),
                  render: (text, record) => {
                    if (record.isNew) {
                      return (
                        <InputNumber
                          size="small"
                          min={1}
                          value={newRuleData.startNumber}
                          onChange={(value) => handleFieldChange('startNumber', value)}
                          style={{ width: '100%', fontSize: '10px' }}
                          controls={false}
                        />
                      );
                    }
                    if (record.isEditing) {
                      return (
                        <InputNumber
                          size="small"
                          min={1}
                          value={editingRuleData.startNumber ?? text}
                          onChange={(value) => handleFieldChange('startNumber', value)}
                          style={{ width: '100%', fontSize: '10px' }}
                          controls={false}
                        />
                      );
                    }
                    return <span style={{ fontWeight: 'bold', color: '#52c41a', fontSize: '11px' }}>{text}</span>;
                  }
                },
                {
                  title: '递增',
                  dataIndex: 'increment',
                  key: 'increment',
                  width: getRuleEditorColumnWidth('increment', 80, '递增'),
                  render: (text, record) => {
                    if (record.isNew) {
                      return (
                        <InputNumber
                          size="small"
                          min={1}
                          value={newRuleData.increment}
                          onChange={(value) => handleFieldChange('increment', value)}
                          style={{ width: '100%', fontSize: '10px' }}
                          controls={false}
                        />
                      );
                    }
                    if (record.isEditing) {
                      return (
                        <InputNumber
                          size="small"
                          min={1}
                          value={editingRuleData.increment ?? text}
                          onChange={(value) => handleFieldChange('increment', value)}
                          style={{ width: '100%', fontSize: '10px' }}
                          controls={false}
                        />
                      );
                    }
                    return <span style={{ color: '#666', fontSize: '11px' }}>{text}</span>;
                  }
                },
                {
                  title: '备注',
                  dataIndex: 'remark',
                  key: 'remark',
                  width: getRuleEditorColumnWidth('remark', 140, '选择备注'),
                  ellipsis: true,
                  render: (text, record) => {
                    if (record.isNew) {
                      return (
                        <Select
                          size="small"
                          placeholder="选择备注"
                          value={newRuleData.remark}
                          onChange={(value) => handleFieldChange('remark', value)}
                          style={{ fontSize: '12px', minHeight: '28px', width: '100%' }}
                          styles={{ popup: { root: { fontSize: '12px' } } }}
                        >
                          <Option value="焊接支架" style={{ fontSize: '12px', lineHeight: '20px', padding: '4px 8px' }}>
                            焊接支架
                          </Option>
                        </Select>
                      );
                    }
                    if (record.isEditing) {
                      return (
                        <Select
                          size="small"
                          placeholder="选择备注"
                          value={editingRuleData.remark ?? text}
                          onChange={(value) => handleFieldChange('remark', value)}
                          style={{ fontSize: '12px', minHeight: '28px', width: '100%' }}
                          styles={{ popup: { root: { fontSize: '12px' } } }}
                        >
                          <Option value="焊接支架" style={{ fontSize: '12px', lineHeight: '20px', padding: '4px 8px' }}>
                            焊接支架
                          </Option>
                        </Select>
                      );
                    }
                    return (
                      <span style={{ color: '#666', fontSize: '10px' }} title={text}>
                        {text.length > 12 ? `${text.substring(0, 12)}...` : text}
                      </span>
                    );
                  }
                },
                {
                  title: '属性',
                  dataIndex: 'attributes',
                  key: 'attributes',
                  width: getRuleEditorColumnWidth('attributes', 160, '属性'),
                  ellipsis: true,
                  render: (text, record) => {
                    if (record.isNew) {
                      return (
                        <Select
                          mode="tags"
                          size="small"
                          placeholder="属性"
                          value={newRuleData.attributes ? Object.keys(newRuleData.attributes) : []}
                          onChange={(value) => handleFieldChange('attributes', value)}
                          style={{ width: '100%', fontSize: '10px' }}
                          options={[
                            { value: '材质', label: '材质' },
                            { value: '规格', label: '规格' },
                            { value: '焊接方法', label: '焊接方法' },
                            { value: '管径', label: '管径' },
                            { value: '壁厚', label: '壁厚' }
                          ]}
                        />
                      );
                    }
                    if (record.isEditing) {
                      return (
                        <Select
                          mode="tags"
                          size="small"
                          placeholder="属性"
                          value={editingRuleData.attributes ? Object.keys(editingRuleData.attributes) : (text === '-' ? [] : text.split(' | ').filter(Boolean))}
                          onChange={(value) => handleFieldChange('attributes', value)}
                          style={{ width: '100%', fontSize: '10px' }}
                          options={[
                            { value: '材质', label: '材质' },
                            { value: '规格', label: '规格' },
                            { value: '焊接方法', label: '焊接方法' },
                            { value: '管径', label: '管径' },
                            { value: '壁厚', label: '壁厚' }
                          ]}
                        />
                      );
                    }
                    return (
                      <span style={{ color: '#666', fontSize: '10px' }} title={text}>
                        {text.length > 12 ? `${text.substring(0, 12)}...` : text}
                      </span>
                    );
                  }
                },
                {
                  title: '操作',
                  key: 'actions',
                  width: 150,
                  fixed: 'right',
                  render: (_, record) => {
                    if (record.isNew) {
                      return (
                        <Space size="small">
                          <Button
                            type="primary"
                            size="small"
                            onClick={handleSaveRule}
                            style={{ fontSize: '10px' }}
                          >
                            保存
                          </Button>
                          <Button
                            size="small"
                            onClick={handleCancel}
                            style={{ fontSize: '10px' }}
                          >
                            取消
                          </Button>
                        </Space>
                      );
                    }
                    
                    if (record.isEditing) {
                      return (
                        <Space size="small">
                          <Button
                            type="primary"
                            size="small"
                            onClick={handleSaveRule}
                            style={{ fontSize: '10px' }}
                          >
                            保存
                          </Button>
                          <Button
            size="small"
                            onClick={handleCancel}
                            style={{ fontSize: '10px' }}
                          >
                            取消
                          </Button>
                        </Space>
                      );
                    }
                    
                    return (
                      <Space size="small">
                        <Tooltip title="编辑">
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleEditRule(record);
                            }}
                            style={{ fontSize: '10px' }}
                          />
                        </Tooltip>
                  <Popconfirm
                    title="确定删除此规则？"
                          onConfirm={() => handleDeleteRule(record.id)}
                    okText="确定"
                    cancelText="取消"
                  >
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                            onClick={(event) => event.stopPropagation()}
                            style={{ fontSize: '10px' }}
                    />
                  </Popconfirm>
                        <Tooltip title="重置规则设置">
                          <Button
                            type="text"
                            size="small"
                            icon={<ReloadOutlined />}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleResetRuleNumber(rules.find(r => r.id === record.id));
                            }}
                            style={{ fontSize: '10px' }}
                          />
                        </Tooltip>
                      </Space>
                    );
                  }
                }
              ]}
              pagination={false}
              size="small"
              scroll={{
                x: 'max-content',
                y: 'clamp(400px, 52vh, 680px)'
              }}
              onRow={(record) => ({
                onClick: () => {
                  if (!record.isNew && !record.isEditing) {
                    onActiveRuleChange(rules.find(r => r.id === record.id));
                  }
                },
                onDoubleClick: () => {
                  // 双击编辑规则
                  if (!record.isNew && !record.isEditing) {
                    handleEditRule(record);
                  }
                },
                style: {
                  backgroundColor: record.isActive ? '#e6f7ff' : 'transparent',
                  cursor: record.isNew || record.isEditing ? 'default' : 'pointer'
                }
              })}
            />
          )}
        </Card>

        {/* 移除原来的表单，已集成到表格中 */}

        {/* 快速模板 */}
        {rules.length === 0 && !isCreating && !editingRule && (
          <Card size="small" title="快速模板">
            <List
              size="small"
              dataSource={defaultRuleTemplates}
              renderItem={(template) => (
                <List.Item
                  actions={[
                    <Button
                      type="primary"
                      size="small"
                      onClick={() => handleUseTemplate(template)}
                    >
                      使用
                    </Button>
                  ]}
                >
                  <div>
                    <div style={{ fontWeight: 'bold' }}>{template.name}</div>
                    <div style={{ fontSize: '12px', color: '#666' }}>
                      {generatePreview(template)}
                    </div>
                  </div>
                </List.Item>
              )}
            />
          </Card>
        )}
      </RuleDefinitionSection>

      {/* 下半部分：标注信息表格 */}
      <AnnotationInfoSection>
        {/* 固定标题栏 */}
        <AnnotationInfoHeader>
          <Title level={5} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' }}>
            <Space>
              <FileTextOutlined />
              第 {panelProps.currentPage || 1} 页标注信息 ({textAnnotations.length})
            </Space>
            {textAnnotations.length > 0 && (
              <Dropdown
                menu={{
                  items: [
                    {
                      key: 'clear-current-page',
                      label: (
                        <Popconfirm
                          title="确定要删除当前页标注信息吗？"
                          description="此操作将清空当前页面的所有标注数据，且不可撤销！"
                          onConfirm={() => handleClearAllAnnotations({ scope: 'current' })}
                          okText="确定删除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                        >
                          <div style={{ color: '#ff4d4f' }}>
                            <DeleteOutlined /> 删除当前页标注
                          </div>
                        </Popconfirm>
                      ),
                    },
                    {
                      key: 'clear-all',
                      label: (
                        <Popconfirm
                          title="确定要删除所有标注信息吗？"
                          description="此操作将清空所有页面的标注数据，且不可撤销！"
                          onConfirm={() => handleClearAllAnnotations({ scope: 'all' })}
                          okText="确定删除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                        >
                          <div style={{ color: '#ff4d4f' }}>
                            <DeleteOutlined /> 删除所有页标注
                          </div>
                        </Popconfirm>
                      ),
                    },
                    {
                      key: 'clear-text-current-page',
                      label: (
                        <Popconfirm
                          title="确定要清除当前页焊口号吗？"
                          description="此操作仅清除当前页焊口号文本，保留焊口位置框。"
                          onConfirm={() => handleClearAllAnnotations({ keepBox: true, scope: 'current' })}
                          okText="确定清除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                        >
                          <div style={{ color: '#fa8c16' }}>
                            <ClearOutlined /> 仅清除当前页焊口号
                          </div>
                        </Popconfirm>
                      ),
                    },
                    {
                      key: 'clear-text-all',
                      label: (
                        <Popconfirm
                          title="确定要清除所有页焊口号吗？"
                          description="此操作将清除所有页面的焊口号文本，保留焊口位置框。"
                          onConfirm={() => handleClearAllAnnotations({ keepBox: true, scope: 'all' })}
                          okText="确定清除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                        >
                          <div style={{ color: '#fa8c16' }}>
                            <ClearOutlined /> 仅清除所有页焊口号
                          </div>
                        </Popconfirm>
                      ),
                    }
                  ]
                }}
                trigger={['click']}
              >
                <Button
                  type="text"
                  size="small"
                  danger
                  style={{ fontSize: '11px' }}
                >
                  批量操作 <DownOutlined />
                </Button>
              </Dropdown>
            )}
          </Title>
          {textAnnotations.length > 0 && (
            <Space wrap size={6} style={{ marginTop: 8 }}>
              <span style={{ fontSize: 12, color: '#666' }}>
                当前页字体（{batchFontTargets.length < textAnnotations.length ? `已选 ${batchFontTargets.length}` : `本页 ${textAnnotations.length}`}）：
              </span>
              <InputNumber
                size="small"
                min={6}
                max={96}
                value={batchTopFontSize}
                onChange={value => setBatchTopFontSize(Number(value) || 16)}
                addonBefore="上"
                style={{ width: 92 }}
              />
              <InputNumber
                size="small"
                min={6}
                max={96}
                value={batchBottomFontSize}
                onChange={value => setBatchBottomFontSize(Number(value) || 34)}
                addonBefore="下"
                style={{ width: 92 }}
              />
              <InputNumber
                size="small"
                min={6}
                max={96}
                value={batchRegularFontSize}
                onChange={value => setBatchRegularFontSize(Number(value) || 34)}
                addonBefore="普通"
                style={{ width: 112 }}
              />
              <Button size="small" type="primary" onClick={applyBatchFontSizes}>
                应用
              </Button>
            </Space>
          )}
          {batchCircleFrameTargets.length > 0 && (
            <Space wrap size={6} style={{ marginTop: 6 }}>
              <span style={{ fontSize: 12, color: '#666' }}>
                所有页圆形/分栏圆形/菱形字体（框固定为A3打印10mm，共 {batchCircleFrameTargets.length} 个）：
              </span>
              <InputNumber
                size="small"
                min={6}
                max={96}
                value={batchTopFontSize}
                onChange={value => setBatchTopFontSize(Number(value) || 16)}
                addonBefore="上"
                style={{ width: 92 }}
                disabled={batchAllPagesFontApplying}
              />
              <InputNumber
                size="small"
                min={6}
                max={96}
                value={batchBottomFontSize}
                onChange={value => setBatchBottomFontSize(Number(value) || 34)}
                addonBefore="下"
                style={{ width: 92 }}
                disabled={batchAllPagesFontApplying}
              />
              <InputNumber
                size="small"
                min={6}
                max={96}
                value={batchRegularFontSize}
                onChange={value => setBatchRegularFontSize(Number(value) || 34)}
                addonBefore="普通"
                style={{ width: 112 }}
                disabled={batchAllPagesFontApplying}
              />
              <Button
                size="small"
                type="primary"
                onClick={applyBatchAllPagesFontSizes}
                loading={batchAllPagesFontApplying}
              >
                应用
              </Button>
            </Space>
          )}
          {splitCircleTargets.length > 0 && (
            <Space wrap size={6} style={{ marginTop: 6 }}>
              <span style={{ fontSize: 12, color: '#666' }}>
                批量内容（{splitCircleTargets.length < textAnnotations.length ? `已选 ${splitCircleTargets.length}` : `本页 ${splitCircleTargets.length}`}）：
              </span>
              <Space.Compact size="small">
                <Button size="small" disabled style={{ color: '#555' }}>寸径</Button>
                <Select
                  mode="tags"
                  size="small"
                  value={batchDiameterText ? [batchDiameterText] : []}
                  options={batchDiameterOptions}
                  onChange={values => setBatchDiameterText(values[values.length - 1] || '')}
                  placeholder={batchDiameterOptions.length ? '选择或自行输入' : '自行输入寸径'}
                  showSearch
                  allowClear
                  maxTagCount={1}
                  style={{ width: 160 }}
                />
              </Space.Compact>
              <Space.Compact size="small">
                <Button size="small" disabled style={{ color: '#555' }}>接头</Button>
                <Select
                  mode="tags"
                  size="small"
                  value={batchJointTypeText ? [batchJointTypeText] : []}
                  options={batchJointTypeOptions}
                  onChange={values => setBatchJointTypeText(values[values.length - 1] || '')}
                  placeholder={batchJointTypeOptions.length ? '选择或自行输入' : '自行输入接头类型'}
                  showSearch
                  allowClear
                  maxTagCount={1}
                  style={{ width: 160 }}
                />
              </Space.Compact>
              <Select
                mode="tags"
                size="small"
                value={batchDiameterRangeValues}
                options={batchDiameterRangeOptions}
                onChange={values => {
                  const normalizedValues = values.map(value => String(value).trim()).filter(Boolean);
                  setBatchDiameterRangeText(normalizedValues.join(','));
                  setSavedBatchDiameterRanges(previous => Array.from(new Set([
                    ...previous,
                    ...normalizedValues
                  ])));
                }}
                placeholder="选择或新增焊口号范围"
                allowClear
                style={{ minWidth: 260 }}
              />
              <Tag color={weldRangeAutoPending ? 'processing' : 'success'}>
                {weldRangeAutoPending ? '停止标注5秒后自动统计范围' : '焊口号范围已统计'}
              </Tag>
              <Button size="small" type="primary" onClick={applyBatchSplitCircleContent}>
                填入寸径
              </Button>
              <Button size="small" type="primary" onClick={applyBatchJointType}>
                填入接头
              </Button>
              <span style={{ fontSize: 11, color: '#999' }}>
                {batchDiameterOptions.length
                  ? '寸径只读取材料表中的管子；默认取多数值，有选中项时只改选中项'
                  : '未读取到管子寸径；默认取当前页多数值，也可自行输入'}；接头类型同样优先作用于选中焊口
              </span>
            </Space>
          )}
        </AnnotationInfoHeader>

        {/* 可滚动的表格容器 */}
        <AnnotationTableContainer>
          {textAnnotations.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#999', padding: '40px 0' }}>
              <InfoCircleOutlined style={{ fontSize: '32px', marginBottom: '12px', display: 'block' }} />
              暂无标注信息
              <br />
              <small>请在PDF上进行标注</small>
            </div>
          ) : (
            <div style={{ flex: '0 0 auto', minHeight: 0 }}>
              <StyledTable
                ref={annotationTableRef}
                dataSource={annotationTableData}
                columns={annotationColumns}
                pagination={false}
                size="small"
                scroll={annotationTableScroll}
                virtual={false}
                onRow={(record) => ({
                  onClick: (event) => {
                    if (!record.annotation) return;

                    if (event.ctrlKey || event.metaKey) {
                      event.preventDefault();
                      event.stopPropagation();
                      const next = new Set(selectedAnnotationIds || []);
                      if (next.has(record.annotation.id)) {
                        next.delete(record.annotation.id);
                      } else {
                        next.add(record.annotation.id);
                      }
                      suppressSelectedEditUntilRef.current = Date.now() + 500;
                      onAnnotationSelectionChange?.(Array.from(next));
                      return;
                    }

                    if (onAnnotationClick) {
                      onAnnotationClick(record.annotation);
                    }
                  },
                  onDoubleClick: () => {
                    // 双击编辑标注
                    if (record.annotation) {
                      handleEditAnnotation(record.annotation);
                    }
                  },
                  style: {
                    cursor: 'pointer'
                  },
                  className: record.annotation && (
                    selectedAnnotationIdSet.has(record.annotation.id) || selectedAnnotation === record.annotation.id
                  )
                    ? 'annotation-row-selected'
                    : ''
                })}
              />
            </div>
          )}
        </AnnotationTableContainer>

      </AnnotationInfoSection>

        </PanelContainer>
      )}
    </>
  );
};

// 🚀 性能优化：使用 React.memo 避免不必要的重新渲染
export default React.memo(AnnotationRulesPanel, (prevProps, nextProps) => {
  // 检查每个属性
  const checks = {
    visible: prevProps.visible === nextProps.visible,
    annotationMode: prevProps.annotationMode === nextProps.annotationMode,
    rules: prevProps.rules === nextProps.rules,
    activeRule: prevProps.activeRule === nextProps.activeRule,
    continuousNumberingEnabled: prevProps.continuousNumberingEnabled === nextProps.continuousNumberingEnabled,
    continuousNumber: prevProps.continuousNumber === nextProps.continuousNumber,
    materialRows: prevProps.materialRows === nextProps.materialRows,
    currentPage: prevProps.currentPage === nextProps.currentPage,
    annotations: !nextProps.visible || prevProps.annotations === nextProps.annotations,
    currentPageAnnotations: !nextProps.visible || (
      prevProps.currentPageAnnotations === nextProps.currentPageAnnotations &&
      prevProps.currentPageAnnotationRevision === nextProps.currentPageAnnotationRevision
    ),
    selectedAnnotationId: prevProps.selectedAnnotation === nextProps.selectedAnnotation,
    selectedAnnotationIds: JSON.stringify(prevProps.selectedAnnotationIds || []) === JSON.stringify(nextProps.selectedAnnotationIds || [])
  };
  
  return Object.values(checks).every(v => v === true);
});
