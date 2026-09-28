/**
 * 内存监控工具
 * 用于检测和警告内存使用情况
 */

class MemoryMonitor {
  constructor() {
    this.isSupported = 'memory' in performance && 'jsHeapSizeLimit' in performance.memory;
    this.warningThreshold = 0.8; // 80%内存使用率触发警告
    this.criticalThreshold = 0.9; // 90%内存使用率触发严重警告
    this.checkInterval = null;
    this.onWarning = null;
    this.onCritical = null;
    this.lastEmergencyCleanupAt = 0;
    this.emergencyCleanupCooldownMs = 60 * 1000;
  }

  /**
   * 获取当前内存使用情况
   */
  getMemoryUsage() {
    if (!this.isSupported) {
      return null;
    }

    const memory = performance.memory;
    return {
      used: memory.usedJSHeapSize,
      total: memory.totalJSHeapSize,
      limit: memory.jsHeapSizeLimit,
      usageRatio: memory.usedJSHeapSize / memory.jsHeapSizeLimit,
      usedMB: (memory.usedJSHeapSize / 1024 / 1024).toFixed(2),
      totalMB: (memory.totalJSHeapSize / 1024 / 1024).toFixed(2),
      limitMB: (memory.jsHeapSizeLimit / 1024 / 1024).toFixed(2)
    };
  }

  /**
   * 检查内存状态
   */
  checkMemory() {
    const usage = this.getMemoryUsage();
    if (!usage) return null;

    const { usageRatio, usedMB, limitMB } = usage;

    if (usageRatio >= this.criticalThreshold) {
      console.error(`🚨 内存严重不足! 已使用 ${usedMB}MB / ${limitMB}MB (${(usageRatio * 100).toFixed(1)}%)`);
      
      // 触发紧急清理
      const now = Date.now();
      if (now - this.lastEmergencyCleanupAt >= this.emergencyCleanupCooldownMs) {
        this.lastEmergencyCleanupAt = now;
        this.performEmergencyCleanup();
      }
      
      this.onCritical?.(usage);
      return 'critical';
    } else if (usageRatio >= this.warningThreshold) {
      console.warn(`⚠️ 内存使用较高: ${usedMB}MB / ${limitMB}MB (${(usageRatio * 100).toFixed(1)}%)`);
      this.onWarning?.(usage);
      return 'warning';
    }

    return 'normal';
  }

  /**
   * 执行紧急内存清理
   */
  performEmergencyCleanup() {
    console.warn('🆘 执行紧急内存清理...');
    
    // 尝试触发垃圾回收（如果浏览器支持）
    if (window.gc) {
      window.gc();
      console.log('♻️ 已触发垃圾回收');
    }
    
    // 清理页面缓存（如果可用）
    try {
      const pageCache = require('./pageDataCache').default;
      if (pageCache) {
        const stats = pageCache.getStats();
        console.log(`📊 清理前: ${stats.cachedPages} 页在缓存中`);
        
        // 立即执行强制清理。该路径会覆盖批量模式的常规30页窗口，
        // 只释放可重建的完整识别数据，长期轻量数据和状态仍保留。
        const cleanedStats = pageCache.emergencyCleanup();
        
        const newStats = cleanedStats || pageCache.getStats();
        console.log(`📊 清理后: ${newStats.cachedPages} 页在缓存中`);
      }
    } catch (e) {
      console.warn('页面缓存清理失败:', e);
    }
  }

  /**
   * 开始定期监控
   */
  startMonitoring(interval = 10000) {
    if (!this.isSupported) {
      console.warn('当前浏览器不支持内存监控API');
      return;
    }

    if (this.checkInterval) {
      this.stopMonitoring();
    }

    console.log('🔍 开始内存监控...');
    window.__luotuMemoryMonitorState = {
      running: true,
      interval,
      startedAt: Date.now(),
      lastStoppedAt: null
    };
    this.checkInterval = setInterval(() => {
      window.__luotuMemoryMonitorState = {
        ...(window.__luotuMemoryMonitorState || {}),
        running: true,
        lastCheckAt: Date.now()
      };
      this.checkMemory();
    }, interval);

    // 立即检查一次
    this.checkMemory();
  }

  /**
   * 停止监控
   */
  stopMonitoring() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      window.__luotuMemoryMonitorState = {
        ...(window.__luotuMemoryMonitorState || {}),
        running: false,
        lastStoppedAt: Date.now()
      };
      console.log('⏸️ 内存监控已停止');
    }
  }

  /**
   * 设置警告回调
   */
  setWarningCallback(callback) {
    this.onWarning = callback;
  }

  /**
   * 设置严重警告回调
   */
  setCriticalCallback(callback) {
    this.onCritical = callback;
  }

  /**
   * 格式化内存信息（用于显示）
   */
  formatMemoryInfo() {
    const usage = this.getMemoryUsage();
    if (!usage) {
      return '内存监控不可用';
    }

    return `内存: ${usage.usedMB}MB / ${usage.limitMB}MB (${(usage.usageRatio * 100).toFixed(1)}%)`;
  }

  /**
   * 记录内存快照
   */
  logSnapshot(label = '') {
    const usage = this.getMemoryUsage();
    if (!usage) return;

    console.log(`📸 内存快照${label ? ' - ' + label : ''}:`, {
      已使用: `${usage.usedMB}MB`,
      总分配: `${usage.totalMB}MB`,
      限制: `${usage.limitMB}MB`,
      使用率: `${(usage.usageRatio * 100).toFixed(1)}%`
    });
  }
}

// 创建单例
const memoryMonitor = new MemoryMonitor();

export default memoryMonitor;

