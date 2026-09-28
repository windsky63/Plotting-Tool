const fs = require('fs');
const path = require('path');

// 控制台颜色
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

console.log('\n' + colors.cyan + '='.repeat(60) + colors.reset);
console.log(colors.cyan + '  PDF单线图焊口预制标注工具 - 打包前检查' + colors.reset);
console.log(colors.cyan + '='.repeat(60) + colors.reset + '\n');

// 需要检查的文件和目录
const requiredItems = [
  { path: 'package.json', type: 'file', critical: true, desc: '项目配置文件' },
  { path: 'app.ico', type: 'file', critical: true, desc: '应用图标' },
  { path: 'public/electron.js', type: 'file', critical: true, desc: 'Electron主进程' },
  { path: 'public/preload.js', type: 'file', critical: true, desc: 'Preload脚本(public)' },
  { path: 'preload.js', type: 'file', critical: true, desc: 'Preload脚本(根目录)' },
  { path: 'main.js', type: 'file', critical: true, desc: '主进程入口' },
  { path: 'public/app-config.json', type: 'file', critical: true, desc: '应用配置' },
  { path: 'public/electron-is-dev.js', type: 'file', critical: true, desc: '开发环境检测' },
  { path: 'src/App.js', type: 'file', critical: true, desc: 'React主组件' },
  { path: 'src/index.js', type: 'file', critical: true, desc: 'React入口' },
  { path: 'ocr_server', type: 'dir', critical: true, desc: 'OCR服务器目录' },
  { path: 'ocr_server/ocr_server.exe', type: 'file', critical: true, desc: 'OCR服务器可执行文件' },
  { path: 'ocr_server/settings.json', type: 'file', critical: false, desc: 'OCR配置文件' },
  { path: 'ocr_server/models', type: 'dir', critical: true, desc: 'OCR模型目录' },
  { path: 'ocr_server/_internal', type: 'dir', critical: true, desc: 'OCR依赖库' },
  { path: 'node_modules', type: 'dir', critical: true, desc: 'Node依赖包' }
];

let hasErrors = false;
let hasWarnings = false;
let checksPassed = 0;
let checksTotal = requiredItems.length;

console.log(colors.blue + '📋 检查必需文件和目录...\n' + colors.reset);

// 检查每一项
requiredItems.forEach((item, index) => {
  const fullPath = path.join(__dirname, '..', item.path);
  const exists = fs.existsSync(fullPath);
  
  let status, symbol, color;
  
  if (exists) {
    checksPassed++;
    status = '✓ 通过';
    symbol = '✅';
    color = colors.green;
    
    // 如果是文件，显示大小
    if (item.type === 'file') {
      const stats = fs.statSync(fullPath);
      const sizeKB = (stats.size / 1024).toFixed(2);
      console.log(`${symbol} ${color}${item.desc}${colors.reset}`);
      console.log(`   路径: ${item.path} (${sizeKB} KB)`);
    } else {
      // 如果是目录，显示文件数量
      const files = fs.readdirSync(fullPath);
      console.log(`${symbol} ${color}${item.desc}${colors.reset}`);
      console.log(`   路径: ${item.path} (${files.length} 项)`);
    }
  } else {
    if (item.critical) {
      hasErrors = true;
      status = '✗ 缺失（必需）';
      symbol = '❌';
      color = colors.red;
    } else {
      hasWarnings = true;
      status = '⚠ 缺失（可选）';
      symbol = '⚠️';
      color = colors.yellow;
    }
    console.log(`${symbol} ${color}${item.desc}${colors.reset}`);
    console.log(`   路径: ${item.path} - ${status}`);
  }
  
  console.log('');
});

// 检查 node_modules 中的关键依赖
console.log(colors.blue + '📦 检查关键依赖包...\n' + colors.reset);

const criticalDependencies = [
  'electron',
  'electron-builder',
  'react',
  'react-dom',
  'react-scripts',
  'antd'
];

criticalDependencies.forEach(dep => {
  const depPath = path.join(__dirname, '..', 'node_modules', dep);
  const exists = fs.existsSync(depPath);
  
  if (exists) {
    console.log(`✅ ${colors.green}${dep}${colors.reset}`);
  } else {
    hasErrors = true;
    console.log(`❌ ${colors.red}${dep} - 未安装${colors.reset}`);
  }
});

// 检查 package.json 配置
console.log('\n' + colors.blue + '⚙️  检查打包配置...\n' + colors.reset);

const packageJsonPath = path.join(__dirname, '..', 'package.json');
if (fs.existsSync(packageJsonPath)) {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  
  // 检查必要的脚本
  const requiredScripts = ['build', 'build-electron', 'electron-pack'];
  requiredScripts.forEach(script => {
    if (packageJson.scripts && packageJson.scripts[script]) {
      console.log(`✅ ${colors.green}脚本 "${script}" 已配置${colors.reset}`);
    } else {
      hasWarnings = true;
      console.log(`⚠️ ${colors.yellow}脚本 "${script}" 未配置${colors.reset}`);
    }
  });
  
  // 检查打包配置
  if (packageJson.build) {
    console.log(`✅ ${colors.green}electron-builder 配置已设置${colors.reset}`);
    
    if (packageJson.build.productName) {
      console.log(`   产品名称: ${packageJson.build.productName}`);
    }
    if (packageJson.build.appId) {
      console.log(`   应用ID: ${packageJson.build.appId}`);
    }
    if (packageJson.version) {
      console.log(`   版本号: ${packageJson.version}`);
    }
  } else {
    hasErrors = true;
    console.log(`❌ ${colors.red}electron-builder 配置缺失${colors.reset}`);
  }
}

// 检查 OCR 配置
console.log('\n' + colors.blue + '🔧 检查 OCR 配置...\n' + colors.reset);

const appConfigPath = path.join(__dirname, '..', 'public', 'app-config.json');
if (fs.existsSync(appConfigPath)) {
  try {
    const appConfig = JSON.parse(fs.readFileSync(appConfigPath, 'utf8'));
    
    if (appConfig.ocr_server_port) {
      console.log(`✅ ${colors.green}OCR服务端口: ${appConfig.ocr_server_port}${colors.reset}`);
    } else {
      hasWarnings = true;
      console.log(`⚠️ ${colors.yellow}OCR服务端口未配置${colors.reset}`);
    }
    
    if (appConfig.ocr_backend) {
      console.log(`✅ ${colors.green}OCR后端模式: ${appConfig.ocr_backend}${colors.reset}`);
    }
    
    if (appConfig.ocr_backend_exe_path) {
      console.log(`✅ ${colors.green}OCR可执行文件路径: ${appConfig.ocr_backend_exe_path}${colors.reset}`);
      
      // 检查路径是否存在
      const ocrExePath = path.join(__dirname, '..', appConfig.ocr_backend_exe_path);
      if (!fs.existsSync(ocrExePath)) {
        hasWarnings = true;
        console.log(`   ⚠️ ${colors.yellow}警告: OCR可执行文件不存在${colors.reset}`);
      }
    }
  } catch (error) {
    hasErrors = true;
    console.log(`❌ ${colors.red}app-config.json 格式错误: ${error.message}${colors.reset}`);
  }
} else {
  hasErrors = true;
  console.log(`❌ ${colors.red}app-config.json 文件不存在${colors.reset}`);
}

// 估算打包大小
console.log('\n' + colors.blue + '📊 估算打包大小...\n' + colors.reset);

function getDirectorySize(dirPath) {
  let totalSize = 0;
  
  if (!fs.existsSync(dirPath)) {
    return 0;
  }
  
  try {
    const files = fs.readdirSync(dirPath);
    
    files.forEach(file => {
      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);
      
      if (stats.isDirectory()) {
        totalSize += getDirectorySize(filePath);
      } else {
        totalSize += stats.size;
      }
    });
  } catch (error) {
    // 忽略权限错误
  }
  
  return totalSize;
}

const ocrServerSize = getDirectorySize(path.join(__dirname, '..', 'ocr_server'));
const nodeModulesSize = getDirectorySize(path.join(__dirname, '..', 'node_modules'));

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

console.log(`OCR服务器: ${formatBytes(ocrServerSize)}`);
console.log(`Node依赖: ${formatBytes(nodeModulesSize)}`);
console.log(`估算总大小: ${formatBytes(ocrServerSize + nodeModulesSize + 50 * 1024 * 1024)} (包含应用代码)`);

// 总结
console.log('\n' + colors.cyan + '='.repeat(60) + colors.reset);
console.log(colors.cyan + '  检查总结' + colors.reset);
console.log(colors.cyan + '='.repeat(60) + colors.reset + '\n');

console.log(`检查项目: ${checksPassed}/${checksTotal} 通过`);

if (hasErrors) {
  console.log(colors.red + '\n❌ 检查失败！请解决以上错误后再进行打包。\n' + colors.reset);
  console.log('建议操作：');
  console.log('  1. 运行 npm install 安装缺失的依赖');
  console.log('  2. 检查 OCR 服务器文件是否完整');
  console.log('  3. 确认所有必需的配置文件存在');
  process.exit(1);
} else if (hasWarnings) {
  console.log(colors.yellow + '\n⚠️  检查通过，但有警告。建议检查后再打包。\n' + colors.reset);
  console.log('可以继续打包，但某些功能可能不完整。');
  process.exit(0);
} else {
  console.log(colors.green + '\n✅ 所有检查通过！可以开始打包了。\n' + colors.reset);
  console.log('运行以下命令开始打包：');
  console.log(colors.cyan + '  npm run build-electron' + colors.reset);
  console.log('');
  process.exit(0);
}

