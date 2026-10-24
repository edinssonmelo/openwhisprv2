import { useCallback, useEffect, useState } from 'react';
import {
  markOnboardingComplete,
  persistPermissionRecord,
  setOnboardingSystemSkipped,
  type PermissionState,
} from '../storage/appPreferences';

type Step = 'mic' | 'system' | 'ready';

type CheckState = 'idle' | 'ok' | 'skipped' | 'error';

interface SetupOnboardingProps {
  onFinished: () => void;
  whisperOk: boolean;
  whisperMessage: string;
  aiOk: boolean;
  aiMessage: string;
}

const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'mic', label: 'Micrófono' },
  { id: 'system', label: 'Sistema' },
  { id: 'ready', label: 'Listo' },
];

function StepDot({ active, done }: { active: boolean; done: boolean }) {
  return (
    <span
      className={`ob-step-dot ${done ? 'ob-step-dot--done' : ''} ${active ? 'ob-step-dot--active' : ''}`}
      aria-hidden
    />
  );
}

export function SetupOnboarding({
  onFinished,
  whisperOk,
  whisperMessage,
  aiOk,
  aiMessage,
}: SetupOnboardingProps) {
  const [step, setStep] = useState<Step>('mic');
  const [mic, setMic] = useState<CheckState>('idle');
  const [system, setSystem] = useState<CheckState>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doNotShowAgain, setDoNotShowAgain] = useState(true);

  const stepIndex = STEPS.findIndex((s) => s.id === step);

  useEffect(() => {
    let cancelled = false;
    const checkExistingPermissions = async () => {
      let micState: PermissionState = 'unknown';
      let screenState: PermissionState = 'unknown';
      try {
        if (navigator.permissions?.query) {
          const micPermission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
          micState = micPermission.state;
          if (!cancelled && micPermission.state === 'granted') {
            setMic('ok');
            setStep('system');
          }
        }
      } catch {
        micState = 'unknown';
      }
      try {
        const info = await window.meetingAssistant.platform.getInfo();
        const screen = info.mediaAccess?.screen;
        if (screen === 'granted' || screen === 'denied' || screen === 'prompt') {
          screenState = screen;
          if (!cancelled && screen === 'granted') setSystem('ok');
        }
      } catch {
        screenState = 'unknown';
      }
      persistPermissionRecord({ microphone: micState, screenCapture: screenState, systemAudio: screenState });
    };
    void checkExistingPermissions();
    return () => {
      cancelled = true;
    };
  }, []);

  const tryMic = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const access = await window.meetingAssistant.audio.ensureMicrophoneAccess();
      if (!access.ok && access.status !== 'n/a') {
        setMic('error');
        persistPermissionRecord({ microphone: 'denied' });
        setError(
          access.status === 'denied' || access.status === 'restricted'
            ? 'macOS bloqueó el micrófono. En Ajustes del Sistema → Privacidad y seguridad → Micrófono, activa Electron y vuelve a pulsar Permitir.'
            : `No se pudo pedir el micrófono (${access.status}).`,
        );
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((t) => t.stop());
      setMic('ok');
      persistPermissionRecord({ microphone: 'granted' });
      setStep('system');
    } catch (e) {
      setMic('error');
      persistPermissionRecord({ microphone: 'denied' });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const trySystem = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      } as MediaStreamConstraints);
      stream.getTracks().forEach((t) => t.stop());
      setSystem('ok');
      persistPermissionRecord({ systemAudio: 'granted', screenCapture: 'granted' });
      setOnboardingSystemSkipped(false);
      setStep('ready');
    } catch {
      // User cancelled or permission denied – skip silently and advance
      setSystem('skipped');
      persistPermissionRecord({ systemAudio: 'prompt', screenCapture: 'prompt' });
      setOnboardingSystemSkipped(true);
      setStep('ready');
    } finally {
      setBusy(false);
    }
  }, []);

  const skipSystem = useCallback(() => {
    setSystem('skipped');
    persistPermissionRecord({ systemAudio: 'prompt', screenCapture: 'prompt' });
    setOnboardingSystemSkipped(true);
    setError(null);
    setStep('ready');
  }, []);

  const finish = useCallback(() => {
    if (doNotShowAgain) markOnboardingComplete();
    onFinished();
  }, [doNotShowAgain, onFinished]);

  const goSystem = useCallback(() => {
    setError(null);
    setStep('system');
  }, []);

  return (
    <div className="ob-scrim" role="dialog" aria-modal="true" aria-labelledby="ob-title">
      <div className="ob-modal">
        <header className="ob-header">
          <p className="ob-kicker">Openwhispr</p>
          <div className="ob-stepper" aria-hidden>
            {STEPS.map((s, i) => (
              <StepDot key={s.id} active={i === stepIndex} done={i < stepIndex} />
            ))}
          </div>
        </header>

        <div className="ob-body">
          {step === 'mic' && (
            <>
              <h1 id="ob-title" className="ob-title">
                Permite el micrófono
              </h1>
              <p className="ob-desc">
                Así podremos transcribir lo que digas en reuniones y sesiones. Solo se usa cuando inicias una sesión.
                La ventana se oculta un momento para que puedas pulsar Permitir en el aviso de macOS.
              </p>
              <div className={`ob-chip ob-chip--${mic === 'ok' ? 'ok' : mic === 'error' ? 'err' : 'idle'}`}>
                {mic === 'idle' && 'Sin comprobar'}
                {mic === 'ok' && 'Micrófono listo'}
                {mic === 'error' && 'No se pudo activar'}
              </div>
              {mic === 'error' && error ? <p className="ob-error">{error}</p> : null}
              <div className="ob-actions">
                <button
                  type="button"
                  className="ob-btn ob-btn-primary"
                  disabled={busy}
                  onClick={() => {
                    if (mic === 'ok') goSystem();
                    else void tryMic();
                  }}
                >
                  {busy ? 'Comprobando…' : mic === 'ok' ? 'Continuar' : 'Permitir micrófono'}
                </button>
                <button type="button" className="ob-btn ob-btn-ghost" onClick={goSystem}>
                  {mic === 'ok' ? 'Siguiente' : 'Configurar después'}
                </button>
              </div>
            </>
          )}

          {step === 'system' && (
            <>
              <h1 id="ob-title" className="ob-title">
                Audio del sistema
              </h1>
              <p className="ob-desc">
                Elige una ventana o pantalla <strong>y marca compartir audio</strong> si el navegador lo ofrece. Así
                capturamos llamadas y reuniones, no solo tu voz.
              </p>
              <p className="ob-tip">
                En macOS, si no ves la opción de audio, puede hacer falta un dispositivo virtual (p. ej. BlackHole).
                Si cancelas o no aplica, pasamos al siguiente paso automáticamente.
              </p>
              <div className={`ob-chip ob-chip--${system === 'ok' ? 'ok' : system === 'skipped' ? 'skip' : 'idle'}`}>
                {system === 'idle' && 'Sin comprobar'}
                {system === 'ok' && 'Captura de sistema lista'}
                {system === 'skipped' && 'Omitido'}
              </div>
              <div className="ob-actions">
                <button type="button" className="ob-btn ob-btn-primary" disabled={busy} onClick={() => void trySystem()}>
                  {busy ? 'Abriendo selector…' : system === 'ok' ? 'Permiso concedido' : 'Probar pantalla/audio'}
                </button>
                <button type="button" className="ob-btn ob-btn-secondary" disabled={busy} onClick={skipSystem}>
                  Omitir por ahora
                </button>
              </div>
            </>
          )}

          {step === 'ready' && (
            <>
              <h1 id="ob-title" className="ob-title">
                Todo listo
              </h1>
              <p className="ob-desc">Permisos registrados localmente. Puedes cambiarlos desde el sistema en cualquier momento.</p>
              <ul className="ob-summary">
                <li>
                  <span className="ob-summary-label">Micrófono</span>
                  <span className={`ob-summary-val ob-summary-val--${mic === 'ok' ? 'ok' : 'no'}`}>
                    {mic === 'ok' ? 'Listo' : 'Pendiente'}
                  </span>
                </li>
                <li>
                  <span className="ob-summary-label">Audio del sistema</span>
                  <span className={`ob-summary-val ob-summary-val--${system === 'ok' ? 'ok' : 'no'}`}>
                    {system === 'ok' ? 'Listo' : 'Omitido'}
                  </span>
                </li>
              </ul>
              <label className="ob-checkbox-row">
                <input
                  type="checkbox"
                  checked={doNotShowAgain}
                  onChange={(event) => setDoNotShowAgain(event.target.checked)}
                />
                <span>No volver a mostrar</span>
              </label>
              <div className="ob-actions">
                <button type="button" className="ob-btn ob-btn-primary ob-btn-wide" onClick={finish}>
                  Ir al panel
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
