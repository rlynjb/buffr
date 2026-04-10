---
title: bug--manual-actions
category: docs
---
# buffr — Bug Reports: Manual Actions

> Three bugs in the Next Actions feature, all sharing the same root pattern:
> optimistic UI update followed by a fire-and-forget API call with no rollback on failure.

---

## Bug 1: Edit loses changes silently on server failure

### Feature
Manual Actions — inline edit

### Environment
Any browser. Occurs when the Netlify Function returns an error (network failure, Blob write failure, function timeout) during a PUT to `/manual-actions`.

### Data model
```typescript
// Backend — netlify/functions/lib/storage/manual-actions.ts
interface ManualAction {
  id: string;
  text: string;
  done: boolean;
}
// Stored as JSON array in a single Netlify Blob keyed by projectId
```

### Steps to reproduce
1. Open a project with existing manual actions
2. Click on an action's text to enter inline edit mode
3. Change the text (e.g., "Fix auth" → "Fix auth middleware")
4. Press Enter or blur the field to commit the edit
5. While the PUT request is in flight, simulate a network failure (DevTools → Network → Offline, or Netlify Function cold start timeout)
6. Observe the UI still shows "Fix auth middleware"
7. Reload the page
8. The action reverts to "Fix auth"

### Observed behaviour
The UI updates immediately on blur/Enter and stays showing the new text regardless of whether the server accepted the change. No error is shown to the user. The `console.error` fires but is invisible in production.

### Expected behaviour
On server failure, either:
- (a) Revert the action text to its pre-edit value and show an error notification, or
- (b) Keep the optimistic text but show a visible retry/error indicator on that action item

### Error output
```
// Console only — no user-visible feedback
Failed to edit manual action: TypeError: Failed to fetch
```

### Suspected cause
In `resume-card.tsx`, `handleEditManual` does an optimistic `setActions` update then fires `updateManualAction` in a catch-and-log pattern with no rollback:

```typescript
async function handleEditManual(id: string, text: string) {
  setActions((prev) => prev.map((a) => (a.id === id ? { ...a, text } : a)));
  try {
    await updateManualAction(project.id, id, { text });
  } catch (err) {
    console.error("Failed to edit manual action:", err);
    // ← no rollback of the optimistic update
  }
}
```

Compare with `handleAddManual` which correctly rolls back:
```typescript
} catch (err) {
  console.error("Failed to save manual action:", err);
  setActions((prev) => prev.filter((a) => a.id !== id)); // ← rollback
}
```

### Constraints
- Fix must follow the same optimistic UI pattern (don't add loading spinners that block editing)
- Must not change the data model
- Must not affect the add or delete flows
- Should use the existing `NotificationProvider` / `useNotification` for error feedback if adding user-visible errors

---

## Bug 2: Reorder reverts on reload after server failure

### Feature
Manual Actions — drag-and-drop reorder

### Environment
Any browser. Occurs when the PATCH to `/manual-actions` fails (network error, function timeout, Blob write failure).

### Data model
Same as Bug 1. The reorder endpoint receives `{ orderedIds: string[] }`, reads the full array from Blobs, rebuilds it in the new order, and writes the full array back.

### Steps to reproduce
1. Open a project with 3+ manual actions (e.g., A, B, C)
2. Drag action C above action A (new order: C, A, B)
3. While the PATCH is in flight, simulate network failure
4. UI shows order C, A, B
5. Reload the page
6. Actions revert to A, B, C

### Observed behaviour
The UI reorders immediately and stays in the new order for the rest of the session. The failed PATCH is silently swallowed. On reload, the server's stored order (unchanged) is loaded, causing a jarring revert.

### Expected behaviour
On server failure, either:
- (a) Revert the list to the pre-drag order and show an error notification, or
- (b) Show a visible "unsaved" indicator and retry the reorder

### Error output
```
// No console output at all — the catch is empty
reorderManualActions(project.id, ids).catch(() => {});
```

### Suspected cause
In `resume-card.tsx`, `handleReorder` fires the API call inside the `setActions` updater callback with an empty catch:

```typescript
function handleReorder(fromIndex: number, toIndex: number) {
  setActions((prev) => {
    const next = [...prev];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    const ids = next.map((a) => a.id);
    reorderManualActions(project.id, ids).catch(() => {}); // ← silent swallow
    return next;
  });
}
```

Two problems:
1. The API call is fire-and-forget with no error handling at all
2. The API call is initiated inside the `setActions` updater function (a setState callback), which is a side effect in a place React expects to be pure — this won't cause bugs today but is an anti-pattern

### Constraints
- Fix must preserve the drag-and-drop UX (no loading states that block dragging)
- Must not change the data model or the PATCH endpoint contract
- Must not affect add, edit, or done flows
- The API call should be moved outside the setState updater

---

## Bug 3: Mark-done state lost on rapid toggling or server failure

### Feature
Manual Actions — mark done

### Environment
Any browser. Two trigger conditions:
- (a) Server failure on the PUT request
- (b) Rapid clicks on "Done" across multiple actions before prior PUTs resolve

### Data model
Same as Bug 1. The PUT endpoint reads the full action array, finds the action by ID, sets `done: true`, and writes the full array back. Each PUT is a full-array overwrite.

### Steps to reproduce

**Scenario A — Server failure:**
1. Open a project with actions
2. Click "Done" on an action
3. Simulate network failure during the PUT
4. UI shows the action as done (strikethrough, green border, opacity reduced)
5. Reload the page
6. Action reverts to not-done

**Scenario B — Rapid toggling (race condition):**
1. Open a project with 3 actions: A (not done), B (not done), C (not done)
2. Quickly click "Done" on A, then immediately "Done" on B (within ~200ms)
3. Two parallel PUT requests fire:
   - PUT 1: reads [A, B, C], marks A done, writes [A✓, B, C]
   - PUT 2: reads [A, B, C] (before PUT 1's write lands), marks B done, writes [A, B✓, C]
4. PUT 2 wins (last write), server has [A, B✓, C] — action A's done state is lost
5. Reload: A shows as not-done despite being marked done in the UI

### Observed behaviour
**Scenario A:** Action appears done in UI but reverts on reload. No error shown.
**Scenario B:** One or more actions silently revert to not-done on reload. The last PUT to land overwrites all prior PUTs because the backend does full-array replacement.

### Expected behaviour
**Scenario A:** On failure, revert the done state and show an error notification.
**Scenario B:** Either serialize the PUT requests (queue them) or use the server response to reconcile local state. The server response from each PUT returns the full updated array — the frontend should use it.

### Error output
```
// Scenario A — no console output, empty catch
updateManualAction(project.id, id, { done: true }).catch(() => {});

// Scenario B — no error at all, both PUTs succeed with 200
// The bug is a data race, not an error
```

### Suspected cause
In `resume-card.tsx`, `handleActionDone` uses the same fire-and-forget pattern:

```typescript
function handleActionDone(id: string) {
  setActions((prev) => prev.map((a) => (a.id === id ? { ...a, done: true } : a)));
  updateManualAction(project.id, id, { done: true }).catch(() => {});
}
```

Two issues:
1. No rollback on failure (same as Bug 1 and 2)
2. The backend reads the full array, mutates one item, and writes back — parallel requests create a read-modify-write race. The frontend ignores the server's response (which contains the authoritative array state)

Note that `handleDeleteManual` partially avoids the race by using the server response:
```typescript
const remaining = await deleteManualAction(project.id, id);
setActions(remaining); // ← reconciles with server state
```
But `handleActionDone` doesn't do this.

### Constraints
- Fix must not add visible loading states that block "Done" clicks
- Must not change the backend data model (full-array-in-one-blob is fine for now)
- Must not affect add, edit, or reorder flows
- Consider: should the fix reconcile local state from the PUT response (like delete does) to prevent the race?

---

## Shared Fix Pattern

All three bugs share the same pattern. A consistent fix across all three would:

1. **Capture pre-mutation state** before the optimistic update
2. **Await the API call** (not fire-and-forget)
3. **On success:** optionally reconcile with server response (the PUT and PATCH endpoints all return the full updated array)
4. **On failure:** revert to pre-mutation state and call `notify("error", "Failed to [action] — reverted")` using the existing `NotificationProvider`

The `handleAddManual` function already demonstrates the correct pattern for step 3's failure path. The `handleDeleteManual` function demonstrates reconciling with the server response on success. Combining both patterns gives the template:

```typescript
async function handleEditManual(id: string, text: string) {
  const previous = actions; // capture
  setActions((prev) => prev.map((a) => (a.id === id ? { ...a, text } : a))); // optimistic
  try {
    const updated = await updateManualAction(project.id, id, { text }); // await
    setActions(updated); // reconcile with server truth
  } catch (err) {
    console.error("Failed to edit manual action:", err);
    setActions(previous); // rollback
    notify("error", "Edit failed — reverted");
  }
}
```

This requires threading `notify` from `useNotification()` into the ResumeCard component (it's already available via the provider in `app-shell.tsx`).