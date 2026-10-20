import {optimizePdfExport} from './optimizePdfExport';

const original = new Blob(['original file']);
const health = {ok: true, json: async () => ({available: true, maxBytes: 1000})};
test('unavailable service preserves exact input without uploading it', async () => {
  const fetchImpl = jest.fn(async () => ({ok: false}));
  const result = await optimizePdfExport(original, {fetchImpl});
  expect(result.blob).toBe(original); expect(result.warning).toBeTruthy(); expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test('failed validation preserves input', async () => {
  const fetchImpl = jest.fn().mockResolvedValueOnce(health).mockResolvedValueOnce({ok: false, status: 422});
  expect((await optimizePdfExport(original, {fetchImpl})).blob).toBe(original);
});
test('successful rewrite uses smaller PDF and no-gain response preserves original', async () => {
  const smaller = new Blob(['%PDF']);
  const fetchImpl = jest.fn().mockResolvedValueOnce(health).mockResolvedValueOnce({ok: true, status: 200,
    headers: {get: () => 'application/pdf'}, blob: async () => smaller});
  expect((await optimizePdfExport(original, {fetchImpl})).blob).toBe(smaller);
  fetchImpl.mockResolvedValueOnce(health).mockResolvedValueOnce({status: 204});
  expect((await optimizePdfExport(original, {fetchImpl})).blob).toBe(original);
});
