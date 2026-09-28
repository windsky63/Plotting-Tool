const POSITION_KEYS = ['startX', 'startY', 'endX', 'endY'];

export function buildAnnotationMoveTransaction(annotations, moves, isAutomatic = () => false) {
  const requested = new Map(moves.map(move => [move.id, move.updates]));
  const before = new Map();
  const after = new Map();
  const changedAnnotations = [];
  annotations.forEach(annotation => {
    const updates = requested.get(annotation.id);
    if (!updates || !POSITION_KEYS.every(key => Number.isFinite(updates[key]))) return;
    if (!POSITION_KEYS.some(key => annotation[key] !== updates[key])) return;
    const oldPatch = { qualityModified: annotation.qualityModified };
    const newPatch = { qualityModified: isAutomatic(annotation) ? true : annotation.qualityModified };
    POSITION_KEYS.forEach(key => { oldPatch[key] = annotation[key]; newPatch[key] = updates[key]; });
    before.set(annotation.id, oldPatch);
    after.set(annotation.id, newPatch);
    changedAnnotations.push(annotation);
  });
  return { before, after, changedAnnotations };
}

export function applyAnnotationMovePatches(annotations, patches) {
  let changed = false;
  const result = annotations.map(annotation => {
    const patch = patches.get(annotation.id);
    if (!patch || !Object.keys(patch).some(key => annotation[key] !== patch[key])) return annotation;
    changed = true;
    return { ...annotation, ...patch };
  });
  return changed ? result : annotations;
}
