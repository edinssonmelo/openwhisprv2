# Openwhispr

Aplicación de escritorio para **transcribir voz en tu propia máquina**. El audio no se envía a la nube: la transcripción la hace **Whisper** (vía whisper.cpp) de forma local.

**“Casi en tiempo real”** aquí significa: la app escucha el micrófono (y, si podés, el audio del sistema), detecta **cuándo termina un tramo de habla** (silencio / VAD) y entonces manda ese **segmento** al motor. No es subtitulado palabra a palabra al milisegundo; el retardo depende de la duración del segmento y del tiempo que tarde Whisper en procesarlo.

```
  Voz  ──▶  Openwhispr  ──▶  segmentos (pausas / VAD)  ──▶  whisper.cpp (local)  ──▶  texto en pantalla
```

---

## Instalación del proyecto

```bash
npm install
npm run dev
```

**Importante:** al clonar el repo **no** tenés el modelo de Whisper ni el binario `whisper-cli`. Son archivos grandes y se generan en tu PC. Sin ese paso, la app no puede transcribir.

### Modelo y motor (obligatorio para transcribir)

1. **Herramientas en el sistema:** [Node.js](https://nodejs.org/) (LTS), **git**, **cmake**, compilador C++ acorde a tu OS, y **ffmpeg** en el `PATH`.
2. **Compilar whisper.cpp y descargar un modelo base** (clona en `.local/whisper.cpp/` y arma `whisper-cli`):

   ```bash
   npm run whisper:setup
   ```

3. **Descargar el modelo grande usado por defecto** (Large V3 Turbo → `.local/models/ggml-large-v3-turbo.bin`):

   ```bash
   npm run whisper:setup:turbo
   ```

4. **Comprobar** que ffmpeg, CLI y modelo se ven bien:

   ```bash
   npm run whisper:check
   ```

Si algo falla, el propio comando indica qué falta.

**Permisos:** micrófono y, si usás captura de sistema, lo que pida el SO para pantalla/audio.

---

## Desarrollo y build

```bash
npm run typecheck
npm run build
```

En código existe un modo más experimental (`SAFE_BASELINE = false`) con refinado opcional por **Ollama** en local; el flujo habitual es baseline local sin eso.

### V2: Whisper principal, Qwen comparativo y refinado

La recomendación actual para español conversacional es usar Whisper Large V3 Turbo como ASR principal. Qwen3-ASR queda como motor secundario para comparación y Gemma/Ollama puede refinar puntuación en una capa separada:

```bash
npm run dev:v2:whisper
npm run dev:v2:compare
npm run dev:v2:refine
npm run qwen:check -- recordings/tmp/final-seg-1778125017430-fgapizy-62903-82688.wav
```

Variables principales:

- `ASR_FINAL_ENGINE=whisper | qwen | compare` (default: `whisper`)
- `TRANSCRIPT_REFINEMENT_MODE=off | whisper-only | whisper-qwen` (default: `off`)
- `TRANSCRIPT_REFINER_MODEL=gemma3:4b`

Comando manual para Qwen:

```bash
QWEN3_ASR_MODEL=".local/qwen-asr/Qwen3-ASR-1.7B-8bit" \
QWEN3_ASR_LANGUAGE="Spanish" \
.venv-qwen-asr/bin/python scripts/asr_qwen3_final.py recordings/tmp/final-seg-1778125017430-fgapizy-62903-82688.wav
```

### Preview v2 con Moonshine (opcional)

Moonshine está apagado por defecto. Para probarlo explícitamente como preview experimental:

```bash
python3 -m venv .venv-moonshine
.venv-moonshine/bin/python -m pip install -r requirements-moonshine.txt
.venv-moonshine/bin/python scripts/asr_moonshine_preview.py .venv-moonshine/lib/python3.13/site-packages/moonshine_voice/assets/two_cities.wav
ASR_PIPELINE_MODE=moonshine-qwen-v2 \
ENABLE_EXPERIMENTAL_PREVIEW=true \
MOONSHINE_ASR_CMD=".venv-moonshine/bin/python scripts/asr_moonshine_preview.py" \
npm run dev
```

---

## Licencia

MIT — ver [LICENSE](LICENSE).
