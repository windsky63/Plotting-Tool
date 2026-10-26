import copy
import json
from pathlib import Path
import tempfile
import unittest

import fitz

from repair_annotation_cache_scale import REPAIR_ID, read_payload, repair
from render_pdf_page_cache import scale_for_pixel_cap


class RepairAnnotationCacheScaleTest(unittest.TestCase):
    def setUp(self):
        self.runtime = (Path(__file__).resolve().parent.parent / 'runtime').resolve()
        self.runtime.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='repair-test-', dir=self.runtime)
        self.directory = Path(self.temporary.name).resolve()
        self.editable = self.directory / 'editable.pdf'
        self.annotated = self.directory / 'annotated.pdf'
        base = fitz.open()
        base.new_page(width=1190.88, height=841.68)
        page = base.new_page(width=2383.94, height=1683.78)
        page.draw_line(fitz.Point(1200, 700), fitz.Point(1250, 725), width=2)
        self.factor = 1.25 / scale_for_pixel_cap(page, 1.25, 6000000)
        self.annotation = {'id': 'retained-id', 'page': 2, 'text': '12', 'borderShape': 'circle',
                           'startX': 2400 / self.factor, 'startY': 1400 / self.factor,
                           'endX': 2400 / self.factor, 'endY': 1400 / self.factor,
                           'fontSize': 40, 'frameSize': 113.52, 'color': '#FF0000', 'hasLeaderLine': False}
        self.payload = {'version': '1.0', 'timestamp': '2026-10-25T07:25:06.995Z',
                        'annotations': [copy.deepcopy(self.annotation)]}
        with fitz.open(stream=base.tobytes(), filetype='pdf') as editable:
            editable.embfile_add('annotations.json', json.dumps(self.payload).encode(), filename='annotations.json')
            editable.save(self.editable)
        overlay = fitz.open()
        raster = overlay.new_page(width=page.rect.width, height=page.rect.height)
        raster.draw_circle(fitz.Point(1200 / self.factor, 700 / self.factor), 4, color=(1, 0, 0), fill=(1, 0, 0))
        page.insert_image(page.rect, stream=raster.get_pixmap(matrix=fitz.Matrix(1, 1), alpha=True).tobytes('png'))
        base.save(self.annotated)
        overlay.close()
        base.close()

    def tearDown(self):
        self.assertTrue(self.directory.is_relative_to(self.runtime))
        self.temporary.cleanup()

    def test_repairs_both_outputs_preserving_metadata_and_originals(self):
        result = repair(self.editable, annotated_path=self.annotated)
        self.assertTrue(result['inputFilesUnchanged'])
        with fitz.open(result['editableOutput']) as output:
            _, payload = read_payload(output)
            item = payload['annotations'][0]
            self.assertAlmostEqual(item['startX'], 2400)
            self.assertAlmostEqual(item['startY'], 1400)
            for key in ('id', 'text', 'fontSize', 'frameSize', 'color', 'page'):
                self.assertEqual(item[key], self.annotation[key])
            self.assertEqual(payload['timestamp'], self.payload['timestamp'])
            self.assertEqual(payload['coordinateRepair']['repairId'], REPAIR_ID)
            self.assertEqual(len(output), 2)
        with fitz.open(result['annotatedOutput']) as output:
            # The red marker has actually moved onto the original pipe anchor.
            pix = output[1].get_pixmap(matrix=fitz.Matrix(2, 2), clip=fitz.Rect(1199, 699, 1201, 701))
            pixels = list(zip(*[iter(pix.samples)] * 3))
            self.assertTrue(any(red > 200 and green < 80 and blue < 80 for red, green, blue in pixels))
        with fitz.open(self.editable) as original:
            self.assertEqual(read_payload(original)[1], self.payload)

    def test_rejects_existing_outputs_and_repeat_repairs(self):
        result = repair(self.editable)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            repair(self.editable)
        with self.assertRaisesRegex(ValueError, 'already been repaired'):
            repair(result['editableOutput'])

    def test_rejects_mismatched_annotated_document_before_writing(self):
        wrong = self.directory / 'wrong.pdf'
        with fitz.open() as doc:
            doc.new_page()
            doc.save(wrong)
        with self.assertRaisesRegex(ValueError, 'geometries differ'):
            repair(self.editable, annotated_path=wrong)
        self.assertFalse((self.directory / 'editable-坐标修复.pdf').exists())


if __name__ == '__main__':
    unittest.main()
