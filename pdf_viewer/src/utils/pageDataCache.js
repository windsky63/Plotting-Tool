/**
 * 页面数据缓存管理工具
 * 用于大批量识别时的内存优化，只保留当前页前后N页的数据
 */

export class PageDataCache {
  constructor(cacheSize = 20) {
    // 缓存窗口大小（当前页前后各保留N页）
    this.cacheSize = cacheSize;
    
    // 数据存储
    this.dataStore = {}; // {pageNum: data}
    this.statusStore = {}; // {pageNum: status}
    this.lightDataStore = {}; // {pageNum: lightData} - 轻量级数据存储（只保留关键信息）
    
    // 统计信息
    this.totalPages = 0;
    this.recognizedCount = 0;
    
    // 清理计数器
    this.cleanupCounter = 0;
    this.cleanupInterval = 10; // 每识别10页触发一次清理
    
    // 批量识别模式标志
    this.isBatchMode = false;
    this.batchModeStartPage = null;
    this.lastTouchedPage = 1;
  }

  /**
   * 提取轻量级数据（保留完整材料/支架数据用于导出，清理大量的detections坐标）
   * 🚀 优化策略：detections坐标信息占用大量内存，清理后可视化框不显示，但导出功能正常
   */
  _extractLightData(data) {
    if (!data) return null;
    
    return {
      drawingNumber: data.drawingNumber || '',
      pipelineNumber: data.pipelineNumber || '',
      pageNumber: data.pageNumber || '',
      isScaffoldMode: data.isScaffoldMode || false,
      isMaterialMode: data.isMaterialMode || false,
      pageInfo: data.pageInfo || {},
      // 🔑 保留完整的材料和支架数据（用于导出Excel）
      materials: data.materials || [],
      scaffolds: data.scaffolds || data.scaffoldData || [],
      scaffoldData: data.scaffoldData || data.scaffolds || [],
      // ❌ 不保留detections（坐标数据占用大量内存，清理后黄色框不显示但导出正常）
      // detections: 不保留
    };
  }

  /**
   * 设置页面数据
   */
  setPageData(pageNum, data) {
    this.lastTouchedPage = Number(pageNum) || this.lastTouchedPage;
    // 保存完整数据
    this.dataStore[pageNum] = data;
    
    // 同时保存轻量级数据（用于长期访问）
    if (data) {
      this.lightDataStore[pageNum] = this._extractLightData(data);
    }
    
    // 定期触发清理
    this.cleanupCounter++;
    if (this.cleanupCounter >= this.cleanupInterval) {
      this.cleanupCounter = 0;
      // 延迟清理，避免阻塞当前操作
      setTimeout(() => this._performCleanup(pageNum), 100);
    }
  }

  /**
   * 设置页面状态
   */
  setPageStatus(pageNum, status) {
    this.statusStore[pageNum] = status;
    
    if (status === 'completed') {
      this.recognizedCount++;
    }
  }

  /**
   * 获取页面数据
   */
  getPageData(pageNum) {
    // 优先返回完整数据
    if (this.dataStore[pageNum]) {
      return this.dataStore[pageNum];
    }
    
    // 如果完整数据已被清理，返回轻量级数据（至少能显示基本信息）
    if (this.lightDataStore[pageNum]) {
      console.log(`📋 第${pageNum}页: 返回轻量级数据（完整数据已清理）`);
      return {
        ...this.lightDataStore[pageNum],
        _isLightData: true // 标记这是轻量级数据
      };
    }
    
    return null;
  }

  /**
   * 获取页面状态
   */
  getPageStatus(pageNum) {
    return this.statusStore[pageNum] || 'unrecognized';
  }

  /**
   * 获取页面数据和状态
   */
  getPage(pageNum) {
    return {
      data: this.getPageData(pageNum),
      status: this.getPageStatus(pageNum)
    };
  }

  /**
   * 检查页面是否在缓存中
   */
  hasPage(pageNum) {
    return this.dataStore.hasOwnProperty(pageNum);
  }

  /**
   * 启用批量识别模式（更激进的内存管理）
   */
  enableBatchMode(startPage) {
    this.isBatchMode = true;
    this.batchModeStartPage = startPage;
    console.log('🚀 启用批量识别模式: 激进内存管理已启动');
  }

  /**
   * 禁用批量识别模式
   */
  disableBatchMode() {
    this.isBatchMode = false;
    this.batchModeStartPage = null;
    console.log('⏸️ 批量识别模式已关闭');
  }

  /**
   * 执行内存清理（保留当前页前后N页的完整数据）
   */
  _performCleanup(currentPage, forcedCacheSize = null) {
    // 批量识别模式：增大缓存窗口到30页（从5页提升）
    // 保证用户翻页时仍能看到附近页面的完整数据
    const effectiveCacheSize = Number.isFinite(forcedCacheSize)
      ? Math.max(0, Number(forcedCacheSize))
      : (this.isBatchMode ? 30 : this.cacheSize);
    
    const minPage = Math.max(1, currentPage - effectiveCacheSize);
    const maxPage = currentPage + effectiveCacheSize;
    
    const pagesToRemove = [];
    
    // 找出需要清理完整数据的页面
    for (const pageNum in this.dataStore) {
      const page = parseInt(pageNum);
      if (page < minPage || page > maxPage) {
        pagesToRemove.push(pageNum);
      }
    }
    
    if (pagesToRemove.length > 0) {
      const mode = this.isBatchMode ? '[批量模式]' : '';
      console.log(`🧹 ${mode} 清理完整数据: 移除 ${pagesToRemove.length} 页 (保留范围: ${minPage}-${maxPage})`);
      
      // 只移除完整数据，保留轻量级数据和状态
      pagesToRemove.forEach(pageNum => {
        delete this.dataStore[pageNum];
        // 保留 lightDataStore 和 statusStore（占用内存很小）
      });
      
      // 输出统计信息
      if (process.env.NODE_ENV === 'development') {
        console.log(`📊 缓存统计: 完整数据${Object.keys(this.dataStore).length}页, 轻量数据${Object.keys(this.lightDataStore).length}页`);
      }
    }
  }

  /**
   * 手动触发清理
   */
  cleanup(currentPage) {
    this._performCleanup(currentPage);
  }

  /**
   * 内存达到临界值时立即缩小完整数据窗口。
   * 此路径有意忽略批量模式的 30 页窗口；轻量数据和识别状态仍保留。
   */
  emergencyCleanup(currentPage = this.lastTouchedPage) {
    const page = Math.max(1, Number(currentPage) || 1);
    this._performCleanup(page, 2);
    return this.getStats();
  }

  /**
   * 获取所有已识别的页码列表（用于导出）
   */
  getRecognizedPages() {
    return Object.keys(this.statusStore)
      .filter(pageNum => this.statusStore[pageNum] === 'completed')
      .map(pageNum => parseInt(pageNum))
      .sort((a, b) => a - b);
  }

  /**
   * 获取所有已识别页面的数据（用于导出）
   * 注意：如果数据已被清理，返回的数据中会缺失
   */
  getAllRecognizedData() {
    const result = {};
    this.getRecognizedPages().forEach(pageNum => {
      if (this.hasPage(pageNum)) {
        result[pageNum] = {
          data: this.getPageData(pageNum),
          status: this.getPageStatus(pageNum)
        };
      }
    });
    return result;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      totalRecognized: this.recognizedCount,
      cachedPages: Object.keys(this.dataStore).length,
      lightPages: Object.keys(this.lightDataStore).length,
      totalTrackedPages: Object.keys(this.statusStore).length,
      cacheSize: this.cacheSize
    };
  }

  /**
   * 重置缓存
   */
  reset() {
    this.dataStore = {};
    this.statusStore = {};
    this.lightDataStore = {};
    this.recognizedCount = 0;
    this.cleanupCounter = 0;
    this.lastTouchedPage = 1;
    console.log('🔄 页面数据缓存已重置');
  }

  /**
   * 调整缓存大小
   */
  setCacheSize(size) {
    this.cacheSize = Math.max(3, size); // 常规模式最小保留前后各3页
    console.log(`⚙️ 缓存大小已调整为: 前后各${this.cacheSize}页`);
  }
}

// 创建单例
const pageDataCache = new PageDataCache(20); // 默认保留前后20页

export default pageDataCache;

