import { useCallback, useState } from 'react';
import {
  markOnboardingComplete,
  setOnboardingSystemSkipped,
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

  const stepIndex = STEPS.findIndex((s) => s.id === step);

  const tryMic = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((t) => t.stop());
      setMic('ok');
    } catch (e) {
      setMic('error');
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
      setOnboardingSystemSkipped(false);
    } catch (e) {
      setSystem('error');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const skipSystem = useCallback(() => {
    setSystem('skipped');
    setOnboardingSystemSkipped(true);
    setError(null);
    setStep('ready');
  }, []);

  const finish = useCallback(() => {
    markOnboardingComplete();
    onFinished();
  }, [onFinished]);

  const goSystem = useCallback(() => {
    setError(null);
    setStep('system');
  }, []);

  return (
    <div className="ob-scrim" role="dialog" aria-modal="true" aria-labelledby="ob-title">
      <div className="ob-modal">
        <header className="ob-header">
          <p className="ob-kicker">Openwhispr</p>
          <p className="ob-header-sub">Configuración rápida · solo en tu equipo</p>
          <div className="ob-stepper" aria-hidden>
            {STEPS.map((s, i) => (
              <div key={s.id} className="ob-stepper-item">
                <StepDot active={i === stepIndex} done={i < stepIndex} />
                <span className={`ob-stepper-label ${i === stepIndex ? 'ob-stepper-label--on' : ''}`}>{s.label}</span>
              </div>
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
              </p>
              <div className={`ob-chip ob-chip--${mic === 'ok' ? 'ok' : mic === 'error' ? 'err' : 'idle'}`}>
                {mic === 'idle' && 'Sin comprobar'}
                {mic === 'ok' && 'Micrófono listo'}
                {mic === 'error' && 'No se pudo activar'}
              </div>
              {mic === 'error' && error ? <p className="ob-error">{error}</p> : null}
              <div className="ob-actions">
                <button type="button" className="ob-btn ob-btn-primary" disabled={busy} onClick={() => void tryMic()}>
                  {busy ? 'Comprobando…' : 'Permitir micrófono'}
                </button>
                <button
                  type="button"
                  className="ob-btn ob-btn-secondary"
                  disabled={busy || mic !== 'ok'}
                  onClick={goSystem}
                >
                  Continuar
                </button>
                {mic === 'error' ? (
                  <button type="button" className="ob-btn ob-btn-ghost" disabled={busy} onClick={goSystem}>
                    Configurar después →
                  </button>
                ) : null}
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
                En macOS, si no ves audio del sistema, suele hacer falta un dispositivo virtual (p. ej. BlackHole) y
                enrutar el audio. Puedes saltar este paso y configurarlo después en Ajustes.
              </p>
              <div className={`ob-chip ob-chip--${system === 'ok' ? 'ok' : system === 'error' ? 'err' : system === 'skipped' ? 'skip' : 'idle'}`}>
                {system === 'idle' && 'Sin comprobar'}
                {system === 'ok' && 'Captura de sistema lista'}
                {system === 'error' && 'Sin permiso o cancelado'}
                {system === 'skipped' && 'Omitido'}
              </div>
              {system === 'error' && error ? <p className="ob-error">{error}</p> : null}
              <div className="ob-actions">
                <button type="button" className="ob-btn ob-btn-primary" disabled={busy} onClick={() => void trySystem()}>
                  {busy ? 'Abriendo selector…' : 'Probar captura de sistema'}
                </button>
                <button type="button" className="ob-btn ob-btn-secondary" disabled={busy} onClick={skipSystem}>
                  Omitir por ahora
                </button>
                <button
                  type="button"
                  className="ob-btn ob-btn-ghost"
                  disabled={system !== 'ok' && system !== 'error' && system !== 'skipped'}
                  onClick={() => setStep('ready')}
                >
                  Ver resumen →
                </button>
              </div>
            </>
          )}

          {step === 'ready' && (
            <>
              <h1 id="ob-title" className="ob-title">
                Todo preparado
              </h1>
              <p className="ob-desc">Resumen local (nada se envía a la nube en este paso).</p>
              <ul className="ob-summary">
                <li>
                  <span className="ob-summary-label">Micrófono</span>
                  <span className={`ob-summary-val ob-summary-val--${mic === 'ok' ? 'ok' : 'no'}`}>
                    {mic === 'ok' ? 'Listo' : 'Pendiente / omitido'}
                  </span>
                </li>
                <li>
                  <span className="ob-summary-label">Audio del sistema</span>
                  <span className={`ob-summary-val ob-summary-val--${system === 'ok' ? 'ok' : 'no'}`}>
                    {system === 'ok' ? 'Listo' : system === 'skipped' ? 'Omitido' : 'Pendiente'}
                  </span>
                </li>
                <li>
                  <span className="ob-summary-label">Whisper</span>
                  <span className={`ob-summary-val ob-summary-val--${whisperOk ? 'ok' : 'no'}`}>
                    {whisperOk ? 'Listo' : whisperMessage}
                  </span>
                </li>
                <li>
                  <span className="ob-summary-label">Asistente IA</span>
                  <span className={`ob-summary-val ob-summary-val--${aiOk ? 'ok' : 'no'}`}>
                    {aiOk ? 'Listo' : `Opcional · ${aiMessage}`}
                  </span>
                </li>
              </ul>
              <button type="button" className="ob-btn ob-btn-primary ob-btn-wide" onClick={finish}>
                Ir al panel principal
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
