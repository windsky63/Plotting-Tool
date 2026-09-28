落图工具与分图点工具迁移说明

本迁移包用于把当前电脑上的落图工具和 IDF 分图点工具转移到新电脑。

包含内容：
1. 落图工具源码、public 配置、scripts 脚本、当前 build_prod 生产包。
2. OCR 服务代码配置，仅包含 ocr_server/python 与 settings.json，不包含模型、缓存和虚拟环境。
3. IDF 分图点工具当前可运行文件。
4. luotu-support-qa skill 与常用启动脚本、说明文档。

未包含内容：
1. node_modules。新电脑如需重新构建源码，在项目目录执行 npm install。
2. 本地 OCR/MinerU 模型、虚拟环境、Docker/WSL 数据。
3. runtime 日志、自动保存草稿、旧生产包备份、临时调试文件。

当前远端服务配置：
OCR: 192.168.32.61:8766
MinerU: 192.168.32.61:8081

常用启动方式：
1. 落图工具生产服务：
   在 pdf_viewer\pdf_viewer 目录执行：
   node scripts\prod_server_with_autosave_proxy.js
   默认端口 3005。

2. IDF 分图点工具：
   在 idf_mineru_tool 目录执行：
   start_idf_mineru_tool.cmd
   默认端口 3006。

迁移后注意：
1. 如果新电脑继续使用公网入口，需要将公网3005映射到新电脑3005，并确保网络、IP和防火墙规则正确。
2. 如果只在内网使用，访问新电脑实际 IP 的3005/3006即可。
3. 若 OCR/MinerU 地址变化，需要修改 public\app-config.json、scripts\prod_server_with_autosave_proxy.js 和 idf_mineru_tool\start_idf_mineru_tool.cmd。
