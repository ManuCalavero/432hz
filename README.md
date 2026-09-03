# cooler

App MVP para subir un archivo de audio, retunarlo manteniendo la duracion, y descargar el resultado en WAV y MP3.

Incluye:

- Cola de procesamiento secuencial (jobs en memoria).
- El estado de cada conversión se mantiene solo en memoria durante la sesión.

## Requisitos

- Node.js 18+

`ffmpeg` no se instala globalmente: la app usa `ffmpeg-static`.

## Instalacion

```bash
npm install
```

## Ejecutar

```bash
npm start
```

Abre:

- `http://localhost:3000`

## Flujo de conversion

1. El usuario arrastra o selecciona un archivo de audio.
2. Se valida el formato y la duracion del archivo.
3. Se encola un job.
4. Se aplica retune global con perfil de afinacion:

- `original`: 440 -> 440 Hz (sin transformacion de afinacion)
- `exact`: 440 -> 432 Hz

Filtro actual (alta calidad con resampler SoX):

```text
asetrate=44100*(targetA4/440),aresample=44100:resampler=soxr:precision=28:cheby=1,atempo=440/targetA4
```

5. Se exporta WAV PCM 16-bit 44.1 kHz.
6. Se exporta MP3 320 kbps 44.1 kHz.
7. El resultado se muestra durante la sesión y no se guarda ningún historial.

## API principal

- `POST /api/jobs` crea job multipart con campos `audio` y `tuningMode=original|exact`
- `GET /api/jobs/:id` consulta estado y enlaces de descarga si esta completado
- `GET /api/download/:id/wav` descarga WAV
- `GET /api/download/:id/mp3` descarga MP3
- `GET /health` estado de servicio

## Estructura

- `src/server.js`: API, estados y cola
- `src/audio.js`: descarga y conversion ffmpeg
- `src/store.js`: estado temporal de los jobs en memoria
- `public/`: interfaz web

## Notas importantes

- La cola y el estado de los jobs son temporales; al cerrar la aplicación no se conserva ningún registro.
- Este MVP asume acceso permitido a contenido de YouTube y no gestiona aspectos legales/licencias.
- Se limita la duracion maxima del audio a 60 minutos.
- No requiere instalar `ffmpeg` en el equipo del usuario final (se usa `ffmpeg-static`).
