# Openwhispr

Asistente de reuniones **local-first** de código abierto: captura de audio (micrófono y/o sistema), transcripción en vivo con **whisper.cpp**, y opción de refinado local con Ollama/Gemma. Funciona en **macOS** y **Windows** mediante **Electron**.

## Requisitos (resumen)

- **Node.js** (LTS recomendado) y npm
- **ffmpeg** instalado y en el `PATH`
- **whisper.cpp**: binario `whisper-cli` construido localmente y al menos un modelo GGML (el proyecto incluye scripts de ayuda, p. ej. `npm run whisper:setup:turbo`)
- **Permisos** de micrófono y, si aplica, captura de pantalla/audio del sistema según la plataforma
- *(Opcional)* **Ollama** con un modelo compatible (p. ej. Gemma) para texto refinado fuera del modo safe-baseline

Tras clonar: `npm install` → seguir los scripts `whisper:*` y `polisher:*` en `package.json` para verificar el entorno.

## Desarrollo

```bash
npm install
npm run dev
```

```bash
npm run typecheck
npm run build
```

## Licencia

MIT — ver [LICENSE](LICENSE).
