/** Copia texto en Electron y en el navegador, con varios fallbacks. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;

  try {
    if (typeof window !== 'undefined' && window.meetingAssistant?.clipboard?.writeText) {
      const r = await window.meetingAssistant.clipboard.writeText(trimmed);
      if (r?.ok) return true;
    }
  } catch {
    /* seguir con otros métodos */
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(trimmed);
      return true;
    }
  } catch {
    /* execCommand fallback */
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = trimmed;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
