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

---

## Licencia

MIT — ver [LICENSE](LICENSE).
