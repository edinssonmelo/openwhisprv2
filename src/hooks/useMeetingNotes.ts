import { useEffect, useRef, useState } from 'react';
import { loadMeetingNoteText, saveMeetingNoteText } from '../utils/meetingNotesStorage';

export type MeetingNotesSaveStatus = 'idle' | 'saving' | 'saved';

export function useMeetingNotes(sessionId: string | null) {
  const [text, setText] = useState('');
  const [saveStatus, setSaveStatus] = useState<MeetingNotesSaveStatus>('idle');
  const hydrateRef = useRef(true);

  useEffect(() => {
    if (!sessionId) {
      setText('');
      setSaveStatus('idle');
      hydrateRef.current = true;
      return;
    }
    setText(loadMeetingNoteText(sessionId));
    setSaveStatus('idle');
    hydrateRef.current = true;
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    if (hydrateRef.current) {
      hydrateRef.current = false;
      return;
    }
    setSaveStatus('saving');
    const t = window.setTimeout(() => {
      saveMeetingNoteText(sessionId, text);
      setSaveStatus('saved');
    }, 350);
    return () => window.clearTimeout(t);
  }, [text, sessionId]);

  useEffect(() => {
    if (saveStatus !== 'saved') return;
    const t = window.setTimeout(() => setSaveStatus('idle'), 1100);
    return () => window.clearTimeout(t);
  }, [saveStatus]);

  return { text, setText, saveStatus };
}
