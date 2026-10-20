import {loadCloudAnnotationDraft, saveCloudAnnotationDraft} from './annotationCloudDraftStore';

const originalFetch = global.fetch;
beforeEach(() => {global.fetch = jest.fn(); window.localStorage.clear();});
afterEach(() => {global.fetch = originalFetch;});
const reply = data => ({ok: true, status: 200, text: async () => JSON.stringify(data)});
test('existing read responses containing a draft remain compatible without a success field', async () => {
  global.fetch.mockResolvedValue(reply({draft: {annotations: [{id: 1}]}}));
  await expect(loadCloudAnnotationDraft('original', 'web_original')).resolves.toEqual({annotations: [{id: 1}]});
  expect(global.fetch.mock.calls[0][0]).toBe('/api/annotation-drafts/latest?userKey=web_original&fingerprint=original');
});
test('a save still requires explicit success and retains the existing endpoint', async () => {
  global.fetch.mockResolvedValueOnce(reply({}));
  await expect(saveCloudAnnotationDraft({fileInfo: {fingerprint: 'a', recoveryUserKey: 'web_original'}, annotations: []})).rejects.toThrow('未确认');
  global.fetch.mockResolvedValueOnce(reply({success: true}));
  await expect(saveCloudAnnotationDraft({fileInfo: {fingerprint: 'a', recoveryUserKey: 'web_original'}, annotations: []})).resolves.toEqual({success: true});
  expect(global.fetch.mock.calls[1][0]).toBe('/api/annotation-drafts/save');
  expect(JSON.parse(global.fetch.mock.calls[1][1].body).userKey).toBe('web_original');
});
