# Privacidad y datos de Openwhispr

Openwhispr es **local-first**. El contenido de tus reuniones se queda en tu equipo.

## Qué se guarda localmente

En `app.getPath('userData')` y en el almacenamiento del navegador de la app:

- Sesiones y transcripciones de reuniones.
- Notas y resúmenes generados.
- Preferencias (modo de captura, tema, estrategia de audio, dispositivos).
- Estado de onboarding.
- `installId`: identificador anónimo de instalación (UUID), en `userData/telemetry.json`.

Los audios/grabaciones temporales viven en `recordings/` (empaquetada: bajo `userData`).

## Qué NO se envía nunca

- Audio de las reuniones.
- Transcripciones ni notas.
- Datos personales sensibles.

## Qué puede enviarse (solo si aceptas)

La telemetría es **opt-in**. Si la activas y hay un endpoint configurado, se envían eventos
anónimos: `installId`, nombre de evento, sistema operativo, versión de la app y timestamp.

El **feedback** es voluntario: solo se envía lo que escribes (mensaje, email opcional). Los logs
básicos solo se adjuntan si marcas explícitamente esa opción.

## Control del usuario

- Activar/desactivar métricas: `window.meetingAssistant.telemetry.setConsent(true|false)`.
  (Exponer un toggle en Ajustes es parte del wiring de UI recomendado.)
- Enviar feedback: `window.meetingAssistant.feedback.submit({ message, email?, includeLogs? })`
  o `feedback.openExternal()`.
- Borrar todos los datos locales: elimina la carpeta de datos de la app.

### Ubicación de los datos por plataforma

- **macOS**: `~/Library/Application Support/Openwhispr/`
- **Windows**: `%APPDATA%\Openwhispr\`

Borrar esa carpeta elimina sesiones, transcripciones, preferencias e `installId`.

## Permisos que pide la app (y por qué)

- **Micrófono**: para capturar tu voz durante la reunión.
- **Captura de audio del sistema / pantalla**: para transcribir a los demás participantes
  (audio que sale por tus altavoces). En macOS esto usa permisos de captura del sistema.

Sin estos permisos, Openwhispr no puede transcribir esa fuente de audio.

## Limitaciones actuales

- Beta, probada primero en macOS (Apple Silicon e Intel).
- Windows en camino.
- La captura de audio del sistema en macOS depende de permisos y, en algunos casos, de helpers
  nativos incluidos en la app.
