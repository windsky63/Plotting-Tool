/**
 * 焊点识别规则管理器
 * 复刻 Python 项目中的 FeatureRuleManager
 */

import {
  rule12SidedWeld,
  rule6SidedWeld,
  rule5SidedValve,
  ruleSmallCircleWeld,
  rule12CurveCircleWeld,
  ruleComplexCircleWeld,
  rule17SegmentCircleWeld,
  ruleHexWeldWithFill,
  ruleBlackFilledComponent,
  ruleHighDensityFilledWeld,
  rule15SegmentClosedPath,
  rule6SegmentClosedPath,
  rule12SegmentLongClosedPath,
  ruleSingaporeWeld,
  ruleMalaysiaWeld,
  ruleShenyuanWeld
} from './WeldDetector';

export class WeldRuleManager {
  constructor() {
    this.rules = new Map();
    this.initializeDefaultRules();
  }

  /**
   * 初始化默认规则
   */
  initializeDefaultRules() {
    // 保留用户标注的规则：12条曲线组成的小型焊点（支持圆形和各方向椭圆形）
    this.addRule('12_curve_circle_weld', rule12CurveCircleWeld, '12条曲线组成的小型焊点 (圆/横椭/竖椭)', true);
    
    // 新增：高密度填充型焊点（CAD实心圆点）
    this.addRule('high_density_filled_weld', ruleHighDensityFilledWeld, '高密度填充型焊点 (CAD实心点)', false);
    
    // 新增：差连识别（14-16线段闭合路径，2.5x2.6）
    this.addRule('15_segment_closed_path', rule15SegmentClosedPath, '差连识别 (14-16线段, 2.5x2.6)', true);

    // 新增：6条曲线闭合路径（南京金凌石化）
    this.addRule('6_segment_closed_path', rule6SegmentClosedPath, '南京金凌石化 (6曲线闭合路径)', true);

    // 新增：福海创焊口 (12线段，闭合路径，总长度大于29)
    this.addRule('12_segment_long_closed_path', rule12SegmentLongClosedPath, '福海创焊口', true);

    // 新增：新加坡焊点 (28-37线段，闭合，连续，总长度<20)
    this.addRule('singapore_weld', ruleSingaporeWeld, '新加坡焊点 (>27且<38线段, 闭合, 连续, 长度<20)', true);

    // Malaysia project: small flat 12-line closed weld symbol.
    this.addRule('malaysia_weld', ruleMalaysiaWeld, '马来西亚项目', true);

    // 福建申远新图纸：24条短直线组成的小型闭合圆。
    this.addRule('shenyuan_weld', ruleShenyuanWeld, '申远焊口', true);
  }

  /**
   * 添加规则
   */
  addRule(id, func, description = '', enabled = true) {
    this.rules.set(id, {
      id,
      name: description || id,
      func,
      enabled,
      description
    });
  }

  /**
   * 启用/禁用规则
   */
  setRuleEnabled(id, enabled) {
    const rule = this.rules.get(id);
    if (rule) {
      rule.enabled = enabled;
      console.log(`规则 '${rule.name}' 已${enabled ? '启用' : '禁用'}`);
    }
  }

  /**
   * 获取所有启用的规则
   */
  getEnabledRules() {
    return Array.from(this.rules.values()).filter(r => r.enabled);
  }

  /**
   * 获取所有规则（用于UI显示）
   */
  getAllRules() {
    return Array.from(this.rules.values());
  }

  /**
   * 评估所有启用的规则
   * @param {Array} paths - 路径对象数组
   * @returns {Set} - 检测到的路径索引集合
   */
  evaluate(paths) {
    const detectedIndices = new Set();
    const enabledRules = this.getEnabledRules();
    
    if (enabledRules.length === 0) {
      console.warn('⚠️ 没有启用的识别规则');
      return [];
    }
    
    console.log(`🔍 评估 ${enabledRules.length} 个启用规则，共 ${paths.length} 个路径...`);
    
    paths.forEach((path, index) => {
      for (const rule of enabledRules) {
        try {
          if (rule.func(path)) {
            detectedIndices.add(index);
            console.log(`✅ Path ${path.id} 匹配规则: ${rule.name}`);
            break; // OR 逻辑：匹配任一规则即可
          }
        } catch (error) {
          // 输出错误信息以便调试
          console.warn(`⚠️ 规则 '${rule.name}' 执行出错 (Path ${path.id}):`, error.message);
        }
      }
    });
    
    return Array.from(detectedIndices);
  }

  /**
   * 保存配置到 localStorage
   */
  saveConfig() {
    const config = {};
    this.rules.forEach((rule, id) => {
      config[id] = { enabled: rule.enabled };
    });
    localStorage.setItem('weld_rules_config', JSON.stringify(config));
  }

  /**
   * 从 localStorage 加载配置
   */
  loadConfig() {
    try {
      const configStr = localStorage.getItem('weld_rules_config');
      if (!configStr) return;
      
      const config = JSON.parse(configStr);
      Object.entries(config).forEach(([id, settings]) => {
        const rule = this.rules.get(id);
        if (rule && typeof settings.enabled === 'boolean') {
          rule.enabled = settings.enabled;
        }
      });
      
      console.log('✅ 焊点规则配置已加载');
    } catch (error) {
      console.error('加载焊点规则配置失败:', error);
    }
  }
}
