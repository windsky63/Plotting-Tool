"""Package a committed web build for the project's existing static deployment.

No server credentials, app-config.json, runtime data or business PDFs are included.
Usage: python scripts/package_web_update.py --label 20261026-01 --verification runtime/verification.json
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent
REPOSITORY = ROOT.parent


def git(*args):
    return subprocess.check_output(['git', *args], cwd=REPOSITORY).decode('utf-8').strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--label', required=True)
    parser.add_argument('--verification', required=True, type=Path)
    args = parser.parse_args()
    if any(character in args.label for character in '/\\:'):
        raise ValueError('Label must not contain path separators')
    build = ROOT / 'build_prod'
    worker = build / 'pdf.worker-6.3.289.min.mjs'
    if not (build / 'index.html').is_file() or not worker.is_file():
        raise ValueError('Build build_prod before packaging')
    if '6.3.289' not in worker.read_text(encoding='utf-8'):
        raise ValueError('PDF.js worker version mismatch')
    main_js = list((build / 'static/js').glob('main.*.js'))
    if len(main_js) != 1 or 'snapshot:v4' not in main_js[0].read_text(encoding='utf-8'):
        raise ValueError('Build does not contain the snapshot:v4 fix')
    if git('status', '--porcelain', '--untracked-files=no'):
        raise ValueError('Commit tracked source changes before packaging')
    revision = git('rev-parse', 'HEAD')
    verification = json.loads(args.verification.read_text(encoding='utf-8'))
    if not verification.get('productionBuildPassed') or not verification.get('frontendTestsPassed'):
        raise ValueError('Passing build and test verification is required')
    release_dir = REPOSITORY / 'releases'
    release_dir.mkdir(exist_ok=True)
    archive = release_dir / f'落图工具-部署包-{args.label}.zip'
    outputs = [archive, archive.with_suffix('.zip.sha256.txt'), archive.with_name(archive.stem + '-更新说明.txt')]
    if any(output.exists() for output in outputs):
        raise ValueError('Release output already exists; use a new label')
    entries = {}
    excluded_build = {'app-config.json', 'app-config.example.json', 'cors-test.html', 'test_ocr.html',
                      'electron.js', 'electron-is-dev.js', 'preload.js'}
    for path in sorted(build.rglob('*')):
        if path.is_file() and path.name not in excluded_build and path.suffix != '.map':
            entries['build_prod/' + path.relative_to(build).as_posix()] = path.read_bytes()
    source_files = git('ls-files', 'pdf_viewer/src', 'pdf_viewer/public', 'pdf_viewer/package.json',
                       'pdf_viewer/package-lock.json', 'pdf_viewer/scripts/sync_pdfjs_worker.mjs',
                       'pdf_viewer/scripts/repair_annotation_cache_scale.py',
                       'pdf_viewer/scripts/test_repair_annotation_cache_scale.py',
                       'pdf_viewer/scripts/render_pdf_page_cache.py',
                       'pdf_viewer/scripts/package_web_update.py',
                       'pdf_viewer/docs/annotation-position-investigation.md').splitlines()
    for relative in source_files:
        path = REPOSITORY / relative
        if path.name in excluded_build:
            continue
        if path.is_file():
            entries['source_update/' + path.relative_to(ROOT).as_posix()] = path.read_bytes()
    entries['source_update/.env.production'] = (
        'REACT_APP_SERVER_PAGE_CACHE=true\nREACT_APP_IMAGE_FIRST_PDF=true\nREACT_APP_TEST_MIRROR=false\n'
    ).encode('utf-8')
    removed = ['src/utils/DiagnoseWeldTextCoordinates.js', 'src/utils/DebugWeldTextMatch.js']
    entries['source_update/deleted-files.txt'] = ('\n'.join(removed) + '\n').encode('utf-8')
    verification['sourceCommit'] = revision
    entries['validation/verification.json'] = json.dumps(verification, ensure_ascii=False, indent=2).encode('utf-8')
    notes = f'''落图工具服务器更新包：{args.label}
源码版本：{revision}

本次修复
1. 后台预取缓存保存实际 renderScale / 2，修复大页面约 2.2% 比例错配导致标识向左上偏移。
2. 缓存版本更新为 snapshot:v4，旧错误页面图片会重建；不删除本机或云端草稿。
3. 保留异步截图期间缩放和切换文档的独立时序修复。
4. 提供历史 PDF 坐标修复脚本，并移除无业务调用的旧诊断模块。

更新步骤
1. 使用者先保存或导出当前图纸，关闭旧页面。
2. 备份服务器当前实际静态目录和 app-config.json，保留原源码备份。
3. 将 build_prod 内的内容覆盖到服务实际 STATIC_ROOT；保留服务器 app-config.json。
   本包不包含服务器配置、runtime、用户 PDF、node_modules 或服务器 Python 环境。
4. 如维护服务器源码，将 source_update 内 src、public、包文件、scripts 和 docs 同步到 pdf_viewer。
   源码目录中按 source_update/deleted-files.txt 清除两份已废弃诊断模块；保留原服务器配置。
   包内 .env.production 仅含前端功能开关，不替换服务器进程的环境变量或连接配置。
5. 按原方式重启现有网页服务，保留当前端口和代理；浏览器 Ctrl+F5。
   不要清除浏览器网站数据，以免删除本机草稿和用户键。
6. 用未修复的原始 PDF 新建标识，验证翻页、重开、导出、撤销重做及草稿保存恢复。

已有偏移的 PDF
更新网页不会自动改写已保存坐标。仅对已确认命中本次缓存比例缺陷的文件运行修复脚本：
  python scripts/repair_annotation_cache_scale.py "问题文件-可编辑版.pdf" --annotated "问题文件-标注版.pdf"
在 source_update 或已更新的 pdf_viewer 目录运行，使用服务器已有的 PyMuPDF。
脚本默认 1.25 栅格比例 / 600 万像素上限；不同配置请按说明设置。
输出独立副本及修复报告，拒绝覆盖和重复修复。标注版调整图片层，文字/框也随层缩放；
可编辑版保留原字号和框配置。详见 docs/annotation-position-investigation.md。

验证
前端：{verification.get('frontendPassedCount')} 项通过，{verification.get('frontendSkippedCount')} 项既有跳过。
修复脚本：{verification.get('pythonPassedCount')} 项通过。生产构建及版本化 PDF.js worker 核验通过。
包内 SHA256SUMS.txt 校验所有载荷文件；包外 .sha256.txt 校验整个 ZIP。
这些是本地验证，未连接或更新生产服务器。

回滚
恢复备份的静态目录、配置和对应源码，再按原方式重启并 Ctrl+F5。
保留数据库、runtime、本机/云端草稿和原 PDF；修复副本保留原文件作为文件回滚依据。
'''
    entries['更新说明.txt'] = notes.encode('utf-8-sig')
    manifest = {'label': args.label, 'sourceCommit': revision, 'staticRoot': 'build_prod',
                'backendUpdateRequired': False, 'preserveServerConfig': True,
                'snapshotVersion': 'v4', 'payloadFilesBeforeManifest': len(entries)}
    entries['release-manifest.json'] = json.dumps(manifest, ensure_ascii=False, indent=2).encode('utf-8')
    entries['SHA256SUMS.txt'] = ''.join(
        f'{hashlib.sha256(data).hexdigest()}  {name}\n' for name, data in sorted(entries.items())
    ).encode('utf-8')
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as package:
        for name, data in sorted(entries.items()):
            package.writestr(name, data)
    with zipfile.ZipFile(archive) as package:
        if package.testzip() is not None:
            raise ValueError('ZIP integrity check failed')
        for name, data in entries.items():
            if hashlib.sha256(package.read(name)).digest() != hashlib.sha256(data).digest():
                raise ValueError(f'Archive content mismatch: {name}')
    archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
    outputs[1].write_text(f'{archive_hash}  {archive.name}\n', encoding='utf-8')
    outputs[2].write_text(notes, encoding='utf-8-sig')
    print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size,
                      'sha256': archive_hash, 'sourceCommit': revision, 'files': len(entries)},
                     ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
