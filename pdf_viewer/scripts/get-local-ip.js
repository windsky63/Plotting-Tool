// 获取本机IP地址的工具脚本
const os = require('os');

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // 跳过内部(127.0.0.1)和非IPv4地址
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({
          name: name,
          address: iface.address
        });
      }
    }
  }

  return addresses;
}

const ips = getLocalIP();

console.log('\n=== 本机网络地址 ===\n');
if (ips.length === 0) {
  console.log('未找到可用的网络接口');
} else {
  ips.forEach(ip => {
    console.log(`接口: ${ip.name}`);
    console.log(`地址: http://${ip.address}:3005`);
    console.log('');
  });
  
  console.log('请将上面的地址分享给其他电脑访问\n');
}














































