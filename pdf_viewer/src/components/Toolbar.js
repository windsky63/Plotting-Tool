import React, { useState, useRef, useEffect } from 'react';
import {
  Button,
  Input,
  InputNumber,
  Select,
  Slider,
  Space,
  Tooltip,
  Divider,
  Upload,
  message,
  Popover,
  Dropdown,
  Modal,
  Form,
  Radio
} from 'antd';
import {
  FileAddOutlined,
  SearchOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  LeftOutlined,
  RightOutlined,
  HighlightOutlined,
  EditOutlined,
  BgColorsOutlined,
  UndoOutlined,
  RedoOutlined,
  SaveOutlined,
  PrinterOutlined,
  SettingOutlined,
  FileExcelOutlined,
  FilePdfOutlined,
  ImportOutlined,
  PlusOutlined,
  DeleteOutlined,
  NumberOutlined,
  FileTextOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  ClearOutlined,
  StopOutlined,
  DownloadOutlined,
  CloudUploadOutlined,
  ScissorOutlined,
  FontSizeOutlined,  // UI缩放图标
  ThunderboltOutlined,
  ExperimentOutlined,
  BranchesOutlined
} from '@ant-design/icons';
import styled from 'styled-components';
import SupportAssistant from './SupportAssistant';
import ShortcutHelp from './ShortcutHelp';

const TOOLBAR_LAYOUT_HEIGHT = 56;
const TOOLBAR_CONTROL_HEIGHT = 32;

const ToolbarContainer = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  background: white;
  border-bottom: 1px solid #e8e8e8;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
  min-height: ${TOOLBAR_LAYOUT_HEIGHT}px;
  flex-shrink: 0;
  z-index: 6000;
  --toolbar-control-height: ${TOOLBAR_CONTROL_HEIGHT}px;
  
  .ant-btn {
    font-size: 14px;
    height: var(--toolbar-control-height);
    padding: 4px 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    
    &.ant-btn-sm {
      font-size: 13px;
      height: var(--toolbar-control-height);
    }
  }
  
  .ant-select {
    font-size: 14px;
    height: var(--toolbar-control-height);
    display: inline-flex;
    align-items: center;
    
    .ant-select-selector {
      height: var(--toolbar-control-height) !important;
      min-height: var(--toolbar-control-height) !important;
      box-sizing: border-box;
      align-items: center;
      
      .ant-select-selection-item {
        line-height: ${TOOLBAR_CONTROL_HEIGHT - 2}px;
      }
    }
    
    &.ant-select-sm {
      font-size: 13px;
      
      .ant-select-selector {
        height: var(--toolbar-control-height) !important;
        min-height: var(--toolbar-control-height) !important;
        
        .ant-select-selection-item {
          line-height: ${TOOLBAR_CONTROL_HEIGHT - 2}px;
        }
      }
    }
  }
  
  .ant-input {
    font-size: 14px;
    height: var(--toolbar-control-height);
  }

  .ant-input-number,
  .ant-input-number-affix-wrapper {
    height: var(--toolbar-control-height);
    display: inline-flex;
    align-items: center;
  }

  .ant-input-number-input {
    height: ${TOOLBAR_CONTROL_HEIGHT - 2}px;
  }
  
  .ant-input-search {
    .ant-input {
      font-size: 14px;
    }
  }

  @media (max-width: 1200px) {
    .ant-btn {
      padding: 4px 8px;
    }
  }
`;

const ToolbarTier = styled.div`
  display: flex;
  align-items: stretch;
  min-width: 0;
  border-bottom: ${props => props.$last ? '0' : '1px solid #f0f0f0'};
  background: ${props => props.$secondary ? '#fafafa' : '#fff'};
`;

const ToolbarTierToggle = styled(Button)`
  && {
    width: 92px;
    min-width: 92px;
    height: auto;
    min-height: 44px;
    border: 0;
    border-radius: 0 !important;
    border-right: ${props => props.$right ? '0' : '1px solid #e8e8e8'};
    border-left: ${props => props.$right ? '1px solid #e8e8e8' : '0'};
    margin-left: ${props => props.$right ? 'auto' : '0'};
    background: ${props => props.$secondary ? '#f5f5f5' : '#f0f7ff'};
    color: ${props => props.$secondary ? '#595959' : '#0958d9'};
    font-weight: 600;
    box-shadow: none;
  }
`;

const ToolbarTierContent = styled.div`
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;

  & > * {
    flex: 0 0 auto;
  }

  &::-webkit-scrollbar {
    height: 4px;
  }

  &::-webkit-scrollbar-thumb {
    background: #c9c9c9;
    border-radius: 2px;
  }
`;

const ToolbarSection = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;

  > .ant-btn,
  > .ant-select,
  > .ant-dropdown-trigger {
    align-self: center;
  }
`;

const ZoomControls = styled(ToolbarSection)`
  height: ${TOOLBAR_CONTROL_HEIGHT}px;

  > .ant-btn,
  > .ant-select,
  .ant-select-selector {
    height: ${TOOLBAR_CONTROL_HEIGHT}px !important;
    min-height: ${TOOLBAR_CONTROL_HEIGHT}px !important;
    box-sizing: border-box;
  }
`;

const PageNavigation = styled(ToolbarSection)`
  height: ${TOOLBAR_CONTROL_HEIGHT}px;

  .ant-space-compact,
  button,
  input {
    height: ${TOOLBAR_CONTROL_HEIGHT}px;
  }
`;

const PageInput = styled(Input)`
  width: 60px;
  text-align: center;
`;

const PageTotal = styled(Button)`
  && {
    height: ${TOOLBAR_CONTROL_HEIGHT}px;
    color: #999;
    font-size: 12px;
  }
`;

const ScaleSlider = styled(Slider)`
  width: 120px;
  margin: 0 8px;
`;

const ColorPicker = styled.div`
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: 2px solid #d9d9d9;
  cursor: pointer;
  background: ${props => props.color};
  
  &:hover {
    border-color: #1890ff;
  }
`;

const AnnotationTools = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px;
  background: #fafafa;
  border-radius: 6px;
  
  .ant-select-sm {
    font-size: 13px;
  }
`;



const Toolbar = ({
  currentPage = 1,
  totalPages = 0,
  scale = 1.0,
  onPageChange,
  onScaleChange,
  onFileSelect,

  onSearch,
  onSearchNext,
  onSearchPrev,
  searchText = '',
  searchResults = [],
  currentSearchIndex = -1,
  annotationMode = false,
  onToggleAnnotationMode,
  onTogglePipeSegmentMode,
  pipeSegmentMode,
  pipeSegmentStartLetter,
  onPipeSegmentStartLetterChange,
  pipeSegmentFontSize,
  onPipeSegmentFontSizeChange,
  onResetPipeSegmentCounter,
  // 移除onAnnotationToolChange和currentAnnotationTool
  annotationColor = '#FF0000',
  onAnnotationColorChange,
  annotationFontSize = 14,
  onAnnotationFontSizeChange,
  annotationTopFontSize = 16,
  onAnnotationTopFontSizeChange,
  annotationBottomFontSize = 14,
  onAnnotationBottomFontSizeChange,
  annotationFrameSize = 100,
  onAnnotationFrameSizeChange,
  annotationFrameSizeMode = 'auto-a3',
  onAnnotationFrameSizeModeChange,
  annotationBorderShape = 'rectangle',
  onAnnotationBorderShapeChange,
  annotationPipeTagRotation = 0,
  onAnnotationPipeTagRotationChange,
  annotationPipeTagZeroPadCount = 0,
  onAnnotationPipeTagZeroPadCountChange,
  selectedAnnotationFontTools = null,
  onSelectedAnnotationFontChange,
  onToggleRulesPanel,
  rulesPanelVisible = true,
  onToggleAreaDeleteMode, // 新增回调
  areaDeleteMode, // 新增状态
  areaDeleteType, // 新增：删除类型 'all' | 'text-only'
  onQuickSave,
  onUndo,
  onRedo,
  // OCR服务状态
  ocrServerStatus = { status: 'starting', message: '正在启动OCR服务...', isReady: false },
  mineruServerStatus = { status: 'starting', message: '正在启动MinerU服务...', isReady: false },
  onRestartOCRServer,
  canUndo = false,
  canRedo = false,

  onFileOpen,
  onExportExcel,
  onExportPDF,
  onConfirmWeldAiTrainingSample,
  onExportWeldAiTrainingSample,
  weldAiSampleSubmitting = false,
  weldAiSampleExporting = false,
  onMergeEditablePDF,
  onSplitEditablePDF,
  templateUploaded = false,
  pdfFile = null,
  ocrContext = null,
  // 新增材料编码相关参数
  enableMaterialEncoding = false,
  onToggleMaterialEncoding,
  // 支架模板相关参数
  scaffoldTemplateUploaded = false,
  // 混合模板相关参数
  mixedTemplateUploaded = false,
  onUploadTritium,
  // Web端缩放
  webZoomFactor = 1.0,
  onWebZoomChange,
  canvasPerformanceMode = 'smooth',
  onCanvasPerformanceModeChange,
  weldAdjustmentAvailable = false,
  weldAdjustmentMode = 'idle',
  onWeldAdjustmentAction
}) => {
  const [searchValue, setSearchValue] = useState('');
  const [pageInput, setPageInput] = useState(currentPage?.toString() || '1');
  const [scaleSelectOpen, setScaleSelectOpen] = useState(false);
  const [pipeSegmentSettingsOpen, setPipeSegmentSettingsOpen] = useState(false);
  const [auxiliaryToolsExpanded, setAuxiliaryToolsExpanded] = useState(false);
  const fileInputRef = useRef(null);
  const scaleSelectRef = useRef(null);

  // MinerU 页码选择弹窗状态
  const [mineruPageModalVisible, setMineruPageModalVisible] = useState(false);
  const [pageSelectPurpose, setPageSelectPurpose] = useState('mineru');
  const [mineruPageMode, setMineruPageMode] = useState('all');   // 'all' | 'range' | 'custom'
  const [mineruStartPage, setMineruStartPage] = useState(1);
  const [mineruEndPage, setMineruEndPage] = useState(totalPages || 1);
  const [mineruCustomPages, setMineruCustomPages] = useState('');  // 如 "1,3,5-7"
  const toolbarRef = useRef(null);

  const openMineruPageModal = (purpose = 'mineru') => {
    setPageSelectPurpose(purpose);
    setMineruPageMode('all');
    setMineruStartPage(1);
    setMineruEndPage(totalPages || 1);
    setMineruCustomPages('');
    setMineruPageModalVisible(true);
  };

  const handleMineruConfirm = () => {
    let pages = null;  // null 表示全部页
    if (mineruPageMode === 'range') {
      const start = Math.max(1, mineruStartPage || 1);
      const end   = Math.min(totalPages || 1, mineruEndPage || totalPages || 1);
      if (start > end) {
        message.warning('起始页不能大于结束页');
        return;
      }
      pages = { type: 'range', start, end };
    } else if (mineruPageMode === 'custom') {
      const raw = (mineruCustomPages || '').trim();
      if (!raw) {
        message.warning('请输入页码');
        return;
      }
      // 解析 "1,3,5-7" 格式
      const pageSet = new Set();
      for (const part of raw.split(',')) {
        const seg = part.trim();
        const rangeMatch = seg.match(/^(\d+)\s*-\s*(\d+)$/);
        if (rangeMatch) {
          const s = parseInt(rangeMatch[1], 10);
          const e = parseInt(rangeMatch[2], 10);
          for (let i = s; i <= e; i++) pageSet.add(i);
        } else if (/^\d+$/.test(seg)) {
          pageSet.add(parseInt(seg, 10));
        }
      }
      if (pageSet.size === 0) {
        message.warning('页码格式不正确，请输入如：1,3,5-7');
        return;
      }
      pages = { type: 'custom', pages: [...pageSet].sort((a, b) => a - b) };
    }
    setMineruPageModalVisible(false);
    if (pageSelectPurpose === 'scaffold') {
      window.dispatchEvent(new CustomEvent('scaffold-ocr-action', {
        detail: { action: 'recognizeScaffoldSelectedPages', pageRange: pages }
      }));
      return;
    }

    window.dispatchEvent(new CustomEvent('ocr-action', {
      detail: { action: 'startOCR', engine: 'mineru', pages }
    }));
  };

  const handleResetPipeSegmentCounter = () => {
    onResetPipeSegmentCounter?.();
    setPipeSegmentSettingsOpen(false);
  };

  const scaleOptions = [
    { label: '25%', value: 0.25 },
    { label: '50%', value: 0.5 },
    { label: '75%', value: 0.75 },
    { label: '100%', value: 1.0 },
    { label: '125%', value: 1.25 },
    { label: '150%', value: 1.5 },
    { label: '200%', value: 2.0 },
    { label: '300%', value: 3.0 },
    { label: '适合宽度', value: 'fitWidth' },
    { label: '适合页面', value: 'fitPage' }
  ];

  // 移除不需要的标注工具数组，因为现在只有文字标注
  // const annotationTools = [
  //   { key: 'highlight', label: '高亮', icon: <HighlightOutlined /> },
  //   { key: 'underline', label: '下划线', icon: <EditOutlined /> },
  //   { key: 'strikethrough', label: '删除线', icon: <EditOutlined /> },
  //   { key: 'rectangle', label: '矩形', icon: <BgColorsOutlined /> },
  //   { key: 'circle', label: '圆形', icon: <BgColorsOutlined /> },
  //   { key: 'arrow', label: '箭头', icon: <RightOutlined /> },
  //   { key: 'text', label: '文字', icon: <EditOutlined /> }
  // ];

  const annotationColors = [
    '#FF0000', // 红色 - 默认颜色
    '#0000FF', // 蓝色
    '#FFFF00', // 黄色
    '#FF6B6B', // 浅红色
    '#4ECDC4', // 青色
    '#45B7D1', // 蓝色
    '#96CEB4', // 绿色
    '#FFEAA7', // 浅黄
    '#DDA0DD', // 紫色
    '#98D8C8'  // 薄荷绿
  ];

  const fontSizeOptions = [
    { label: '5px', value: 5 },
    { label: '6px', value: 6 },
    { label: '8px', value: 8 },
    { label: '10px', value: 10 },
    { label: '12px', value: 12 },
    { label: '14px', value: 14 },
    { label: '16px', value: 16 },
    { label: '18px', value: 18 },
    { label: '20px', value: 20 },
    { label: '24px', value: 24 },
    { label: '28px', value: 28 },
    { label: '32px', value: 32 },
    { label: '34px', value: 34 },
    { label: '36px', value: 36 },
    { label: '40px', value: 40 },
    { label: '44px', value: 44 },
    { label: '48px', value: 48 },
    { label: '52px', value: 52 },
    { label: '56px', value: 56 },
    { label: '60px', value: 60 },
    { label: '64px', value: 64 },
    { label: '68px', value: 68 },
    { label: '72px', value: 72 }
  ];

  const borderShapeOptions = [
    { label: '菱形框', value: 'diamond', icon: '◇' },
    { label: '圆形框', value: 'circle', icon: '○' },
    { label: '分栏圆形', value: 'split-circle', icon: '◉' },
    { label: '长方形框', value: 'text-rectangle', icon: '▭' },
    { label: '管段框', value: 'pipe-tag', icon: '▭' },
    { label: '现场焊缝', value: 'field-weld', icon: '◆' },
    { label: '车间焊缝', value: 'shop-weld', icon: '⚪' },
    { label: '无边框', value: 'none', icon: '—' }
  ];

  const handleFileUpload = (info) => {
    if (info.file.status === 'done' || info.file.originFileObj) {
      const file = info.file.originFileObj || info.file;
      if (file.type === 'application/pdf') {
        onFileSelect(file);
      } else {
        message.error('请选择PDF文件');
      }
    }
  };

  const handlePageInputChange = (e) => {
    setPageInput(e.target.value);
  };

  const handlePageInputConfirm = () => {
    const page = parseInt(pageInput);
    if (page >= 1 && page <= totalPages) {
      onPageChange(page);
    } else {
      setPageInput(currentPage?.toString() || '1');
      message.warning(`页码应在 1-${totalPages} 之间`);
    }
  };

  const handleScaleChange = (value) => {
    if (typeof value === 'string') {
      // 处理特殊缩放模式
      onScaleChange(value);
    } else {
      onScaleChange(value);
    }
  };

  const handleSearchChange = (e) => {
    setSearchValue(e.target.value);
  };

  const handleSearchSubmit = () => {
    if (searchValue.trim()) {
      onSearch(searchValue.trim(), []);
    }
  };

  const colorPickerContent = (
    <div style={{ display: 'flex', flexWrap: 'wrap', width: '120px', gap: '4px' }}>
      {annotationColors.map(color => (
        <ColorPicker
          key={color}
          color={color}
          onClick={() => onAnnotationColorChange?.(color)}
          style={{
            border: color === annotationColor ? '2px solid #1890ff' : '2px solid #d9d9d9'
          }}
        />
      ))}
    </div>
  );

  const annotationTools = annotationMode ? (
    <AnnotationTools>
      {annotationBorderShape === 'split-circle' && (
        <>
          <span style={{ fontSize: 12, color: '#666' }}>上</span>
          <Tooltip title="上半字体大小">
            <Select
              value={annotationTopFontSize}
              style={{ width: 70 }}
              onChange={onAnnotationTopFontSizeChange}
              size="small"
              options={fontSizeOptions}
            />
          </Tooltip>
          <span style={{ fontSize: 12, color: '#666' }}>下</span>
          <Tooltip title="下半字体大小">
            <Select
              value={annotationBottomFontSize}
              style={{ width: 70 }}
              onChange={onAnnotationBottomFontSizeChange}
              size="small"
              options={fontSizeOptions}
            />
          </Tooltip>
        </>
      )}
      <Popover content={colorPickerContent} title="选择颜色" trigger="click">
        <Tooltip title="选择颜色">
          <ColorPicker color={annotationColor} />
        </Tooltip>
      </Popover>
      
      {annotationBorderShape !== 'split-circle' && <Tooltip title="字体大小">
        <Select
          value={annotationFontSize}
          style={{ width: 70 }}
          onChange={onAnnotationFontSizeChange}
          size="small"
          options={fontSizeOptions}
          onBlur={() => {
            setTimeout(() => {
              if (document.activeElement && document.activeElement.blur) {
                document.activeElement.blur();
              }
              if (document.body && document.body.focus) {
                document.body.focus();
              }
            }, 0);
          }}
          onOpenChange={(open) => {
            if (!open) {
              setTimeout(() => {
                if (document.activeElement && document.activeElement.blur) {
                  document.activeElement.blur();
                }
                if (document.body && document.body.focus) {
                  document.body.focus();
                }
              }, 10);
            }
          }}
        />
      </Tooltip>}

      <Tooltip title="边框样式">
        <Select
          value={annotationBorderShape}
          style={{ width: 120 }}
          onChange={onAnnotationBorderShapeChange}
          size="small"
          options={borderShapeOptions.map(shape => ({
            label: (
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ fontSize: '12px' }}>{shape.icon}</span>
                <span style={{ fontSize: '11px' }}>{shape.label}</span>
              </span>
            ),
            value: shape.value
          }))}
          onBlur={() => {
            setTimeout(() => {
              if (document.activeElement && document.activeElement.blur) {
                document.activeElement.blur();
              }
              if (document.body && document.body.focus) {
                document.body.focus();
              }
            }, 0);
          }}
          onOpenChange={(open) => {
            if (!open) {
              setTimeout(() => {
                if (document.activeElement && document.activeElement.blur) {
                  document.activeElement.blur();
                }
                if (document.body && document.body.focus) {
                  document.body.focus();
                }
              }, 10);
            }
          }}
        />
      </Tooltip>

      <Tooltip title="框大小模式">
        <Select
          aria-label="框型大小模式"
          className="annotation-frame-size-control"
          value={annotationFrameSizeMode}
          size="small"
          style={{ width: 112 }}
          onChange={onAnnotationFrameSizeModeChange}
          options={[
            { value: 'auto-a3', label: '自动适应A3' },
            { value: 'fixed-px', label: '固定px' }
          ]}
        />
      </Tooltip>
      {annotationFrameSizeMode === 'fixed-px' && (
        <Tooltip title="框尺寸">
          <InputNumber
            aria-label="固定框型大小（px）"
            className="annotation-frame-size-control"
            value={annotationFrameSize}
            min={1}
            max={300}
            step={1}
            precision={1}
            size="small"
            addonAfter="px"
            style={{ width: 108 }}
            onChange={(value) => {
              if (value !== null) onAnnotationFrameSizeChange?.(value);
            }}
          />
        </Tooltip>
      )}

      {annotationBorderShape === 'pipe-tag' && (
        <Tooltip title="管段框数字补零个数">
          <InputNumber
            value={annotationPipeTagZeroPadCount}
            min={0}
            max={8}
            step={1}
            size="small"
            addonBefore="补零"
            style={{ width: 112 }}
            onChange={(value) => onAnnotationPipeTagZeroPadCountChange?.(Number(value) || 0)}
          />
        </Tooltip>
      )}

      {annotationBorderShape === 'pipe-tag' && (
        <Tooltip title="管段框旋转角度">
          <InputNumber
            value={annotationPipeTagRotation}
            min={-180}
            max={180}
            step={5}
            size="small"
            addonAfter="°"
            style={{ width: 92 }}
            onChange={(value) => onAnnotationPipeTagRotationChange?.(Number(value) || 0)}
          />
        </Tooltip>
      )}
    </AnnotationTools>
  ) : null;

  const selectedAnnotationTools = selectedAnnotationFontTools?.visible ? (
    <AnnotationTools style={{ background: '#eef6ff', border: '1px solid #91caff' }}>
      <span style={{ fontSize: 12, color: '#0958d9', whiteSpace: 'nowrap' }}>
        已选{selectedAnnotationFontTools.count || 1}个
      </span>
      {selectedAnnotationFontTools.mixedType ? (
        <span style={{ fontSize: 12, color: '#d46b08', whiteSpace: 'nowrap' }}>
          普通/分栏不能混合改字体
        </span>
      ) : selectedAnnotationFontTools.type === 'split-circle' ? (
        <>
          <span style={{ fontSize: 12, color: '#666' }}>上</span>
          <Tooltip title="批量修改分栏圆形上半字体">
            <Select
              value={selectedAnnotationFontTools.topFontSize}
              placeholder="混合"
              style={{ width: 76 }}
              onChange={(value) => onSelectedAnnotationFontChange?.('topFontSize', value)}
              size="small"
              options={fontSizeOptions}
            />
          </Tooltip>
          <span style={{ fontSize: 12, color: '#666' }}>下</span>
          <Tooltip title="批量修改分栏圆形下半字体">
            <Select
              value={selectedAnnotationFontTools.bottomFontSize}
              placeholder="混合"
              style={{ width: 76 }}
              onChange={(value) => onSelectedAnnotationFontChange?.('bottomFontSize', value)}
              size="small"
              options={fontSizeOptions}
            />
          </Tooltip>
        </>
      ) : (
        <>
          <span style={{ fontSize: 12, color: '#666' }}>字体</span>
          <Tooltip title="批量修改选中标注字体">
            <Select
              value={selectedAnnotationFontTools.fontSize}
              placeholder="混合"
              style={{ width: 76 }}
              onChange={(value) => onSelectedAnnotationFontChange?.('fontSize', value)}
              size="small"
              options={fontSizeOptions}
            />
          </Tooltip>
        </>
      )}
    </AnnotationTools>
  ) : null;

  React.useEffect(() => {
    setPageInput(currentPage?.toString() || '1');
  }, [currentPage]);

  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return undefined;

    const updateToolbarMetrics = () => {
      const actualHeight = Math.max(TOOLBAR_LAYOUT_HEIGHT, Math.ceil(toolbar.offsetHeight || 0));
      const screenBottom = Math.max(actualHeight, Math.ceil(toolbar.getBoundingClientRect().bottom || 0));
      // Reserve the complete, live toolbar height so neither the sidebar nor
      // the PDF workspace can slide underneath expanded or wrapped controls.
      document.documentElement.style.setProperty('--toolbar-height', `${actualHeight}px`);
      document.documentElement.style.setProperty('--toolbar-screen-bottom', `${screenBottom}px`);
    };

    updateToolbarMetrics();
    const animationFrame = window.requestAnimationFrame(updateToolbarMetrics);
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateToolbarMetrics)
      : null;
    resizeObserver?.observe(toolbar);
    window.addEventListener('resize', updateToolbarMetrics);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateToolbarMetrics);
    };
  }, []);

  return (
    <>
    <ToolbarContainer ref={toolbarRef}>
      <ToolbarTier>
        <ToolbarTierContent id="toolbar-common-tools">
      {/* 文件操作 */}
      <ToolbarSection>
        <Tooltip title="打开PDF文件">
          <Button icon={<FileAddOutlined />} onClick={onFileSelect} />
        </Tooltip>
        

      </ToolbarSection>

      {selectedAnnotationTools && (
        <>
          <Divider type="vertical" />
          <ToolbarSection>
            {selectedAnnotationTools}
          </ToolbarSection>
        </>
      )}

      <Divider type="vertical" />

      {/* 页面导航 */}
      <PageNavigation role="group" aria-label="页码导航">
        <Tooltip title="上一页">
          <Button
            aria-label="上一页"
            icon={<LeftOutlined />}
            disabled={currentPage <= 1}
            onClick={() => onPageChange(currentPage - 1)}
            size="small"
          />
        </Tooltip>
        
        <Space.Compact>
          <PageInput
            value={pageInput}
            onChange={handlePageInputChange}
            onPressEnter={handlePageInputConfirm}
            onBlur={handlePageInputConfirm}
            placeholder="页码"
            size="small"
            style={{ width: 60 }}
          />
          <PageTotal disabled aria-label="总页数">
            / {totalPages || 0}
          </PageTotal>
        </Space.Compact>
        
        <Tooltip title="下一页">
          <Button
            aria-label="下一页"
            icon={<RightOutlined />}
            disabled={currentPage >= totalPages}
            onClick={() => onPageChange(currentPage + 1)}
            size="small"
          />
        </Tooltip>
      </PageNavigation>

      <Divider type="vertical" />

      <ToolbarSection>
        <Dropdown
          trigger={['click']}
          disabled={!weldAdjustmentAvailable}
          menu={{
            onClick: ({ key }) => onWeldAdjustmentAction?.(key),
            items: [
              {
                key: 'insert',
                label: weldAdjustmentMode === 'insert' ? '✓ 添加焊点（当前模式）' : '添加焊点'
              },
              {
                key: 'delete',
                label: weldAdjustmentMode === 'delete' ? '✓ 删除焊点（当前模式）' : '删除焊点'
              },
              { type: 'divider' },
              {
                key: 'exit',
                label: '退出焊点调整',
                disabled: weldAdjustmentMode === 'idle'
              }
            ]
          }}
        >
          <Tooltip title={weldAdjustmentAvailable ? '添加或删除焊点，翻页后仍保持当前调整状态' : '请先完成智能编号，或打开带有可编辑焊口标注的 PDF'}>
            <Button
              size="small"
              type={weldAdjustmentMode !== 'idle' ? 'primary' : 'default'}
              danger={weldAdjustmentMode === 'delete'}
              disabled={!weldAdjustmentAvailable}
            >
              {weldAdjustmentMode === 'insert'
                ? '焊点调整（添加）'
                : weldAdjustmentMode === 'delete'
                  ? '焊点调整（删除）'
                  : '焊点调整'}
            </Button>
          </Tooltip>
        </Dropdown>
      </ToolbarSection>

      <Divider type="vertical" />

      {/* 缩放控制 */}
      <ZoomControls role="group" aria-label="PDF缩放">
        <Tooltip title="缩小">
          <Button
            icon={<ZoomOutOutlined />}
            onClick={() => {
              const newScale = Math.max(0.25, scale - 0.25);
              // 移除缩放优化事件触发
              handleScaleChange(newScale);
            }}
            disabled={scale <= 0.25}
            size="small"
          />
        </Tooltip>
        
        <Select
          ref={scaleSelectRef}
          value={scale}
          style={{ width: 90 }}
          size="small"
          onChange={(value) => {
            handleScaleChange(value);
            // 选择后自动关闭下拉菜单
            setScaleSelectOpen(false);
          }}
          options={scaleOptions}
          open={scaleSelectOpen}
          onOpenChange={(open) => {
            setScaleSelectOpen(open);
          }}
          onClick={() => {
            // 点击后自动失焦并显示下拉菜单
            setScaleSelectOpen(true);
            setTimeout(() => {
              if (scaleSelectRef.current) {
                scaleSelectRef.current.blur();
              }
            }, 50);
          }}
          onMouseEnter={() => {
            // 鼠标悬停时自动打开下拉菜单
            setScaleSelectOpen(true);
          }}
          onMouseLeave={(e) => {
            // 检查鼠标是否移动到下拉菜单区域
            const dropdown = document.querySelector('.ant-select-dropdown');
            if (dropdown && e.relatedTarget && e.relatedTarget instanceof Node && dropdown.contains(e.relatedTarget)) {
              return; // 如果鼠标移动到下拉菜单，不关闭
            }
            // 延迟关闭，给用户时间移动到下拉菜单
            setTimeout(() => {
              const dropdown = document.querySelector('.ant-select-dropdown');
              if (!dropdown || !dropdown.matches(':hover')) {
                setScaleSelectOpen(false);
              }
            }, 100);
          }}
          styles={{
             popup: {
               root: { zIndex: 6001 } // 确保下拉菜单在最上层
             }
           }}
        />
        
        <Tooltip title="放大">
          <Button
            icon={<ZoomInOutlined />}
            onClick={() => {
              const newScale = Math.min(3.0, scale + 0.25);
              // 移除缩放优化事件触发
              handleScaleChange(newScale);
            }}
            disabled={scale >= 3.0}
            size="small"
          />
        </Tooltip>

      </ZoomControls>

      <Divider type="vertical" />


      {/* 标注工具 - 简化版 */}
      <ToolbarSection>
        <Tooltip title={annotationMode ? '退出标注模式' : '进入标注模式'}>
          <Button
            type={annotationMode ? 'primary' : 'default'}
            icon={<EditOutlined />}
            onClick={onToggleAnnotationMode}
          >
            标注模式
          </Button>
        </Tooltip>


        <Tooltip title={pipeSegmentMode ? '退出管段号模式' : '进入管段号模式'}>
          <Button
            type={pipeSegmentMode ? 'primary' : 'default'}
            icon={<NumberOutlined />}
            onClick={onTogglePipeSegmentMode}
            style={{ 
              backgroundColor: pipeSegmentMode ? '#722ed1' : undefined,
              borderColor: pipeSegmentMode ? '#722ed1' : undefined
            }}
          >
            管段号
          </Button>
        </Tooltip>

        <Popover
          content={
            <div style={{ width: 280, padding: '8px 0' }}>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>起始序号:</label>
                <Input
                  value={pipeSegmentStartLetter}
                  style={{ width: '100%' }}
                  onChange={(e) => onPipeSegmentStartLetterChange(e.target.value)}
                  placeholder="输入起始序号，如：A、1、P1等"
                  maxLength={10}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>字体大小:</label>
                <Select
                  value={pipeSegmentFontSize}
                  style={{ width: '100%' }}
                  onChange={onPipeSegmentFontSizeChange}
                  options={[
                    { label: '10px', value: 10 },
                    { label: '12px', value: 12 },
                    { label: '14px', value: 14 },
                    { label: '16px', value: 16 },
                    { label: '18px', value: 18 },
                    { label: '20px', value: 20 },
                    { label: '24px', value: 24 },
                    { label: '28px', value: 28 },
                    { label: '32px', value: 32 }
                  ]}
                />
              </div>
            </div>
          }
          title="管段号设置"
          trigger="click"
          placement="bottomLeft"
          open={pipeSegmentSettingsOpen}
          onOpenChange={setPipeSegmentSettingsOpen}
        >
          <Tooltip title="管段号设置">
            <Button icon={<SettingOutlined />} />
          </Tooltip>
        </Popover>

        <Tooltip title="重置管段号计数器">
          <Button
            icon={<ReloadOutlined />}
            onClick={handleResetPipeSegmentCounter}
          >
            重置计数器
          </Button>
        </Tooltip>

        <Dropdown 
          menu={{ 
            items: [
              {
                key: 'all',
                label: '删除区域内所有标注',
                icon: <DeleteOutlined />,
                onClick: () => onToggleAreaDeleteMode('all')
              },
              {
                key: 'text-only',
                label: '仅清除区域内焊口号',
                icon: <ClearOutlined />,
                onClick: () => onToggleAreaDeleteMode('text-only')
              }
            ],
            selectedKeys: [areaDeleteType || 'all']
          }}
          placement="bottom"
          arrow
        >
            <Button
              type={areaDeleteMode ? 'primary' : 'default'}
              danger={areaDeleteMode && areaDeleteType !== 'text-only'}
              icon={<ScissorOutlined />}
              onClick={() => onToggleAreaDeleteMode()}
              style={areaDeleteMode && areaDeleteType === 'text-only' ? { backgroundColor: '#fa8c16', borderColor: '#fa8c16', color: 'white' } : {}}
            >
              {areaDeleteType === 'text-only' ? '区域清除' : '区域删除'}
            </Button>
        </Dropdown>

         {/* 材料编码开关 */}
         <Tooltip title={enableMaterialEncoding ? "已启用材料编码：OCR识别完成后将自动调用材料编码API。如果编码服务不可用，将只导出基础识别结果。" : "材料编码已禁用：仅进行OCR识别"}>
           <Button
             hidden
             type={enableMaterialEncoding ? "primary" : "default"}
             icon={<ImportOutlined />}
             onClick={onToggleMaterialEncoding}
             style={{ 
               display: 'none',
               marginRight: 4,
               backgroundColor: enableMaterialEncoding ? '#722ed1' : undefined,
               borderColor: enableMaterialEncoding ? '#722ed1' : undefined,
               color: enableMaterialEncoding ? 'white' : undefined
             }}
           >
             {enableMaterialEncoding ? '编码已启用' : '启用编码'}
           </Button>
         </Tooltip>

         {/* API探测按钮 */}
         <Tooltip title="探测材料编码API的可用接口">
           <Button
             hidden
             icon={<ReloadOutlined />}
             onClick={async () => {
               try {
                 console.log('🔍 开始探测API接口...');
                 message.loading({ content: '正在探测API接口...', key: 'probeApi' });
                 
                 const { ocrService } = await import('../services/ocrService');
                 const result = await ocrService.probeExternalAPI();
                 
                 message.destroy('probeApi');
                 
                 if (result.accessible) {
                   let statusMessage = '';
                   
                   if (result.corsIssue) {
                     statusMessage = `⚠️ 检测到CORS限制（这是正常的）`;
                     statusMessage += `\n🌐 外部API服务器存在但有跨域限制`;
                   } else {
                     statusMessage = `✅ API服务器完全可访问 (${result.rootStatus})`;
                   }
                   
                   if (result.apiTest) {
                     if (result.apiTest.success) {
                       statusMessage += `\n🎯 批量编码接口测试成功！`;
                       statusMessage += `\n📝 测试任务ID: ${result.apiTest.taskId}`;
                     } else {
                       if (result.corsIssue) {
                         statusMessage += `\n❌ CORS限制阻止了API调用`;
                         statusMessage += `\n💡 这需要服务器端配置CORS头部`;
                         statusMessage += `\n❌ 编码功能将不可用`;
                         message.warning({
                           content: statusMessage,
                           duration: 15
                         });
                       } else {
                         statusMessage += `\n⚠️ 批量编码接口异常: ${result.apiTest.error || result.apiTest.status}`;
                       }
                     }
                   }
                   
                   if (result.endpoints.length > 0) {
                     console.log('🎯 发现的接口:', result.endpoints);
                   }
                   console.log('📊 完整API探测结果:', result);
                 } else {
                   message.error({
                     content: `❌ API服务器不可访问: ${result.error}`,
                     duration: 8
                   });
                 }
               } catch (error) {
                 console.error('探测API时出错:', error);
               }
             }}
             style={{ display: 'none', marginRight: 8 }}
           >
             探测API
           </Button>
         </Tooltip>

        {/* 全局高亮标注按钮 */}
        <Tooltip title="为所有页面中手动高亮选中的框添加标注（统一使用连续的V编号）">
          <Button
            icon={<HighlightOutlined />}
            onClick={() => {
              console.log('🔘 [Toolbar] 点击全局阀门标注按钮');
              if (typeof window !== 'undefined') {
                const event = new CustomEvent('ocr-global-annotation', { 
                  detail: { action: 'annotateHighlighted' } 
                });
                console.log('📡 [Toolbar] 派发事件:', event);
                window.dispatchEvent(event);
              }
            }}
            style={{ 
              marginLeft: 8,
              backgroundColor: '#faad14',
              borderColor: '#faad14',
              color: 'white'
            }}
          >
            全局阀门标注
          </Button>
        </Tooltip>

        {/* 全局支架标注按钮 */}
        <Tooltip title="为所有已识别页面的支架批量添加标注（按图纸页码分组编号，页码重新开始时编号从S1重新计数）">
          <Button
            icon={<PlusOutlined />}
            onClick={() => {
              if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('global-batch-annotation', { 
                  detail: { action: 'batchAddAllScaffoldAnnotations' } 
                }));
              }
            }}
            style={{ 
              marginLeft: 8,
              backgroundColor: '#52c41a',
              borderColor: '#52c41a',
              color: 'white'
            }}
          >
            全局支架标注
          </Button>
        </Tooltip>

      </ToolbarSection>

      <Divider type="vertical" />

      {/* 其他操作 */}
      <ToolbarSection>
        <Tooltip title="导出焊口表">
          <Button 
            icon={<FileExcelOutlined />} 
            onClick={onExportExcel}
            style={{ marginRight: 8, backgroundColor: '#52c41a', color: 'white' }}
            size="middle"
          >
            导出焊口表
          </Button>
        </Tooltip>
        
        {/* 保持原有两种PDF生成逻辑，只允许在不需要标注版时跳过高内存阶段。 */}
        <Dropdown
          trigger={['click']}
          placement="bottom"
          menu={{
            items: [
              {
                key: 'editable',
                label: '仅导出可编辑版',
                onClick: () => onExportPDF?.('editable')
              },
              {
                key: 'both',
                label: '导出可编辑版与标注版',
                onClick: () => onExportPDF?.('both')
              }
            ]
          }}
        >
          <Tooltip title="选择PDF导出内容">
            <Button
              icon={<FilePdfOutlined />}
              style={{ marginRight: 8, backgroundColor: '#f5222d', color: 'white' }}
              size="middle"
            >
              导出PDF
            </Button>
          </Tooltip>
        </Dropdown>

        
        <Tooltip title="保存到原文件 (Ctrl+S)">
          <Button icon={<SaveOutlined />} onClick={onQuickSave} style={{ backgroundColor: '#FFEB3B', borderColor: '#FFC107' }} />
        </Tooltip>

          <Tooltip title="标注完成：上传数据到氚云">
            <Button 
              icon={<CloudUploadOutlined />} 
              onClick={onUploadTritium}
              style={{ backgroundColor: '#1890ff', color: 'white', marginLeft: 8 }}
            >
              上传氚云
            </Button>
          </Tooltip>
        
        {/* 撤销重做按钮 */}
        <Tooltip title="撤销">
          <Button
            icon={<UndoOutlined />}
            onClick={onUndo}
            disabled={!canUndo}
          />
        </Tooltip>
        
        <Tooltip title="重做">
          <Button
            icon={<RedoOutlined />}
            onClick={onRedo}
            disabled={!canRedo}
          />
        </Tooltip>
        
        {annotationTools}
        <ShortcutHelp variant="toolbar" />
      </ToolbarSection>
          </ToolbarTierContent>
        <ToolbarTierToggle
          type="text"
          $secondary
          $right
          aria-expanded={auxiliaryToolsExpanded}
          aria-controls="toolbar-auxiliary-tools"
          onClick={() => setAuxiliaryToolsExpanded(expanded => !expanded)}
          icon={<RightOutlined style={{ transform: auxiliaryToolsExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }} />}
        >
          辅助工具
        </ToolbarTierToggle>
      </ToolbarTier>

      {auxiliaryToolsExpanded && (
        <ToolbarTier $secondary $last>
          <ToolbarTierContent id="toolbar-auxiliary-tools">
            <ToolbarSection>
              <Tooltip title="对照 Ep3d 标注 PDF，将匹配到的焊口落到当前设计院 PDF">
                <Button
                  icon={<BranchesOutlined />}
                  onClick={() => {
                    if (typeof window !== 'undefined') {
                      window.dispatchEvent(new CustomEvent('compare-layout-open'));
                    }
                  }}
                >
                  对照落图
                </Button>
              </Tooltip>

              <Dropdown
                menu={{
                  items: [
                    { key: 'draw', label: '绘制材料表区域' },
                    { key: 'split', label: '材料表分割线' },
                    { key: 'pipelineArea', label: '管线号区域' },
                    { key: 'pipeClassArea', label: '管道等级区域' },
                    { key: 'drawingNumberArea', label: '图号区域' },
                    { key: 'pageNumberArea', label: '页码区域' },
                    { key: 'scaffoldArea', label: '支架区域' },
                    { key: 'weldRecognitionArea', label: '焊点区域' },
                    { key: 'saveTemplate', label: '导出识别模板' },
                    { key: 'clear', label: '清空绘制区域' }
                  ],
                  onClick: ({ key }) => {
                    const actionByKey = {
                      draw: 'startRegion',
                      split: 'splitLine',
                      pipelineArea: 'setPipelineArea',
                      pipeClassArea: 'setPipeClassArea',
                      drawingNumberArea: 'setDrawingNumberArea',
                      pageNumberArea: 'setPageNumberArea',
                      scaffoldArea: 'setScaffoldArea',
                      weldRecognitionArea: 'setWeldRecognitionArea',
                      saveTemplate: 'saveTemplate',
                      clear: 'clear'
                    };
                    const action = actionByKey[key];
                    if (action && typeof window !== 'undefined') {
                      window.dispatchEvent(new CustomEvent('ocr-action', { detail: { action } }));
                    }
                  }
                }}
                placement="bottomLeft"
              >
                <Button>模板设置</Button>
              </Dropdown>

              <Tooltip title="导入识别模板">
                <Button
                  icon={<ImportOutlined />}
                  onClick={() => document.getElementById('import-template-input')?.click()}
                >
                  导入识别模板
                </Button>
              </Tooltip>
              <input
                id="import-template-input"
                type="file"
                accept=".json"
                style={{ display: 'none' }}
                onChange={(event) => {
                  const file = event.target.files[0];
                  if (file) {
                    const reader = new FileReader();
                    reader.onload = (loadEvent) => {
                      try {
                        const template = JSON.parse(loadEvent.target.result);
                        if (typeof window !== 'undefined') {
                          window.dispatchEvent(new CustomEvent('ocr-action', {
                            detail: { action: 'importTemplate', template }
                          }));
                        }
                      } catch (error) {
                        message.error('模板文件格式错误');
                      }
                    };
                    reader.readAsText(file);
                  }
                  event.target.value = '';
                }}
              />

              <Space.Compact>
                <Tooltip title={!pdfFile ? '请先选择PDF文件' : !templateUploaded ? '请先导入识别模板' : '选择识别引擎开始识别'}>
                  <Dropdown
                    disabled={!pdfFile || !templateUploaded}
                    trigger={['click']}
                    menu={{
                      items: [
                        {
                          key: 'paddleocr',
                          label: 'PaddleOCR 识别',
                          icon: <ThunderboltOutlined />,
                          onClick: () => {
                            if (typeof window !== 'undefined') {
                              window.dispatchEvent(new CustomEvent('ocr-action', {
                                detail: { action: 'startOCR', engine: 'paddleocr' }
                              }));
                            }
                          }
                        },
                        {
                          key: 'mineru',
                          label: 'MinerU 识别',
                          icon: <ExperimentOutlined />,
                          onClick: () => openMineruPageModal()
                        }
                      ]
                    }}
                  >
                    <Button
                      type="primary"
                      icon={<FileTextOutlined />}
                      disabled={!pdfFile || !templateUploaded}
                      style={{
                        backgroundColor: (pdfFile && templateUploaded) ? '#52c41a' : undefined,
                        borderColor: (pdfFile && templateUploaded) ? '#52c41a' : undefined
                      }}
                    >
                      开始识别 ▾
                    </Button>
                  </Dropdown>
                </Tooltip>

                <Tooltip title={
                  !pdfFile ? '请先选择PDF文件' :
                  !templateUploaded ? '请先导入识别模板' :
                  mixedTemplateUploaded ? '阀门识别：同时识别材料表和支架信息（混合模板）' :
                  scaffoldTemplateUploaded ? '支架识别：识别PDF中的支架编号和位置信息' :
                  '材料表识别：识别PDF中的材料清单表格'
                }>
                  <Dropdown
                    menu={{
                      items: [
                        {
                          key: 'single',
                          label: '单页识别',
                          icon: <FileTextOutlined />,
                          onClick: () => window.dispatchEvent(new CustomEvent('visual-ocr-action', {
                            detail: { action: 'recognizeSinglePage' }
                          }))
                        },
                        {
                          key: 'all',
                          label: '全部识别',
                          icon: <FileAddOutlined />,
                          onClick: () => window.dispatchEvent(new CustomEvent('visual-ocr-action', {
                            detail: { action: 'recognizeAll' }
                          }))
                        },
                        {
                          key: 'selectedPages',
                          label: '选页识别',
                          icon: <FileTextOutlined />,
                          disabled: !scaffoldTemplateUploaded,
                          onClick: () => openMineruPageModal('scaffold')
                        },
                        {
                          key: 'stop',
                          label: '停止识别',
                          icon: <StopOutlined />,
                          disabled: !ocrContext?.currentOcrProcess || !ocrContext?.currentOcrProcess?.websocket,
                          onClick: () => window.dispatchEvent(new CustomEvent('visual-ocr-action', {
                            detail: { action: 'stopRecognize' }
                          }))
                        },
                        {
                          key: 'export',
                          label: '导出识别结果',
                          icon: <DownloadOutlined />,
                          onClick: () => window.dispatchEvent(new CustomEvent('visual-ocr-action', {
                            detail: { action: 'exportRecognition' }
                          }))
                        }
                      ]
                    }}
                    disabled={!pdfFile || !templateUploaded}
                    trigger={['click', 'hover']}
                  >
                    <Button
                      type="primary"
                      disabled={!pdfFile || !templateUploaded}
                      style={{
                        backgroundColor: (pdfFile && templateUploaded)
                          ? (mixedTemplateUploaded ? '#eb2f96' : scaffoldTemplateUploaded ? '#722ed1' : '#1890ff')
                          : undefined,
                        borderColor: (pdfFile && templateUploaded)
                          ? (mixedTemplateUploaded ? '#eb2f96' : scaffoldTemplateUploaded ? '#722ed1' : '#1890ff')
                          : undefined,
                        borderLeft: 'none',
                        color: 'white'
                      }}
                    >
                      {mixedTemplateUploaded ? '阀门识别' : scaffoldTemplateUploaded ? '支架识别' : '材料表识别'}
                    </Button>
                  </Dropdown>
                </Tooltip>
              </Space.Compact>
            </ToolbarSection>

            <Divider type="vertical" />

            <ToolbarSection>
              <Tooltip title="限制PDF Canvas像素与内存；默认流畅档将单页限制在150万像素以内">
                <Select
                  aria-label="Canvas性能档位"
                  value={canvasPerformanceMode}
                  size="small"
                  style={{ width: 158, height: TOOLBAR_CONTROL_HEIGHT }}
                  onChange={onCanvasPerformanceModeChange}
                  options={[
                    { value: 'smooth', label: '性能：流畅' },
                    { value: 'balanced', label: '性能：均衡' },
                    { value: 'quality', label: '性能：高清' }
                  ]}
                />
              </Tooltip>
            </ToolbarSection>

            <Divider type="vertical" />

            <ToolbarSection>
              <Tooltip title="确认引线连接管道的一端，并提交到远端焊点AI训练样本库">
                <Button
                  icon={<CloudUploadOutlined />}
                  onClick={onConfirmWeldAiTrainingSample}
                  loading={weldAiSampleSubmitting}
                  disabled={!pdfFile || weldAiSampleSubmitting}
                >
                  确认训练样本
                </Button>
              </Tooltip>
              <Tooltip title="导出引线管道端点训练包；audit目录包含最多20页可视化抽查图">
                <Button
                  icon={<DownloadOutlined />}
                  onClick={onExportWeldAiTrainingSample}
                  loading={weldAiSampleExporting}
                  disabled={!pdfFile || weldAiSampleSubmitting || weldAiSampleExporting}
                >
                  导出训练包
                </Button>
              </Tooltip>
            </ToolbarSection>

            <Divider type="vertical" />

            <ToolbarSection>
              <Dropdown
                menu={{
                  items: [
                    {
                      key: 'merge',
                      label: '合并可编辑版',
                      icon: <ImportOutlined />,
                      onClick: onMergeEditablePDF
                    },
                    {
                      key: 'split',
                      label: '拆分可编辑版',
                      icon: <ImportOutlined />,
                      onClick: onSplitEditablePDF
                    }
                  ]
                }}
                placement="bottom"
              >
                <Button icon={<ImportOutlined />}>合并/拆分PDF</Button>
              </Dropdown>
              <Tooltip title={ocrServerStatus.message}>
                <Button
                  icon={ocrServerStatus.status === 'ready'
                    ? <InfoCircleOutlined style={{ color: '#52c41a' }} />
                    : ocrServerStatus.status === 'error'
                      ? <InfoCircleOutlined style={{ color: '#f5222d' }} />
                      : <ReloadOutlined style={{ color: '#1890ff' }} spin />}
                  onClick={onRestartOCRServer}
                  size="small"
                >
                  OCR服务
                </Button>
              </Tooltip>
              <Tooltip title={mineruServerStatus.message}>
                <Button
                  icon={mineruServerStatus.status === 'ready'
                    ? <InfoCircleOutlined style={{ color: '#52c41a' }} />
                    : mineruServerStatus.status === 'error'
                      ? <InfoCircleOutlined style={{ color: '#f5222d' }} />
                      : <ReloadOutlined style={{ color: '#722ed1' }} spin />}
                  size="small"
                >
                  MinerU
                </Button>
              </Tooltip>
            </ToolbarSection>

            <Divider type="vertical" />

            <ToolbarSection>
              <Tooltip title="界面缩放（适配不同分辨率屏幕）">
                <Dropdown
                  menu={{
                    items: [
                      { key: '0.7', label: '70% - 小屏幕' },
                      { key: '0.8', label: '80%' },
                      { key: '0.85', label: '85%' },
                      { key: '0.9', label: '90%' },
                      { key: '1.0', label: '100% - 默认' },
                      { key: '1.1', label: '110%' },
                      { key: '1.2', label: '120%' },
                      { type: 'divider' },
                      { key: 'auto', label: '🔄 自动适配' }
                    ],
                    onClick: async ({ key }) => {
                      if (window.electronAPI && window.electronAPI.setZoomFactor) {
                        const result = key === 'auto'
                          ? await window.electronAPI.resetZoomFactor()
                          : await window.electronAPI.setZoomFactor(parseFloat(key));
                        if (result?.success) {
                          message.success(`${key === 'auto' ? '已自动适配' : '界面缩放已设置为'}: ${Math.round(result.zoomFactor * 100)}%`);
                        }
                      } else if (onWebZoomChange) {
                        onWebZoomChange(key === 'auto' ? 1.0 : parseFloat(key));
                      } else {
                        message.warning('缩放功能不可用');
                      }
                    }
                  }}
                  trigger={['click']}
                >
                  <Button icon={<FontSizeOutlined />}>界面缩放</Button>
                </Dropdown>
              </Tooltip>
              <Tooltip title={rulesPanelVisible ? '隐藏规则面板' : '显示规则面板'}>
                <Button
                  icon={<SettingOutlined />}
                  onClick={onToggleRulesPanel}
                  type={rulesPanelVisible ? 'primary' : 'default'}
                >
                  规则面板
                </Button>
              </Tooltip>
              <SupportAssistant variant="toolbar" />
            </ToolbarSection>
          </ToolbarTierContent>
        </ToolbarTier>
      )}
    </ToolbarContainer>

    {/* MinerU 页码选择弹窗 */}
    <Modal
      title={<span><ExperimentOutlined style={{ color: '#722ed1', marginRight: 8 }} />MinerU 识别 — 选择页码</span>}
      open={mineruPageModalVisible}
      onOk={handleMineruConfirm}
      onCancel={() => setMineruPageModalVisible(false)}
      okText="开始识别"
      cancelText="取消"
      width={420}
      okButtonProps={{ type: 'primary', style: { backgroundColor: '#722ed1', borderColor: '#722ed1' } }}
    >
      <div style={{ padding: '8px 0' }}>
        <div style={{ marginBottom: 12, color: '#666', fontSize: 13 }}>
          当前 PDF 共 <strong>{totalPages}</strong> 页，请选择识别范围：
        </div>
        <Radio.Group
          value={mineruPageMode}
          onChange={e => setMineruPageMode(e.target.value)}
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          <Radio value="all">
            <span style={{ fontWeight: 500 }}>全部页面</span>
            <span style={{ color: '#999', marginLeft: 8, fontSize: 12 }}>识别第 1 — {totalPages} 页</span>
          </Radio>

          <Radio value="range">
            <span style={{ fontWeight: 500 }}>连续页码范围</span>
          </Radio>
          {mineruPageMode === 'range' && (
            <div style={{ marginLeft: 24, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13 }}>第</span>
              <InputNumber
                min={1}
                max={totalPages || 1}
                value={mineruStartPage}
                onChange={v => setMineruStartPage(v)}
                style={{ width: 70 }}
                size="small"
              />
              <span style={{ fontSize: 13 }}>页 至 第</span>
              <InputNumber
                min={1}
                max={totalPages || 1}
                value={mineruEndPage}
                onChange={v => setMineruEndPage(v)}
                style={{ width: 70 }}
                size="small"
              />
              <span style={{ fontSize: 13 }}>页</span>
            </div>
          )}

          <Radio value="custom">
            <span style={{ fontWeight: 500 }}>自定义页码</span>
          </Radio>
          {mineruPageMode === 'custom' && (
            <div style={{ marginLeft: 24 }}>
              <Input
                placeholder="例如：1,3,5-7,10"
                value={mineruCustomPages}
                onChange={e => setMineruCustomPages(e.target.value)}
                size="small"
                style={{ width: 220 }}
              />
              <div style={{ color: '#999', fontSize: 12, marginTop: 4 }}>
                用逗号分隔页码，用连字符表示范围
              </div>
            </div>
          )}
        </Radio.Group>
      </div>
    </Modal>
    </>
  );
};

export default Toolbar;
