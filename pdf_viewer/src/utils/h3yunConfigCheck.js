/**
 * 氚云配置检查工具
 */

export const checkH3yunConfig = (config) => {
  const errors = [];
  const warnings = [];

  // 检查必填配置
  if (!config.baseUrl || config.baseUrl === 'https://www.h3yun.com/api') {
    warnings.push('⚠️ 使用默认的 baseUrl，请确认是否正确');
  }

  if (!config.appCode || config.appCode === 'YOUR_APP_CODE') {
    errors.push('❌ appCode 未配置或使用默认值');
  }

  if (!config.engineCode || config.engineCode === 'YOUR_ENGINE_CODE') {
    errors.push('❌ engineCode 未配置或使用默认值');
  }

  if (!config.formCode) {
    errors.push('❌ formCode 未配置');
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    summary: errors.length === 0 
      ? '✅ 配置检查通过' 
      : `❌ 发现 ${errors.length} 个错误`
  };
};

/**
 * 打印配置检查结果
 */
export const printConfigCheckResult = (result) => {
  console.group('🔍 氚云配置检查结果');
  
  console.log(result.summary);
  
  if (result.errors.length > 0) {
    console.group('❌ 错误:');
    result.errors.forEach(error => console.error(error));
    console.groupEnd();
  }
  
  if (result.warnings.length > 0) {
    console.group('⚠️ 警告:');
    result.warnings.forEach(warning => console.warn(warning));
    console.groupEnd();
  }
  
  if (result.isValid) {
    console.log('✅ 可以尝试上传数据');
  } else {
    console.log('💡 配置步骤：');
    console.log('1. 复制 src/config/h3yun.config.example.js');
    console.log('2. 重命名为 src/config/h3yun.config.js');
    console.log('3. 在氚云管理后台获取 appCode 和 engineCode');
    console.log('4. 填写到配置文件中');
    console.log('5. 重新启动应用');
  }
  
  console.groupEnd();
  
  return result.isValid;
};

/**
 * 测试氚云连接
 */
export const testH3yunConnection = async (baseUrl) => {
  try {
    console.log('🔌 测试氚云连接:', baseUrl);
    
    // 尝试访问氚云API（不带认证，只测试连通性）
    const response = await fetch(baseUrl, {
      method: 'HEAD',
      mode: 'no-cors' // 避免CORS错误
    });
    
    console.log('✅ 网络连接正常');
    return true;
  } catch (error) {
    console.error('❌ 网络连接失败:', error.message);
    return false;
  }
};

/**
 * 生成配置说明
 */
export const getConfigGuide = () => {
  return `
╔════════════════════════════════════════════════════════════╗
║               氚云配置指南                                  ║
╚════════════════════════════════════════════════════════════╝

📋 必需配置项：

1. appCode (应用编码)
   - 在哪里找：氚云管理后台 > 应用设置 > 应用编码
   - 格式示例：D000000appxxxxxxxxx
   
2. engineCode (引擎编码)  
   - 在哪里找：氚云管理后台 > 应用设置 > 引擎编码
   - 格式示例：Engine

3. formCode (表单编码)
   - 已配置：D148357F67d10547274c48d7bc977b28a4a9c6a6
   - 通常不需要修改

4. baseUrl (API地址)
   - 默认值：https://www.h3yun.com/api
   - 企业版可能有自定义域名

📝 配置步骤：

步骤1：复制配置文件
  cp src/config/h3yun.config.example.js src/config/h3yun.config.js

步骤2：编辑配置文件
  打开 src/config/h3yun.config.js
  填写 appCode 和 engineCode

步骤3：重启应用
  npm start

🔧 测试配置：
  在浏览器控制台输入：
  > import('./utils/h3yunConfigCheck.js').then(m => m.testH3yunConnection('https://www.h3yun.com/api'))

📚 更多信息：
  查看文件：氚云上传功能说明.md
  `;
};

