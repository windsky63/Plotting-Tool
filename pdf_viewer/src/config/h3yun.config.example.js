// 氚云API配置示例文件
// 使用方法：
// 1. 复制此文件为 h3yun.config.js
// 2. 填写您的氚云配置信息
// 3. h3yun.config.js 已添加到 .gitignore，不会被提交到代码库

export const h3yunConfig = {
  // 氚云API基础地址
  baseUrl: 'https://www.h3yun.com/api',
  
  // 应用编码（在氚云管理后台获取）
  appCode: 'YOUR_APP_CODE',
  
  // 主表编码（数据工作日志表单）
  // 注意：D148357F67d10547274c48d7bc977b28a4a9c6a6 是子表编码，不是主表编码
  formCode: 'D148357st1mm2l5ga0ucn4ogzl05',
  
  // 引擎编码（在氚云管理后台获取）
  engineCode: 'YOUR_ENGINE_CODE',
  
  // 是否启用调试模式
  debug: true
};

// 获取配置的辅助函数
export const getH3yunConfig = () => {
  // 尝试导入实际配置文件
  try {
    const actualConfig = require('./h3yun.config.js');
    return actualConfig.h3yunConfig || h3yunConfig;
  } catch (error) {
    console.warn('未找到 h3yun.config.js，使用默认配置');
    return h3yunConfig;
  }
};

