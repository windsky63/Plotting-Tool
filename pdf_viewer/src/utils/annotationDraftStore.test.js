import {
  loadLatestAnnotationDraft,
  saveEmergencyAnnotationDraft,
  saveLatestAnnotationDraft
} from './annotationDraftStore';

describe('annotation draft emergency recovery', () => {
  test('recovers the synchronous shadow copy when IndexedDB cannot commit', async () => {
    window.localStorage.clear();
    const originalIndexedDb = window.indexedDB;
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: { open: () => { throw new Error('simulated close during IndexedDB open'); } }
    });

    const draft = {
      fileInfo: { name: 'sample.pdf', fingerprint: 'sample' },
      annotations: [{ id: 'a1', text: '12', fontSize: 24 }],
      updatedAt: '2026-09-15T12:00:00.000Z'
    };

    expect(saveEmergencyAnnotationDraft(draft)).toBe(true);
    await expect(saveLatestAnnotationDraft(draft)).rejects.toThrow('simulated close');
    await expect(loadLatestAnnotationDraft()).resolves.toMatchObject({
      dirty: true,
      annotations: [{ id: 'a1', text: '12', fontSize: 24 }]
    });

    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: originalIndexedDb
    });
  });
});
