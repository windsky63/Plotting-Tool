远端 OCR/MinerU 工作站启动说明

用途：
在本机启动落图生产网页、IDF 分图点工具、自动保存和帮助服务。
不会启动或安装本地 OCR/MinerU；识别服务固定使用：

OCR     192.168.32.61:8766
MinerU  192.168.32.61:8081

启动：
双击 start_remote_workstation.cmd

地址：
落图生产网页  http://127.0.0.1:3005/
分图点工具    http://127.0.0.1:3006/
自动保存健康  http://127.0.0.1:8789/health
帮助服务健康  http://127.0.0.1:8788/health

说明：
1. 脚本全部使用迁移包相对路径，迁移目录后仍可运行。
2. 日志保存在 pdf_viewer\runtime\workstation-logs。
3. 帮助助手如需生成 AI 答复，需设置 DEEPSEEK_API_KEY 用户或系统环境变量。
4. 当前网络必须能够访问远端 OCR/MinerU；本脚本不配置 VPN。
5. TortoiseGit 已安装，但迁移包没有 .git 历史。应使用正式仓库执行 Clone，或从旧电脑复制完整仓库。
6. 已在当前 Windows 用户的“启动”目录添加自动启动入口，登录后会自动运行本工作站脚本。
7. 首次允许局域网电脑访问前，请以管理员身份运行 install_firewall_rules.cmd。
8. 3005 与 3006 已通过“LuotuRemoteWorkstation”计划任务在 Windows 启动时运行，不依赖用户登录。
