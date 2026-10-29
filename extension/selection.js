// Returns the selected text in a tab, checking every frame and focused text fields.
export async function getSelectionText(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const el = document.activeElement;
      const isField = el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text'));
      if (isField && el.selectionStart !== el.selectionEnd) {
        return el.value.slice(el.selectionStart, el.selectionEnd);
      }
      return window.getSelection()?.toString() ?? '';
    },
  });
  return results.map((r) => r.result).find((t) => t && t.trim()) ?? '';
}
