import { fileAdapter } from './fileAdapter';

jest.mock('../utils/platformDetect', () => ({ isElectron: () => false, hasElectronAPI: () => false }));
jest.mock('antd', () => ({ message: { info: jest.fn() } }));

beforeEach(() => {
  jest.useFakeTimers();
  fileAdapter.fileHandle = null;
  URL.createObjectURL = jest.fn(() => 'blob:test-pdf');
  URL.revokeObjectURL = jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); delete window.showSaveFilePicker; });

test('browser download is reported as unconfirmed and its URL survives immediate handoff', async () => {
  const result = await fileAdapter.savePDF(new Uint8Array([1, 2]), 'drawing.pdf');
  expect(result.saveMethod).toBe('download');
  expect(result.message).toContain('已发起下载');
  jest.advanceTimersByTime(150);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  jest.advanceTimersByTime(59850);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-pdf');
});

test('only successful writable close reports confirmed original save', async () => {
  const writable = { write: jest.fn(), close: jest.fn() };
  fileAdapter.fileHandle = { name: 'drawing.pdf', createWritable: async () => writable };
  const result = await fileAdapter.savePDF(new Uint8Array([1]));
  expect(writable.close).toHaveBeenCalledTimes(1);
  expect(result.saveMethod).toBe('original');
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

test('failed disk write falls back to an unconfirmed download', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  fileAdapter.fileHandle = { createWritable: async () => { throw new Error('disk unavailable'); } };
  const result = await fileAdapter.savePDF(new Uint8Array([1]));
  expect(result.saveMethod).toBe('download');
});
