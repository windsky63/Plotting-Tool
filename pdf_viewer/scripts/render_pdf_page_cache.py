import os
import sys
import time
import gc
import math
import fitz


def scale_for_pixel_cap(page, preferred_scale, pixel_cap):
    width = max(1.0, float(page.rect.width))
    height = max(1.0, float(page.rect.height))
    if math.ceil(width * preferred_scale) * math.ceil(height * preferred_scale) <= pixel_cap:
        return preferred_scale
    low, high = 0.01, preferred_scale
    for _ in range(40):
        candidate = (low + high) / 2
        pixels = math.ceil(width * candidate) * math.ceil(height * candidate)
        if pixels <= pixel_cap:
            low = candidate
        else:
            high = candidate
    return low


def main():
    source, output_dir = sys.argv[1], sys.argv[2]
    expected = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    document = fitz.open(source)
    total = min(len(document), expected) if expected else len(document)
    preferred_scale = max(0.25, float(os.environ.get("PDF_PAGE_CACHE_SCALE", "1.25")))
    max_pixels = max(1_000_000, int(os.environ.get("PDF_PAGE_CACHE_MAX_PIXELS", "6000000")))
    preview_max_pixels = max(
        250_000,
        min(max_pixels, int(os.environ.get("PDF_PAGE_CACHE_PREVIEW_MAX_PIXELS", "1500000"))),
    )
    yield_seconds = max(0, int(os.environ.get("PDF_PAGE_CACHE_YIELD_MS", "20"))) / 1000
    for index in range(total):
        target = os.path.join(output_dir, f"page-{index + 1}.png")
        preview_target = os.path.join(output_dir, f"preview-page-{index + 1}.png")
        page = document[index]
        base_pixels = max(1.0, float(page.rect.width) * float(page.rect.height))
        preview_scale = scale_for_pixel_cap(page, preferred_scale, preview_max_pixels)
        if os.path.exists(preview_target) and os.path.getsize(preview_target) > 0:
            preview_pix = fitz.Pixmap(preview_target)
        else:
            preview_pix = page.get_pixmap(
                matrix=fitz.Matrix(preview_scale, preview_scale),
                alpha=False,
            )
            preview_temporary = preview_target + ".tmp.png"
            preview_pix.save(preview_temporary)
            os.replace(preview_temporary, preview_target)
        print(
            f"PREVIEW {index + 1} {preview_pix.width} {preview_pix.height} {preview_scale:.8f}",
            flush=True,
        )
        preview_pix = None
        safe_scale = scale_for_pixel_cap(page, preferred_scale, max_pixels)
        if os.path.exists(target) and os.path.getsize(target) > 0:
            pix = fitz.Pixmap(target)
        else:
            matrix = fitz.Matrix(safe_scale, safe_scale)
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            temporary = target + ".tmp.png"
            pix.save(temporary)
            os.replace(temporary, target)
        print(f"PAGE {index + 1} {pix.width} {pix.height} {safe_scale:.8f}", flush=True)
        pix = None
        page = None
        if index % 4 == 3:
            # MuPDF keeps decoded fonts/images in a native cache that is not
            # visible to the browser heap monitor. Drop it regularly so a long
            # drawing cannot accumulate hundreds of pages in renderer memory.
            try:
                fitz.TOOLS.store_shrink(100)
            except Exception:
                pass
        if index % 10 == 9:
            gc.collect()
        # Keep full-quality output, but briefly yield between pages so a large
        # background cache cannot monopolise the production workstation.
        if yield_seconds:
            time.sleep(yield_seconds)
    document.close()


if __name__ == '__main__':
    main()
