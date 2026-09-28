/**
 * 书签日志记录工具
 * 用于记录材料表识别和焊点批量编号时处理的页面及其对应的书签信息
 */

import { message } from 'antd';
import { DEFAULT_OCR_SERVER_HOST, buildOcrServerUrl } from '../config/ocrServer';

class BookmarkLogger {
  constructor() {
    this.logs = []; // 本地日志缓存
    this.currentSession = null; // 当前会话信息
  }

  /**
   * 开始新的处理会话
   * @param {string} pdfName - PDF文件名
   * @param {string} operationType - 操作类型：'material_ocr' 或 'weld_numbering'
   * @param {Array} bookmarks - PDF书签列表
   */
  async startSession(pdfName, operationType, bookmarks = []) {
    const userName = await this.getUserName();
    const operationNames = {
      material_ocr: '材料表识别',
      weld_numbering: '焊点批量编号',
      automatic_layout: '自动落图'
    };
    
    this.currentSession = {
      sessionId: this.generateSessionId(),
      pdfName,
      operationType,
      operationName: operationNames[operationType] || operationType,
      startTime: new Date().toISOString(),
      bookmarks,
      processedPages: [],
      totalPages: 0,
      userName,
      clientInfo: this.getClientInfo()
    };

    console.log('📝 开始新的处理会话:', this.currentSession.sessionId);
    return this.currentSession.sessionId;
  }

  /**
   * 记录处理的页面
   * @param {number} pageNum - 页码
   * @param {Object} pageData - 页面数据（材料表数据或焊点数据）
   * @param {string} status - 处理状态：'success', 'error', 'skipped'
   */
  logPage(pageNum, pageData = {}, status = 'success') {
    if (!this.currentSession) {
      console.warn('⚠️ 没有活跃的处理会话');
      return;
    }

    // 查找页面对应的书签
    const bookmark = this.findBookmarkForPage(pageNum, this.currentSession.bookmarks);

    const pageLog = {
      pageNum,
      bookmark: bookmark ? {
        title: bookmark.title,
        level: bookmark.level
      } : null,
      status,
      timestamp: new Date().toISOString(),
      dataCount: this.getDataCount(pageData, this.currentSession.operationType),
      details: this.currentSession.operationType === 'automatic_layout'
        ? this.buildAutomaticLayoutPageDetails(pageData)
        : this.currentSession.operationType === 'weld_numbering'
          ? this.buildWeldNumberingPageDetails(pageData)
          : null
    };

    this.currentSession.processedPages.push(pageLog);
    this.currentSession.totalPages = this.currentSession.processedPages.length;

    console.log(`📄 记录第${pageNum}页: ${bookmark?.title || '无书签'} - ${status}`);
  }

  /**
   * 结束当前会话并生成统计报告
   * @returns {Object} 会话统计信息
   */
  async endSession() {
    console.log('💾 endSession 被调用, currentSession:', !!this.currentSession);
    
    if (!this.currentSession) {
      console.warn('⚠️ 没有活跃的处理会话');
      return null;
    }

    console.log('📊 当前会话信息:', {
      sessionId: this.currentSession.sessionId,
      pdfName: this.currentSession.pdfName,
      operationType: this.currentSession.operationType,
      processedPages: this.currentSession.processedPages.length
    });

    this.currentSession.endTime = new Date().toISOString();
    this.currentSession.duration = this.calculateDuration(
      this.currentSession.startTime,
      this.currentSession.endTime
    );

    // 生成统计信息
    console.log('📈 生成统计信息...');
    const stats = this.generateStats(this.currentSession);
    console.log('📈 统计信息:', stats);

    // 保存到本地日志
    this.logs.push(this.currentSession);

    // 保存到文件
    console.log('💾 开始保存到文件...');
    await this.saveToFile(this.currentSession, stats);
    console.log('💾 文件保存完成');

    console.log('✅ 会话结束，已生成统计报告');

    const session = this.currentSession;
    this.currentSession = null;

    return { session, stats };
  }

  /**
   * 查找页面对应的书签
   */
  findBookmarkForPage(pageNum, bookmarks) {
    if (!bookmarks || bookmarks.length === 0) {
      return null;
    }

    let bestMatch = null;

    const searchBookmarks = (bookmarkList) => {
      for (let i = 0; i < bookmarkList.length; i++) {
        const bookmark = bookmarkList[i];

        // 精确匹配
        if (bookmark.page === pageNum) {
          bestMatch = bookmark;
          return true;
        }

        // 如果当前页在两个书签之间，选择前一个书签
        if (i < bookmarkList.length - 1) {
          const nextBookmark = bookmarkList[i + 1];
          if (bookmark.page <= pageNum && nextBookmark.page > pageNum) {
            bestMatch = bookmark;
          }
        } else if (bookmark.page <= pageNum) {
          // 最后一个书签，且页码小于等于当前页
          bestMatch = bookmark;
        }

        // 递归搜索子书签
        if (bookmark.children && bookmark.children.length > 0) {
          if (searchBookmarks(bookmark.children)) {
            return true;
          }
        }
      }
      return false;
    };

    searchBookmarks(bookmarks);
    return bestMatch;
  }

  /**
   * 获取数据数量
   */
  getDataCount(pageData, operationType) {
    if (operationType === 'material_ocr') {
      // 材料表识别：统计材料行数
      return pageData?.material?.length || 0;
    } else if (operationType === 'weld_numbering') {
      // 焊点编号：统计焊点数量
      return pageData?.welds?.length || 0;
    } else if (operationType === 'automatic_layout') {
      return pageData?.annotations?.length || 0;
    }
    return 0;
  }

  buildWeldNumberingPageDetails(pageData = {}) {
    const diagnostic = pageData?.straightPipeAutoWeld;
    if (!diagnostic) {
      return {
        weldCount: Array.isArray(pageData?.welds) ? pageData.welds.length : 0,
        straightPipeAutoWeld: null
      };
    }

    const material = diagnostic.material || null;
    const numberOrNull = value => Number.isFinite(Number(value)) ? Number(value) : null;
    return {
      weldCount: Array.isArray(pageData?.welds) ? pageData.welds.length : 0,
      straightPipeAutoWeld: {
        status: String(diagnostic.status || ''),
        reason: String(diagnostic.reason || ''),
        addedCount: numberOrNull(diagnostic.addedCount),
        material: material ? {
          eligible: material.eligible === true,
          steelClass: String(material.steelClass || ''),
          diameterInch: numberOrNull(material.diameterInch),
          rawQuantityValues: Array.isArray(material.rawQuantityValues)
            ? material.rawQuantityValues.map(value => String(value ?? ''))
            : [],
          parsedLengthsM: Array.isArray(material.parsedLengthsM)
            ? material.parsedLengthsM.map(numberOrNull)
            : [],
          totalLengthM: numberOrNull(material.totalLengthM),
          referenceLengthM: numberOrNull(material.referenceLengthM),
          weldCount: numberOrNull(material.weldCount),
          safetyLimit: numberOrNull(material.safetyLimit),
          pipeRowCount: numberOrNull(material.pipeRowCount)
        } : null
      }
    };
  }

  buildAutomaticLayoutPageDetails(pageData = {}) {
    const annotations = Array.isArray(pageData.annotations) ? pageData.annotations : [];
    const materialDiagnostics = annotations.find(annotation => annotation?.batchMaterialContent)
      ?.batchMaterialContent || null;
    const items = annotations.map((annotation) => {
      const diagnostics = annotation.layoutDiagnostics || {};
      const startX = Number(annotation.startX || 0);
      const startY = Number(annotation.startY || 0);
      const endX = Number(annotation.endX || 0);
      const endY = Number(annotation.endY || 0);
      return {
        weldNumber: String(annotation.text ?? ''),
        pipelineNumber: String(annotation.pipelineNumber || ''),
        ruleName: String(annotation.ruleName || ''),
        diameter: String(annotation.topText || ''),
        jointType: String(annotation.jointTypeText || ''),
        fittingType: String(annotation.batchMaterialContent?.fittingType || ''),
        fittingRole: String(annotation.batchMaterialContent?.fittingRole || ''),
        contentSource: String(annotation.batchMaterialContent?.source || ''),
        fittingMaterialRowCount: Number(annotation.batchMaterialContent?.fittingMaterialRowCount || 0),
        fittingMaterialAmbiguous: annotation.batchMaterialContent?.fittingMaterialAmbiguous === true,
        startX,
        startY,
        endX,
        endY,
        leaderLength: Number(diagnostics.lineLength || Math.hypot(endX - startX, endY - startY)),
        family: String(diagnostics.family || ''),
        source: String(diagnostics.source || ''),
        selectionStage: String(diagnostics.selectionStage || ''),
        longPipeGroupId: String(diagnostics.longPipeGroupId || ''),
        longPipeLane: Number(diagnostics.longPipeLane ?? -1),
        pipeAngleDegrees: Number.isFinite(diagnostics.pipeAngleDegrees)
          ? Number(diagnostics.pipeAngleDegrees)
          : null,
        perpendicularDeviationDegrees: Number.isFinite(diagnostics.perpendicularDeviationDegrees)
          ? Number(diagnostics.perpendicularDeviationDegrees)
          : null,
        usedFallback: diagnostics.usedFallback === true,
        isCollisionFree: diagnostics.isCollisionFree !== false,
        hardCollisionCount: Number(diagnostics.hardCollisionCount || 0),
        leaderIntersectionCount: Number(diagnostics.leaderIntersectionCount || 0),
        collisionViolationCount: Number(diagnostics.collisionViolationCount || 0),
        constraintViolationCount: Number(diagnostics.constraintViolationCount || 0),
        penalty: Number(diagnostics.penalty || 0)
      };
    });

    return {
      annotationCount: items.length,
      fallbackCount: items.filter(item => item.usedFallback).length,
      collisionCount: items.filter(item => item.hardCollisionCount > 0).length,
      missingJointTypeCount: items.filter(item => !item.jointType.trim()).length,
      materialDiagnostics,
      items
    };
  }

  /**
   * 生成统计信息
   */
  generateStats(session) {
    const successPages = session.processedPages.filter(p => p.status === 'success');
    const errorPages = session.processedPages.filter(p => p.status === 'error');
    const skippedPages = session.processedPages.filter(p => p.status === 'skipped');

    // 按书签分组统计
    const bookmarkStats = {};
    session.processedPages.forEach(page => {
      if (page.bookmark) {
        const key = page.bookmark.title;
        if (!bookmarkStats[key]) {
          bookmarkStats[key] = {
            title: page.bookmark.title,
            level: page.bookmark.level,
            pages: [],
            totalData: 0
          };
        }
        bookmarkStats[key].pages.push(page.pageNum);
        bookmarkStats[key].totalData += page.dataCount || 0;
      }
    });

    return {
      totalPages: session.processedPages.length,
      successCount: successPages.length,
      errorCount: errorPages.length,
      skippedCount: skippedPages.length,
      totalDataCount: session.processedPages.reduce((sum, p) => sum + (p.dataCount || 0), 0),
      bookmarkStats: Object.values(bookmarkStats),
      duration: session.duration
    };
  }

  /**
   * 保存到文件
   */
  async saveToFile(session, stats) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const fileName = `处理日志_${session.operationName}_${timestamp}.log`;

      const logData = {
        session,
        stats,
        summary: this.generateSummary(session, stats)
      };

      // 生成文本格式的日志（更易读）
      const textLog = logData.summary;

      // 优先保存到项目目录（通过后端API）
      try {
        console.log('💾 调用后端API保存日志到项目目录...');
        
        // 获取OCR服务器端口
        const configResponse = await fetch('./app-config.json');
        if (!configResponse.ok) {
          throw new Error('无法读取配置文件');
        }
        
        const config = await configResponse.json();
        const port = config.ocr_server_port;
        
        if (!port) {
          throw new Error('配置文件中缺少OCR服务端口信息');
        }
        
        // 获取OCR服务器地址（支持局域网访问）
        // 使用当前访问的hostname，而不是固定的127.0.0.1
        const serverHost = DEFAULT_OCR_SERVER_HOST;
        const ocrServerUrl = buildOcrServerUrl(serverHost, port);
        
        console.log('🌐 OCR服务器地址:', ocrServerUrl);
        
        // 获取客户端信息（用于局域网访问时识别来源）
        const clientInfo = {
          ip: await this.getClientIP(port, serverHost),
          hostname: window.location.hostname,
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          language: navigator.language
        };
        
        // 调用后端API保存日志（一天一个文件）
        const response = await fetch(`${ocrServerUrl}/api/logs/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            log_content: textLog,
            operation_type: session.operationType, // 'weld_numbering' 或 'material_ocr'
            client_info: clientInfo
          })
        });
        
        if (!response.ok) {
          throw new Error(`API请求失败: ${response.status}`);
        }
        
        const result = await response.json();
        
        if (result.success) {
          const action = result.is_new_file ? '创建' : '追加';
          console.log(`✅ 日志已${action}到项目目录:`, result.file_path);
          message.success(`处理日志已${action}到: ${result.file_name}`, 5);
          return; // 成功保存，直接返回
        } else {
          throw new Error('API返回失败');
        }
        
      } catch (apiError) {
        console.warn('⚠️ 通过API保存失败，尝试其他方式:', apiError.message);
        
        // 回退方案：Electron环境或浏览器下载
        if (window.electronAPI && window.electronAPI.getDesktopPath) {
          // Electron环境：保存到桌面
          try {
            const desktopPath = await window.electronAPI.getDesktopPath();
            const filePath = `${desktopPath}/${fileName}`;

            // 使用Node.js的fs模块保存（通过Electron）
            const fs = window.require?.('fs');
            if (fs) {
              fs.writeFileSync(filePath, textLog, 'utf-8');
              console.log('✅ 日志已保存到:', filePath);
              message.success(`处理日志已保存到桌面: ${fileName}`);
            } else {
              // 回退到下载方式
              this.downloadAsFile(textLog, fileName, 'text/plain');
            }
          } catch (error) {
            console.warn('保存到桌面失败，使用下载方式:', error);
            this.downloadAsFile(textLog, fileName, 'text/plain');
          }
        } else {
          // Web环境：触发下载
          console.log('🌐 [Web] 触发日志下载:', fileName);
          this.downloadAsFile(textLog, fileName, 'text/plain');
          console.log('✅ 日志下载已触发，请检查浏览器下载栏');
          message.success(`处理日志已下载: ${fileName}`, 5);
          
          // 额外提示
          setTimeout(() => {
            message.info('请检查浏览器下载文件夹', 3);
          }, 1000);
        }
      }

    } catch (error) {
      console.error('❌ 保存日志失败:', error);
      message.error('保存日志失败: ' + error.message);
    }
  }

  /**
   * 生成文本摘要（简化版，只保留书签信息）
   */
  generateSummary(session, stats) {
    if (session.operationType === 'automatic_layout') {
      return this.generateAutomaticLayoutSummary(session, stats);
    }
    if (session.operationType === 'weld_numbering') {
      return this.generateWeldNumberingSummary(session, stats);
    }

    const lines = [
      `${session.operationName} - 书签处理记录`,
      `PDF: ${session.pdfName}`,
      `时间: ${new Date(session.startTime).toLocaleString('zh-CN')}`,
      `操作人: ${session.userName}`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``
    ];

    // 按书签分组统计
    if (stats.bookmarkStats.length > 0) {
      stats.bookmarkStats.forEach(bs => {
        const indent = '  '.repeat(bs.level - 1);
        const pages = bs.pages.sort((a, b) => a - b);
        const pageRange = pages.length > 1 ? 
          `第${pages[0]}-${pages[pages.length - 1]}页` : 
          `第${pages[0]}页`;
        lines.push(`${indent}${bs.title}`);
        lines.push(`${indent}  ${pageRange}`);
        lines.push(``);
      });
    } else {
      // 没有书签时的简单列表
      lines.push(`处理页面: 第${session.processedPages[0]?.pageNum || '?'}-${session.processedPages[session.processedPages.length - 1]?.pageNum || '?'}页`);
      lines.push(``);
      lines.push(`注意: 此PDF没有书签信息`);
    }

    return lines.join('\n');
  }

  generateWeldNumberingSummary(session, stats) {
    const lines = [
      '焊点批量编号处理日志',
      `PDF: ${session.pdfName}`,
      `时间: ${new Date(session.startTime).toLocaleString('zh-CN')}`,
      `操作人: ${session.userName}`,
      `处理页数: ${stats.totalPages}`,
      ''
    ];
    const diagnostics = session.processedPages
      .map(page => ({ pageNum: page.pageNum, data: page.details?.straightPipeAutoWeld }))
      .filter(item => item.data);

    if (diagnostics.length === 0) {
      lines.push('直管长度补点：本次未启用或没有诊断结果。');
      return lines.join('\n');
    }

    lines.push('直管长度补点诊断：');
    diagnostics.forEach(({ pageNum, data }) => {
      const material = data.material;
      lines.push(`第 ${pageNum} 页 | 状态 ${data.status || '-'} | ${data.reason || '无异常原因'}`);
      if (!material) {
        lines.push('  材料计算：无可用数据');
        return;
      }
      const rawQuantityValues = Array.isArray(material.rawQuantityValues) ? material.rawQuantityValues : [];
      const quantitySources = Array.isArray(material.quantitySources) ? material.quantitySources : [];
      const parsedLengthsM = Array.isArray(material.parsedLengthsM) ? material.parsedLengthsM : [];
      lines.push(`  PIPE QTY 原值: ${rawQuantityValues.length ? rawQuantityValues.join(' + ') : '-'}`);
      lines.push(`  QTY 取值来源: ${quantitySources.length ? quantitySources.join(' + ') : '-'}`);
      lines.push(`  换算长度(m): ${parsedLengthsM.length ? parsedLengthsM.join(' + ') : '-'}`);
      lines.push(`  总长度: ${material.totalLengthM ?? '-'}m | 管径: ${material.diameterInch ?? '-'}英寸 | 钢级: ${material.steelClass || '-'}`);
      lines.push(`  参考长度: ${material.referenceLengthM ?? '-'}m | 计算补点数: ${material.weldCount ?? '-'} | 安全上限: ${material.safetyLimit ?? '-'}`);
      if (material.weldCount !== null && material.safetyLimit !== null && material.weldCount > material.safetyLimit) {
        lines.push('  结论: 超过安全上限');
      }
    });
    return lines.join('\n');
  }

  generateAutomaticLayoutSummary(session, stats) {
    const allItems = session.processedPages.flatMap(page => page.details?.items || []);
    const fallbackCount = allItems.filter(item => item.usedFallback).length;
    const collisionCount = allItems.filter(item => item.hardCollisionCount > 0).length;
    const missingJointTypeCount = allItems.filter(item => !item.jointType.trim()).length;
    const lines = [
      '自动落图诊断日志',
      `PDF: ${session.pdfName}`,
      `时间: ${new Date(session.startTime).toLocaleString('zh-CN')}`,
      `操作人: ${session.userName}`,
      `会话: ${session.sessionId}`,
      `处理页数: ${stats.totalPages}`,
      `生成标注: ${allItems.length}`,
      `使用兜底: ${fallbackCount}`,
      `存在硬碰撞: ${collisionCount}`,
      `缺少接头形式: ${missingJointTypeCount}`,
      ''
    ];

    session.processedPages
      .slice()
      .sort((a, b) => a.pageNum - b.pageNum)
      .forEach((page) => {
        const details = page.details || {};
        lines.push(
          `===== 第 ${page.pageNum} 页：${details.annotationCount || 0} 个标注，` +
          `兜底 ${details.fallbackCount || 0}，硬碰撞 ${details.collisionCount || 0}，` +
          `缺少接头形式 ${details.missingJointTypeCount || 0} =====`
        );
        const material = details.materialDiagnostics;
        if (material) {
          const formatCandidates = (values) => (Array.isArray(values) && values.length > 0)
            ? values.map(item => `${item.code}:${item.count}`).join(', ')
            : '-';
          lines.push(
            `材料表诊断 | 本页行 ${material.pageMaterialRows ?? 0} | 使用行 ${material.usedMaterialRows ?? 0} | ` +
            `PIPE行 ${material.pipeMaterialRows ?? 0} | 管线精确匹配行 ${material.exactPipelineRows ?? 0} | ` +
            `寸径原值 ${(material.diameterRawValues || []).join(', ') || '-'} | ` +
            `寸径候选 ${(material.diameterCandidates || []).join(', ') || '-'} | ` +
            `最终寸径 ${material.diameter || '(未识别)'} | 寸径提取 ${material.diameterExtractionMode || '-'} | ` +
            `接头提取 ${material.jointTypeExtractionMode || '-'} | ` +
            `描述列候选 ${formatCandidates(material.standardJointTypeCandidates)} | ` +
            `原始列候选 ${formatCandidates(material.rawJointTypeCandidates)} | ` +
            `最终 ${material.jointType || '(未识别)'}`
          );
          (material.materialDescriptionSamples || []).forEach((sample, index) => {
            lines.push(`材料描述样本 ${index + 1}: ${sample}`);
          });
        }
        (details.items || []).forEach((item) => {
          lines.push(
            `焊点 ${item.weldNumber || '(空号)'} | 管线 ${item.pipelineNumber || '(未识别)'} | ` +
            `寸径 ${item.diameter || '(未识别)'} | 接头 ${item.jointType || '(未识别)'} | ` +
            `管件 ${item.fittingType || '-'}${item.fittingRole ? `/${item.fittingRole}` : ''} | ` +
            `内容来源 ${item.contentSource || '-'} | 管件材料行 ${item.fittingMaterialRowCount || 0}${item.fittingMaterialAmbiguous ? '(有歧义)' : ''} | ` +
            `起点 (${item.startX.toFixed(1)}, ${item.startY.toFixed(1)}) -> ` +
            `圈心 (${item.endX.toFixed(1)}, ${item.endY.toFixed(1)}) | ` +
            `引线 ${item.leaderLength.toFixed(1)} | 方向 ${item.family || '-'} | ` +
            `候选 ${item.source || '-'} | 阶段 ${item.selectionStage || '-'} | ` +
            `长管组 ${item.longPipeGroupId || '-'} | 排 ${item.longPipeLane >= 0 ? item.longPipeLane + 1 : '-'} | ` +
            `管线角度 ${item.pipeAngleDegrees ?? '-'} | 偏离垂直 ${item.perpendicularDeviationDegrees ?? '-'} | ` +
            `兜底 ${item.usedFallback ? '是' : '否'} | ` +
            `引线交叉 ${item.leaderIntersectionCount} | 硬碰撞 ${item.hardCollisionCount} | ` +
            `约束异常 ${item.constraintViolationCount} | ` +
            `评分 ${item.penalty.toFixed(1)}`
          );
        });
        lines.push('');
      });

    if (fallbackCount || collisionCount || missingJointTypeCount) {
      lines.push('建议优先复核以上存在兜底、硬碰撞或缺少接头形式的页面。');
    } else {
      lines.push('本次自动落图未发现兜底、硬碰撞或接头形式缺失。');
    }
    return lines.join('\n');
  }

  /**
   * 上传到服务器（用于局域网/公网统计）
   */
  async uploadToServer(logData) {
    try {
      // 从配置获取服务器地址
      const configResponse = await fetch('./app-config.json');
      if (!configResponse.ok) {
        return; // 配置不存在时静默失败
      }

      const config = await configResponse.json();
      const logServerUrl = config.bookmark_log_server_url;

      if (!logServerUrl) {
        console.log('ℹ️ 未配置日志服务器，跳过上传');
        return;
      }

      // 上传到服务器
      const response = await fetch(logServerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(logData),
        timeout: 5000
      });

      if (response.ok) {
        console.log('✅ 日志已上传到服务器');
      } else {
        console.warn('⚠️ 日志上传失败:', response.status);
      }
    } catch (error) {
      console.warn('⚠️ 日志上传失败:', error.message);
      // 上传失败不影响主流程，静默处理
    }
  }

  /**
   * 浏览器下载文件
   */
  downloadAsFile(data, fileName, mimeType = 'application/json') {
    try {
      const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      
      console.log('🔽 触发下载:', fileName, '大小:', blob.size, 'bytes');
      
      a.click();
      
      // 延迟移除，确保下载触发
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log('✅ 下载链接已清理');
      }, 100);
      
    } catch (error) {
      console.error('❌ 下载文件失败:', error);
      throw error;
    }
  }

  /**
   * 生成会话ID
   */
  generateSessionId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 获取用户名（异步）
   */
  async getUserName() {
    // 尝试从多个来源获取用户名
    try {
      if (window.electronAPI?.getUserName) {
        const userName = await window.electronAPI.getUserName();
        return userName || '未知用户';
      }
    } catch (error) {
      console.warn('获取系统用户名失败:', error);
    }
    
    // 回退到本地存储或默认值
    return localStorage.getItem('userName') || '未知用户';
  }

  /**
   * 获取客户端IP地址（通过后端API）
   */
  async getClientIP(port, serverHost = '127.0.0.1') {
    try {
      // 尝试通过后端API获取真实IP
      const response = await fetch(`${buildOcrServerUrl(serverHost, port)}/api/client-ip`, {
        method: 'GET',
        timeout: 1000
      });
      
      if (response.ok) {
        const data = await response.json();
        return data.ip || window.location.hostname;
      }
    } catch (error) {
      console.warn('获取客户端IP失败:', error);
    }
    
    // 回退到hostname
    return window.location.hostname;
  }

  /**
   * 获取客户端信息
   */
  getClientInfo() {
    const isElectron = !!(window.electronAPI);
    const platform = isElectron ? 'Electron桌面版' : 'Web浏览器版';
    const userAgent = navigator.userAgent;
    const hostname = window.location.hostname;
    
    return `${platform} - ${hostname} - ${userAgent.split(' ').slice(-2).join(' ')}`;
  }

  /**
   * 计算时长
   */
  calculateDuration(startTime, endTime) {
    const start = new Date(startTime);
    const end = new Date(endTime);
    const diffMs = end - start;
    const diffSec = Math.floor(diffMs / 1000);
    const minutes = Math.floor(diffSec / 60);
    const seconds = diffSec % 60;
    return `${minutes}分${seconds}秒`;
  }

  /**
   * 获取当前会话
   */
  getCurrentSession() {
    return this.currentSession;
  }

  /**
   * 获取所有日志
   */
  getAllLogs() {
    return this.logs;
  }

  /**
   * 清空日志
   */
  clearLogs() {
    this.logs = [];
    console.log('🗑️ 日志已清空');
  }
}

// 导出单例
export const bookmarkLogger = new BookmarkLogger();

// 导出便捷函数
export const startProcessingSession = (pdfName, operationType, bookmarks) => {
  return bookmarkLogger.startSession(pdfName, operationType, bookmarks);
};

export const logProcessedPage = (pageNum, pageData, status) => {
  return bookmarkLogger.logPage(pageNum, pageData, status);
};

export const saveAutomaticLayoutLog = async (pdfName, annotations = []) => {
  const layoutAnnotations = (annotations || []).filter(annotation => annotation?.layoutDiagnostics);
  if (layoutAnnotations.length === 0) {
    return null;
  }

  await bookmarkLogger.startSession(pdfName || 'unknown.pdf', 'automatic_layout', []);
  const annotationsByPage = {};
  layoutAnnotations.forEach((annotation) => {
    const pageNum = Number(annotation.page || 1);
    if (!annotationsByPage[pageNum]) annotationsByPage[pageNum] = [];
    annotationsByPage[pageNum].push(annotation);
  });
  Object.keys(annotationsByPage)
    .map(Number)
    .sort((a, b) => a - b)
    .forEach((pageNum) => {
      bookmarkLogger.logPage(pageNum, { annotations: annotationsByPage[pageNum] }, 'success');
    });
  return bookmarkLogger.endSession();
};

export const endProcessingSession = async () => {
  return await bookmarkLogger.endSession();
};

export default bookmarkLogger;
