// Admin actions must reach a live tool loop, not a cached answer or text-only
// knowledge shortcut. Backup banners are presentation, not conversation state.
export function canAnswerFromKnowledge(surface) { return surface !== 'admin'; }
export function stripBackupBanner(text) {
  return String(text || '').replace(/^(?:\s*[_*]\(Running on (?:backup[^\n]*|Groq backup)\)[_*]\s*)+/i, '').trim();
}
export function cleanBackupHistory(messages) {
  return messages.map(m => m?.role !== 'assistant' ? m : {
    ...m, content: typeof m.content === 'string' ? stripBackupBanner(m.content)
      : Array.isArray(m.content) ? m.content.map(b => b?.type === 'text' ? { ...b, text: stripBackupBanner(b.text) } : b) : m.content,
  });
}
