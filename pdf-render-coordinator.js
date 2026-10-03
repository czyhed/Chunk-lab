const renderStates = new WeakMap();

function cancelState(state) {
  if (!state) return Promise.resolve();
  state.cancelled = true;
  for (const task of state.tasks) task.cancel();
  return Promise.allSettled([...state.tasks].map((task) => task.promise));
}

export function beginPdfRender(root) {
  const previous = renderStates.get(root);
  const state = { cancelled: false, tasks: new Set() };
  renderStates.set(root, state);
  return {
    waitForPrevious: cancelState(previous),
    get cancelled() { return state.cancelled || renderStates.get(root) !== state; },
    track(task) { state.tasks.add(task); },
    untrack(task) { state.tasks.delete(task); },
    complete() { if (renderStates.get(root) === state) renderStates.delete(root); },
  };
}

export function cancelPdfRender(root) {
  const state = renderStates.get(root);
  const settled = cancelState(state);
  void settled.then(() => {
    if (renderStates.get(root) === state) renderStates.delete(root);
  });
  return settled;
}
