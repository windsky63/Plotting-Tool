"""Apply the two integration points without replacing server-specific code."""
from datetime import datetime
from pathlib import Path
import shutil


def install():
    scripts = Path(__file__).resolve().parent
    target = scripts / 'prod_server_with_autosave_proxy.js'
    for name in ['pdf_export_optimizer.js', 'optimize_pdf_export.py']:
        if not (scripts / name).is_file():
            raise RuntimeError('Missing optimizer file: ' + name)
    text = target.read_text(encoding='utf-8-sig')
    import_line = "const {createPdfExportOptimizer} = require('./pdf_export_optimizer');"
    hook = '  if (pdfExportOptimizer.handle(req, res)) return;'
    if import_line in text and hook in text:
        print('Already installed; restart the existing Node service after updating optimizer files.')
        return
    if 'pdfExportOptimizer' in text or 'createPdfExportOptimizer' in text:
        raise RuntimeError('Partial or custom integration found; review before patching')
    anchor = '  if (pdfPageCacheService?.handle(req, res)) {'
    if text.count(anchor) != 1:
        raise RuntimeError('Server integration point differs; no files changed')
    backup = target.with_name(target.name + '.before-optimize-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    shutil.copy2(target, backup)
    updated = import_line + '\nconst pdfExportOptimizer = createPdfExportOptimizer();\n' + text.replace(anchor, hook + '\n\n' + anchor, 1)
    target.write_text(updated, encoding='utf-8')
    print('Installed. Backup:', backup.name)
    print('Restart the existing Node service; keep its ports and environment unchanged.')


if __name__ == '__main__':
    install()
