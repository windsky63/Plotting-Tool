# 3004 测试镜像

- 生产端：`http://192.168.32.66:3005/`
- 测试镜像：`http://192.168.32.66:3004/`
- 静态目录：`build_mirror`
- 启动脚本：`node scripts/test_mirror_server.js`
- 服务端页面缓存：`runtime/pdf-page-cache-mirror`

3004 使用独立浏览器 Origin、独立访问日志和独立处理日志，不与 3005 的本地缓存及后台统计混用。

首次打开 PDF 时，浏览器把文件注册给 3004 一次。服务端随后使用独立 Python/PyMuPDF 进程串行生成页面 PNG，并在最后一次使用后保存在磁盘一天。浏览器不再通过 PDF.js 执行后台全页渲染，只下载已经生成的页面镜像；当前页真实 PDF Canvas 完成后会自动接管显示。标注层不写入页面镜像，导出仍使用原始 PDF，因此不会降低标注版质量。

服务端依赖 Python 3 和 PyMuPDF。可以用 `PDF_PAGE_CACHE_PYTHON` 指定 Python 路径。缓存任务全局串行，避免多个终端同时生成页面导致内存峰值。

验证完成后，应将同一份源码构建成普通生产包再部署到 3005，不要直接复制带 `REACT_APP_TEST_MIRROR=true` 的镜像包。
