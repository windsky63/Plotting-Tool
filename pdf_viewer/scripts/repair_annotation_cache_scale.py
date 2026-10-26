"""Repair annotations authored against an incorrectly scaled page cache.

Inputs are never overwritten. Requires PyMuPDF (the existing PDF cache dependency).
The default ratio models the confirmed 1.25 raster / 6M-pixel cache defect.
"""
import argparse
import collections
import copy
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile

import fitz
from render_pdf_page_cache import scale_for_pixel_cap

REPAIR_ID = 'LUOTU_CACHE_SCALE_REPAIR_V1'
POSITION_KEYS = ('startX', 'startY', 'endX', 'endY')


def digest(path):
    result = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def page_geometry(doc):
    return [(tuple(page.mediabox), tuple(page.cropbox), page.rotation) for page in doc]


def read_payload(doc):
    indices = [i for i in range(doc.embfile_count())
               if doc.embfile_info(i).get('filename') == 'annotations.json']
    if len(indices) != 1:
        raise ValueError('Expected exactly one editable annotations.json attachment')
    return indices[0], json.loads(doc.embfile_get(indices[0]))


def save_copy(doc, output, verify):
    """Verify a temporary PDF before exposing the final output name."""
    output = Path(output).resolve()
    if output.exists():
        raise ValueError(f'Output already exists: {output}')
    if not output.parent.is_dir():
        raise ValueError(f'Output directory does not exist: {output.parent}')
    handle, temporary = tempfile.mkstemp(prefix='luotu-repair-', suffix='.pdf', dir=output.parent)
    os.close(handle)
    try:
        doc.save(temporary, garbage=0, deflate=True, no_new_id=True)
        with fitz.open(temporary) as reopened:
            verify(reopened)
        # Windows rename also rejects a concurrent pre-existing output.
        if output.exists():
            raise ValueError(f'Output already exists: {output}')
        os.rename(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def repair(editable_path, *, annotated_path=None, output_dir=None, pixel_cap=6000000,
           preferred_scale=1.25, factor=None):
    editable_path = Path(editable_path).resolve()
    annotated_path = Path(annotated_path).resolve() if annotated_path else None
    directory = Path(output_dir).resolve() if output_dir else editable_path.parent
    editable_output = directory / f'{editable_path.stem}-坐标修复.pdf'
    annotated_output = directory / f'{annotated_path.stem}-坐标修复.pdf' if annotated_path else None
    report_path = directory / f'{editable_path.stem}-修复报告.json'
    for output in [editable_output, annotated_output, report_path]:
        if output and output.exists():
            raise ValueError(f'Output already exists: {output}')
    if not directory.is_dir():
        raise ValueError(f'Output directory does not exist: {directory}')
    if pixel_cap <= 0 or not math.isfinite(preferred_scale) or preferred_scale <= 0:
        raise ValueError('Invalid cache rendering parameters')
    if factor is not None and (not math.isfinite(factor) or factor <= 0):
        raise ValueError('Invalid correction factor')
    inputs = [editable_path] + ([annotated_path] if annotated_path else [])
    hashes = {str(path): digest(path) for path in inputs}
    report = {'repairId': REPAIR_ID, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'inputSha256': hashes, 'pixelCap': pixel_cap, 'preferredRasterScale': preferred_scale,
              'explicitFactor': factor, 'pages': []}
    with fitz.open(editable_path) as editable:
        attachment_index, source = read_payload(editable)
        if source.get('coordinateRepair', {}).get('repairId') == REPAIR_ID:
            raise ValueError('This editable PDF has already been repaired')
        geometry = page_geometry(editable)
        repaired = copy.deepcopy(source)
        annotations = repaired.get('annotations')
        if not isinstance(annotations, list) or not annotations:
            raise ValueError('No editable annotations found')
        grouped = collections.defaultdict(list)
        for annotation in annotations:
            page = int(annotation.get('page', 1))
            if page < 1 or page > len(editable):
                raise ValueError(f'Invalid annotation page: {page}')
            if any(not isinstance(annotation.get(key), (int, float)) or
                   not math.isfinite(annotation[key]) for key in POSITION_KEYS):
                raise ValueError(f'Invalid annotation coordinates on page {page}')
            grouped[page].append(annotation)
        factors = {}
        for page_number, items in sorted(grouped.items()):
            page = editable[page_number - 1]
            if page.rotation or page.mediabox != page.cropbox:
                raise ValueError('This repair supports unrotated pages with matching MediaBox/CropBox')
            actual = scale_for_pixel_cap(page, preferred_scale, pixel_cap)
            multiplier = factor if factor is not None else preferred_scale / actual
            factors[page_number] = multiplier
            for annotation in items:
                for key in POSITION_KEYS:
                    annotation[key] *= multiplier
            report['pages'].append({'page': page_number, 'annotations': len(items),
                                    'actualRasterScale': actual, 'factor': multiplier})
        repaired['coordinateRepair'] = {key: value for key, value in report.items() if key != 'inputSha256'}
        repaired['coordinateRepair']['sourceSha256'] = hashes[str(editable_path)]
        encoded = json.dumps(repaired, ensure_ascii=False, separators=(',', ':')).encode('utf-8')

        # Prepare the optional flattened copy before writing either output.
        flattened = fitz.open(annotated_path) if annotated_path else None
        try:
            if flattened is not None:
                if page_geometry(flattened) != geometry:
                    raise ValueError('Editable and annotated PDF page geometries differ')
                if REPAIR_ID in (flattened.metadata.get('keywords') or ''):
                    raise ValueError('This annotated PDF has already been repaired')
                usage = collections.Counter(xref for page in flattened for xref in page.get_contents())
                for page_number, multiplier in factors.items():
                    page = flattened[page_number - 1]
                    streams = page.get_contents()
                    if not streams or usage[streams[-1]] != 1:
                        raise ValueError(f'Cannot isolate annotation layer on page {page_number}')
                    xref = streams[-1]
                    content = flattened.xref_stream(xref)
                    names = [image[7] for image in page.get_images(full=True)
                             if re.search(rb'/' + re.escape(image[7].encode('ascii')) + rb'\s+Do\b', content)]
                    if len(names) != 1 or len(re.findall(rb'\bDo\b', content)) != 1:
                        raise ValueError(f'Expected one isolated annotation image on page {page_number}')
                    # PDF coordinates point upwards. Scale around the visible
                    # top-left, so both PDF outputs use the same corrected points.
                    media = page.mediabox
                    tx, ty = (1 - multiplier) * media.x0, (1 - multiplier) * media.y1
                    prefix = f'q\n{multiplier:.12f} 0 0 {multiplier:.12f} {tx:.12f} {ty:.12f} cm\n'.encode('ascii')
                    flattened.update_stream(xref, prefix + content + b'\nQ\n')
                metadata = flattened.metadata
                metadata['keywords'] = ((metadata.get('keywords') or '') + ' ' + REPAIR_ID).strip()
                flattened.set_metadata(metadata)
            # Preserve the Filespec and its references. Updating the stream
            # directly also avoids the bytes-buffer bug in PyMuPDF 1.28's
            # embfile_upd(item, bytes) implementation.
            attachment_xref = editable.embfile_upd(attachment_index)
            if not isinstance(attachment_xref, int) or attachment_xref <= 0:
                raise ValueError('This script requires a PyMuPDF version returning the attachment stream xref')
            editable.update_stream(attachment_xref, encoded)
            editable.xref_set_key(attachment_xref, 'DL', str(len(encoded)))
            editable.xref_set_key(attachment_xref, 'Params/Size', str(len(encoded)))
            if editable.xref_get_key(attachment_xref, 'Params/CheckSum')[0] != 'null':
                editable.xref_set_key(attachment_xref, 'Params/CheckSum', '<' + hashlib.md5(encoded).hexdigest() + '>')

            def verify_editable(doc):
                if page_geometry(doc) != geometry or read_payload(doc)[1] != repaired:
                    raise ValueError('Editable output validation failed')

            save_copy(editable, editable_output, verify_editable)
            if flattened is not None:
                def verify_flattened(doc):
                    if page_geometry(doc) != geometry or REPAIR_ID not in (doc.metadata.get('keywords') or ''):
                        raise ValueError('Annotated output validation failed')
                save_copy(flattened, annotated_output, verify_flattened)
        finally:
            if flattened is not None:
                flattened.close()
    if any(digest(path) != hashes[str(path)] for path in inputs):
        raise ValueError('An input PDF changed during repair')
    report.update({'editableOutput': str(editable_output),
                   'annotatedOutput': str(annotated_output) if annotated_output else None,
                   'annotationCount': len(annotations), 'inputFilesUnchanged': True,
                   'editablePayloadVerified': True})
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('editable')
    parser.add_argument('--annotated')
    parser.add_argument('--output-dir')
    parser.add_argument('--pixel-cap', type=int, default=6000000)
    parser.add_argument('--preferred-scale', type=float, default=1.25)
    parser.add_argument('--factor', type=float, help='Override the per-page factor after independent verification')
    args = parser.parse_args()
    result = repair(args.editable, annotated_path=args.annotated, output_dir=args.output_dir,
                    pixel_cap=args.pixel_cap, preferred_scale=args.preferred_scale, factor=args.factor)
    print(json.dumps({key: value for key, value in result.items() if key != 'pages'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
