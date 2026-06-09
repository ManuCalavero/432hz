# cooler

App MVP para pegar un enlace de YouTube, extraer solo audio, retunarlo manteniendo la duracion, y descargar el resultado en WAV y MP3.

Incluye:

- Cola de procesamiento secuencial (jobs en memoria).
- Logs persistentes en `data/jobs.json` con estado `ok/ko`, tiempos y errores.
- Interfaz web para usuario y tabla de logs de admin.

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

## Produccion (yt-dlp / YouTube)

YouTube puede requerir verificacion anti-bot en servidores. Si aparece el error
`Sign in to confirm you're not a bot`, configura una de estas variables de entorno:

- `YTDLP_COOKIES_FROM_BROWSER=chrome` (o `firefox`, `safari`, etc.)
- `YTDLP_COOKIES_FILE=/ruta/absoluta/a/cookies.txt`
- `YTDLP_COOKIES_B64=...` con el cookie file de Netscape codificado en base64

Si existen varias, la app prioriza `YTDLP_COOKIES_FROM_BROWSER`, luego `YTDLP_COOKIES_FILE` y por ultimo `YTDLP_COOKIES_B64`.

La app carga automaticamente un archivo `.env` al arrancar, asi que puedes definir
ahi estas variables en local o en despliegues que las soporten.

En Render o en cualquier hosting similar, configura las mismas variables en el panel
de entorno del servicio. No hace falta subir `.env`; usa `.env.example` como plantilla.

Opcional (si YouTube sigue devolviendo problemas de formatos en servidores):

- `YTDLP_EXTRACTOR_ARGS=youtube:player_client=android,web,ios`

La app ya usa ese valor por defecto, pero puedes sobreescribirlo desde entorno.

Abre:

- `http://localhost:3000`

## Flujo de conversion

1. El usuario pega URL de YouTube.
2. Se valida URL y metadatos basicos.
3. Se encola un job.
4. Worker descarga audio (`audioonly`).
5. Se aplica retune global con perfil de afinacion:

- `original`: 440 -> 440 Hz (sin transformacion de afinacion)
- `exact`: 440 -> 432 Hz

Filtro actual (alta calidad con resampler SoX):

```text
asetrate=44100*(targetA4/440),aresample=44100:resampler=soxr:precision=28:cheby=1,atempo=440/targetA4
```

6. Se exporta WAV PCM 16-bit 44.1 kHz.
7. Se exporta MP3 320 kbps 44.1 kHz.
8. Se guarda log final con resultado `ok/ko`.

## API principal

- `POST /api/jobs` crea job con body `{ "url": "...", "tuningMode": "original|exact" }`
- `GET /api/jobs/:id` consulta estado y enlaces de descarga si esta completado
- `GET /api/download/:id/wav` descarga WAV
- `GET /api/download/:id/mp3` descarga MP3
- `GET /api/admin/logs` lista de logs para admin
- `GET /health` estado de servicio

## Estructura

- `src/server.js`: API, estados y cola
- `src/audio.js`: descarga y conversion ffmpeg
- `src/store.js`: persistencia JSON de jobs/logs
- `public/`: interfaz web

## Notas importantes

- La cola actual es en memoria (si reinicias el proceso, solo se preservan logs ya escritos).
- Este MVP asume acceso permitido a contenido de YouTube y no gestiona aspectos legales/licencias.
- Se limita la duracion maxima del audio a 60 minutos.
- No requiere instalar `ffmpeg` en el equipo del usuario final (se usa `ffmpeg-static`).
