// Isolated production-like test mirror. It serves a separately built bundle
// on port 3004 while reusing the same bounded backend proxies as production port 3005.
process.env.PORT = process.env.PORT || '3004';
process.env.STATIC_ROOT = process.env.STATIC_ROOT || 'build_mirror';
process.env.AUDIT_DIR = process.env.AUDIT_DIR || 'runtime/audit-logs-mirror';
process.env.PROCESSING_LOG_DIR = process.env.PROCESSING_LOG_DIR || 'runtime/processing-logs-mirror';
process.env.ENABLE_PDF_PAGE_CACHE = '1';
process.env.PDF_PAGE_CACHE_DIR = process.env.PDF_PAGE_CACHE_DIR || 'runtime/pdf-page-cache-mirror';
require('./prod_server_with_autosave_proxy');
