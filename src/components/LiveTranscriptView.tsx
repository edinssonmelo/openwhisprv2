interface LiveTranscriptViewProps {
  committedText: string;
  previewSuffix: string;
  rawPreview?: string;
  showDebug?: boolean;
  pipelineLabel?: string;
}

export function LiveTranscriptView({
  committedText,
  previewSuffix,
  rawPreview = '',
  showDebug = false,
  pipelineLabel = 'Transcript',
}: LiveTranscriptViewProps) {
  const hasText = committedText.trim() || previewSuffix.trim();

  return (
    <div className="v2-live-transcript-view">
      <div className="v2-live-transcript-label">{pipelineLabel}</div>
      <p className={hasText ? 'v2-live-transcript-text' : 'v2-live-transcript-text empty-clean'}>
        {committedText.trim() ? <span>{committedText}</span> : null}
        {previewSuffix.trim() ? (
          <>
            {committedText.trim() ? ' ' : null}
            <span className="v2-preview-suffix">{previewSuffix}</span>
          </>
        ) : null}
        {!hasText ? 'Sin texto en la demo todavía.' : null}
      </p>
      {showDebug && (
        <div className="v2-raw-preview-debug">
          <span>rawPreview</span>
          <code>{rawPreview.trim() || '-'}</code>
        </div>
      )}
    </div>
  );
}
